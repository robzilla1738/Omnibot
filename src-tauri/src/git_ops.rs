use crate::scanner::augmented_path_env;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChangedFile {
    pub path: String,
    pub status: String,
    pub staged: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorktreeEntry {
    pub path: String,
    pub branch: String,
    pub head: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoStatus {
    pub is_repo: bool,
    pub root_path: String,
    pub branch: String,
    pub head_short: String,
    pub ahead: u32,
    pub behind: u32,
    pub changed_files: Vec<GitChangedFile>,
    pub diff_stat: String,
    pub diff_preview: String,
    pub worktrees: Vec<GitWorktreeEntry>,
}

fn run_git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("PATH", augmented_path_env())
        .output()
        .map_err(|e| format!("Failed to run git: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "git command failed".to_string()
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

pub fn inspect_git_status(workspace_root: &str) -> GitRepoStatus {
    let Ok(top_level) = run_git(workspace_root, &["rev-parse", "--show-toplevel"]) else {
        return GitRepoStatus {
            is_repo: false,
            root_path: workspace_root.to_string(),
            branch: String::new(),
            head_short: String::new(),
            ahead: 0,
            behind: 0,
            changed_files: Vec::new(),
            diff_stat: String::new(),
            diff_preview: String::new(),
            worktrees: Vec::new(),
        };
    };
    let root_path = top_level.trim().to_string();
    let branch = run_git(&root_path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .unwrap_or_else(|_| "main".to_string())
        .trim()
        .to_string();
    let head_short = run_git(&root_path, &["rev-parse", "--short", "HEAD"])
        .unwrap_or_default()
        .trim()
        .to_string();

    let mut changed_files = Vec::new();
    if let Ok(porcelain) = run_git(&root_path, &["status", "--porcelain=v1"]) {
        for line in porcelain.lines() {
            if line.len() < 4 {
                continue;
            }
            let xy = &line[..2];
            let file_path = line[3..].trim().to_string();
            let staged = !xy.starts_with(' ') && !xy.starts_with('?');
            let status = match xy.trim() {
                "M" | "MM" => "modified",
                "A" | "AM" => "added",
                "D" => "deleted",
                "R" => "renamed",
                "??" => "untracked",
                _ => "changed",
            }
            .to_string();
            changed_files.push(GitChangedFile {
                path: file_path,
                status,
                staged,
            });
        }
    }

    let diff_stat = run_git(&root_path, &["diff", "--stat", "HEAD"])
        .or_else(|_| run_git(&root_path, &["diff", "--stat"]))
        .unwrap_or_default()
        .trim()
        .to_string();

    let mut diff_preview = run_git(&root_path, &["diff", "HEAD"])
        .or_else(|_| run_git(&root_path, &["diff"]))
        .unwrap_or_default();
    if diff_preview.len() > 24_000 {
        diff_preview.truncate(24_000);
        diff_preview.push_str("\n... [diff truncated at 24 KB]");
    }

    let mut worktrees = Vec::new();
    if let Ok(wt_raw) = run_git(&root_path, &["worktree", "list", "--porcelain"]) {
        let mut current_path = String::new();
        let mut current_head = String::new();
        let mut current_branch = String::new();
        for line in wt_raw.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                if !current_path.is_empty() {
                    worktrees.push(GitWorktreeEntry {
                        path: current_path.clone(),
                        branch: current_branch.clone(),
                        head: current_head.clone(),
                    });
                }
                current_path = p.trim().to_string();
                current_head.clear();
                current_branch = "detached".to_string();
            } else if let Some(h) = line.strip_prefix("HEAD ") {
                current_head = h.trim().chars().take(7).collect();
            } else if let Some(b) = line.strip_prefix("branch ") {
                current_branch = b
                    .trim()
                    .strip_prefix("refs/heads/")
                    .unwrap_or(b.trim())
                    .to_string();
            }
        }
        if !current_path.is_empty() {
            worktrees.push(GitWorktreeEntry {
                path: current_path,
                branch: current_branch,
                head: current_head,
            });
        }
    }

    GitRepoStatus {
        is_repo: true,
        root_path,
        branch,
        head_short,
        ahead: 0,
        behind: 0,
        changed_files,
        diff_stat,
        diff_preview,
        worktrees,
    }
}

pub fn ensure_bot_worktree(
    workspace_root: &str,
    chat_id: &str,
    bot_slug: &str,
) -> Result<String, String> {
    let status = inspect_git_status(workspace_root);
    if !status.is_repo {
        return Ok(workspace_root.to_string());
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let wt_base = home
        .join(".omni-bot")
        .join("worktrees")
        .join(chat_id.chars().take(12).collect::<String>());
    fs::create_dir_all(&wt_base)
        .map_err(|e| format!("Failed to create worktree directory: {e}"))?;

    let wt_dir = wt_base.join(bot_slug);
    if wt_dir.exists() {
        return Ok(wt_dir.to_string_lossy().into_owned());
    }

    let branch_name = format!(
        "omni/{}/{}",
        chat_id.chars().take(8).collect::<String>(),
        bot_slug
    );
    let wt_str = wt_dir.to_string_lossy().into_owned();
    let res = run_git(
        &status.root_path,
        &["worktree", "add", "-B", &branch_name, &wt_str, "HEAD"],
    );
    match res {
        Ok(_) => Ok(wt_str),
        Err(_) => Ok(workspace_root.to_string()),
    }
}

pub fn read_file_diff(workspace_root: &str, file_path: &str) -> Result<String, String> {
    let diff = run_git(workspace_root, &["diff", "HEAD", "--", file_path])
        .or_else(|_| run_git(workspace_root, &["diff", "--", file_path]))?;
    if !diff.trim().is_empty() {
        return Ok(diff);
    }
    let full = Path::new(workspace_root).join(file_path);
    fs::read_to_string(&full).map_err(|e| format!("Could not read {file_path}: {e}"))
}
