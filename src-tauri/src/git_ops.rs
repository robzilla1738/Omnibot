use crate::scanner::augmented_path_env;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::Duration;

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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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

#[derive(Clone, Copy)]
enum Git {
    /// Never takes optional locks, so status checks don't contend with a bot's Git commands.
    Read,
    Write,
    /// Populates or deletes a checkout, or runs hooks.
    Long,
}

const DIFF_PREVIEW_BYTES: u64 = 24_000;
const FILE_DIFF_BYTES: u64 = 256_000;

fn run_git(cwd: &str, args: &[&str], kind: Git) -> Result<String, String> {
    let (stdout, truncated) = run_git_limited(cwd, args, kind, Some(8 * 1024 * 1024))?;
    if truncated {
        return Err(
            "Git output exceeded 8 MB. Narrow the repository changes and try again.".into(),
        );
    }
    Ok(stdout)
}

/// Returns stdout and whether it was cut at `limit` bytes. Git is stopped once it writes past
/// the limit, so a huge diff is never fully produced or read.
fn run_git_limited(
    cwd: &str,
    args: &[&str],
    kind: Git,
    limit: Option<u64>,
) -> Result<(String, bool), String> {
    let output_dir = std::env::temp_dir().join(format!("omni-git-{}", uuid::Uuid::new_v4()));
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&output_dir).map_err(|e| e.to_string())?;
    struct OutputDir(PathBuf);
    impl Drop for OutputDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = OutputDir(output_dir.clone());
    let stdout_path = output_dir.join("stdout");
    let stdout = fs::File::create(&stdout_path).map_err(|e| e.to_string())?;
    let stderr_path = output_dir.join("stderr");
    let stderr = fs::File::create(&stderr_path).map_err(|e| e.to_string())?;
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(cwd)
        .env("PATH", augmented_path_env())
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .stdout(stdout)
        .stderr(stderr);
    if matches!(kind, Git::Read) {
        command.env("GIT_OPTIONAL_LOCKS", "0");
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to run git: {e}"))?;
    let timeout = Duration::from_secs(match kind {
        Git::Long => 300,
        Git::Read | Git::Write => 15,
    });
    let stdout_len = || fs::metadata(&stdout_path).map_or(0, |m| m.len());
    let stderr_overflow = || fs::metadata(&stderr_path).is_ok_and(|m| m.len() > 1024 * 1024);
    let start = std::time::Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break Some(status);
        }
        let overflow = limit.is_some_and(|limit| stdout_len() > limit);
        if overflow || stderr_overflow() || start.elapsed() > timeout {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.kill();
            let _ = child.wait();
            if stderr_overflow() {
                return Err("Git error output exceeded 1 MB; the operation was stopped.".into());
            }
            if overflow {
                break None;
            }
            return Err("Git took too long. Check repository hooks or locks and try again.".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    if stderr_overflow() {
        return Err(
            "Git error output exceeded 1 MB. Inspect repository hooks before retrying.".into(),
        );
    }
    if status.is_some_and(|status| !status.success()) {
        let mut stderr = Vec::new();
        fs::File::open(output_dir.join("stderr"))
            .and_then(|file| file.take(16_000).read_to_end(&mut stderr))
            .map_err(|e| e.to_string())?;
        let stderr = String::from_utf8_lossy(&stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "git command failed".to_string()
        } else {
            stderr
        });
    }
    let truncated = limit.is_some_and(|limit| stdout_len() > limit);
    let mut stdout = Vec::new();
    fs::File::open(&stdout_path)
        .and_then(|file| {
            file.take(limit.unwrap_or(u64::MAX))
                .read_to_end(&mut stdout)
        })
        .map_err(|e| e.to_string())?;
    // Drop a multi-byte character split by the limit rather than rendering a replacement.
    let valid = match std::str::from_utf8(&stdout) {
        Err(error) if truncated && error.error_len().is_none() => error.valid_up_to(),
        _ => stdout.len(),
    };
    Ok((
        String::from_utf8_lossy(&stdout[..valid]).into_owned(),
        truncated,
    ))
}

pub fn repository_root(workspace_root: &str) -> Result<String, String> {
    let output = run_git(workspace_root, &["rev-parse", "--show-toplevel"], Git::Read)?;
    let path = output.strip_suffix('\n').unwrap_or(&output);
    fs::canonicalize(path)
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| format!("Could not resolve repository: {error}"))
}

pub fn inspect_git_status(workspace_root: &str) -> GitRepoStatus {
    let Ok(root_path) = repository_root(workspace_root) else {
        return GitRepoStatus {
            is_repo: false,
            root_path: workspace_root.to_string(),
            ..Default::default()
        };
    };
    let git = |args: &[&str]| run_git(&root_path, args, Git::Read);
    // Unborn branches still have a symbolic HEAD; only a detached HEAD has no branch name.
    let branch = git(&["symbolic-ref", "--short", "-q", "HEAD"])
        .map_or_else(|_| "HEAD (detached)".to_string(), |b| b.trim().to_string());
    let head_short = git(&["rev-parse", "--short", "HEAD"])
        .unwrap_or_default()
        .trim()
        .to_string();

    let mut changed_files = Vec::new();
    if let Ok(porcelain) = git(&["status", "--porcelain=v1", "-z"]) {
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

    let diff_stat = git(&["diff", "--stat", "HEAD"])
        .or_else(|_| git(&["diff", "--stat"]))
        .unwrap_or_default()
        .trim()
        .to_string();

    let preview =
        |args: &[&str]| run_git_limited(&root_path, args, Git::Read, Some(DIFF_PREVIEW_BYTES));
    let (mut diff_preview, truncated) = preview(&["diff", "HEAD"])
        .or_else(|_| preview(&["diff"]))
        .unwrap_or_default();
    if truncated {
        diff_preview.push_str("\n... [diff truncated at 24 KB]");
    }

    let mut worktrees = Vec::new();
    if let Ok(wt_raw) = git(&["worktree", "list", "--porcelain"]) {
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

    let divergence =
        git(&["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]).unwrap_or_default();
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

// Full identifiers prevent timestamp-prefix collisions across rooms. Encode arbitrary IDs so
// they cannot escape the worktree root or become Git options.
fn key(value: &str) -> String {
    value.bytes().map(|b| format!("{b:02x}")).collect()
}

fn canonical(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn common_dir(cwd: &str) -> Result<PathBuf, String> {
    let dir = run_git(
        cwd,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        Git::Read,
    )?;
    Ok(canonical(Path::new(dir.trim())))
}

/// A folder is only reusable if it is itself a worktree root and its HEAD resolves; an empty
/// or half-created folder would otherwise resolve to an enclosing repository.
fn is_complete_worktree(path: &Path) -> bool {
    let cwd = path.to_string_lossy();
    let toplevel = run_git(
        &cwd,
        &["rev-parse", "--is-inside-work-tree", "--show-toplevel"],
        Git::Read,
    );
    toplevel.is_ok_and(|out| {
        let mut lines = out.lines();
        lines.next() == Some("true")
            && lines.next().map(|top| canonical(Path::new(top))) == Some(canonical(path))
    }) && run_git(&cwd, &["rev-parse", "--verify", "-q", "HEAD"], Git::Read).is_ok()
}

pub(crate) fn ensure_bot_worktree_in(
    workspace_root: &str,
    chat_id: &str,
    bot_slug: &str,
    data_dir: &Path,
) -> Result<String, String> {
    let root = run_git(workspace_root, &["rev-parse", "--show-toplevel"], Git::Read)?;
    let root = root.trim();
    let chat_key = key(chat_id);
    let bot_key = key(bot_slug);
    let canonical_root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    // The repository identity prevents reusing a different project's checkout.
    let mut hash = 0xcbf29ce484222325u64;
    for byte in canonical_root.as_os_str().as_encoded_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    let repository_key = format!("{hash:016x}");
    let expected = common_dir(root)?;
    let legacy = data_dir.join("worktrees").join(&chat_key).join(&bot_key);
    if legacy.exists()
        && is_complete_worktree(&legacy)
        && common_dir(&legacy.to_string_lossy()).ok() == Some(expected.clone())
    {
        return Ok(legacy.to_string_lossy().into_owned());
    }
    let wt_base = data_dir
        .join("worktrees")
        .join(repository_key)
        .join(&chat_key);
    fs::create_dir_all(&wt_base).map_err(|e| e.to_string())?;
    let wt_dir = wt_base.join(&bot_key);
    let wt_str = wt_dir.to_string_lossy().into_owned();
    if wt_dir.exists() {
        if !is_complete_worktree(&wt_dir) {
            return Err(format!(
                "The worktree folder {wt_str} is incomplete. Move or delete it, then try again."
            ));
        }
        if common_dir(&wt_str)? != expected {
            return Err("Existing worktree belongs to another repository.".into());
        }
        return Ok(wt_str);
    }
    // A worktree folder deleted outside Git still holds its branch until pruned.
    run_git(root, &["worktree", "prune"], Git::Write)?;
    let branch = format!("omni/{chat_key}/{bot_key}");
    let branch_ref = format!("refs/heads/{branch}");
    // Never reset an existing branch or fall back to the shared workspace.
    let added = if run_git(root, &["show-ref", "--verify", &branch_ref], Git::Read).is_ok() {
        run_git(root, &["worktree", "add", &wt_str, &branch], Git::Long)
    } else {
        run_git(
            root,
            &["worktree", "add", "-b", &branch, &wt_str, "HEAD"],
            Git::Long,
        )
    };
    if let Err(error) = added {
        if wt_dir.exists() {
            let _ = fs::remove_dir_all(&wt_dir);
            let _ = run_git(root, &["worktree", "prune"], Git::Write);
        }
        return Err(error);
    }
    Ok(wt_str)
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCleanup {
    /// Deleted worktree folders, and deleted branches as `branch <name>`.
    pub removed: Vec<String>,
    pub kept: Vec<KeptWorktreeItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeptWorktreeItem {
    pub item: String,
    pub reason: String,
}

/// Removes a chat's Omnibot worktrees and their `omni/` branches without forcing anything:
/// worktrees with changes and branches with unmerged commits are kept and reported.
pub fn remove_chat_worktrees(data_dir: &Path, chat_id: &str) -> WorktreeCleanup {
    let chat_key = key(chat_id);
    let base = data_dir.join("worktrees");
    // Legacy layout: worktrees/<chat>/<bot>; current: worktrees/<repository>/<chat>/<bot>.
    let mut chat_dirs = vec![base.join(&chat_key)];
    if let Ok(entries) = fs::read_dir(&base) {
        chat_dirs.extend(
            entries
                .flatten()
                .filter(|entry| entry.file_name() != chat_key.as_str())
                .map(|entry| entry.path().join(&chat_key)),
        );
    }
    let mut cleanup = WorktreeCleanup::default();
    for chat_dir in chat_dirs {
        let Ok(entries) = fs::read_dir(&chat_dir) else {
            continue;
        };
        for entry in entries.flatten().filter(|e| e.path().is_dir()) {
            remove_worktree(&entry.path(), &mut cleanup);
        }
        // Succeeds only when nothing was kept.
        let _ = fs::remove_dir(&chat_dir);
    }
    cleanup
}

fn remove_worktree(path: &Path, cleanup: &mut WorktreeCleanup) {
    let path = canonical(path);
    let label = path.to_string_lossy().into_owned();
    let mut keep = |item: String, reason: String| {
        cleanup.kept.push(KeptWorktreeItem { item, reason });
    };
    if !is_complete_worktree(&path) {
        keep(label, "This folder isn't a complete Git worktree.".into());
        return;
    }
    let repository = match common_dir(&label) {
        Ok(dir) => dir.to_string_lossy().into_owned(),
        Err(error) => return keep(label, error),
    };
    let branch = run_git(
        &label,
        &["symbolic-ref", "--short", "-q", "HEAD"],
        Git::Read,
    )
    .ok()
    .map(|b| b.trim().to_string())
    .filter(|b| b.starts_with("omni/"));
    if let Err(error) = run_git(&repository, &["worktree", "remove", &label], Git::Long) {
        let reason = if error.contains("modified or untracked") {
            "It has uncommitted or untracked changes.".into()
        } else {
            error
        };
        return keep(label, reason);
    }
    cleanup.removed.push(label);
    if let Some(branch) = branch {
        match run_git(&repository, &["branch", "-d", &branch], Git::Write) {
            Ok(_) => cleanup.removed.push(format!("branch {branch}")),
            Err(error) => cleanup.kept.push(KeptWorktreeItem {
                item: format!("branch {branch}"),
                reason: if error.contains("not fully merged") {
                    "It has commits that aren't merged.".into()
                } else {
                    error
                },
            }),
        }
    }
    let _ = run_git(&repository, &["worktree", "prune"], Git::Write);
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
    let root = repository_root(workspace_root)?;
    let workspace_root = root.as_str();
    let full = workspace_file(workspace_root, file_path)?;
    let (mut diff, truncated) = run_git_limited(
        workspace_root,
        &["--literal-pathspecs", "diff", "HEAD", "--", file_path],
        Git::Read,
        Some(FILE_DIFF_BYTES),
    )
    .or_else(|_| {
        run_git_limited(
            workspace_root,
            &["--literal-pathspecs", "diff", "--", file_path],
            Git::Read,
            Some(FILE_DIFF_BYTES),
        )
    })?;
    if truncated {
        diff.push_str("\n... [file diff truncated at 256 KB]");
    }
    if !diff.trim().is_empty() {
        return Ok(diff);
    }
    if !fs::metadata(&full).map_err(|e| e.to_string())?.is_file() {
        return Err("Only regular files can be previewed.".into());
    }
    let file = fs::File::open(&full).map_err(|e| format!("Could not read {file_path}: {e}"))?;
    let mut bytes = Vec::new();
    file.take(FILE_DIFF_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let truncated = bytes.len() > FILE_DIFF_BYTES as usize;
    bytes.truncate(FILE_DIFF_BYTES as usize);
    if bytes.contains(&0) {
        return Ok("Binary file (preview unavailable)".into());
    }
    let valid = match std::str::from_utf8(&bytes) {
        Err(error) if truncated && error.error_len().is_none() => error.valid_up_to(),
        _ => bytes.len(),
    };
    let mut content = String::from_utf8_lossy(&bytes[..valid]).into_owned();
    if truncated {
        content.push_str("\n... [file truncated at 256 KB]");
    }
    Ok(content)
}

pub fn git_stage_and_commit(workspace_root: &str, message: &str) -> Result<String, String> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("Commit message cannot be empty.".to_string());
    }
    let root = repository_root(workspace_root)?;
    run_git(&root, &["add", "-A"], Git::Long)?;
    run_git(&root, &["commit", "-m", trimmed], Git::Long)
}

pub fn git_discard_file(workspace_root: &str, file_path: &str) -> Result<String, String> {
    let root = repository_root(workspace_root)?;
    let workspace_root = root.as_str();
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
        Git::Read,
    )
    .is_ok()
        || run_git(
            workspace_root,
            &["cat-file", "-e", &format!("HEAD:{file_path}")],
            Git::Read,
        )
        .is_ok();
    if tracked {
        let branch = run_git(
            workspace_root,
            &[
                "status",
                "--porcelain=v2",
                "--branch",
                "--untracked-files=no",
            ],
            Git::Read,
        )?;
        if branch.lines().any(|line| line == "# branch.oid (initial)") {
            if !full.is_file() {
                return Err(
                    "Only individual files can be discarded before the first commit.".into(),
                );
            }
            run_git(
                workspace_root,
                &[
                    "--literal-pathspecs",
                    "rm",
                    "--cached",
                    "--force",
                    "--",
                    file_path,
                ],
                Git::Write,
            )?;
            fs::remove_file(&full)
                .map_err(|e| format!("Unstaged {file_path}, but could not remove it: {e}"))?;
            return Ok(format!("Discarded new file {file_path}"));
        }
        let status = run_git(
            workspace_root,
            &["status", "--porcelain=v1", "-z", "--untracked-files=no"],
            Git::Read,
        )?;
        let mut entries = status.split('\0').filter(|entry| !entry.is_empty());
        let mut original = None;
        while let Some(entry) = entries.next() {
            if entry.len() < 4 || !entry.is_char_boundary(3) {
                continue;
            }
            if entry[..2].contains(['R', 'C']) {
                let source = entries.next().ok_or("Incomplete Git rename status")?;
                if entry[..2].contains('R') && &entry[3..] == file_path {
                    let source_path = workspace_file(workspace_root, source)?;
                    if source_path.symlink_metadata().is_ok() {
                        return Err("The original rename path now exists. Preserve that file before discarding the rename.".into());
                    }
                    original = Some(source);
                    break;
                }
            }
        }
        // Restore tracked changes, including staged deletions. Never delete on a Git error.
        let mut args = vec![
            "--literal-pathspecs",
            "restore",
            "--source=HEAD",
            "--staged",
            "--worktree",
            "--",
            file_path,
        ];
        if let Some(original) = original {
            args.push(original);
        }
        run_git(workspace_root, &args, Git::Write)?;
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

    fn run_git(cwd: &str, args: &[&str]) -> Result<String, String> {
        super::run_git(cwd, args, Git::Long)
    }

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
    fn switching_repositories_keeps_old_dirty_worktrees_intact() {
        let first = repository();
        let second = repository();
        let data = first.dir.join("data");
        let original =
            ensure_bot_worktree_in(first.dir.to_str().unwrap(), "room", "bot", &data).unwrap();
        fs::write(Path::new(&original).join("uncommitted.txt"), "keep me").unwrap();
        let next =
            ensure_bot_worktree_in(second.dir.to_str().unwrap(), "room", "bot", &data).unwrap();
        assert_ne!(original, next);
        assert_eq!(
            fs::read_to_string(Path::new(&original).join("uncommitted.txt")).unwrap(),
            "keep me"
        );
        assert!(!Path::new(&next).join("uncommitted.txt").exists());
        assert_eq!(
            original,
            ensure_bot_worktree_in(first.dir.to_str().unwrap(), "room", "bot", &data).unwrap()
        );
    }

    #[test]
    fn legacy_worktree_is_reused_without_losing_uncommitted_edits() {
        let f = repository();
        let data = f.dir.join("data");
        let legacy = data.join("worktrees/726f6f6d/626f74");
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        run_git(
            f.dir.to_str().unwrap(),
            &["worktree", "add", "-b", "legacy", legacy.to_str().unwrap()],
        )
        .unwrap();
        fs::write(legacy.join("uncommitted.txt"), "keep me").unwrap();
        let actual = ensure_bot_worktree_in(f.dir.to_str().unwrap(), "room", "bot", &data).unwrap();
        assert_eq!(Path::new(&actual), legacy);
        assert!(legacy.join("uncommitted.txt").exists());
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
    fn subfolder_actions_use_the_same_repository_relative_paths_as_status() {
        let f = repository();
        let root = f.dir.to_str().unwrap();
        fs::create_dir_all(f.dir.join("sub/sub")).unwrap();
        for name in ["sub/file.txt", "sub/sub/file.txt"] {
            fs::write(f.dir.join(name), "original\n").unwrap();
        }
        git_stage_and_commit(root, "nested files").unwrap();
        fs::write(f.dir.join("sub/file.txt"), "selected edit\n").unwrap();
        fs::write(f.dir.join("sub/sub/file.txt"), "keep this edit\n").unwrap();
        let sub = f.dir.join("sub");
        let sub = sub.to_str().unwrap();
        assert!(inspect_git_status(sub)
            .changed_files
            .iter()
            .any(|f| f.path == "sub/file.txt"));
        let diff = read_file_diff(sub, "sub/file.txt").unwrap();
        assert!(diff.contains("+selected edit"));
        assert!(!diff.contains("keep this edit"));
        git_discard_file(sub, "sub/file.txt").unwrap();
        assert_eq!(
            fs::read_to_string(f.dir.join("sub/file.txt")).unwrap(),
            "original\n"
        );
        assert_eq!(
            fs::read_to_string(f.dir.join("sub/sub/file.txt")).unwrap(),
            "keep this edit\n"
        );
        fs::write(f.dir.join("tracked.txt"), "root edit\n").unwrap();
        git_stage_and_commit(sub, "all displayed repository changes").unwrap();
        assert!(inspect_git_status(sub).changed_files.is_empty());
    }

    #[test]
    fn individual_file_previews_are_bounded_for_tracked_and_untracked_files() {
        let f = repository();
        let root = f.dir.to_str().unwrap();
        for name in ["tracked.txt", "untracked.txt"] {
            fs::write(f.dir.join(name), "💻".repeat(100_000)).unwrap();
            let diff = read_file_diff(root, name).unwrap();
            assert!(diff.contains("truncated"));
            assert!(diff.len() < FILE_DIFF_BYTES as usize + 64);
            assert!(!diff.contains('\u{FFFD}'));
        }
    }

    #[test]
    fn discard_rename_restores_both_paths_and_preserves_recreated_originals() {
        let f = repository();
        let root = f.dir.to_str().unwrap();
        run_git(root, &["mv", "tracked.txt", "renamed.txt"]).unwrap();
        fs::write(f.dir.join("tracked.txt"), "new work at old path").unwrap();
        assert!(git_discard_file(root, "renamed.txt").is_err());
        assert_eq!(
            fs::read_to_string(f.dir.join("tracked.txt")).unwrap(),
            "new work at old path"
        );
        fs::remove_file(f.dir.join("tracked.txt")).unwrap();
        git_discard_file(root, "renamed.txt").unwrap();
        assert_eq!(
            fs::read_to_string(f.dir.join("tracked.txt")).unwrap(),
            "original\n"
        );
        assert!(!f.dir.join("renamed.txt").exists());
        assert!(inspect_git_status(root).changed_files.is_empty());
    }

    #[test]
    fn discard_staged_new_file_works_before_and_after_the_first_commit() {
        for f in [Fixture::new(&[]), repository()] {
            let root = f.dir.to_str().unwrap();
            run_git(root, &["init", "-q"]).unwrap();
            fs::write(f.dir.join("new.txt"), "new work").unwrap();
            run_git(root, &["add", "new.txt"]).unwrap();
            git_discard_file(root, "new.txt").unwrap();
            assert!(!f.dir.join("new.txt").exists());
            assert!(inspect_git_status(root).changed_files.is_empty());
        }
    }

    #[test]
    fn worktree_discard_never_touches_the_main_checkout() {
        let f = repository();
        let root = f.dir.to_str().unwrap();
        let data = Fixture::new(&[]);
        let worktree = ensure_bot_worktree_in(root, "room", "bot", &data.dir).unwrap();
        fs::write(f.dir.join("tracked.txt"), "keep main checkout edit").unwrap();
        fs::write(Path::new(&worktree).join("tracked.txt"), "worktree edit").unwrap();
        git_discard_file(&worktree, "tracked.txt").unwrap();
        assert_eq!(
            fs::read_to_string(f.dir.join("tracked.txt")).unwrap(),
            "keep main checkout edit"
        );
        assert_eq!(
            fs::read_to_string(Path::new(&worktree).join("tracked.txt")).unwrap(),
            "original\n"
        );
    }

    #[test]
    fn noisy_git_hook_is_stopped_with_bounded_error_output() {
        let f = repository();
        let root = f.dir.to_str().unwrap();
        let hooks = f.dir.join("hooks");
        fs::create_dir(&hooks).unwrap();
        let hook = hooks.join("pre-commit");
        fs::write(&hook, "#!/bin/sh\nexec yes noisy-hook >&2\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o700)).unwrap();
        run_git(root, &["config", "core.hooksPath", hooks.to_str().unwrap()]).unwrap();
        fs::write(f.dir.join("tracked.txt"), "edit").unwrap();
        let start = std::time::Instant::now();
        let error = git_stage_and_commit(root, "hook must stop").unwrap_err();
        assert!(error.contains("error output exceeded"), "{error}");
        assert!(start.elapsed() < Duration::from_secs(5));
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
        assert!(status.diff_preview.len() < DIFF_PREVIEW_BYTES as usize + 64);
        assert!(!status.diff_preview.contains('\u{FFFD}'));
    }

    #[test]
    fn branch_names_are_reported_honestly() {
        let f = repository();
        let root = f.dir.to_str().unwrap();
        run_git(root, &["checkout", "-q", "-b", "feature"]).unwrap();
        assert_eq!(inspect_git_status(root).branch, "feature");
        run_git(root, &["checkout", "-q", "--detach"]).unwrap();
        assert_eq!(inspect_git_status(root).branch, "HEAD (detached)");
        let empty = Fixture::new(&[]);
        let empty_root = empty.dir.to_str().unwrap();
        run_git(empty_root, &["init", "-q", "-b", "trunk"]).unwrap();
        assert_eq!(inspect_git_status(empty_root).branch, "trunk");
    }

    #[test]
    fn incomplete_worktree_folders_are_rejected_and_failed_adds_leave_nothing_behind() {
        let f = repository();
        let root = f.dir.to_str().unwrap();
        run_git(root, &["config", "core.hooksPath", "/dev/null"]).unwrap();
        let data = f.dir.join("state");
        let first = ensure_bot_worktree_in(root, "room", "x", &data).unwrap();
        let partial = Path::new(&first).parent().unwrap().join(key("y"));
        fs::create_dir_all(&partial).unwrap();
        let error = ensure_bot_worktree_in(root, "room", "y", &data).unwrap_err();
        assert!(error.contains("incomplete"), "{error}");
        fs::remove_dir(&partial).unwrap();

        let hooks = f.dir.join("hooks");
        fs::create_dir_all(&hooks).unwrap();
        let hook = hooks.join("post-checkout");
        fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o700)).unwrap();
        run_git(root, &["config", "core.hooksPath", hooks.to_str().unwrap()]).unwrap();
        assert!(ensure_bot_worktree_in(root, "room", "y", &data).is_err());
        assert!(!partial.exists());
        run_git(root, &["config", "core.hooksPath", "/dev/null"]).unwrap();
        let retried = ensure_bot_worktree_in(root, "room", "y", &data).unwrap();
        assert!(is_complete_worktree(Path::new(&retried)));
    }

    #[test]
    fn chat_cleanup_removes_clean_worktrees_and_keeps_dirty_or_unmerged_work() {
        let f = repository();
        let root = f.dir.to_str().unwrap();
        run_git(root, &["config", "core.hooksPath", "/dev/null"]).unwrap();
        let data = f.dir.join("state");
        let worktree =
            |chat: &str, bot: &str| ensure_bot_worktree_in(root, chat, bot, &data).unwrap();
        let clean = worktree("room", "clean");
        let dirty = worktree("room", "dirty");
        let ahead = worktree("room", "ahead");
        let other = worktree("other", "clean");
        fs::write(Path::new(&dirty).join("draft.txt"), "keep me").unwrap();
        fs::write(Path::new(&ahead).join("tracked.txt"), "committed work").unwrap();
        run_git(&ahead, &["commit", "-qam", "work"]).unwrap();
        let branch = |bot: &str| format!("omni/{}/{}", key("room"), key(bot));
        let has_branch = |bot: &str| {
            run_git(
                root,
                &[
                    "show-ref",
                    "--verify",
                    &format!("refs/heads/{}", branch(bot)),
                ],
            )
            .is_ok()
        };

        let result = remove_chat_worktrees(&data, "room");

        assert!(!Path::new(&clean).exists());
        assert!(!has_branch("clean"));
        assert!(result
            .removed
            .contains(&format!("branch {}", branch("clean"))));
        assert!(Path::new(&dirty).join("draft.txt").exists());
        assert!(has_branch("dirty"));
        assert!(result
            .kept
            .iter()
            .any(|k| k.item == canonical(Path::new(&dirty)).to_string_lossy()
                && k.reason.contains("uncommitted")));
        assert!(!Path::new(&ahead).exists());
        assert!(has_branch("ahead"));
        assert!(result.kept.iter().any(
            |k| k.item == format!("branch {}", branch("ahead")) && k.reason.contains("merged")
        ));
        assert!(Path::new(&other).exists());
        let listed = run_git(root, &["worktree", "list", "--porcelain"]).unwrap();
        assert_eq!(listed.matches("worktree ").count(), 3);
    }
}
