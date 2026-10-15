//! Execution locations and process slots are shared across every room.
use crate::scanner::CliDriverKind;
use crate::state::{BotProfile, OmniRuntimeState, SharedOmniState};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub fn supports_plan(driver: CliDriverKind) -> bool {
    matches!(
        driver,
        CliDriverKind::Claude
            | CliDriverKind::Codex
            | CliDriverKind::Cursor
            | CliDriverKind::Grok
            | CliDriverKind::Aider
    )
}

pub fn validate(bot: &BotProfile) -> Result<(), String> {
    if matches!(
        bot.permission_mode.as_str(),
        "bypassPermissions" | "acceptEdits"
    ) && bot.cli_driver != CliDriverKind::Claude
    {
        return Err("This adapter does not support the selected permission override. Choose CLI permissions.".into());
    }
    if bot.permission_mode == "plan" && !supports_plan(bot.cli_driver) {
        return Err(format!("{} does not expose a supported plan-only mode. Choose CLI permissions or another driver.", bot.name));
    }
    if bot
        .model
        .as_deref()
        .is_some_and(|m| !crate::lifecycle::valid_model_id(m))
    {
        return Err(format!(
            "{} has an invalid model ID. Model IDs can't start with \"-\" or contain control characters.",
            bot.name
        ));
    }
    if bot.cli_driver == CliDriverKind::Ollama
        && bot
            .model
            .as_deref()
            .is_none_or(|m| m.trim().is_empty() || m == "default")
    {
        return Err("Choose an installed Ollama model before sending.".into());
    }
    Ok(())
}

pub struct ExecutionLease {
    state: SharedOmniState,
    task_id: String,
}
impl Drop for ExecutionLease {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.state.write() {
            guard.execution_slots.remove(&self.task_id);
        }
    }
}

const GIT_OPERATION_WAIT: Duration = Duration::from_secs(5);

fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// The checkout a folder belongs to: the nearest ancestor containing `.git`. The search
/// checks but never climbs past a stop folder, and never enters `ceiling` from below, so a
/// dotfiles repository in the home folder doesn't merge unrelated folders and bot homes
/// into one checkout.
fn checkout_key(cwd: &str, stops: &[PathBuf], ceiling: Option<&Path>) -> String {
    let start = canonical(Path::new(cwd));
    for dir in start.ancestors() {
        if dir != start && ceiling == Some(dir) {
            break;
        }
        if dir.join(".git").exists() {
            return dir.to_string_lossy().into_owned();
        }
        if stops.iter().any(|stop| stop == dir) {
            break;
        }
    }
    start.to_string_lossy().into_owned()
}

fn checkout_key_for(state: &SharedOmniState, cwd: &str) -> Result<String, String> {
    let stops = {
        let guard = state.read().map_err(|_| "State lock poisoned")?;
        [
            guard.data_dir.clone(),
            PathBuf::from(&guard.store.preferences.workspace_root),
        ]
    };
    let stops = stops.map(|path| canonical(&path));
    let home = dirs::home_dir().map(|path| canonical(&path));
    Ok(checkout_key(cwd, &stops, home.as_deref()))
}

fn overlapping_holder(guard: &OmniRuntimeState, key: &str) -> Option<String> {
    guard
        .execution_slots
        .iter()
        .find(|(_, path)| Path::new(path).starts_with(key) || Path::new(key).starts_with(path))
        .map(|(id, _)| id.clone())
}

fn holder_name(guard: &OmniRuntimeState, task_id: &str) -> String {
    guard
        .store
        .chats
        .iter()
        .flat_map(|chat| &chat.tasks)
        .find(|task| task.id == task_id)
        .map_or_else(
            || "another operation".into(),
            |task| {
                let bot = guard.store.bots.iter().find(|b| b.id == task.bot_id);
                format!("@{}", bot.map_or(task.bot_id.as_str(), |b| b.name.as_str()))
            },
        )
}

pub async fn acquire(
    state: SharedOmniState,
    chat_id: &str,
    task_id: &str,
    cwd: &str,
) -> Result<ExecutionLease, String> {
    let key = checkout_key_for(&state, cwd)?;
    loop {
        {
            let mut guard = state.write().map_err(|_| "State lock poisoned")?;
            if guard.cancelled_chats.contains(chat_id) {
                return Err("Stopped while queued.".into());
            }
            let limit = guard.store.preferences.max_parallel_bots.clamp(1, 6) as usize;
            if guard.execution_slots.len() < limit && overlapping_holder(&guard, &key).is_none() {
                guard.execution_slots.insert(task_id.into(), key);
                return Ok(ExecutionLease {
                    state: state.clone(),
                    task_id: task_id.into(),
                });
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Claims a checkout for a user-initiated Git operation. Unlike [`acquire`], it ignores the
/// parallel-bot limit and chat cancellation, and fails after a short wait naming the holder.
pub async fn acquire_for_git(
    state: SharedOmniState,
    operation_id: &str,
    cwd: &str,
) -> Result<ExecutionLease, String> {
    acquire_checkout(state, operation_id, cwd, GIT_OPERATION_WAIT).await
}

async fn acquire_checkout(
    state: SharedOmniState,
    operation_id: &str,
    cwd: &str,
    wait: Duration,
) -> Result<ExecutionLease, String> {
    let key = checkout_key_for(&state, cwd)?;
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        {
            let mut guard = state.write().map_err(|_| "State lock poisoned")?;
            match overlapping_holder(&guard, &key) {
                None => {
                    guard.execution_slots.insert(operation_id.into(), key);
                    return Ok(ExecutionLease {
                        state: state.clone(),
                        task_id: operation_id.into(),
                    });
                }
                Some(holder) if tokio::time::Instant::now() >= deadline => {
                    return Err(format!(
                        "This checkout is busy: {} is running. Try again when it finishes.",
                        holder_name(&guard, &holder)
                    ));
                }
                Some(_) => {}
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

pub async fn workspace(
    state: &SharedOmniState,
    chat_id: &str,
    bot_id: &str,
) -> Result<String, String> {
    let (data_dir, path, worktrees) = {
        let guard = state.read().map_err(|_| "State lock poisoned")?;
        let chat = guard
            .store
            .chats
            .iter()
            .find(|c| c.id == chat_id)
            .ok_or("Chat not found")?;
        let project = guard
            .store
            .workspaces
            .iter()
            .find(|p| Some(&p.path) == chat.workspace_path.as_ref());
        (
            guard.data_dir.clone(),
            chat.workspace_path.clone(),
            chat.use_worktrees
                || project
                    .is_some_and(|p| p.use_worktrees_default && chat.participant_bot_ids.len() > 1),
        )
    };
    let chat_id = chat_id.to_string();
    let bot_id = bot_id.to_string();
    tokio::task::spawn_blocking(move || match path {
        Some(path) if worktrees => {
            crate::git_ops::ensure_bot_worktree_in(&path, &chat_id, &bot_id, &data_dir)
        }
        Some(path) => std::fs::canonicalize(path)
            .map(|p| p.to_string_lossy().into_owned())
            .map_err(|e| e.to_string()),
        None => crate::homes::bot_home(&data_dir, &bot_id),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::Fixture;
    #[tokio::test]
    async fn slots_are_global_cancellable_and_exclude_overlapping_folders() {
        let f = Fixture::new(&["A"]);
        f.state.write().unwrap().store.preferences.max_parallel_bots = 1;
        let lease = acquire(f.state.clone(), "room", "one", "/project")
            .await
            .unwrap();
        let queued = acquire(f.state.clone(), "other", "two", "/another-project");
        assert!(tokio::time::timeout(Duration::from_millis(80), queued)
            .await
            .is_err());
        f.state.write().unwrap().store.preferences.max_parallel_bots = 3;
        assert!(tokio::time::timeout(
            Duration::from_millis(80),
            acquire(f.state.clone(), "other", "two", "/project/subdir")
        )
        .await
        .is_err());
        f.state
            .write()
            .unwrap()
            .cancelled_chats
            .insert("other".into());
        assert!(acquire(f.state.clone(), "other", "two", "/another-project")
            .await
            .is_err());
        drop(lease);
        assert!(f.state.read().unwrap().execution_slots.is_empty());
        acquire(f.state.clone(), "room", "three", "/project")
            .await
            .unwrap();
    }
    #[test]
    fn checkout_search_stays_below_home_and_the_data_folder() {
        let f = Fixture::new(&[]);
        let home = canonical(&f.dir).join("home");
        let data = home.join(".omni-bot");
        for dir in [
            ".git",
            ".omni-bot/bots/61/home",
            "code/notes",
            "repo/.git",
            "repo/src",
        ] {
            std::fs::create_dir_all(home.join(dir)).unwrap();
        }
        let key = |path: PathBuf| {
            checkout_key(
                path.to_str().unwrap(),
                std::slice::from_ref(&data),
                Some(&home),
            )
        };
        let bot_home = data.join("bots/61/home");
        assert_eq!(key(bot_home.clone()), bot_home.to_str().unwrap());
        let notes = home.join("code/notes");
        assert_eq!(key(notes.clone()), notes.to_str().unwrap());
        assert_eq!(
            key(home.join("repo/src")),
            home.join("repo").to_str().unwrap()
        );
        assert_eq!(key(home.clone()), home.to_str().unwrap());
    }

    #[tokio::test]
    async fn bot_homes_inside_a_repository_do_not_share_a_checkout() {
        let f = Fixture::new(&["A", "B"]);
        std::fs::create_dir_all(f.dir.join(".git")).unwrap();
        let data = f.state.read().unwrap().data_dir.clone();
        let first = crate::homes::bot_home(&data, "A").unwrap();
        let second = crate::homes::bot_home(&data, "B").unwrap();
        let _lease = acquire(f.state.clone(), "room", "one", &first)
            .await
            .unwrap();
        tokio::time::timeout(
            Duration::from_millis(500),
            acquire(f.state.clone(), "other", "two", &second),
        )
        .await
        .expect("separate bot homes must not wait for each other")
        .unwrap();
    }

    #[tokio::test]
    async fn git_operations_wait_briefly_name_the_holder_and_ignore_cancellation() {
        let f = Fixture::new(&["A"]);
        {
            let mut g = f.state.write().unwrap();
            g.store.preferences.max_parallel_bots = 1;
            g.store.chats[0].tasks.push(crate::state::WorkflowTask {
                id: "task".into(),
                workflow_id: "workflow".into(),
                bot_id: "A".into(),
                from_bot_id: None,
                instructions: String::new(),
                mode: "sequential".into(),
                status: "running".into(),
                reason: None,
                workspace_path: None,
            });
            g.cancelled_chats.insert("room".into());
        }
        std::fs::create_dir_all(f.dir.join("sub")).unwrap();
        let project = f.dir.to_str().unwrap();
        let lease = acquire_checkout(f.state.clone(), "held", "/elsewhere", Duration::ZERO)
            .await
            .unwrap();
        // The parallel-bot limit is full, but a different checkout is still available.
        let commit = acquire_checkout(f.state.clone(), "commit", project, Duration::ZERO)
            .await
            .unwrap();
        drop((lease, commit));
        f.state.write().unwrap().cancelled_chats.clear();
        let bot = acquire(f.state.clone(), "room", "task", project)
            .await
            .unwrap();
        f.state
            .write()
            .unwrap()
            .cancelled_chats
            .insert("room".into());
        let error = acquire_checkout(
            f.state.clone(),
            "commit",
            f.dir.join("sub").to_str().unwrap(),
            Duration::from_millis(100),
        )
        .await
        .err()
        .unwrap();
        assert_eq!(
            error,
            "This checkout is busy: @A is running. Try again when it finishes."
        );
        drop(bot);
        acquire_for_git(f.state.clone(), "commit", project)
            .await
            .unwrap();
    }

    #[test]
    fn model_ids_that_look_like_flags_are_rejected() {
        let mut bot = crate::test_support::bot("A");
        bot.model = Some("--dangerously-skip-permissions".into());
        assert!(validate(&bot).is_err());
        bot.model = Some(" -m".into());
        assert!(validate(&bot).is_err());
        bot.model = Some("gpt-5".into());
        assert!(validate(&bot).is_ok());
    }

    #[test]
    fn unsupported_plan_mode_and_missing_ollama_model_fail_before_execution() {
        let mut bot = crate::test_support::bot("A");
        bot.cli_driver = CliDriverKind::Pi;
        bot.permission_mode = "plan".into();
        assert!(validate(&bot).is_err());
        bot.cli_driver = CliDriverKind::Codex;
        assert!(validate(&bot).is_ok());
        bot.cli_driver = CliDriverKind::Ollama;
        bot.permission_mode = "auto".into();
        assert!(validate(&bot).is_err());
        bot.model = Some("installed-model".into());
        assert!(validate(&bot).is_ok());
    }
}
