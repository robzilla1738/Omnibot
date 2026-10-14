use crate::scanner::augmented_path_env;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
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
    if let Ok(porcelain) = run_git(&root_path, &["status", "--porcelain=v1", "-z"]) {
        let mut entries = porcelain.split('\0').filter(|entry| !entry.is_empty());
        while let Some(entry) = entries.next() {
            if entry.len() < 4 || !entry.is_char_boundary(3) {
                continue;
            }
            let xy = &entry[..2];
            let path = entry[3..].to_string();
            if xy.contains('R') || xy.contains('C') {
                entries.next();
            }
            let status = if xy == "??" {
                "untracked"
            } else if xy.contains('U') || xy == "AA" || xy == "DD" {
                "conflicted"
            } else if xy.contains('R') {
                "renamed"
            } else if xy.contains('D') {
                "deleted"
            } else if xy.contains('A') {
                "added"
            } else {
                "modified"
            };
            changed_files.push(GitChangedFile {
                path,
                status: status.into(),
                staged: !xy.starts_with(' ') && !xy.starts_with('?'),
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
        let mut end = 24_000;
        while !diff_preview.is_char_boundary(end) {
            end -= 1;
        }
        diff_preview.truncate(end);
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

    let divergence = run_git(
        &root_path,
        &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    )
    .unwrap_or_default();
    let mut counts = divergence
        .split_whitespace()
        .filter_map(|n| n.parse::<u32>().ok());
    GitRepoStatus {
        is_repo: true,
        root_path,
        branch,
        head_short,
        ahead: counts.next().unwrap_or(0),
        behind: counts.next().unwrap_or(0),
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
    ensure_bot_worktree_in(
        workspace_root,
        chat_id,
        bot_slug,
        &crate::state::omni_data_dir(),
    )
}

fn ensure_bot_worktree_in(
    workspace_root: &str,
    chat_id: &str,
    bot_slug: &str,
    data_dir: &Path,
) -> Result<String, String> {
    let root = run_git(workspace_root, &["rev-parse", "--show-toplevel"])?;
    let root = root.trim();
    // Full identifiers prevent timestamp-prefix collisions across rooms. Encode
    // arbitrary IDs so they cannot escape the worktree root or become Git options.
    fn key(value: &str) -> String {
        value
            .as_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }
    let chat_key = key(chat_id);
    let bot_key = key(bot_slug);
    let wt_base = data_dir.join("worktrees").join(&chat_key);
    fs::create_dir_all(&wt_base).map_err(|e| e.to_string())?;
    let wt_dir = wt_base.join(&bot_key);
    let wt_str = wt_dir.to_string_lossy().into_owned();
    if wt_dir.exists() {
        let expected = run_git(
            root,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )?;
        let actual = run_git(
            &wt_str,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )?;
        if fs::canonicalize(expected.trim()).ok() != fs::canonicalize(actual.trim()).ok() {
            return Err("Existing worktree belongs to another repository.".into());
        }
        return Ok(wt_str);
    }
    let branch = format!("omni/{chat_key}/{bot_key}");
    // Never reset an existing branch or fall back to the shared workspace.
    if run_git(
        root,
        &["show-ref", "--verify", &format!("refs/heads/{branch}")],
    )
    .is_ok()
    {
        run_git(root, &["worktree", "add", &wt_str, &branch])?;
    } else {
        run_git(root, &["worktree", "add", "-b", &branch, &wt_str, "HEAD"])?;
    }
    Ok(wt_str)
}

// Git pathspec magic, traversal, and symlinked parents must not broaden a file action.
fn workspace_file(workspace_root: &str, file_path: &str) -> Result<PathBuf, String> {
    let path = Path::new(file_path);
    if file_path.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)) || c.as_os_str() == ".git")
    {
        return Err("Expected a relative file path inside the repository.".into());
    }
    let root = fs::canonicalize(workspace_root).map_err(|e| e.to_string())?;
    let full = root.join(path);
    let mut ancestor = full.as_path();
    while !ancestor.exists() {
        ancestor = ancestor.parent().ok_or("Invalid file path")?;
    }
    let canonical = fs::canonicalize(ancestor).map_err(|e| e.to_string())?;
    if !canonical.starts_with(&root) {
        return Err("File path leaves the repository.".into());
    }
    Ok(full)
}

pub fn read_file_diff(workspace_root: &str, file_path: &str) -> Result<String, String> {
    let full = workspace_file(workspace_root, file_path)?;
    let diff = run_git(
        workspace_root,
        &["--literal-pathspecs", "diff", "HEAD", "--", file_path],
    )
    .or_else(|_| {
        run_git(
            workspace_root,
            &["--literal-pathspecs", "diff", "--", file_path],
        )
    })?;
    if !diff.trim().is_empty() {
        return Ok(diff);
    }
    fs::read_to_string(&full).map_err(|e| format!("Could not read {file_path}: {e}"))
}

pub fn git_stage_and_commit(workspace_root: &str, message: &str) -> Result<String, String> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("Commit message cannot be empty.".to_string());
    }
    run_git(workspace_root, &["add", "-A"])?;
    run_git(workspace_root, &["commit", "-m", trimmed])
}

pub fn git_discard_file(workspace_root: &str, file_path: &str) -> Result<String, String> {
    let full = workspace_file(workspace_root, file_path)?;
    let tracked = run_git(
        workspace_root,
        &[
            "--literal-pathspecs",
            "ls-files",
            "--error-unmatch",
            "--",
            file_path,
        ],
    )
    .is_ok()
        || run_git(
            workspace_root,
            &["cat-file", "-e", &format!("HEAD:{file_path}")],
        )
        .is_ok();
    if tracked {
        // Restore tracked changes, including staged deletions. Never delete on a Git error.
        run_git(
            workspace_root,
            &[
                "--literal-pathspecs",
                "restore",
                "--source=HEAD",
                "--staged",
                "--worktree",
                "--",
                file_path,
            ],
        )?;
    } else if full.is_file() {
        fs::remove_file(&full).map_err(|e| format!("Failed to remove {file_path}: {e}"))?;
    } else {
        return Err("Only individual files can be discarded.".into());
    }
    Ok(format!("Discarded changes in {file_path}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::Fixture;

    fn repository() -> Fixture {
        let f = Fixture::new(&[]);
        let root = f.dir.to_str().unwrap();
        run_git(root, &["init", "-q"]).unwrap();
        run_git(root, &["config", "user.name", "Test"]).unwrap();
        run_git(root, &["config", "user.email", "test@localhost"]).unwrap();
        fs::write(f.dir.join("tracked.txt"), "original\n").unwrap();
        run_git(root, &["add", "tracked.txt"]).unwrap();
        run_git(
            root,
            &["-c", "core.hooksPath=/dev/null", "commit", "-qm", "initial"],
        )
        .unwrap();
        f
    }

    #[test]
    fn git_status_preserves_unicode_spaces_and_rename_destination() {
        let f = repository();
        let root = f.dir.to_str().unwrap();
        run_git(root, &["mv", "tracked.txt", " renamed 日本.txt "]).unwrap();
        fs::write(f.dir.join("line\nbreak.txt"), "new").unwrap();
        let status = inspect_git_status(root);
        assert!(status
            .changed_files
            .iter()
            .any(|f| f.path == " renamed 日本.txt " && f.status == "renamed"));
        assert!(status
            .changed_files
            .iter()
            .any(|f| f.path == "line\nbreak.txt"));
    }

    #[test]
    fn discard_restores_staged_deletions_and_handles_literal_globs() {
        let f = repository();
        let root = f.dir.to_str().unwrap();
        run_git(root, &["rm", "tracked.txt"]).unwrap();
        git_discard_file(root, "tracked.txt").unwrap();
        assert_eq!(
            fs::read_to_string(f.dir.join("tracked.txt")).unwrap(),
            "original\n"
        );
        fs::write(f.dir.join("*.txt"), "untracked").unwrap();
        git_discard_file(root, "*.txt").unwrap();
        assert!(f.dir.join("tracked.txt").exists());
        assert!(!f.dir.join("*.txt").exists());
    }

    #[test]
    fn file_actions_reject_traversal_absolute_and_external_symlinks() {
        let f = repository();
        let root = f.dir.to_str().unwrap();
        for path in ["../outside.txt", "/tmp/outside.txt", ".git/config", ".", ""] {
            assert!(git_discard_file(root, path).is_err());
            assert!(read_file_diff(root, path).is_err());
        }
        std::os::unix::fs::symlink("/tmp", f.dir.join("outside")).unwrap();
        assert!(read_file_diff(root, "outside/missing.txt").is_err());
    }

    #[test]
    fn worktrees_are_unique_reusable_and_never_fall_back() {
        let f = repository();
        let root = f.dir.to_str().unwrap();
        run_git(root, &["config", "core.hooksPath", "/dev/null"]).unwrap();
        let data = f.dir.join("state");
        let first = ensure_bot_worktree_in(root, "chat_12345678901", "A", &data).unwrap();
        let second = ensure_bot_worktree_in(root, "chat_12345678902", "A", &data).unwrap();
        assert_ne!(first, second);
        assert_ne!(first, root);
        fs::write(Path::new(&first).join("tracked.txt"), "isolated edits").unwrap();
        assert_eq!(
            fs::read_to_string(f.dir.join("tracked.txt")).unwrap(),
            "original\n"
        );
        assert_eq!(
            ensure_bot_worktree_in(root, "chat_12345678901", "A", &data).unwrap(),
            first
        );
        let outside = Fixture::new(&[]);
        assert!(ensure_bot_worktree_in(outside.dir.to_str().unwrap(), "chat", "A", &data).is_err());
    }

    #[test]
    fn unicode_diff_truncation_never_panics() {
        let f = repository();
        let root = f.dir.to_str().unwrap();
        fs::write(f.dir.join("tracked.txt"), "💻".repeat(8000)).unwrap();
        let status = inspect_git_status(root);
        assert!(status.diff_preview.contains("truncated"));
    }
}
