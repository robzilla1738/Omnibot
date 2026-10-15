//! Shared identity rules for setup imports, templates, and profile edits.
use crate::state::{BotProfile, PersistedStore};

const RESERVED: &[&str] = &["all", "everyone", "swarm"];

fn occupied(store: &PersistedStore, id: &str, value: &str) -> bool {
    RESERVED.iter().any(|s| s.eq_ignore_ascii_case(value))
        || store.bots.iter().any(|b| {
            b.id != id
                && (b.name.to_lowercase() == value.to_lowercase()
                    || b.slug.to_lowercase() == value.to_lowercase())
        })
}

pub fn unique_name(store: &PersistedStore, base: &str) -> String {
    let mut name = base.to_string();
    let mut suffix = 2;
    while occupied(store, "", &name) {
        name = format!("{base} {suffix}");
        suffix += 1;
    }
    name
}

pub fn validate_profile(store: &PersistedStore, bot: &mut BotProfile) -> Result<(), String> {
    bot.name = bot.name.trim().into();
    if bot.name.is_empty()
        || bot.name.chars().count() > 40
        || bot.name.chars().any(char::is_control)
    {
        return Err("Choose a bot name between 1 and 40 characters.".into());
    }
    if occupied(store, &bot.id, &bot.name) {
        return Err(
            "Bot names and handles must be unique; all, everyone, and swarm are reserved.".into(),
        );
    }
    if bot.id.is_empty() {
        bot.id = format!("bot_custom_{}", uuid::Uuid::new_v4());
    }
    let source = if bot.slug.trim().is_empty() {
        &bot.name
    } else {
        &bot.slug
    };
    let base = source
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>();
    let base = base.trim_matches('-');
    let base = if base.is_empty() { "bot" } else { base };
    let mut slug = base.to_string();
    let mut suffix = 2;
    while occupied(store, &bot.id, &slug) {
        slug = format!("{base}-{suffix}");
        suffix += 1;
    }
    bot.slug = slug;
    if bot
        .model
        .as_ref()
        .is_some_and(|m| m.len() > 256 || m.chars().any(char::is_control))
    {
        return Err("Use a valid CLI model ID.".into());
    }
    if !matches!(
        bot.permission_mode.as_str(),
        "auto" | "plan" | "bypassPermissions" | "acceptEdits"
    ) {
        return Err("Choose a supported permission mode.".into());
    }
    Ok(())
}

pub fn migrate(store: &mut PersistedStore) {
    if store.home_layout_version < 4 {
        for chat in &mut store.chats {
            if chat.is_bot_home || chat.is_primary {
                if chat.workspace_path.is_some() && !chat.is_primary {
                    chat.is_bot_home = false;
                } else {
                    chat.owner_bot_id = chat.participant_bot_ids.first().cloned();
                    chat.is_bot_home = true;
                }
            }
            chat.is_group = chat.participant_bot_ids.len() > 1 && !chat.is_bot_home;
        }
        let mut owners = std::collections::HashSet::new();
        for chat in &mut store.chats {
            if let Some(owner) = &chat.owner_bot_id {
                if !owners.insert(owner.clone()) {
                    chat.owner_bot_id = None;
                    chat.is_bot_home = false;
                    chat.is_group = chat.participant_bot_ids.len() > 1;
                    chat.title = format!("{} · Previous conversation", chat.title);
                }
            }
        }
        // Keep names/history intact; repair legacy handle collisions deterministically.
        let mut handles = Vec::<String>::new();
        for index in 0..store.bots.len() {
            let bot = &store.bots[index];
            let base = if bot.slug.is_empty() {
                "bot"
            } else {
                &bot.slug
            };
            let mut slug = base.to_string();
            let mut suffix = 2;
            while RESERVED.contains(&slug.to_lowercase().as_str())
                || handles
                    .iter()
                    .any(|h| h.to_lowercase() == slug.to_lowercase())
                || store
                    .bots
                    .iter()
                    .any(|b| b.id != bot.id && b.name.to_lowercase() == slug.to_lowercase())
            {
                slug = format!("{base}-{suffix}");
                suffix += 1;
            }
            handles.push(slug.clone());
            store.bots[index].slug = slug;
        }
        store.home_layout_version = 4;
    }
    for chat in &mut store.chats {
        for task in &mut chat.tasks {
            if matches!(task.status.as_str(), "queued" | "running") {
                task.status = "interrupted".into();
                task.reason = Some(
                    "The app closed before this task finished. Send a new request to retry.".into(),
                );
            }
        }
    }
    for routine in &mut store.routines {
        if matches!(routine.run_status.as_deref(), Some("queued" | "running")) {
            routine.run_status = Some("interrupted".into());
            routine.last_error = Some("The app closed before this run finished.".into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        server,
        test_support::{input, Fixture},
    };
    use serde_json::json;

    #[tokio::test]
    async fn archive_preserves_history_and_restore_reuses_home() {
        let f = Fixture::new(&["A"]);
        f.script("A", "echo retained-history");
        crate::orchestrator::dispatch_chat_turn(f.state.clone(), input("hello"))
            .await
            .unwrap();
        f.wait().await;
        server::delete_bot_profile(&f.state, "A").unwrap();
        let mut bot = f.state.read().unwrap().store.bots[0].clone();
        assert!(bot.archived);
        assert_eq!(f.state.read().unwrap().store.chats[0].messages.len(), 2);
        assert!(
            crate::orchestrator::dispatch_chat_turn(f.state.clone(), input("again"))
                .await
                .is_err()
        );
        bot.archived = false;
        server::upsert_bot_profile(&f.state, bot).unwrap();
        assert_eq!(f.state.read().unwrap().store.chats.len(), 1);
        let disk: PersistedStore = serde_json::from_slice(
            &std::fs::read(f.state.read().unwrap().data_dir.join("store.json")).unwrap(),
        )
        .unwrap();
        assert!(!disk.bots[0].archived);
        assert_eq!(disk.chats[0].messages.len(), 2);
    }

    #[tokio::test]
    async fn failed_destructive_saves_restore_the_entire_store() {
        let f = Fixture::new(&["A"]);
        f.script("A", "echo history");
        crate::orchestrator::dispatch_chat_turn(f.state.clone(), input("hello"))
            .await
            .unwrap();
        f.wait().await;
        let previous = serde_json::to_value(&f.state.read().unwrap().store).unwrap();
        let blocker = f.dir.join("not-a-directory");
        std::fs::write(&blocker, "block").unwrap();
        f.state.write().unwrap().data_dir = blocker;
        for result in [
            server::clear_chat_thread(&f.state, "room"),
            server::delete_chat_thread(&f.state, "room"),
            server::delete_bot_profile(&f.state, "A"),
            server::delete_routine_entry(&f.state, "missing"),
        ] {
            assert!(result.is_err());
            assert_eq!(
                serde_json::to_value(&f.state.read().unwrap().store).unwrap(),
                previous
            );
        }
    }

    #[test]
    fn home_migration_preserves_owner_with_helpers_and_is_idempotent() {
        let f = Fixture::new(&["A", "B"]);
        let mut guard = f.state.write().unwrap();
        guard.store.home_layout_version = 3;
        guard.store.chats[0].is_bot_home = true;
        guard.store.chats[0].workspace_path = None;
        migrate(&mut guard.store);
        assert_eq!(guard.store.chats[0].owner_bot_id.as_deref(), Some("A"));
        assert!(!guard.store.chats[0].is_group);
        let before = serde_json::to_value(&guard.store).unwrap();
        migrate(&mut guard.store);
        assert_eq!(before, serde_json::to_value(&guard.store).unwrap());
    }

    #[test]
    fn name_handle_and_reserved_collisions_are_unambiguous() {
        let f = Fixture::new(&["A"]);
        let mut bot = crate::test_support::bot("all");
        assert!(validate_profile(&f.state.read().unwrap().store, &mut bot).is_err());
        bot.name = "Research".into();
        bot.slug = "a".into();
        validate_profile(&f.state.read().unwrap().store, &mut bot).unwrap();
        assert_eq!(bot.slug, "a-2");
        f.state.write().unwrap().store.bots.push(bot);
        let mut collision = crate::test_support::bot("a-2");
        assert!(validate_profile(&f.state.read().unwrap().store, &mut collision).is_err());
    }

    #[test]
    fn chat_models_are_atomic_and_never_change_profile_defaults() {
        let f = Fixture::new(&["A"]);
        let request = |path: &str| {
            serde_json::from_value(json!({ "participantBotIds": ["A"], "workspacePath": path, "modelOverrides": { "A": "chat-model" } })).unwrap()
        };
        assert!(
            server::create_chat_thread(&f.state, request("/missing-project-for-omni-test"))
                .is_err()
        );
        assert!(f.state.read().unwrap().store.bots[0].model.is_none());
        let (chat, _) =
            server::create_chat_thread(&f.state, request(f.dir.to_str().unwrap())).unwrap();
        assert_eq!(chat.model_overrides["A"].as_deref(), Some("chat-model"));
        assert!(f.state.read().unwrap().store.bots[0].model.is_none());
    }

    #[test]
    fn delegated_home_reopens_and_cannot_be_attached_to_a_project() {
        let f = Fixture::new(&["A", "B"]);
        {
            let mut g = f.state.write().unwrap();
            let c = &mut g.store.chats[0];
            c.is_bot_home = true;
            c.owner_bot_id = Some("A".into());
            c.workspace_path = None;
            c.is_group = false;
        }
        let request =
            serde_json::from_value(json!({"botHome": true, "participantBotIds": ["A"]})).unwrap();
        let (chat, _) = server::create_chat_thread(&f.state, request).unwrap();
        assert_eq!(chat.id, "room");
        let update =
            serde_json::from_value(json!({"chatId": "room", "workspacePath": f.dir})).unwrap();
        assert!(server::update_chat_thread(&f.state, update).is_err());
    }

    #[test]
    fn deleting_chat_disables_routine_without_destroying_it() {
        let f = Fixture::new(&["A"]);
        f.state.write().unwrap().store.routines.push(serde_json::from_value(json!({"id":"r", "name":"Daily", "prompt":"Review", "botId":"A", "chatId":"room", "enabled":true})).unwrap());
        server::delete_chat_thread(&f.state, "room").unwrap();
        let g = f.state.read().unwrap();
        assert_eq!(g.store.routines.len(), 1);
        assert!(!g.store.routines[0].enabled);
        assert!(g.store.routines[0].chat_id.is_none());
    }
}
