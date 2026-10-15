//! Execution locations and process slots are shared across every room.
use crate::scanner::CliDriverKind;
use crate::state::{BotProfile, SharedOmniState};
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

pub async fn acquire(
    state: SharedOmniState,
    chat_id: &str,
    task_id: &str,
    cwd: &str,
) -> Result<ExecutionLease, String> {
    let canonical = std::fs::canonicalize(cwd).unwrap_or_else(|_| std::path::PathBuf::from(cwd));
    let checkout = canonical
        .ancestors()
        .find(|path| path.join(".git").exists())
        .unwrap_or(&canonical);
    let cwd = checkout.to_string_lossy().into_owned();
    loop {
        {
            let mut guard = state.write().map_err(|_| "State lock poisoned")?;
            if guard.cancelled_chats.contains(chat_id) {
                return Err("Stopped while queued.".into());
            }
            let limit = guard.store.preferences.max_parallel_bots.clamp(1, 6) as usize;
            if guard.execution_slots.len() < limit
                && !guard.execution_slots.values().any(|path| {
                    std::path::Path::new(path).starts_with(&cwd)
                        || std::path::Path::new(&cwd).starts_with(path)
                })
            {
                guard.execution_slots.insert(task_id.into(), cwd.clone());
                return Ok(ExecutionLease {
                    state: state.clone(),
                    task_id: task_id.into(),
                });
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
