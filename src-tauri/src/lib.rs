pub mod computer;
pub mod drivers;
pub mod git_ops;
pub mod orchestrator;
pub mod scanner;
pub mod server;
pub mod state;

use computer::{
    get_system_overview, list_workspace_directory, open_on_desktop, read_workspace_file,
    search_workspace_files, write_clipboard_text, LocalFileEntry, SystemOverview,
};
use git_ops::read_file_diff;
use orchestrator::{dispatch_chat_turn, SendMessageInput};
use server::{
    create_chat_thread, delete_bot_profile, delete_chat_thread, delete_routine_entry,
    delete_workspace_entry, spawn_local_server, stop_chat_runs, update_chat_thread,
    update_omni_preferences, upsert_bot_profile, upsert_routine_entry, upsert_workspace_entry,
    CreateChatInput, UpdateChatInput,
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
fn omni_rescan(state: State<'_, ManagedOmniState>) -> Result<OmniSnapshot, String> {
    let mut guard = state
        .0
        .write()
        .map_err(|_| "State lock poisoned".to_string())?;
    guard.rescan_environment();
    Ok(guard.snapshot())
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
fn omni_update_chat(
    state: State<'_, ManagedOmniState>,
    input: UpdateChatInput,
) -> Result<OmniSnapshot, String> {
    update_chat_thread(&state.0, input)
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
fn omni_delete_bot(
    state: State<'_, ManagedOmniState>,
    id: String,
) -> Result<OmniSnapshot, String> {
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
fn omni_git_diff(
    state: State<'_, ManagedOmniState>,
    file_path: String,
) -> Result<String, String> {
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
fn omni_write_clipboard(text: String) -> Result<String, String> {
    write_clipboard_text(&text)
}

pub fn run() {
    let runtime = tokio::runtime::Runtime::new().expect("Failed to initialize Tokio runtime");
    let (port, shared_state, event_tx) = runtime
        .block_on(spawn_local_server())
        .expect("Failed to start local Omni Bot server");

    if std::env::args().any(|a| a == "--server-only") {
        println!("Omni Bot server listening on http://127.0.0.1:{port}");
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
                while let Ok(ev) = rx.recv().await {
                    let _ = app_handle.emit("omni-stream-event", &ev);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            omni_snapshot,
            omni_rescan,
            omni_send_message,
            omni_stop_chat,
            omni_create_chat,
            omni_update_chat,
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
            omni_write_clipboard,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Omni Bot");
}
