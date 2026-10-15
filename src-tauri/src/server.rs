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
    extract::{Query, Request, State},
    http::StatusCode,
    middleware::{self, Next},
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

pub async fn spawn_local_server(
) -> Result<(u16, SharedOmniState, broadcast::Sender<OmniStreamEvent>), String> {
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
    let runtime_state = OmniRuntimeState::load(bound_port, event_tx.clone())?;
    let shared: SharedOmniState = Arc::new(RwLock::new(runtime_state));

    let app = local_router(shared.clone(), bound_port);

    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    Ok((bound_port, shared, event_tx))
}

pub fn local_router(shared: SharedOmniState, bound_port: u16) -> Router {
    Router::new()
        .route("/api/snapshot", get(http_snapshot))
        .route("/api/terminal/list", get(crate::terminal::http_list))
        .route("/api/terminal/start", post(crate::terminal::http_start))
        .route("/api/terminal/output", get(crate::terminal::http_output))
        .route("/api/terminal/write", post(crate::terminal::http_write))
        .route("/api/terminal/resize", post(crate::terminal::http_resize))
        .route("/api/terminal/stop", post(crate::terminal::http_stop))
        .route("/api/storage/retry", post(http_retry_storage))
        .route("/api/rescan", post(http_rescan))
        .route("/api/setup", post(crate::setup::http_complete_setup))
        .route("/api/bot/pin", post(crate::setup::http_pin_bot))
        .route("/api/events", get(http_sse_events))
        .route("/api/chat/send", post(http_send_message))
        .route("/api/chat/preview", post(http_preview_message))
        .route("/api/chat/stop", post(http_stop_chat))
        .route("/api/chat/create", post(http_create_chat))
        .route("/api/chat/update", post(http_update_chat))
        .route("/api/chat/clear", post(http_clear_chat))
        .route("/api/chat/reset-sessions", post(http_reset_sessions))
        .route("/api/chat/delete", post(http_delete_chat))
        .route("/api/bot/upsert", post(http_upsert_bot))
        .route("/api/bot/delete", post(http_delete_bot))
        .route("/api/preferences", post(http_update_preferences))
        .route("/api/workspace/upsert", post(http_upsert_workspace))
        .route("/api/workspace/delete", post(http_delete_workspace))
        .route("/api/routine/upsert", post(http_upsert_routine))
        .route("/api/routine/run", post(crate::routines::http_run))
        .route("/api/routine/delete", post(http_delete_routine))
        .route("/api/computer/overview", get(http_computer_overview))
        .route("/api/computer/files", get(http_list_files))
        .route("/api/computer/read", get(http_read_file))
        .route("/api/computer/search", get(http_search_files))
        .route("/api/computer/open", post(http_open_item))
        .route("/api/git/status", get(http_git_status))
        .route("/api/git/diff", get(http_git_diff))
        .route("/api/git/commit", post(http_git_commit))
        .route("/api/git/discard", post(http_git_discard))
        .route("/api/harness/test", post(http_test_harness))
        .layer(local_cors())
        .layer(middleware::from_fn_with_state(
            bound_port,
            local_request_only,
        ))
        .with_state(shared)
}

const APP_ORIGINS: [&str; 6] = [
    "http://localhost:1420",
    "http://127.0.0.1:1420",
    "http://localhost:1422",
    "http://127.0.0.1:1422",
    "tauri://localhost",
    "http://tauri.localhost",
];

fn local_cors() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(APP_ORIGINS.map(|origin| origin.parse().unwrap()))
        .allow_methods([axum::http::Method::GET, axum::http::Method::POST])
        .allow_headers([axum::http::header::CONTENT_TYPE])
}

fn valid_local_request(headers: &axum::http::HeaderMap, port: u16) -> bool {
    let host = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if host != format!("127.0.0.1:{port}") && host != format!("localhost:{port}") {
        return false;
    }
    if let Some(origin) = headers.get("origin") {
        return origin.to_str().is_ok_and(|origin| {
            APP_ORIGINS.contains(&origin) || origin == format!("http://{host}")
        });
    }
    !headers
        .get("sec-fetch-site")
        .is_some_and(|v| v == "cross-site")
}

async fn local_request_only(
    State(port): State<u16>,
    request: Request,
    next: Next,
) -> axum::response::Response {
    if !valid_local_request(request.headers(), port) {
        return (StatusCode::FORBIDDEN, "Local app requests only").into_response();
    }
    next.run(request).await
}

fn require_idle(guard: &OmniRuntimeState, chat_id: &str) -> Result<(), String> {
    if guard.active_workflows.contains(chat_id) {
        Err("Stop this chat and wait for it to finish before changing or deleting it.".into())
    } else {
        Ok(())
    }
}

async fn http_retry_storage(State(state): State<SharedOmniState>) -> axum::response::Response {
    let mut guard = match state.write() {
        Ok(guard) => guard,
        Err(_) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, "State lock poisoned").into_response()
        }
    };
    guard.save_execution();
    guard.emit(OmniStreamEvent::StateUpdated { chat_id: None });
    Json(guard.snapshot()).into_response()
}

async fn http_snapshot(State(state): State<SharedOmniState>) -> impl IntoResponse {
    match state.read() {
        Ok(guard) => Json(guard.snapshot()).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "State lock poisoned").into_response(),
    }
}

async fn http_rescan(State(state): State<SharedOmniState>) -> impl IntoResponse {
    match crate::state::rescan_environment(state).await {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error).into_response(),
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
        Err(_) => Some(Ok(Event::default().data(
            serde_json::to_string(&OmniStreamEvent::StateUpdated { chat_id: None }).unwrap(),
        ))),
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

async fn http_preview_message(
    State(state): State<SharedOmniState>,
    Json(input): Json<SendMessageInput>,
) -> axum::response::Response {
    match state
        .read()
        .map_err(|_| "State lock poisoned".to_string())
        .and_then(|g| crate::routing::resolve(&g.store, &input, false))
    {
        Ok(plan) => Json(plan).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, error).into_response(),
    }
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
    // Keep runs visible until the child processes have actually stopped.
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
    #[serde(default)]
    pub model_overrides: HashMap<String, Option<String>>,
    pub bot_home: Option<bool>,
    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub participant_bot_ids: Vec<String>,
    pub workspace_id: Option<String>,
    pub workspace_path: Option<String>,
    pub use_worktrees: Option<bool>,
}

fn validate_project_folder(path: &str) -> Result<String, String> {
    let path =
        std::fs::canonicalize(path.trim()).map_err(|_| "Choose an existing project folder.")?;
    if !path.is_dir() {
        return Err("Choose a folder, not a file.".into());
    }
    Ok(path.to_string_lossy().into_owned())
}

pub fn create_chat_thread(
    state: &SharedOmniState,
    input: CreateChatInput,
) -> Result<(ChatThread, OmniSnapshot), String> {
    let mut guard = state
        .write()
        .map_err(|_| "State lock poisoned".to_string())?;
    let mut participants = if input.participant_bot_ids.is_empty() {
        vec!["bot-omni".to_string()]
    } else {
        input.participant_bot_ids
    };
    let mut seen = std::collections::HashSet::new();
    participants.retain(|id| seen.insert(id.clone()));
    if participants
        .iter()
        .any(|id| !guard.store.bots.iter().any(|b| &b.id == id && !b.archived))
    {
        return Err("Unknown participant bot.".into());
    }
    for (id, model) in &input.model_overrides {
        if !participants.contains(id)
            || model
                .as_ref()
                .is_some_and(|m| m.len() > 256 || m.chars().any(char::is_control))
        {
            return Err("Choose a valid model for a chat participant.".into());
        }
    }
    let workspace = if let Some(id) = &input.workspace_id {
        Some(
            guard
                .store
                .workspaces
                .iter()
                .find(|w| &w.id == id)
                .ok_or("Unknown workspace")?,
        )
    } else {
        None
    };
    let workspace_path = input
        .workspace_path
        .as_deref()
        .filter(|p| !p.trim().is_empty())
        .map(|p| p.to_string())
        .or_else(|| workspace.map(|w| w.path.clone()))
        .map(|path| validate_project_folder(&path))
        .transpose()?;
    if workspace.is_some_and(|w| workspace_path.as_deref() != Some(w.path.as_str())) {
        return Err("Project and folder must match.".into());
    }
    if input.use_worktrees.unwrap_or(false) && workspace_path.is_none() {
        return Err("Choose a project before enabling worktrees.".into());
    }
    let is_bot_home = input.bot_home.unwrap_or(false);
    if is_bot_home {
        if participants.len() != 1 || workspace_path.is_some() {
            return Err("A bot conversation needs one bot and no fixed project.".into());
        }
        if let Some(existing) = guard.store.chats.iter().find(|c| {
            (c.is_bot_home || c.is_primary)
                && c.owner_bot_id.as_ref().or(c.participant_bot_ids.first()) == participants.first()
        }) {
            return Ok((existing.clone(), guard.snapshot()));
        }
    }
    let previous = guard.store.clone();
    if let Some(path) = &workspace_path {
        if !guard.store.workspaces.iter().any(|p| &p.path == path) {
            let approve_all_tools = guard.store.preferences.approve_all_tools;
            guard.store.workspaces.push(WorkspaceEntry {
                id: format!("ws_{}", uuid::Uuid::new_v4()),
                name: std::path::Path::new(path)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                path: path.clone(),
                description: String::new(),
                instructions: String::new(),
                memories: Vec::new(),
                approve_all_tools,
                assigned_bot_ids: Vec::new(),
                lead_bot_id: None,
                use_worktrees_default: false,
            });
        }
    }
    let workspace_id = guard
        .store
        .workspaces
        .iter()
        .find(|w| Some(&w.path) == workspace_path.as_ref())
        .map(|w| w.id.clone());
    let is_group = participants.len() > 1;
    let bot_names: Vec<String> = guard
        .store
        .bots
        .iter()
        .filter(|b| participants.contains(&b.id))
        .map(|b| b.name.clone())
        .collect();

    let default_title = if is_group {
        format!("Group chat · {}", bot_names.join(" + "))
    } else {
        bot_names
            .first()
            .cloned()
            .unwrap_or_else(|| "New sidechat".to_string())
    };

    let chat = ChatThread {
        owner_bot_id: is_bot_home.then(|| participants[0].clone()),
        model_overrides: input.model_overrides,
        session_contexts: HashMap::new(),
        tasks: Vec::new(),
        is_bot_home,
        id: format!("chat_{}", uuid::Uuid::new_v4()),
        title: input
            .title
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| {
                workspace_path
                    .as_ref()
                    .map(|p| {
                        format!(
                            "{default_title} · {}",
                            std::path::Path::new(p)
                                .file_name()
                                .unwrap_or_default()
                                .to_string_lossy()
                        )
                    })
                    .unwrap_or(default_title)
            }),
        subtitle: input.subtitle.unwrap_or_else(|| {
            if is_group {
                format!("Group chat · {}", bot_names.join(", "))
            } else {
                "Focused Thread".to_string()
            }
        }),
        is_primary: false,
        is_group,
        participant_bot_ids: participants,
        workspace_id,
        workspace_path,
        use_worktrees: input.use_worktrees.unwrap_or(false),
        max_swarm_turns: guard.store.preferences.default_max_swarm_turns,
        messages: Vec::new(),
        native_sessions: HashMap::new(),
        last_synced_msg_index: HashMap::new(),
        updated_at_ms: now_ms(),
    };

    let index = guard.store.chats.len().min(1);
    guard.store.chats.insert(index, chat.clone());
    if let Err(error) = guard.persist() {
        guard.store = previous;
        return Err(error);
    }
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
    mut input: UpdateChatInput,
) -> Result<OmniSnapshot, String> {
    let mut guard = state
        .write()
        .map_err(|_| "State lock poisoned".to_string())?;
    require_idle(&guard, &input.chat_id)?;
    if let Some(ids) = &input.participant_bot_ids {
        if ids.is_empty()
            || ids
                .iter()
                .any(|id| !guard.store.bots.iter().any(|b| &b.id == id && !b.archived))
        {
            return Err("Select existing participant bots.".into());
        }
    }
    if let Some(path) = input.workspace_path.as_mut() {
        if !path.trim().is_empty() {
            *path = validate_project_folder(path)?;
        }
    }
    if guard
        .store
        .chats
        .iter()
        .any(|c| c.id == input.chat_id && (c.is_primary || c.is_bot_home))
        && (input.workspace_path.as_ref().is_some_and(|p| !p.is_empty())
            || input.use_worktrees == Some(true))
    {
        return Err("Home stays project-free. Open a project work chat instead.".into());
    }
    let previous = guard.store.clone();
    let workspace_id = input.workspace_path.as_ref().and_then(|path| {
        guard
            .store
            .workspaces
            .iter()
            .find(|w| &w.path == path)
            .map(|w| w.id.clone())
    });
    let Some(chat) = guard.store.chats.iter_mut().find(|c| c.id == input.chat_id) else {
        return Err("Chat not found".to_string());
    };
    if let Some(t) = input.title.filter(|s| !s.trim().is_empty()) {
        chat.title = t.trim().to_string();
    }
    if let Some(pids) = input.participant_bot_ids {
        if !pids.is_empty() {
            let mut pids = pids;
            if let Some(owner) = &chat.owner_bot_id {
                if !pids.contains(owner) {
                    pids.insert(0, owner.clone());
                }
            }
            let mut seen = std::collections::HashSet::new();
            pids.retain(|id| seen.insert(id.clone()));
            chat.is_group = pids.len() > 1 && !chat.is_bot_home && !chat.is_primary;
            chat.participant_bot_ids = pids;
            chat.native_sessions.clear();
            chat.session_contexts.clear();
            chat.last_synced_msg_index.clear();
        }
    }
    if input
        .workspace_path
        .as_ref()
        .is_some_and(|p| Some(p) != chat.workspace_path.as_ref())
        || input
            .use_worktrees
            .is_some_and(|wt| wt != chat.use_worktrees)
    {
        chat.native_sessions.clear();
        chat.last_synced_msg_index.clear();
    }
    if let Some(wp) = input.workspace_path {
        chat.workspace_path = if wp.is_empty() { None } else { Some(wp) };
        chat.workspace_id = workspace_id;
        if chat.workspace_path.is_none() {
            chat.use_worktrees = false;
        }
    }
    if let Some(wt) = input.use_worktrees {
        if wt && chat.workspace_path.is_none() {
            guard.store = previous;
            return Err("Choose a project before enabling worktrees.".into());
        }
        chat.use_worktrees = wt;
    }
    if let Some(mt) = input.max_swarm_turns {
        chat.max_swarm_turns = mt.clamp(1, 8);
    }
    chat.updated_at_ms = now_ms();
    if let Err(error) = guard.persist() {
        guard.store = previous;
        return Err(error);
    }
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
    require_idle(&guard, id)?;
    let previous = guard.store.clone();
    if let Some(chat) = guard.store.chats.iter_mut().find(|c| c.id == id) {
        chat.messages.clear();
        chat.tasks.clear();
        chat.session_contexts.clear();
        chat.native_sessions.clear();
        chat.last_synced_msg_index.clear();
        chat.updated_at_ms = now_ms();
    }
    guard.persist_or_restore(previous)?;
    guard.emit(OmniStreamEvent::StateUpdated {
        chat_id: Some(id.to_string()),
    });
    Ok(guard.snapshot())
}

async fn http_reset_sessions(
    State(state): State<SharedOmniState>,
    Json(input): Json<IdInput>,
) -> axum::response::Response {
    let result = (|| {
        let mut guard = state.write().map_err(|_| "State lock poisoned")?;
        require_idle(&guard, &input.id)?;
        let previous = guard.store.clone();
        let chat = guard
            .store
            .chats
            .iter_mut()
            .find(|c| c.id == input.id)
            .ok_or("Chat not found")?;
        chat.native_sessions.clear();
        chat.session_contexts.clear();
        chat.last_synced_msg_index.clear();
        guard.persist_or_restore(previous)?;
        guard.emit(OmniStreamEvent::StateUpdated {
            chat_id: Some(input.id),
        });
        Ok::<_, String>(guard.snapshot())
    })();
    match result {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, error).into_response(),
    }
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
    require_idle(&guard, id)?;
    if guard.store.chats.iter().any(|c| c.id == id && c.is_primary) {
        return Err("The main conversation cannot be deleted. Use Clear history instead.".into());
    }
    let previous = guard.store.clone();
    guard.store.chats.retain(|c| c.is_primary || c.id != id);
    for routine in &mut guard.store.routines {
        if routine.chat_id.as_deref() == Some(id) {
            routine.enabled = false;
            routine.chat_id = None;
            routine.last_error = Some(
                "The target chat was deleted. Choose another chat before enabling this routine."
                    .into(),
            );
        }
    }
    guard.persist_or_restore(previous)?;
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
    crate::state::validate_avatar_image(bot.avatar_image.as_deref())?;
    crate::lifecycle::validate_profile(&guard.store, &mut bot)?;
    if bot
        .max_turn_budget_usd
        .is_some_and(|b| !b.is_finite() || b <= 0.0)
    {
        return Err("Bot budget must be a positive finite number.".into());
    }
    for chat in &guard.store.chats {
        let project_member = guard.store.workspaces.iter().any(|p| {
            Some(&p.path) == chat.workspace_path.as_ref() && p.assigned_bot_ids.contains(&bot.id)
        });
        if chat.participant_bot_ids.contains(&bot.id) || project_member {
            require_idle(&guard, &chat.id)?;
        }
    }
    let previous_store = guard.store.clone();
    if let Some(existing) = guard.store.bots.iter().find(|b| b.id == bot.id) {
        bot.is_primary = existing.is_primary;
        if bot.is_primary {
            bot.archived = false;
        }
        if existing.cli_driver != bot.cli_driver {
            bot.custom_command = None;
            if bot.model == existing.model {
                bot.model = None;
            }
        }
        if existing.name != bot.name
            || existing.role_title != bot.role_title
            || existing.permission_mode != bot.permission_mode
            || existing.reasoning_effort != bot.reasoning_effort
            || existing.cli_driver != bot.cli_driver
            || existing.model != bot.model
            || existing.custom_command != bot.custom_command
            || existing.system_prompt != bot.system_prompt
            || existing.memories != bot.memories
        {
            for chat in &mut guard.store.chats {
                chat.native_sessions.remove(&bot.id);
                chat.last_synced_msg_index.remove(&bot.id);
            }
        }
    } else {
        bot.is_primary = false;
    }
    guard.store.dismissed_bot_ids.retain(|d| d != &bot.id);
    if let Some(existing) = guard.store.bots.iter_mut().find(|b| b.id == bot.id) {
        *existing = bot.clone();
        // Keep dedicated 1:1 thread title & subtitle in sync with updated Bot profile
        for chat in &mut guard.store.chats {
            if !chat.is_group
                && (chat.is_primary || chat.is_bot_home)
                && chat
                    .owner_bot_id
                    .as_ref()
                    .or(chat.participant_bot_ids.first())
                    == Some(&bot.id)
            {
                chat.title = bot.name.clone();
                chat.subtitle = format!("{} · {}", bot.role_title, bot.cli_driver.display_name());
            }
        }
    } else {
        guard.store.bots.push(bot.clone());
        let direct_id = format!("chat-direct-{}", bot.id);
        if !guard.store.chats.iter().any(|c| c.id == direct_id) {
            let max_turns = guard.store.preferences.default_max_swarm_turns;
            guard.store.chats.push(ChatThread {
                owner_bot_id: Some(bot.id.clone()),
                model_overrides: HashMap::new(),
                session_contexts: HashMap::new(),
                tasks: Vec::new(),
                is_bot_home: true,
                id: direct_id,
                title: bot.name.clone(),
                subtitle: format!("{} · {}", bot.role_title, bot.cli_driver.display_name()),
                is_primary: false,
                is_group: false,
                participant_bot_ids: vec![bot.id.clone()],
                workspace_id: None,
                workspace_path: None,
                use_worktrees: false,
                max_swarm_turns: max_turns,
                messages: Vec::new(),
                native_sessions: HashMap::new(),
                last_synced_msg_index: HashMap::new(),
                updated_at_ms: now_ms(),
            });
        }
    }
    if let Err(error) = guard.persist() {
        guard.store = previous_store;
        return Err(error);
    }
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
    if guard.store.bots.iter().any(|b| b.id == id && b.is_primary) {
        return Err("The primary coordinator cannot be deleted.".into());
    }
    for chat in &guard.store.chats {
        let project_member = guard.store.workspaces.iter().any(|p| {
            Some(&p.path) == chat.workspace_path.as_ref()
                && p.assigned_bot_ids.iter().any(|b| b == id)
        });
        if chat.participant_bot_ids.iter().any(|b| b == id) || project_member {
            require_idle(&guard, &chat.id)?;
        }
    }
    let previous = guard.store.clone();
    let bot = guard
        .store
        .bots
        .iter_mut()
        .find(|b| b.id == id)
        .ok_or("Bot not found")?;
    bot.archived = true;
    for project in &mut guard.store.workspaces {
        project.assigned_bot_ids.retain(|bot_id| bot_id != id);
        if project.lead_bot_id.as_deref() == Some(id) {
            project.lead_bot_id = None;
        }
    }
    guard
        .store
        .preferences
        .pinned_bot_ids
        .retain(|bid| bid != id);
    for routine in &mut guard.store.routines {
        if routine.bot_id == id {
            routine.enabled = false;
            routine.last_error = Some(
                "The selected bot is archived. Restore it before enabling this routine.".into(),
            );
        }
    }
    guard.persist_or_restore(previous)?;
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
    if !prefs.workflow_budget_usd.is_finite() || prefs.workflow_budget_usd <= 0.0 {
        return Err("Workflow budget must be a positive finite number.".into());
    }
    prefs.default_max_swarm_turns = prefs.default_max_swarm_turns.clamp(1, 8);
    prefs.max_context_messages = prefs.max_context_messages.clamp(2, 24);
    prefs.max_message_chars = prefs.max_message_chars.clamp(400, 6000);
    prefs.max_parallel_bots = prefs.max_parallel_bots.clamp(1, 6);
    prefs.turn_timeout_secs = prefs.turn_timeout_secs.clamp(30, 1800);
    if !prefs.max_turn_budget_usd.is_finite() || prefs.max_turn_budget_usd <= 0.0 {
        prefs.max_turn_budget_usd = 1.50;
    }

    if !guard.active_workflows.is_empty()
        && (guard.store.preferences.workflow_budget_usd != prefs.workflow_budget_usd
            || guard.store.preferences.max_turn_budget_usd != prefs.max_turn_budget_usd
            || guard.store.preferences.max_parallel_bots != prefs.max_parallel_bots
            || guard.store.preferences.only_explicit_handoffs != prefs.only_explicit_handoffs
            || guard.store.preferences.max_context_messages != prefs.max_context_messages
            || guard.store.preferences.max_message_chars != prefs.max_message_chars
            || guard.store.preferences.turn_timeout_secs != prefs.turn_timeout_secs)
    {
        return Err("Finish running chats before changing execution limits.".into());
    }
    let previous = guard.store.clone();
    if guard.store.preferences.shared_memories != prefs.shared_memories
        || guard.store.preferences.global_instructions != prefs.global_instructions
    {
        if !guard.active_workflows.is_empty() {
            return Err("Stop running chats before changing shared memory or instructions.".into());
        }
        for chat in &mut guard.store.chats {
            chat.native_sessions.clear();
            chat.last_synced_msg_index.clear();
        }
    }
    guard.store.preferences = prefs;
    if let Err(error) = guard.persist() {
        guard.store = previous;
        return Err(error);
    }
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
    let mut guard = state.write().map_err(|_| "State lock poisoned")?;
    if ws.name.trim().is_empty() {
        return Err("Give the project a name.".into());
    }
    ws.path = validate_project_folder(&ws.path)?;
    if guard
        .store
        .workspaces
        .iter()
        .any(|p| p.path == ws.path && p.id != ws.id)
    {
        return Err("This folder is already in your projects.".into());
    }
    if ws.id.trim().is_empty() {
        ws.id = format!("ws_{}", uuid::Uuid::new_v4());
    }
    for id in ws.assigned_bot_ids.iter().chain(ws.lead_bot_id.iter()) {
        if !guard.store.bots.iter().any(|b| &b.id == id && !b.archived) {
            return Err("Choose existing, active project bots.".into());
        }
    }
    let existing = guard.store.workspaces.iter().find(|p| p.id == ws.id);
    let old_path = existing.map(|p| p.path.clone());
    let context_changed = existing.is_some_and(|p| {
        p.path != ws.path
            || p.memories != ws.memories
            || p.instructions != ws.instructions
            || p.approve_all_tools != ws.approve_all_tools
            || p.use_worktrees_default != ws.use_worktrees_default
            || p.assigned_bot_ids != ws.assigned_bot_ids
            || p.lead_bot_id != ws.lead_bot_id
    });
    if context_changed || existing.is_none() {
        for chat in &guard.store.chats {
            if chat.workspace_id.as_ref() == Some(&ws.id)
                || chat.workspace_path.as_deref() == Some(&ws.path)
                || (old_path.is_some() && chat.workspace_path == old_path)
            {
                require_idle(&guard, &chat.id)?;
            }
        }
    }
    let previous = guard.store.clone();
    if let Some(existing) = guard.store.workspaces.iter_mut().find(|w| w.id == ws.id) {
        *existing = ws.clone();
    } else {
        guard.store.workspaces.push(ws.clone());
    }
    for chat in &mut guard.store.chats {
        if chat.workspace_id.as_ref() == Some(&ws.id)
            || (old_path.is_some() && chat.workspace_path == old_path)
        {
            chat.workspace_id = Some(ws.id.clone());
            chat.workspace_path = Some(ws.path.clone());
            if context_changed {
                chat.native_sessions.clear();
                chat.last_synced_msg_index.clear();
            }
        }
    }
    if let Err(error) = guard.persist() {
        guard.store = previous;
        return Err(error);
    }
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
    let path = guard
        .store
        .workspaces
        .iter()
        .find(|w| w.id == id)
        .map(|w| w.path.clone());
    for chat in &guard.store.chats {
        if chat.workspace_id.as_deref() == Some(id)
            || (path.is_some() && chat.workspace_path == path)
        {
            require_idle(&guard, &chat.id)?;
        }
    }
    let previous = guard.store.clone();
    guard.store.workspaces.retain(|w| w.id != id);
    for chat in &mut guard.store.chats {
        if chat.workspace_id.as_deref() == Some(id)
            || (path.is_some() && chat.workspace_path == path)
        {
            chat.workspace_id = None;
            chat.native_sessions.clear();
            chat.last_synced_msg_index.clear();
        }
    }
    if let Err(error) = guard.persist() {
        guard.store = previous;
        return Err(error);
    }
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
    crate::routines::validate(&guard, &routine)?;
    let previous = guard.store.clone();
    if routine.id.trim().is_empty() {
        routine.id = format!("routine_{}", uuid::Uuid::new_v4());
    }
    if let Some(existing) = guard.store.routines.iter().find(|r| r.id == routine.id) {
        routine.workflow_id = existing.workflow_id.clone();
        routine.run_status = existing.run_status.clone();
        routine.last_run_ms = existing.last_run_ms;
        routine.last_attempt_ms = existing.last_attempt_ms;
        routine.last_error = existing.last_error.clone();
    } else {
        routine.last_run_ms = None;
        routine.last_attempt_ms = None;
        routine.last_error = None;
    }
    if let Some(existing) = guard.store.routines.iter_mut().find(|r| r.id == routine.id) {
        *existing = routine;
    } else {
        guard.store.routines.insert(0, routine);
    }
    if let Err(error) = guard.persist() {
        guard.store = previous;
        return Err(error);
    }
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
    let previous = guard.store.clone();
    guard.store.routines.retain(|r| r.id != id);
    guard.persist_or_restore(previous)?;
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
    task_id: Option<String>,
    chat_id: Option<String>,
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

pub fn git_root(
    state: &SharedOmniState,
    chat_id: Option<&str>,
    task_id: Option<&str>,
) -> Result<String, String> {
    let guard = state.read().map_err(|_| "State lock poisoned")?;
    let id = chat_id.ok_or("Select a chat before inspecting Git.")?;
    let chat = guard
        .store
        .chats
        .iter()
        .find(|c| c.id == id)
        .ok_or("Chat not found")?;
    if let Some(task_id) = task_id {
        return chat
            .tasks
            .iter()
            .find(|t| t.id == task_id)
            .and_then(|t| t.workspace_path.clone())
            .ok_or("This task has no working folder.".into());
    }
    chat.workspace_path
        .clone()
        .ok_or("Choose a project for this chat.".into())
}

pub async fn git_commit(
    state: SharedOmniState,
    chat_id: String,
    task_id: Option<String>,
    message: String,
) -> Result<OmniSnapshot, String> {
    let root = git_root(&state, Some(&chat_id), task_id.as_deref())?;
    let operation_id = uuid::Uuid::new_v4().to_string();
    let _lease = crate::execution::acquire(state.clone(), &chat_id, &operation_id, &root).await?;
    tokio::task::spawn_blocking(move || git_stage_and_commit(&root, &message))
        .await
        .map_err(|e| e.to_string())??;
    let guard = state.read().map_err(|_| "State lock poisoned")?;
    guard.emit(OmniStreamEvent::StateUpdated {
        chat_id: Some(chat_id),
    });
    Ok(guard.snapshot())
}

pub async fn git_discard(
    state: SharedOmniState,
    chat_id: String,
    task_id: Option<String>,
    file_path: String,
) -> Result<OmniSnapshot, String> {
    let root = git_root(&state, Some(&chat_id), task_id.as_deref())?;
    let operation_id = uuid::Uuid::new_v4().to_string();
    let _lease = crate::execution::acquire(state.clone(), &chat_id, &operation_id, &root).await?;
    tokio::task::spawn_blocking(move || git_discard_file(&root, &file_path))
        .await
        .map_err(|e| e.to_string())??;
    let guard = state.read().map_err(|_| "State lock poisoned")?;
    guard.emit(OmniStreamEvent::StateUpdated {
        chat_id: Some(chat_id),
    });
    Ok(guard.snapshot())
}

async fn http_git_status(
    State(state): State<SharedOmniState>,
    Query(q): Query<PathQuery>,
) -> axum::response::Response {
    match git_root(&state, q.chat_id.as_deref(), q.task_id.as_deref()) {
        Ok(root) => {
            match tokio::task::spawn_blocking(move || crate::git_ops::inspect_git_status(&root))
                .await
            {
                Ok(status) => Json(status).into_response(),
                Err(error) => {
                    (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response()
                }
            }
        }
        Err(error) => (StatusCode::BAD_REQUEST, error).into_response(),
    }
}

async fn http_git_diff(
    State(state): State<SharedOmniState>,
    Query(q): Query<PathQuery>,
) -> impl IntoResponse {
    let root = match git_root(&state, q.chat_id.as_deref(), q.task_id.as_deref()) {
        Ok(root) => root,
        Err(error) => return (StatusCode::BAD_REQUEST, error).into_response(),
    };
    let file_path = q.path.unwrap_or_default();
    match tokio::task::spawn_blocking(move || read_file_diff(&root, &file_path))
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r)
    {
        Ok(diff) => Json(serde_json::json!({ "diff": diff })).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitCommitBody {
    task_id: Option<String>,
    chat_id: Option<String>,
    message: String,
}

async fn http_git_commit(
    State(state): State<SharedOmniState>,
    Json(body): Json<GitCommitBody>,
) -> impl IntoResponse {
    match git_commit(
        state,
        body.chat_id.unwrap_or_default(),
        body.task_id,
        body.message,
    )
    .await
    {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, error).into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitDiscardBody {
    task_id: Option<String>,
    chat_id: Option<String>,
    file_path: String,
}

async fn http_git_discard(
    State(state): State<SharedOmniState>,
    Json(body): Json<GitDiscardBody>,
) -> impl IntoResponse {
    match git_discard(
        state,
        body.chat_id.unwrap_or_default(),
        body.task_id,
        body.file_path,
    )
    .await
    {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, error).into_response(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::Fixture;

    #[tokio::test]
    async fn packaged_app_cors_allows_local_preflights_and_rejects_foreign_sites() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let router = Router::new()
            .route("/api/test", post(|| async { "ok" }))
            .layer(local_cors())
            .layer(middleware::from_fn_with_state(port, local_request_only));
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        for origin in APP_ORIGINS.into_iter().chain(["https://attacker.example"]) {
            let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .unwrap();
            let request = format!("OPTIONS /api/test HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: {origin}\r\nAccess-Control-Request-Method: POST\r\nAccess-Control-Request-Headers: content-type\r\nConnection: close\r\n\r\n");
            stream.write_all(request.as_bytes()).await.unwrap();
            let mut response = String::new();
            tokio::time::timeout(
                std::time::Duration::from_secs(3),
                stream.read_to_string(&mut response),
            )
            .await
            .unwrap()
            .unwrap();
            if APP_ORIGINS.contains(&origin) {
                assert!(
                    response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.1 204"),
                    "{response}"
                );
                assert!(
                    response
                        .to_lowercase()
                        .contains(&format!("access-control-allow-origin: {origin}")),
                    "{response}"
                );
            } else {
                assert!(response.starts_with("HTTP/1.1 403"));
                assert!(!response.contains("access-control-allow-origin"));
            }
        }
        server.abort();
    }

    #[tokio::test]
    async fn real_http_lifecycle_executes_fake_cli_and_preserves_archived_history() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let f = Fixture::new(&["A"]);
        f.script("A", "echo HTTP_FIXTURE_RESULT");
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = local_router(f.state.clone(), port);
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        async fn request(port: u16, path: &str, body: &str) -> String {
            let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .unwrap();
            stream.write_all(format!("POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            let mut bytes = Vec::new();
            stream.read_to_end(&mut bytes).await.unwrap();
            String::from_utf8(bytes).unwrap()
        }
        let result = request(
            port,
            "/api/chat/send",
            r#"{"chatId":"room","text":"Run fixture"}"#,
        )
        .await;
        assert!(result.starts_with("HTTP/1.1 200"), "{result}");
        f.wait().await;
        let result = request(port, "/api/bot/delete", r#"{"id":"A"}"#).await;
        assert!(result.starts_with("HTTP/1.1 200"), "{result}");
        let snapshot: OmniSnapshot =
            serde_json::from_str(result.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert!(snapshot.bots[0].archived);
        assert!(snapshot.chats[0]
            .messages
            .iter()
            .any(|m| m.text == "HTTP_FIXTURE_RESULT"));
        assert_eq!(snapshot.chats[0].tasks[0].status, "complete");
        assert!(request(
            port,
            "/api/chat/send",
            r#"{"chatId":"room","text":"Do not run"}"#
        )
        .await
        .starts_with("HTTP/1.1 400"));
        server.abort();
    }

    #[test]
    fn control_api_rejects_foreign_origins_and_rebinding_hosts() {
        let mut h = axum::http::HeaderMap::new();
        h.insert("host", "127.0.0.1:4321".parse().unwrap());
        assert!(valid_local_request(&h, 4321));
        h.insert("origin", "https://attacker.example".parse().unwrap());
        assert!(!valid_local_request(&h, 4321));
        h.insert("origin", "http://localhost:1420".parse().unwrap());
        assert!(valid_local_request(&h, 4321));
        h.insert("host", "attacker.example:4321".parse().unwrap());
        assert!(!valid_local_request(&h, 4321));
    }

    #[test]
    fn changing_workspace_invalidates_native_session_and_project_id() {
        let f = Fixture::new(&["A"]);
        {
            let mut g = f.state.write().unwrap();
            g.store.chats[0]
                .native_sessions
                .insert("A".into(), "session".into());
            g.store.chats[0].workspace_id = Some("old-project".into());
        }
        update_chat_thread(
            &f.state,
            UpdateChatInput {
                chat_id: "room".into(),
                title: None,
                participant_bot_ids: None,
                workspace_path: Some("/tmp".into()),
                use_worktrees: None,
                max_swarm_turns: None,
            },
        )
        .unwrap();
        let g = f.state.read().unwrap();
        assert!(g.store.chats[0].native_sessions.is_empty());
        assert!(g.store.chats[0].workspace_id.is_none());
    }

    #[test]
    fn personal_chats_never_inherit_global_project_and_explicit_projects_register() {
        let f = Fixture::new(&["A"]);
        let input = |path: Option<String>| CreateChatInput {
            model_overrides: HashMap::new(),
            bot_home: None,
            title: None,
            subtitle: None,
            participant_bot_ids: vec!["A".into()],
            workspace_id: None,
            workspace_path: path,
            use_worktrees: None,
        };
        let (home, _) = create_chat_thread(&f.state, input(None)).unwrap();
        assert!(home.workspace_path.is_none() && home.workspace_id.is_none());
        assert!(git_root(&f.state, Some(&home.id), None).is_err());
        let (work, _) =
            create_chat_thread(&f.state, input(Some(f.dir.to_string_lossy().into_owned())))
                .unwrap();
        assert!(work.workspace_id.is_some());
        assert_eq!(
            git_root(&f.state, Some(&work.id), None).unwrap(),
            std::fs::canonicalize(&f.dir).unwrap().to_string_lossy()
        );
        assert!(create_chat_thread(
            &f.state,
            input(Some(f.dir.join("missing").to_string_lossy().into_owned()))
        )
        .is_err());
        f.state
            .write()
            .unwrap()
            .store
            .chats
            .iter_mut()
            .find(|c| c.id == home.id)
            .unwrap()
            .is_primary = true;
        assert!(update_chat_thread(
            &f.state,
            UpdateChatInput {
                chat_id: home.id,
                title: None,
                participant_bot_ids: None,
                workspace_path: Some(f.dir.to_string_lossy().into_owned()),
                use_worktrees: None,
                max_swarm_turns: None
            }
        )
        .is_err());
    }

    #[test]
    fn memory_changes_clear_only_affected_sessions_and_require_idle_execution() {
        let f = Fixture::new(&["A"]);
        {
            let mut g = f.state.write().unwrap();
            g.store.chats[0]
                .native_sessions
                .insert("A".into(), "old-session".into());
            g.active_workflows.insert("room".into());
        }
        let mut prefs = f.state.read().unwrap().store.preferences.clone();
        prefs.shared_memories = vec!["A new preference".into()];
        assert!(update_omni_preferences(&f.state, prefs.clone()).is_err());
        f.state.write().unwrap().active_workflows.clear();
        update_omni_preferences(&f.state, prefs).unwrap();
        let g = f.state.read().unwrap();
        assert!(g.store.chats[0].native_sessions.is_empty());
        assert!(
            g.store.workspaces.is_empty(),
            "Saving a preference must not register the app's working directory as a project"
        );
    }

    #[test]
    fn bot_conversations_are_unique_and_do_not_reuse_or_rename_tasks() {
        let f = Fixture::new(&["A"]);
        let request = |home| CreateChatInput {
            model_overrides: HashMap::new(),
            bot_home: Some(home),
            title: Some("A task".into()),
            subtitle: None,
            participant_bot_ids: vec!["A".into()],
            workspace_id: None,
            workspace_path: None,
            use_worktrees: None,
        };
        let (task, _) = create_chat_thread(&f.state, request(false)).unwrap();
        let (home, _) = create_chat_thread(&f.state, request(true)).unwrap();
        let (again, _) = create_chat_thread(&f.state, request(true)).unwrap();
        assert_ne!(task.id, home.id);
        assert_eq!(home.id, again.id);
        assert!(!task.is_bot_home && home.is_bot_home);
        let mut bot = f.state.read().unwrap().store.bots[0].clone();
        bot.name = "Renamed".into();
        upsert_bot_profile(&f.state, bot).unwrap();
        let guard = f.state.read().unwrap();
        assert_eq!(
            guard
                .store
                .chats
                .iter()
                .find(|c| c.id == task.id)
                .unwrap()
                .title,
            "A task"
        );
        assert_eq!(
            guard
                .store
                .chats
                .iter()
                .find(|c| c.id == home.id)
                .unwrap()
                .title,
            "Renamed"
        );
    }

    #[test]
    fn duplicate_bot_names_are_rejected() {
        let f = Fixture::new(&["A", "B"]);
        let mut bot = crate::test_support::bot("B");
        bot.name = "a".into();
        assert!(upsert_bot_profile(&f.state, bot).is_err());
    }
}
