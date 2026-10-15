use crate::scanner::CliDriverKind;
use crate::state::{
    import_cli_bots, OmniSnapshot, OmniStreamEvent, SharedOmniState, WorkspaceEntry,
};
use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupInput {
    pub cli_drivers: Vec<CliDriverKind>,
    pub primary_driver: Option<CliDriverKind>,
    pub primary_name: String,
    #[serde(default)]
    pub primary_profile: Option<SetupProfile>,
    pub workspace_path: String,
    pub approve_all_tools: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupProfile {
    pub shape: String,
    pub color: String,
    pub avatar_image: Option<String>,
    pub role_title: String,
    pub description: String,
}

pub fn complete_setup(state: &SharedOmniState, input: SetupInput) -> Result<OmniSnapshot, String> {
    let mut guard = state.write().map_err(|_| "State lock poisoned")?;
    if !guard.active_workflows.is_empty() {
        return Err("Finish or stop running chats before changing setup.".into());
    }
    if let Some(profile) = &input.primary_profile {
        crate::state::validate_avatar_image(profile.avatar_image.as_deref())?;
        if profile.role_title.chars().count() > 100 || profile.description.chars().count() > 500 {
            return Err("Keep the role under 100 characters and description under 500.".into());
        }
    }
    let name = input.primary_name.trim();
    if name.is_empty() || name.chars().count() > 40 {
        return Err("Choose a name between 1 and 40 characters.".into());
    }
    if guard
        .store
        .bots
        .iter()
        .any(|b| !b.is_primary && b.name.eq_ignore_ascii_case(name))
    {
        return Err("Another bot already has that name.".into());
    }
    let workspace = if input.workspace_path.trim().is_empty() {
        None
    } else {
        let path = std::fs::canonicalize(input.workspace_path.trim())
            .map_err(|_| "Choose an existing project folder using its full path.")?;
        if !path.is_dir() {
            return Err("The workspace must be a folder.".into());
        }
        Some(path)
    };
    for driver in input.cli_drivers.iter().chain(input.primary_driver.iter()) {
        if !guard
            .harnesses
            .iter()
            .any(|h| h.kind == *driver && h.installed)
        {
            return Err(format!(
                "{} is no longer detected. Scan again before continuing.",
                driver.display_name()
            ));
        }
    }
    let mut store = guard.store.clone();
    crate::state::remove_legacy_welcome(&mut store);
    let selected: Vec<_> = guard
        .harnesses
        .iter()
        .filter(|h| input.cli_drivers.contains(&h.kind))
        .cloned()
        .collect();
    if let Some(workspace) = workspace {
        let path = workspace.to_string_lossy().into_owned();
        if let Some(project) = store.workspaces.iter_mut().find(|w| w.path == path) {
            project.approve_all_tools = input.approve_all_tools;
        } else {
            store.workspaces.push(WorkspaceEntry {
                id: format!("ws_{}", uuid::Uuid::new_v4()),
                name: workspace
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                path: path.clone(),
                description: String::new(),
                instructions: String::new(),
                memories: Vec::new(),
                approve_all_tools: input.approve_all_tools,
                assigned_bot_ids: Vec::new(),
                lead_bot_id: None,
                use_worktrees_default: false,
            });
        }
        store.preferences.workspace_root = path;
    }
    store.preferences.approve_all_tools = input.approve_all_tools;
    store.preferences.onboarding_completed = true;
    let primary = store
        .bots
        .iter_mut()
        .find(|b| b.is_primary)
        .ok_or("Main bot not found")?;
    primary.name = name.into();
    if let Some(profile) = input.primary_profile {
        primary.shape = profile.shape;
        primary.color = profile.color;
        primary.avatar_image = profile.avatar_image;
        primary.role_title = profile.role_title.trim().into();
        primary.description = profile.description.trim().into();
    }
    if let Some(driver) = input.primary_driver {
        if primary.cli_driver != driver {
            primary.model = None;
            primary.custom_command = None;
        }
        primary.cli_driver = driver;
    }
    primary.permission_mode = "auto".into();
    let primary_id = primary.id.clone();
    for chat in &mut store.chats {
        chat.native_sessions.remove(&primary_id);
        chat.last_synced_msg_index.remove(&primary_id);
        if chat.is_primary {
            chat.title = name.into();
            chat.workspace_path = None;
            chat.workspace_id = None;
            chat.use_worktrees = false;
        }
    }
    let mut primary = store
        .bots
        .iter()
        .find(|b| b.is_primary)
        .cloned()
        .ok_or("Main bot not found")?;
    crate::lifecycle::validate_profile(&store, &mut primary)?;
    if let Some(saved) = store.bots.iter_mut().find(|b| b.is_primary) {
        *saved = primary;
    }
    import_cli_bots(&mut store, &selected);
    // Selecting a CLI explicitly adds its individual bot to the sidebar.
    // Preserve unrelated pins and keep repeated setup idempotent.
    for harness in &selected {
        let id = format!("bot-{}", harness.kind.as_str());
        if store.bots.iter().any(|bot| bot.id == id && !bot.is_primary)
            && !store.preferences.pinned_bot_ids.contains(&id)
        {
            store.preferences.pinned_bot_ids.push(id);
        }
    }
    let previous = std::mem::replace(&mut guard.store, store);
    if let Err(error) = guard.persist() {
        guard.store = previous;
        return Err(error);
    }
    guard.emit(OmniStreamEvent::StateUpdated { chat_id: None });
    Ok(guard.snapshot())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinBotInput {
    pub bot_id: String,
    pub pinned: bool,
}

pub fn pin_bot(state: &SharedOmniState, input: PinBotInput) -> Result<OmniSnapshot, String> {
    let mut guard = state.write().map_err(|_| "State lock poisoned")?;
    let bot = guard
        .store
        .bots
        .iter()
        .find(|b| b.id == input.bot_id)
        .ok_or("Bot not found")?;
    if bot.archived {
        return Err("Restore this bot before pinning it.".into());
    }
    if bot.is_primary {
        return Err("The main bot is always visible.".into());
    }
    let previous = guard.store.preferences.pinned_bot_ids.clone();
    guard
        .store
        .preferences
        .pinned_bot_ids
        .retain(|id| id != &input.bot_id);
    if input.pinned {
        guard.store.preferences.pinned_bot_ids.push(input.bot_id);
    }
    if let Err(error) = guard.persist() {
        guard.store.preferences.pinned_bot_ids = previous;
        return Err(error);
    }
    guard.emit(OmniStreamEvent::StateUpdated { chat_id: None });
    Ok(guard.snapshot())
}

pub async fn http_complete_setup(
    State(state): State<SharedOmniState>,
    Json(input): Json<SetupInput>,
) -> axum::response::Response {
    match complete_setup(&state, input) {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, error).into_response(),
    }
}
pub async fn http_pin_bot(
    State(state): State<SharedOmniState>,
    Json(input): Json<PinBotInput>,
) -> axum::response::Response {
    match pin_bot(&state, input) {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, error).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::Fixture;
    use serde_json::json;

    fn fixture() -> Fixture {
        let f = Fixture::new(&["main"]);
        {
            let mut guard = f.state.write().unwrap();
            guard.store.bots[0].is_primary = true;
            guard.store.chats[0].is_primary = true;
            guard.harnesses.push(
                serde_json::from_value(json!({
                    "id":"codex", "kind":"codex", "name":"Codex", "binaryName":"codex",
                    "installed":true, "description":"Fixture", "installHint":"", "authHint":"",
                    "models":[], "supportsJsonStream":true, "supportsSessionResume":true
                }))
                .unwrap(),
            );
        }
        f
    }
    fn input(f: &Fixture) -> SetupInput {
        SetupInput {
            cli_drivers: vec![CliDriverKind::Codex],
            primary_driver: Some(CliDriverKind::Codex),
            primary_name: "Omni".into(),
            primary_profile: None,
            workspace_path: f.dir.to_string_lossy().into_owned(),
            approve_all_tools: false,
        }
    }
    #[test]
    fn setup_pins_selected_individual_bots_without_seeding_group_chats() {
        let f = fixture();
        let result = complete_setup(&f.state, input(&f)).unwrap();
        assert!(result.preferences.onboarding_completed);
        assert!(!result.preferences.approve_all_tools);
        assert_eq!(result.preferences.pinned_bot_ids, vec!["bot-codex"]);
        assert_eq!(result.bots.len(), 2);
        assert_eq!(result.chats.len(), 2);
        assert!(result
            .chats
            .iter()
            .all(|c| !c.is_group && c.messages.is_empty()));
        let direct = result.chats.iter().find(|c| !c.is_primary).unwrap();
        assert_eq!(direct.workspace_id, result.chats[0].workspace_id);
        let repeated = complete_setup(&f.state, input(&f)).unwrap();
        assert_eq!(repeated.bots.len(), 2);
        assert_eq!(repeated.chats.len(), 2);
        assert_eq!(repeated.preferences.pinned_bot_ids, vec!["bot-codex"]);
        let saved: serde_json::Value = serde_json::from_slice(
            &std::fs::read(f.state.read().unwrap().data_dir.join("store.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(saved["preferences"]["onboardingCompleted"], true);
    }
    #[test]
    fn discovered_bots_inherit_cli_models_without_overwriting_saved_choices() {
        let f = fixture();
        let mut g = f.state.write().unwrap();
        let mut harnesses = g.harnesses.clone();
        for h in &mut harnesses {
            h.models = vec!["catalog-model".into()];
        }
        import_cli_bots(&mut g.store, &harnesses);
        let bot = g
            .store
            .bots
            .iter_mut()
            .find(|b| b.id == "bot-codex")
            .unwrap();
        assert!(bot.model.is_none());
        bot.model = Some("chosen-model".into());
        import_cli_bots(&mut g.store, &harnesses);
        assert_eq!(
            g.store
                .bots
                .iter()
                .find(|b| b.id == "bot-codex")
                .unwrap()
                .model
                .as_deref(),
            Some("chosen-model")
        );
    }

    #[test]
    fn setup_with_no_selected_tools_preserves_a_single_main_bot() {
        let f = fixture();
        let mut request = input(&f);
        request.cli_drivers.clear();
        let result = complete_setup(&f.state, request).unwrap();
        assert_eq!(result.bots.len(), 1);
        assert_eq!(result.chats.len(), 1);
    }
    #[test]
    fn invalid_setup_does_not_partially_mutate_state() {
        let f = fixture();
        let mut request = input(&f);
        request.cli_drivers.push(CliDriverKind::Claude);
        assert!(complete_setup(&f.state, request).is_err());
        let mut request = input(&f);
        request.workspace_path = f.dir.join("missing").to_string_lossy().into_owned();
        assert!(complete_setup(&f.state, request).is_err());
        let guard = f.state.read().unwrap();
        assert!(!guard.store.preferences.onboarding_completed);
        assert_eq!(guard.store.bots.len(), 1);
        assert_eq!(guard.store.bots[0].name, "main");
    }
    #[test]
    fn imported_names_remain_unique_and_pinning_is_explicit_and_idempotent() {
        let f = fixture();
        let mut request = input(&f);
        request.primary_name = "Codex".into();
        let result = complete_setup(&f.state, request).unwrap();
        assert_eq!(result.bots[1].name, "Codex 2");
        for _ in 0..2 {
            pin_bot(
                &f.state,
                PinBotInput {
                    bot_id: "bot-codex".into(),
                    pinned: true,
                },
            )
            .unwrap();
        }
        assert_eq!(
            f.state.read().unwrap().store.preferences.pinned_bot_ids,
            vec!["bot-codex"]
        );
        assert!(pin_bot(
            &f.state,
            PinBotInput {
                bot_id: "main".into(),
                pinned: true
            }
        )
        .is_err());
        assert!(pin_bot(
            &f.state,
            PinBotInput {
                bot_id: "missing".into(),
                pinned: true
            }
        )
        .is_err());
        let result = pin_bot(
            &f.state,
            PinBotInput {
                bot_id: "bot-codex".into(),
                pinned: false,
            },
        )
        .unwrap();
        assert!(result.preferences.pinned_bot_ids.is_empty());
        assert_eq!(result.bots.len(), 2);
    }
    #[test]
    fn setup_profile_roundtrips_and_upserts_can_replace_or_remove_it() {
        let f = fixture();
        let mut request = input(&f);
        request.primary_name = "Infinity".into();
        request.primary_profile = Some(SetupProfile {
            shape: "heart".into(),
            color: "violet".into(),
            avatar_image: Some("/omnibot-gauntlet.png".into()),
            role_title: "Team lead".into(),
            description: "My team".into(),
        });
        let result = complete_setup(&f.state, request).unwrap();
        let mut bot = result.bots[0].clone();
        assert_eq!(bot.name, "Infinity");
        assert_eq!(bot.avatar_image.as_deref(), Some("/omnibot-gauntlet.png"));
        assert_eq!(bot.shape, "heart");
        assert_eq!(bot.role_title, "Team lead");
        bot.avatar_image = Some("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG1sAAAAASUVORK5CYII=".into());
        crate::server::upsert_bot_profile(&f.state, bot.clone()).unwrap();
        let saved: crate::state::PersistedStore = serde_json::from_slice(
            &std::fs::read(f.state.read().unwrap().data_dir.join("store.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(saved.bots[0].avatar_image, bot.avatar_image);
        bot.avatar_image = None;
        bot.name = "Renamed".into();
        let result = crate::server::upsert_bot_profile(&f.state, bot).unwrap();
        assert!(result.bots[0].avatar_image.is_none());
        assert_eq!(result.chats[0].title, "Renamed");
    }

    #[test]
    fn unsafe_or_oversized_profile_images_never_mutate_profiles() {
        let f = fixture();
        for image in [
            "https://example.com/tracker.png",
            "data:image/svg+xml;base64,PHN2Zz4=",
            "file:///tmp/picture.png",
        ] {
            let mut bot = f.state.read().unwrap().store.bots[0].clone();
            bot.avatar_image = Some(image.into());
            assert!(crate::server::upsert_bot_profile(&f.state, bot).is_err());
        }
        let mut request = input(&f);
        request.primary_profile = Some(SetupProfile {
            shape: "blob".into(),
            color: "cyan".into(),
            avatar_image: Some(format!(
                "data:image/png;base64,iVBORw0KGgo{}",
                "A".repeat(800_000)
            )),
            role_title: "".into(),
            description: "".into(),
        });
        assert!(complete_setup(&f.state, request).is_err());
        let guard = f.state.read().unwrap();
        assert!(!guard.store.preferences.onboarding_completed);
        assert!(guard.store.bots[0].avatar_image.is_none());
    }

    #[test]
    fn setup_rolls_back_if_persistence_fails() {
        let f = fixture();
        let file = f.dir.join("not-a-directory");
        std::fs::write(&file, "fixture").unwrap();
        f.state.write().unwrap().data_dir = file;
        assert!(complete_setup(&f.state, input(&f)).is_err());
        let guard = f.state.read().unwrap();
        assert!(!guard.store.preferences.onboarding_completed);
        assert_eq!(guard.store.bots.len(), 1);
    }
    #[test]
    fn setup_changes_provider_and_removes_only_the_bundled_welcome() {
        let f = fixture();
        {
            let mut guard = f.state.write().unwrap();
            let main = &mut guard.store.bots[0];
            main.cli_driver = CliDriverKind::Claude;
            main.model = Some("old-model".into());
            main.custom_command = Some("old-command".into());
            let welcome: crate::state::ChatMessage = serde_json::from_value(json!({
                "id":"msg-welcome-omni", "role":"assistant", "authorBotId":"main",
                "cliDriver":"claude", "text":"Welcome to **Omni Bot**. I auto-detected 7 local coding CLIs.",
                "thinking":"", "toolCalls":[], "handoffs":[], "mentionedBotIds":[], "status":"complete", "createdAtMs":0
            })).unwrap();
            let mut real_reply = welcome.clone();
            real_reply.id = "actual-reply".into();
            let chat = &mut guard.store.chats[0];
            chat.messages = vec![welcome, real_reply];
            chat.native_sessions
                .insert("main".into(), "old-session".into());
            chat.last_synced_msg_index.insert("main".into(), 2);
        }
        let result = complete_setup(&f.state, input(&f)).unwrap();
        let main = result.bots.iter().find(|b| b.is_primary).unwrap();
        assert_eq!(main.cli_driver, CliDriverKind::Codex);
        assert!(main.model.is_none());
        assert!(main.custom_command.is_none());
        let chat = &result.chats[0];
        assert_eq!(chat.messages.len(), 1);
        assert_eq!(chat.messages[0].id, "actual-reply");
        assert_eq!(chat.messages[0].cli_driver, Some(CliDriverKind::Claude));
        assert!(chat.native_sessions.is_empty());
        assert!(chat.last_synced_msg_index.is_empty());
        let repeated = complete_setup(&f.state, input(&f)).unwrap();
        assert_eq!(repeated.chats[0].messages.len(), 1);
        let saved: crate::state::PersistedStore = serde_json::from_slice(
            &std::fs::read(f.state.read().unwrap().data_dir.join("store.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(saved.bots[0].cli_driver, CliDriverKind::Codex);
        assert_eq!(saved.chats[0].messages[0].id, "actual-reply");
    }
}
