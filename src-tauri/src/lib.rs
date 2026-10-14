pub mod computer;
pub mod drivers;
pub mod git_ops;
pub mod homes;
pub mod models;
pub mod orchestrator;
pub mod routines;
pub mod scanner;
pub mod server;
pub mod setup;
pub mod state;

use computer::{
    get_system_overview, list_workspace_directory, open_on_desktop, read_workspace_file,
    search_workspace_files, write_clipboard_text, LocalFileEntry, SystemOverview,
};
use git_ops::{git_discard_file, git_stage_and_commit, read_file_diff};
use orchestrator::{dispatch_chat_turn, SendMessageInput};
use scanner::{test_cli_harness, CliDriverKind, CliHarnessTestResult};
use server::{
    clear_chat_thread, create_chat_thread, delete_bot_profile, delete_chat_thread,
    delete_routine_entry, delete_workspace_entry, spawn_local_server, stop_chat_runs,
    update_chat_thread, update_omni_preferences, upsert_bot_profile, upsert_routine_entry,
    upsert_workspace_entry, CreateChatInput, UpdateChatInput,
};
use state::{
    BotProfile, ChatThread, OmniPreferences, OmniSnapshot, RoutineEntry, SharedOmniState,
    WorkspaceEntry,
};
use tauri::{Emitter, Manager, State};

struct ManagedOmniState(SharedOmniState);

#[tauri::command]
fn omni_snapshot(state: State<'_, ManagedOmniState>) -> Result<OmniSnapshot, String> {
    let guard = state
        .0
        .read()
        .map_err(|_| "State lock poisoned".to_string())?;
    Ok(guard.snapshot())
}

#[tauri::command]
async fn omni_rescan(state: State<'_, ManagedOmniState>) -> Result<OmniSnapshot, String> {
    state::rescan_environment(state.0.clone()).await
}

#[tauri::command]
async fn omni_send_message(
    state: State<'_, ManagedOmniState>,
    input: SendMessageInput,
) -> Result<String, String> {
    dispatch_chat_turn(state.0.clone(), input).await
}

#[tauri::command]
fn omni_stop_chat(
    state: State<'_, ManagedOmniState>,
    chat_id: String,
) -> Result<OmniSnapshot, String> {
    stop_chat_runs(&state.0, &chat_id)
}

#[tauri::command]
fn omni_create_chat(
    state: State<'_, ManagedOmniState>,
    input: CreateChatInput,
) -> Result<(ChatThread, OmniSnapshot), String> {
    create_chat_thread(&state.0, input)
}

#[tauri::command]
fn omni_complete_setup(
    state: State<'_, ManagedOmniState>,
    input: setup::SetupInput,
) -> Result<OmniSnapshot, String> {
    setup::complete_setup(&state.0, input)
}

#[tauri::command]
fn omni_pin_bot(
    state: State<'_, ManagedOmniState>,
    input: setup::PinBotInput,
) -> Result<OmniSnapshot, String> {
    setup::pin_bot(&state.0, input)
}

#[tauri::command]
fn omni_update_chat(
    state: State<'_, ManagedOmniState>,
    input: UpdateChatInput,
) -> Result<OmniSnapshot, String> {
    update_chat_thread(&state.0, input)
}

#[tauri::command]
fn omni_clear_chat(state: State<'_, ManagedOmniState>, id: String) -> Result<OmniSnapshot, String> {
    clear_chat_thread(&state.0, &id)
}

#[tauri::command]
fn omni_delete_chat(
    state: State<'_, ManagedOmniState>,
    id: String,
) -> Result<OmniSnapshot, String> {
    delete_chat_thread(&state.0, &id)
}

#[tauri::command]
fn omni_upsert_bot(
    state: State<'_, ManagedOmniState>,
    bot: BotProfile,
) -> Result<OmniSnapshot, String> {
    upsert_bot_profile(&state.0, bot)
}

#[tauri::command]
fn omni_delete_bot(state: State<'_, ManagedOmniState>, id: String) -> Result<OmniSnapshot, String> {
    delete_bot_profile(&state.0, &id)
}

#[tauri::command]
fn omni_update_preferences(
    state: State<'_, ManagedOmniState>,
    preferences: OmniPreferences,
) -> Result<OmniSnapshot, String> {
    update_omni_preferences(&state.0, preferences)
}

#[tauri::command]
fn omni_upsert_workspace(
    state: State<'_, ManagedOmniState>,
    workspace: WorkspaceEntry,
) -> Result<OmniSnapshot, String> {
    upsert_workspace_entry(&state.0, workspace)
}

#[tauri::command]
fn omni_delete_workspace(
    state: State<'_, ManagedOmniState>,
    id: String,
) -> Result<OmniSnapshot, String> {
    delete_workspace_entry(&state.0, &id)
}

#[tauri::command]
fn omni_upsert_routine(
    state: State<'_, ManagedOmniState>,
    routine: RoutineEntry,
) -> Result<OmniSnapshot, String> {
    upsert_routine_entry(&state.0, routine)
}

#[tauri::command]
fn omni_delete_routine(
    state: State<'_, ManagedOmniState>,
    id: String,
) -> Result<OmniSnapshot, String> {
    delete_routine_entry(&state.0, &id)
}

#[tauri::command]
fn omni_computer_overview(state: State<'_, ManagedOmniState>) -> Result<SystemOverview, String> {
    let guard = state
        .0
        .read()
        .map_err(|_| "State lock poisoned".to_string())?;
    Ok(get_system_overview(&guard.store.preferences.workspace_root))
}

#[tauri::command]
fn omni_list_local_files(
    state: State<'_, ManagedOmniState>,
    relative_path: Option<String>,
) -> Result<Vec<LocalFileEntry>, String> {
    let root = {
        let guard = state
            .0
            .read()
            .map_err(|_| "State lock poisoned".to_string())?;
        guard.store.preferences.workspace_root.clone()
    };
    list_workspace_directory(&root, relative_path.as_deref())
}

#[tauri::command]
fn omni_read_local_file(
    state: State<'_, ManagedOmniState>,
    path: String,
    max_bytes: Option<usize>,
) -> Result<String, String> {
    let root = {
        let guard = state
            .0
            .read()
            .map_err(|_| "State lock poisoned".to_string())?;
        guard.store.preferences.workspace_root.clone()
    };
    read_workspace_file(&root, &path, max_bytes.unwrap_or(64_000))
}

#[tauri::command]
fn omni_search_local_files(
    state: State<'_, ManagedOmniState>,
    query: String,
    base_path: Option<String>,
) -> Result<Vec<LocalFileEntry>, String> {
    let root = {
        let guard = state
            .0
            .read()
            .map_err(|_| "State lock poisoned".to_string())?;
        guard.store.preferences.workspace_root.clone()
    };
    search_workspace_files(&root, &query, base_path.as_deref())
}

#[tauri::command]
fn omni_open_local_item(
    state: State<'_, ManagedOmniState>,
    target: String,
    app_name: Option<String>,
    reveal_in_finder: Option<bool>,
) -> Result<String, String> {
    let root = {
        let guard = state
            .0
            .read()
            .map_err(|_| "State lock poisoned".to_string())?;
        guard.store.preferences.workspace_root.clone()
    };
    open_on_desktop(
        &root,
        &target,
        app_name.as_deref(),
        reveal_in_finder.unwrap_or(false),
    )
}

#[tauri::command]
fn omni_git_diff(state: State<'_, ManagedOmniState>, file_path: String) -> Result<String, String> {
    let root = {
        let guard = state
            .0
            .read()
            .map_err(|_| "State lock poisoned".to_string())?;
        guard.store.preferences.workspace_root.clone()
    };
    read_file_diff(&root, &file_path)
}

#[tauri::command]
fn omni_git_commit(
    state: State<'_, ManagedOmniState>,
    message: String,
) -> Result<OmniSnapshot, String> {
    let root = {
        let guard = state
            .0
            .read()
            .map_err(|_| "State lock poisoned".to_string())?;
        guard.store.preferences.workspace_root.clone()
    };
    git_stage_and_commit(&root, &message)?;
    let guard = state
        .0
        .read()
        .map_err(|_| "State lock poisoned".to_string())?;
    Ok(guard.snapshot())
}

#[tauri::command]
fn omni_git_discard(
    state: State<'_, ManagedOmniState>,
    file_path: String,
) -> Result<OmniSnapshot, String> {
    let root = {
        let guard = state
            .0
            .read()
            .map_err(|_| "State lock poisoned".to_string())?;
        guard.store.preferences.workspace_root.clone()
    };
    git_discard_file(&root, &file_path)?;
    let guard = state
        .0
        .read()
        .map_err(|_| "State lock poisoned".to_string())?;
    Ok(guard.snapshot())
}

#[tauri::command]
fn omni_test_harness(kind: CliDriverKind) -> CliHarnessTestResult {
    test_cli_harness(kind)
}

#[tauri::command]
fn omni_write_clipboard(text: String) -> Result<String, String> {
    write_clipboard_text(&text)
}

pub fn run() {
    let runtime = tokio::runtime::Runtime::new().expect("Failed to initialize Tokio runtime");
    let (port, shared_state, event_tx) = runtime
        .block_on(spawn_local_server())
        .expect("Failed to start local Omnibot server");

    runtime.spawn(models::refresh(shared_state.clone()));
    runtime.spawn(routines::scheduler(shared_state.clone()));

    if std::env::args().any(|a| a == "--server-only") {
        println!("Omnibot server listening on http://127.0.0.1:{port}");
        runtime.block_on(async {
            let _ = tokio::signal::ctrl_c().await;
        });
        return;
    }

    tauri::async_runtime::set(runtime.handle().clone());

    tauri::Builder::default()
        .setup(move |app| {
            let _icon_bytes = include_bytes!("../icons/icon.icns");
            app.manage(ManagedOmniState(shared_state.clone()));

            // Forward broadcast stream events to Tauri window events as well
            let app_handle = app.handle().clone();
            let mut rx = event_tx.subscribe();
            tauri::async_runtime::spawn(async move {
                loop {
                    let event = match rx.recv().await {
                        Ok(event) => event,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            state::OmniStreamEvent::StateUpdated { chat_id: None }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    };
                    let _ = app_handle.emit("omni-stream-event", &event);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            omni_snapshot,
            omni_complete_setup,
            omni_pin_bot,
            omni_rescan,
            omni_send_message,
            omni_stop_chat,
            omni_create_chat,
            omni_update_chat,
            omni_clear_chat,
            omni_delete_chat,
            omni_upsert_bot,
            omni_delete_bot,
            omni_update_preferences,
            omni_upsert_workspace,
            omni_delete_workspace,
            omni_upsert_routine,
            omni_delete_routine,
            omni_computer_overview,
            omni_list_local_files,
            omni_read_local_file,
            omni_search_local_files,
            omni_open_local_item,
            omni_git_diff,
            omni_git_commit,
            omni_git_discard,
            omni_test_harness,
            omni_write_clipboard,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Omnibot");
}

#[cfg(test)]
mod test_support;
