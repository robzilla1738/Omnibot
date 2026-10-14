use crate::computer::{
    get_system_overview, list_workspace_directory, open_on_desktop, read_workspace_file,
    search_workspace_files,
};
use crate::git_ops::{git_discard_file, git_stage_and_commit, read_file_diff};
use crate::orchestrator::{dispatch_chat_turn, SendMessageInput};
use crate::scanner::{test_cli_harness, CliDriverKind};
use crate::state::{
    now_ms, BotProfile, ChatThread, OmniPreferences, OmniRuntimeState, OmniSnapshot,
    OmniStreamEvent, RoutineEntry, SharedOmniState, WorkspaceEntry,
};
use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse,
    },
    routing::{get, post},
    Json, Router,
};
use futures_util::stream::Stream;
use serde::Deserialize;
use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::{Arc, RwLock};
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;
use tower_http::cors::CorsLayer;

pub async fn spawn_local_server() -> Result<
    (
        u16,
        SharedOmniState,
        broadcast::Sender<OmniStreamEvent>,
    ),
    String,
> {
    let mut listener = None;
    let mut bound_port = 4321u16;
    for candidate in 4321..=4335 {
        let addr = SocketAddr::from(([127, 0, 0, 1], candidate));
        if let Ok(l) = TcpListener::bind(addr).await {
            bound_port = candidate;
            listener = Some(l);
            break;
        }
    }
    let listener = match listener {
        Some(l) => l,
        None => {
            let l = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
                .await
                .map_err(|e| format!("Failed to bind local server: {e}"))?;
            bound_port = l.local_addr().map(|a| a.port()).unwrap_or(4321);
            l
        }
    };

    let (event_tx, _) = broadcast::channel::<OmniStreamEvent>(512);
    let runtime_state = OmniRuntimeState::load(bound_port, event_tx.clone());
    let shared: SharedOmniState = Arc::new(RwLock::new(runtime_state));

    let app = Router::new()
        .route("/api/snapshot", get(http_snapshot))
        .route("/api/rescan", post(http_rescan))
        .route("/api/events", get(http_sse_events))
        .route("/api/chat/send", post(http_send_message))
        .route("/api/chat/stop", post(http_stop_chat))
        .route("/api/chat/create", post(http_create_chat))
        .route("/api/chat/update", post(http_update_chat))
        .route("/api/chat/clear", post(http_clear_chat))
        .route("/api/chat/delete", post(http_delete_chat))
        .route("/api/bot/upsert", post(http_upsert_bot))
        .route("/api/bot/delete", post(http_delete_bot))
        .route("/api/preferences", post(http_update_preferences))
        .route("/api/workspace/upsert", post(http_upsert_workspace))
        .route("/api/workspace/delete", post(http_delete_workspace))
        .route("/api/routine/upsert", post(http_upsert_routine))
        .route("/api/routine/delete", post(http_delete_routine))
        .route("/api/computer/overview", get(http_computer_overview))
        .route("/api/computer/files", get(http_list_files))
        .route("/api/computer/read", get(http_read_file))
        .route("/api/computer/search", get(http_search_files))
        .route("/api/computer/open", post(http_open_item))
        .route("/api/git/diff", get(http_git_diff))
        .route("/api/git/commit", post(http_git_commit))
        .route("/api/git/discard", post(http_git_discard))
        .route("/api/harness/test", post(http_test_harness))
        .layer(CorsLayer::permissive())
        .with_state(shared.clone());

    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    Ok((bound_port, shared, event_tx))
}

async fn http_snapshot(State(state): State<SharedOmniState>) -> impl IntoResponse {
    match state.read() {
        Ok(guard) => Json(guard.snapshot()).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "State lock poisoned").into_response(),
    }
}

async fn http_rescan(State(state): State<SharedOmniState>) -> impl IntoResponse {
    match state.write() {
        Ok(mut guard) => {
            guard.rescan_environment();
            Json(guard.snapshot()).into_response()
        }
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "State lock poisoned").into_response(),
    }
}

async fn http_sse_events(
    State(state): State<SharedOmniState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = state
        .read()
        .map(|g| g.event_tx.subscribe())
        .expect("State lock valid");
    let stream = BroadcastStream::new(rx).filter_map(|msg| match msg {
        Ok(ev) => {
            let json = serde_json::to_string(&ev).unwrap_or_default();
            Some(Ok(Event::default().data(json)))
        }
        Err(_) => None,
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

async fn http_send_message(
    State(state): State<SharedOmniState>,
    Json(input): Json<SendMessageInput>,
) -> impl IntoResponse {
    match dispatch_chat_turn(state, input).await {
        Ok(msg_id) => Json(serde_json::json!({ "ok": true, "messageId": msg_id })).into_response(),
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": err })),
        )
            .into_response(),
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopChatInput {
    pub chat_id: String,
}

pub fn stop_chat_runs(state: &SharedOmniState, chat_id: &str) -> Result<OmniSnapshot, String> {
    let mut guard = state
        .write()
        .map_err(|_| "State lock poisoned".to_string())?;
    guard.cancelled_chats.insert(chat_id.to_string());
    let to_remove: Vec<String> = guard
        .active_runs
        .iter()
        .filter(|(_, r)| r.chat_id == chat_id)
        .map(|(k, _)| k.clone())
        .collect();
    for k in to_remove {
        guard.active_runs.remove(&k);
    }
    if let Some(chat) = guard.store.chats.iter_mut().find(|c| c.id == chat_id) {
        for m in &mut chat.messages {
            if m.status == "streaming" {
                m.status = "stopped".to_string();
            }
        }
    }
    let _ = guard.persist();
    guard.emit(OmniStreamEvent::StateUpdated {
        chat_id: Some(chat_id.to_string()),
    });
    Ok(guard.snapshot())
}

async fn http_stop_chat(
    State(state): State<SharedOmniState>,
    Json(input): Json<StopChatInput>,
) -> impl IntoResponse {
    match stop_chat_runs(&state, &input.chat_id) {
        Ok(snap) => Json(snap).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateChatInput {
    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub participant_bot_ids: Vec<String>,
    pub workspace_id: Option<String>,
    pub workspace_path: Option<String>,
    pub use_worktrees: Option<bool>,
}

pub fn create_chat_thread(
    state: &SharedOmniState,
    input: CreateChatInput,
) -> Result<(ChatThread, OmniSnapshot), String> {
    let mut guard = state
        .write()
        .map_err(|_| "State lock poisoned".to_string())?;
    let participants = if input.participant_bot_ids.is_empty() {
        vec!["bot-omni".to_string()]
    } else {
        input.participant_bot_ids
    };
    let is_group = participants.len() > 1;
    let bot_names: Vec<String> = guard
        .store
        .bots
        .iter()
        .filter(|b| participants.contains(&b.id))
        .map(|b| b.name.clone())
        .collect();

    let default_title = if is_group {
        format!("Swarm · {}", bot_names.join(" + "))
    } else {
        bot_names
            .first()
            .cloned()
            .unwrap_or_else(|| "New sidechat".to_string())
    };

    let chat = ChatThread {
        id: format!("chat_{}", now_ms()),
        title: input
            .title
            .filter(|t| !t.trim().is_empty())
            .unwrap_or(default_title),
        subtitle: input.subtitle.unwrap_or_else(|| {
            if is_group {
                format!("Swarm Room · {}", bot_names.join(", "))
            } else {
                "Focused Thread".to_string()
            }
        }),
        is_primary: false,
        is_group,
        participant_bot_ids: participants,
        workspace_id: input.workspace_id,
        workspace_path: Some(
            input
                .workspace_path
                .unwrap_or_else(|| guard.store.preferences.workspace_root.clone()),
        ),
        use_worktrees: input.use_worktrees.unwrap_or(false),
        max_swarm_turns: guard.store.preferences.default_max_swarm_turns,
        messages: Vec::new(),
        native_sessions: HashMap::new(),
        last_synced_msg_index: HashMap::new(),
        updated_at_ms: now_ms(),
    };

    guard.store.chats.insert(1, chat.clone());
    let _ = guard.persist();
    guard.emit(OmniStreamEvent::StateUpdated {
        chat_id: Some(chat.id.clone()),
    });
    Ok((chat, guard.snapshot()))
}

async fn http_create_chat(
    State(state): State<SharedOmniState>,
    Json(input): Json<CreateChatInput>,
) -> impl IntoResponse {
    match create_chat_thread(&state, input) {
        Ok((chat, snapshot)) => {
            Json(serde_json::json!({ "chat": chat, "snapshot": snapshot })).into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateChatInput {
    pub chat_id: String,
    pub title: Option<String>,
    pub participant_bot_ids: Option<Vec<String>>,
    pub workspace_path: Option<String>,
    pub use_worktrees: Option<bool>,
    pub max_swarm_turns: Option<u32>,
}

pub fn update_chat_thread(
    state: &SharedOmniState,
    input: UpdateChatInput,
) -> Result<OmniSnapshot, String> {
    let mut guard = state
        .write()
        .map_err(|_| "State lock poisoned".to_string())?;
    let Some(chat) = guard
        .store
        .chats
        .iter_mut()
        .find(|c| c.id == input.chat_id)
    else {
        return Err("Chat not found".to_string());
    };
    if let Some(t) = input.title.filter(|s| !s.trim().is_empty()) {
        chat.title = t.trim().to_string();
    }
    if let Some(pids) = input.participant_bot_ids {
        if !pids.is_empty() {
            chat.is_group = pids.len() > 1 && !chat.is_primary;
            chat.participant_bot_ids = pids;
        }
    }
    if let Some(wp) = input.workspace_path {
        chat.workspace_path = Some(wp);
    }
    if let Some(wt) = input.use_worktrees {
        chat.use_worktrees = wt;
    }
    if let Some(mt) = input.max_swarm_turns {
        chat.max_swarm_turns = mt.clamp(1, 8);
    }
    chat.updated_at_ms = now_ms();
    let _ = guard.persist();
    guard.emit(OmniStreamEvent::StateUpdated {
        chat_id: Some(input.chat_id),
    });
    Ok(guard.snapshot())
}

async fn http_update_chat(
    State(state): State<SharedOmniState>,
    Json(input): Json<UpdateChatInput>,
) -> impl IntoResponse {
    match update_chat_thread(&state, input) {
        Ok(snap) => Json(snap).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdInput {
    pub id: String,
}

pub fn clear_chat_thread(state: &SharedOmniState, id: &str) -> Result<OmniSnapshot, String> {
    let mut guard = state
        .write()
        .map_err(|_| "State lock poisoned".to_string())?;
    if let Some(chat) = guard.store.chats.iter_mut().find(|c| c.id == id) {
        chat.messages.clear();
        chat.native_sessions.clear();
        chat.last_synced_msg_index.clear();
        chat.updated_at_ms = now_ms();
    }
    let _ = guard.persist();
    guard.emit(OmniStreamEvent::StateUpdated {
        chat_id: Some(id.to_string()),
    });
    Ok(guard.snapshot())
}

async fn http_clear_chat(
    State(state): State<SharedOmniState>,
    Json(input): Json<IdInput>,
) -> impl IntoResponse {
    match clear_chat_thread(&state, &input.id) {
        Ok(snap) => Json(snap).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

pub fn delete_chat_thread(state: &SharedOmniState, id: &str) -> Result<OmniSnapshot, String> {
    let mut guard = state
        .write()
        .map_err(|_| "State lock poisoned".to_string())?;
    guard.store.chats.retain(|c| c.is_primary || c.id != id);
    let _ = guard.persist();
    guard.emit(OmniStreamEvent::StateUpdated { chat_id: None });
    Ok(guard.snapshot())
}

async fn http_delete_chat(
    State(state): State<SharedOmniState>,
    Json(input): Json<IdInput>,
) -> impl IntoResponse {
    match delete_chat_thread(&state, &input.id) {
        Ok(snap) => Json(snap).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

pub fn upsert_bot_profile(
    state: &SharedOmniState,
    mut bot: BotProfile,
) -> Result<OmniSnapshot, String> {
    let mut guard = state
        .write()
        .map_err(|_| "State lock poisoned".to_string())?;
    if bot.id.trim().is_empty() {
        bot.id = format!("bot_custom_{}", now_ms());
    }
    let base_slug = if bot.slug.trim().is_empty() {
        bot.name
            .to_lowercase()
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { '-' })
            .collect::<String>()
            .trim_matches('-')
            .to_string()
    } else {
        bot.slug
            .to_lowercase()
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { '-' })
            .collect::<String>()
            .trim_matches('-')
            .to_string()
    };
    let clean_base = if base_slug.is_empty() {
        "bot".to_string()
    } else {
        base_slug
    };
    let mut candidate_slug = clean_base.clone();
    let mut suffix = 2u32;
    while guard
        .store
        .bots
        .iter()
        .any(|b| b.id != bot.id && b.slug.eq_ignore_ascii_case(&candidate_slug))
    {
        candidate_slug = format!("{clean_base}-{suffix}");
        suffix += 1;
    }
    bot.slug = candidate_slug;

    guard.store.dismissed_bot_ids.retain(|d| d != &bot.id);
    if let Some(existing) = guard.store.bots.iter_mut().find(|b| b.id == bot.id) {
        *existing = bot.clone();
        // Keep dedicated 1:1 thread title & subtitle in sync with updated Bot profile
        for chat in &mut guard.store.chats {
            if !chat.is_primary
                && !chat.is_group
                && chat.participant_bot_ids.len() == 1
                && chat.participant_bot_ids[0] == bot.id
            {
                chat.title = bot.name.clone();
                chat.subtitle = format!("{} · {}", bot.role_title, bot.cli_driver.display_name());
            }
        }
    } else {
        guard.store.bots.push(bot.clone());
        let direct_id = format!("chat-direct-{}", bot.id);
        if !guard.store.chats.iter().any(|c| c.id == direct_id) {
            let ws_id = guard.store.workspaces.first().map(|w| w.id.clone());
            let ws_root = guard.store.preferences.workspace_root.clone();
            let max_turns = guard.store.preferences.default_max_swarm_turns;
            guard.store.chats.push(ChatThread {
                id: direct_id,
                title: bot.name.clone(),
                subtitle: format!("{} · {}", bot.role_title, bot.cli_driver.display_name()),
                is_primary: false,
                is_group: false,
                participant_bot_ids: vec![bot.id.clone()],
                workspace_id: ws_id,
                workspace_path: Some(ws_root),
                use_worktrees: false,
                max_swarm_turns: max_turns,
                messages: Vec::new(),
                native_sessions: HashMap::new(),
                last_synced_msg_index: HashMap::new(),
                updated_at_ms: now_ms(),
            });
        }
    }
    let _ = guard.persist();
    guard.emit(OmniStreamEvent::StateUpdated { chat_id: None });
    Ok(guard.snapshot())
}

async fn http_upsert_bot(
    State(state): State<SharedOmniState>,
    Json(bot): Json<BotProfile>,
) -> impl IntoResponse {
    match upsert_bot_profile(&state, bot) {
        Ok(snap) => Json(snap).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

pub fn delete_bot_profile(state: &SharedOmniState, id: &str) -> Result<OmniSnapshot, String> {
    let mut guard = state
        .write()
        .map_err(|_| "State lock poisoned".to_string())?;
    if !guard.store.dismissed_bot_ids.contains(&id.to_string()) {
        guard.store.dismissed_bot_ids.push(id.to_string());
    }
    guard.store.bots.retain(|b| b.is_primary || b.id != id);
    guard.store.chats.retain(|c| {
        c.is_primary
            || !(!c.is_group
                && c.participant_bot_ids.len() == 1
                && c.participant_bot_ids[0] == id)
    });
    for c in &mut guard.store.chats {
        c.participant_bot_ids.retain(|bid| bid != id);
        if c.participant_bot_ids.is_empty() {
            c.participant_bot_ids.push("bot-omni".to_string());
        }
    }
    for w in &mut guard.store.workspaces {
        w.assigned_bot_ids.retain(|bid| bid != id);
        if w.lead_bot_id.as_deref() == Some(id) {
            w.lead_bot_id = Some("bot-omni".to_string());
        }
    }
    let _ = guard.persist();
    guard.emit(OmniStreamEvent::StateUpdated { chat_id: None });
    Ok(guard.snapshot())
}

async fn http_delete_bot(
    State(state): State<SharedOmniState>,
    Json(input): Json<IdInput>,
) -> impl IntoResponse {
    match delete_bot_profile(&state, &input.id) {
        Ok(snap) => Json(snap).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

pub fn update_omni_preferences(
    state: &SharedOmniState,
    mut prefs: OmniPreferences,
) -> Result<OmniSnapshot, String> {
    let mut guard = state
        .write()
        .map_err(|_| "State lock poisoned".to_string())?;
    prefs.max_context_messages = prefs.max_context_messages.clamp(2, 24);
    prefs.max_message_chars = prefs.max_message_chars.clamp(400, 6000);
    prefs.max_parallel_bots = prefs.max_parallel_bots.clamp(1, 6);
    prefs.turn_timeout_secs = prefs.turn_timeout_secs.clamp(30, 1800);
    if prefs.max_turn_budget_usd <= 0.0 {
        prefs.max_turn_budget_usd = 1.50;
    }

    let ws_root = prefs.workspace_root.trim().to_string();
    if !ws_root.is_empty() && !guard.store.workspaces.iter().any(|w| w.path == ws_root) {
        let name = ws_root
            .split('/')
            .rfind(|s| !s.is_empty())
            .unwrap_or("Project")
            .to_string();
        guard.store.workspaces.push(WorkspaceEntry {
            id: format!("ws_{}", now_ms()),
            name,
            path: ws_root.clone(),
            description: "Local project directory".to_string(),
            instructions: String::new(),
            assigned_bot_ids: Vec::new(),
            lead_bot_id: Some("bot-omni".to_string()),
            use_worktrees_default: false,
        });
    }
    guard.store.preferences = prefs;
    let _ = guard.persist();
    guard.emit(OmniStreamEvent::StateUpdated { chat_id: None });
    Ok(guard.snapshot())
}

async fn http_update_preferences(
    State(state): State<SharedOmniState>,
    Json(prefs): Json<OmniPreferences>,
) -> impl IntoResponse {
    match update_omni_preferences(&state, prefs) {
        Ok(snap) => Json(snap).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

pub fn upsert_workspace_entry(
    state: &SharedOmniState,
    mut ws: WorkspaceEntry,
) -> Result<OmniSnapshot, String> {
    let mut guard = state
        .write()
        .map_err(|_| "State lock poisoned".to_string())?;
    if ws.id.trim().is_empty() {
        ws.id = format!("ws_{}", now_ms());
    }
    if let Some(existing) = guard.store.workspaces.iter_mut().find(|w| w.id == ws.id) {
        *existing = ws;
    } else {
        guard.store.workspaces.push(ws);
    }
    let _ = guard.persist();
    guard.emit(OmniStreamEvent::StateUpdated { chat_id: None });
    Ok(guard.snapshot())
}

async fn http_upsert_workspace(
    State(state): State<SharedOmniState>,
    Json(ws): Json<WorkspaceEntry>,
) -> impl IntoResponse {
    match upsert_workspace_entry(&state, ws) {
        Ok(snap) => Json(snap).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

pub fn delete_workspace_entry(state: &SharedOmniState, id: &str) -> Result<OmniSnapshot, String> {
    let mut guard = state
        .write()
        .map_err(|_| "State lock poisoned".to_string())?;
    guard.store.workspaces.retain(|w| w.id != id);
    let _ = guard.persist();
    guard.emit(OmniStreamEvent::StateUpdated { chat_id: None });
    Ok(guard.snapshot())
}

async fn http_delete_workspace(
    State(state): State<SharedOmniState>,
    Json(input): Json<IdInput>,
) -> impl IntoResponse {
    match delete_workspace_entry(&state, &input.id) {
        Ok(snap) => Json(snap).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

pub fn upsert_routine_entry(
    state: &SharedOmniState,
    mut routine: RoutineEntry,
) -> Result<OmniSnapshot, String> {
    let mut guard = state
        .write()
        .map_err(|_| "State lock poisoned".to_string())?;
    if routine.id.trim().is_empty() {
        routine.id = format!("routine_{}", now_ms());
    }
    if let Some(existing) = guard
        .store
        .routines
        .iter_mut()
        .find(|r| r.id == routine.id)
    {
        *existing = routine;
    } else {
        guard.store.routines.insert(0, routine);
    }
    let _ = guard.persist();
    guard.emit(OmniStreamEvent::StateUpdated { chat_id: None });
    Ok(guard.snapshot())
}

async fn http_upsert_routine(
    State(state): State<SharedOmniState>,
    Json(routine): Json<RoutineEntry>,
) -> impl IntoResponse {
    match upsert_routine_entry(&state, routine) {
        Ok(snap) => Json(snap).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

pub fn delete_routine_entry(state: &SharedOmniState, id: &str) -> Result<OmniSnapshot, String> {
    let mut guard = state
        .write()
        .map_err(|_| "State lock poisoned".to_string())?;
    guard.store.routines.retain(|r| r.id != id);
    let _ = guard.persist();
    guard.emit(OmniStreamEvent::StateUpdated { chat_id: None });
    Ok(guard.snapshot())
}

async fn http_delete_routine(
    State(state): State<SharedOmniState>,
    Json(input): Json<IdInput>,
) -> impl IntoResponse {
    match delete_routine_entry(&state, &input.id) {
        Ok(snap) => Json(snap).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

async fn http_computer_overview(State(state): State<SharedOmniState>) -> impl IntoResponse {
    let root = state
        .read()
        .map(|g| g.store.preferences.workspace_root.clone())
        .unwrap_or_else(|_| ".".to_string());
    Json(get_system_overview(&root)).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathQuery {
    path: Option<String>,
    query: Option<String>,
}

async fn http_list_files(
    State(state): State<SharedOmniState>,
    Query(q): Query<PathQuery>,
) -> impl IntoResponse {
    let root = state
        .read()
        .map(|g| g.store.preferences.workspace_root.clone())
        .unwrap_or_else(|_| ".".to_string());
    match list_workspace_directory(&root, q.path.as_deref()) {
        Ok(items) => Json(items).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

async fn http_read_file(
    State(state): State<SharedOmniState>,
    Query(q): Query<PathQuery>,
) -> impl IntoResponse {
    let root = state
        .read()
        .map(|g| g.store.preferences.workspace_root.clone())
        .unwrap_or_else(|_| ".".to_string());
    let path = q.path.unwrap_or_default();
    match read_workspace_file(&root, &path, 64_000) {
        Ok(content) => Json(serde_json::json!({ "content": content })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

async fn http_search_files(
    State(state): State<SharedOmniState>,
    Query(q): Query<PathQuery>,
) -> impl IntoResponse {
    let root = state
        .read()
        .map(|g| g.store.preferences.workspace_root.clone())
        .unwrap_or_else(|_| ".".to_string());
    let needle = q.query.unwrap_or_default();
    match search_workspace_files(&root, &needle, q.path.as_deref()) {
        Ok(items) => Json(items).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenItemBody {
    target: String,
    app_name: Option<String>,
    reveal_in_finder: Option<bool>,
}

async fn http_open_item(
    State(state): State<SharedOmniState>,
    Json(body): Json<OpenItemBody>,
) -> impl IntoResponse {
    let root = state
        .read()
        .map(|g| g.store.preferences.workspace_root.clone())
        .unwrap_or_else(|_| ".".to_string());
    match open_on_desktop(
        &root,
        &body.target,
        body.app_name.as_deref(),
        body.reveal_in_finder.unwrap_or(false),
    ) {
        Ok(msg) => Json(serde_json::json!({ "message": msg })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

async fn http_git_diff(
    State(state): State<SharedOmniState>,
    Query(q): Query<PathQuery>,
) -> impl IntoResponse {
    let root = state
        .read()
        .map(|g| g.store.preferences.workspace_root.clone())
        .unwrap_or_else(|_| ".".to_string());
    let file_path = q.path.unwrap_or_default();
    match read_file_diff(&root, &file_path) {
        Ok(diff) => Json(serde_json::json!({ "diff": diff })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitCommitBody {
    message: String,
}

async fn http_git_commit(
    State(state): State<SharedOmniState>,
    Json(body): Json<GitCommitBody>,
) -> impl IntoResponse {
    let root = state
        .read()
        .map(|g| g.store.preferences.workspace_root.clone())
        .unwrap_or_else(|_| ".".to_string());
    if let Err(e) = git_stage_and_commit(&root, &body.message) {
        return (StatusCode::BAD_REQUEST, e).into_response();
    }
    match state.read() {
        Ok(guard) => Json(guard.snapshot()).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "State lock poisoned").into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitDiscardBody {
    file_path: String,
}

async fn http_git_discard(
    State(state): State<SharedOmniState>,
    Json(body): Json<GitDiscardBody>,
) -> impl IntoResponse {
    let root = state
        .read()
        .map(|g| g.store.preferences.workspace_root.clone())
        .unwrap_or_else(|_| ".".to_string());
    if let Err(e) = git_discard_file(&root, &body.file_path) {
        return (StatusCode::BAD_REQUEST, e).into_response();
    }
    match state.read() {
        Ok(guard) => Json(guard.snapshot()).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "State lock poisoned").into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestHarnessBody {
    kind: CliDriverKind,
}

async fn http_test_harness(Json(body): Json<TestHarnessBody>) -> impl IntoResponse {
    Json(test_cli_harness(body.kind)).into_response()
}
