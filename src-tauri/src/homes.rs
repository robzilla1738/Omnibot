//! Bot homes and project memory are independent of CLI sessions and working repositories.
use crate::state::PersistedStore;
use std::{
    fs,
    path::{Path, PathBuf},
};

fn private_dir(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Runs on every save, so skip the writes when the folder is already private.
        if fs::metadata(path).is_ok_and(|m| m.is_dir() && m.permissions().mode() & 0o777 == 0o700) {
            return Ok(());
        }
        fs::create_dir_all(path)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    fs::create_dir_all(path)?;
    Ok(())
}

fn folder(root: &Path, kind: &str, id: &str) -> PathBuf {
    // IDs are user-editable through the API; encode rather than treating them as paths.
    let key: String = id.bytes().map(|b| format!("{b:02x}")).collect();
    root.join(kind).join(key)
}
pub fn bot_home(root: &Path, id: &str) -> Result<String, String> {
    let path = folder(root, "bots", id).join("home");
    private_dir(&path).map_err(|e| format!("Couldn't open this bot's home: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}
fn export_memory(
    root: &Path,
    kind: &str,
    id: &str,
    name: &str,
    memories: &[String],
) -> std::io::Result<()> {
    let path = folder(root, kind, id);
    private_dir(&path)?;
    let contents = format!("# {name}\n\nThese notes are managed in Omnibot → Memory. Edit or forget them there.\n\n{}\n", memories.iter().map(|m| format!("- {m}")).collect::<Vec<_>>().join("\n"));
    let target = path.join("memory.md");
    if fs::read_to_string(&target).ok().as_deref() != Some(&contents) {
        let temp = path.join(format!("memory-{}.tmp", uuid::Uuid::new_v4()));
        use std::io::Write;
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        fs::rename(temp, target)?;
    }
    Ok(())
}
/// Readable local copies; the transactional app store remains the source of truth.
pub fn sync_memory_folders(root: &Path, store: &PersistedStore) -> std::io::Result<()> {
    for bot in &store.bots {
        export_memory(root, "bots", &bot.id, &bot.name, &bot.memories)?;
        private_dir(&folder(root, "bots", &bot.id).join("home"))?;
    }
    for project in &store.workspaces {
        export_memory(
            root,
            "projects",
            &project.id,
            &project.name,
            &project.memories,
        )?;
    }
    Ok(())
}

/// Deleted projects must not leave their exported notes behind. Bot folders are kept on
/// archive because archived bots can be restored.
pub fn remove_project_memory(root: &Path, id: &str) -> std::io::Result<()> {
    match fs::remove_dir_all(folder(root, "projects", id)) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

fn mark_bot_homes(store: &mut PersistedStore) {
    for chat in &mut store.chats {
        if chat.is_primary
            || (chat.id.starts_with("chat-direct-")
                && !chat.is_group
                && chat.workspace_path.is_none())
        {
            chat.is_bot_home = true;
        }
    }
}

pub fn migrate(store: &mut PersistedStore) {
    for bot in &mut store.bots {
        if bot.system_prompt == "Help the user think, plan, remember preferences, and coordinate their team. Start project work in a project-linked chat. Delegate only to available teammates using complete explicit handoff blocks." { bot.system_prompt = "Help the user with any task supported by the available tools: thinking, research, writing, coding, files, and coordinating their team. Remember saved preferences. Projects provide optional workspace context. Follow the user’s explicit requests within configured permissions. Delegate only to available teammates using complete explicit handoff blocks.".into(); }
    }
    if store.home_layout_version >= 3 {
        return;
    }
    if store.home_layout_version == 2 {
        mark_bot_homes(store);
        store.home_layout_version = 3;
        return;
    }
    // Older discovery created empty project threads for every installed CLI.
    // Retain real work and routine targets; empty seeded threads become homes.
    for chat in &mut store.chats {
        if chat.id.starts_with("chat-direct-")
            && !chat.is_primary
            && !chat.is_group
            && chat.messages.is_empty()
            && !store
                .routines
                .iter()
                .any(|r| r.chat_id.as_deref() == Some(&chat.id))
        {
            chat.workspace_path = None;
            chat.workspace_id = None;
            chat.native_sessions.clear();
            chat.last_synced_msg_index.clear();
            chat.use_worktrees = false;
        }
    }
    if store.home_layout_version == 1 {
        mark_bot_homes(store);
        store.home_layout_version = 3;
        return;
    }
    let mut archived = Vec::new();
    for chat in &mut store.chats {
        if !chat.is_primary {
            continue;
        }
        if chat.workspace_path.is_some()
            && (!chat.messages.is_empty()
                || store
                    .routines
                    .iter()
                    .any(|r| r.chat_id.as_deref() == Some(&chat.id)))
        {
            let mut work = chat.clone();
            work.id = format!("chat_{}", uuid::Uuid::new_v4());
            work.is_primary = false;
            work.is_bot_home = false;
            work.is_group = work.participant_bot_ids.len() > 1;
            let project = store
                .workspaces
                .iter()
                .find(|p| Some(&p.path) == work.workspace_path.as_ref())
                .map(|p| p.name.as_str())
                .unwrap_or("Previous project");
            work.title = format!("{} · {project}", work.title);
            for routine in &mut store.routines {
                if routine.chat_id.as_deref() == Some(&chat.id) {
                    routine.chat_id = Some(work.id.clone());
                }
            }
            archived.push(work);
            chat.messages.clear();
        }
        chat.workspace_id = None;
        chat.workspace_path = None;
        chat.use_worktrees = false;
        chat.native_sessions.clear();
        chat.last_synced_msg_index.clear();
        if let Some(bot) = store.bots.iter().find(|b| b.is_primary) {
            chat.participant_bot_ids = vec![bot.id.clone()];
        }
        chat.subtitle = "Your personal assistant".into();
    }
    store.chats.extend(archived);
    for bot in store.bots.iter_mut().filter(|b| b.is_primary) {
        if [
            "Lead Swarm Coordinator",
            "Lead Coordinator & Principal Engineer",
            "Lead Coordinator",
        ]
        .contains(&bot.role_title.as_str())
        {
            bot.role_title = "Your personal assistant".into();
        }
        if bot
            .system_prompt
            .starts_with("You are the main coordinator in Omni Bot")
        {
            bot.system_prompt = "Help the user with any task supported by the available tools: thinking, research, writing, coding, files, and coordinating their team. Remember saved preferences. Projects provide optional workspace context. Follow the user’s explicit requests within configured permissions. Delegate only to available teammates using complete explicit handoff blocks.".into();
        }
    }
    if store.preferences.global_instructions == "Work in the selected local workspace. Delegate only to available teammates using complete, explicit handoff blocks." { store.preferences.global_instructions = "Delegate only to available teammates using complete, explicit handoff blocks.".into(); }
    mark_bot_homes(store);
    store.home_layout_version = 3;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{input, Fixture};
    use serde_json::json;

    #[test]
    fn migration_preserves_work_history_and_is_idempotent() {
        let f = Fixture::new(&["A"]);
        let mut guard = f.state.write().unwrap();
        guard.store.bots[0].is_primary = true;
        guard.store.bots[0].role_title = "Lead Swarm Coordinator".into();
        guard.store.chats[0].is_primary = true;
        guard.store.chats[0].messages.push(serde_json::from_value(json!({"id":"history", "role":"user", "text":"Existing work", "thinking":"", "toolCalls":[], "handoffs":[], "mentionedBotIds":[], "status":"complete", "createdAtMs":0})).unwrap());
        migrate(&mut guard.store);
        let home = guard.store.chats.iter().find(|c| c.is_primary).unwrap();
        assert!(home.workspace_path.is_none());
        assert!(home.messages.is_empty());
        let work = guard.store.chats.iter().find(|c| !c.is_primary).unwrap();
        assert_eq!(work.messages[0].text, "Existing work");
        assert!(work.workspace_path.is_some());
        migrate(&mut guard.store);
        assert_eq!(guard.store.chats.len(), 2);
        assert_eq!(guard.store.bots[0].role_title, "Your personal assistant");
    }

    #[tokio::test]
    async fn home_and_project_contexts_are_separate() {
        let f = Fixture::new(&["A", "B"]);
        let capture = f.dir.join("context.txt");
        let cwd = f.dir.join("cwd.txt");
        f.script(
            "A",
            &format!(
                "printf '%s' \"$1\" > '{}'\npwd > '{}'\necho DONE",
                capture.display(),
                cwd.display()
            ),
        );
        {
            let mut guard = f.state.write().unwrap();
            guard.store.bots[0].memories = vec!["PERSONAL_A".into()];
            guard.store.bots[1].memories = vec!["PERSONAL_B_PRIVATE".into()];
            guard.store.preferences.shared_memories = vec!["SHARED_PREFERENCE".into()];
            guard.store.workspaces.push(serde_json::from_value(json!({"id":"p", "name":"Project", "path":f.dir, "description":"", "instructions":"PROJECT_INSTRUCTION", "memories":["PROJECT_MEMORY"]})).unwrap());
            guard.store.chats[0].workspace_path = None;
            guard.store.chats[0].workspace_id = None;
        }
        crate::orchestrator::dispatch_chat_turn(f.state.clone(), input("Hello"))
            .await
            .unwrap();
        f.wait().await;
        let context = fs::read_to_string(&capture).unwrap();
        assert!(context.contains("PERSONAL_A"));
        assert!(context.contains("SHARED_PREFERENCE"));
        assert!(!context.contains("PERSONAL_B_PRIVATE"));
        assert!(!context.contains("PROJECT_MEMORY"));
        assert!(!context.contains("PROJECT_INSTRUCTION"));
        assert!(fs::read_to_string(&cwd).unwrap().contains("/bots/41/home"));
        assert!(f.state.read().unwrap().store.chats[0]
            .workspace_path
            .is_none());
        {
            let mut guard = f.state.write().unwrap();
            guard.store.chats[0].workspace_path = Some(f.dir.to_string_lossy().into_owned());
            guard.store.chats[0].messages.clear();
            guard.store.preferences.workspace_root = "/some/other/project".into();
        }
        crate::orchestrator::dispatch_chat_turn(f.state.clone(), input("Work here"))
            .await
            .unwrap();
        f.wait().await;
        let context = fs::read_to_string(&capture).unwrap();
        assert!(context.contains("PROJECT_MEMORY"));
        assert!(context.contains("PROJECT_INSTRUCTION"));
        assert!(!context.contains("PERSONAL_B_PRIVATE"));
        assert_eq!(
            fs::read_to_string(&cwd).unwrap().trim(),
            fs::canonicalize(&f.dir).unwrap().to_str().unwrap()
        );
    }

    #[test]
    fn memory_folders_are_scoped_and_forgetting_updates_exports() {
        let f = Fixture::new(&["../A", "B"]);
        let mut guard = f.state.write().unwrap();
        guard.store.bots[0].memories = vec!["PRIVATE_NOTE".into()];
        guard.persist().unwrap();
        let memory = folder(&guard.data_dir, "bots", "../A").join("memory.md");
        assert!(memory.starts_with(guard.data_dir.join("bots")));
        assert!(fs::read_to_string(&memory)
            .unwrap()
            .contains("PRIVATE_NOTE"));
        assert!(
            !fs::read_to_string(folder(&guard.data_dir, "bots", "B").join("memory.md"))
                .unwrap()
                .contains("PRIVATE_NOTE")
        );
        guard.store.bots[0].memories.clear();
        guard.persist().unwrap();
        assert!(!fs::read_to_string(memory).unwrap().contains("PRIVATE_NOTE"));
    }

    #[test]
    fn deleting_a_project_removes_its_notes_but_archiving_a_bot_keeps_its_folder() {
        let f = Fixture::new(&["A", "B"]);
        let root = {
            let mut guard = f.state.write().unwrap();
            guard.store.workspaces.push(serde_json::from_value(json!({"id":"p", "name":"Project", "path":f.dir, "description":"", "instructions":"", "memories":["PROJECT_NOTE"]})).unwrap());
            guard.persist().unwrap();
            guard.data_dir.clone()
        };
        let project = folder(&root, "projects", "p");
        assert!(project.join("memory.md").exists());
        crate::server::delete_workspace_entry(&f.state, "p").unwrap();
        assert!(!project.exists());
        crate::server::delete_bot_profile(&f.state, "B").unwrap();
        assert!(folder(&root, "bots", "B").join("memory.md").exists());
    }
}
