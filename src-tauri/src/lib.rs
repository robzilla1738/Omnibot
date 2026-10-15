pub mod computer;
pub mod drivers;
pub mod execution;
pub mod git_ops;
pub mod homes;
pub mod lifecycle;
pub mod models;
pub mod orchestrator;
pub mod routines;
pub mod routing;
pub mod scanner;
pub mod server;
pub mod setup;
pub mod state;
pub mod terminal;
pub mod updates;
mod workflow;

use computer::{
    get_system_overview, list_workspace_directory, open_on_desktop, read_workspace_file,
    LocalFileEntry, SystemOverview,
};
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
struct ManagedApiToken(String);

/// Keeps disk writes and process spawns off the main (UI) thread.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

fn workspace_root(state: &SharedOmniState) -> Result<String, String> {
    let guard = state
        .read()
        .map_err(|_| "State lock poisoned".to_string())?;
    Ok(guard.store.preferences.workspace_root.clone())
}

#[tauri::command]
fn omni_api_token(token: State<'_, ManagedApiToken>) -> String {
    token.0.clone()
}

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
async fn omni_create_chat(
    state: State<'_, ManagedOmniState>,
    input: CreateChatInput,
) -> Result<(ChatThread, OmniSnapshot), String> {
    let state = state.0.clone();
    blocking(move || create_chat_thread(&state, input)).await
}

#[tauri::command]
async fn omni_complete_setup(
    state: State<'_, ManagedOmniState>,
    input: setup::SetupInput,
) -> Result<OmniSnapshot, String> {
    let state = state.0.clone();
    blocking(move || setup::complete_setup(&state, input)).await
}

#[tauri::command]
async fn omni_pin_bot(
    state: State<'_, ManagedOmniState>,
    input: setup::PinBotInput,
) -> Result<OmniSnapshot, String> {
    let state = state.0.clone();
    blocking(move || setup::pin_bot(&state, input)).await
}

#[tauri::command]
async fn omni_update_chat(
    state: State<'_, ManagedOmniState>,
    input: UpdateChatInput,
) -> Result<OmniSnapshot, String> {
    let state = state.0.clone();
    blocking(move || update_chat_thread(&state, input)).await
}

#[tauri::command]
async fn omni_clear_chat(
    state: State<'_, ManagedOmniState>,
    id: String,
) -> Result<OmniSnapshot, String> {
    let state = state.0.clone();
    blocking(move || clear_chat_thread(&state, &id)).await
}

#[tauri::command]
async fn omni_delete_chat(
    state: State<'_, ManagedOmniState>,
    id: String,
) -> Result<OmniSnapshot, String> {
    let state = state.0.clone();
    blocking(move || delete_chat_thread(&state, &id)).await
}

#[tauri::command]
async fn omni_upsert_bot(
    state: State<'_, ManagedOmniState>,
    bot: BotProfile,
) -> Result<OmniSnapshot, String> {
    let state = state.0.clone();
    blocking(move || upsert_bot_profile(&state, bot)).await
}

#[tauri::command]
async fn omni_delete_bot(
    state: State<'_, ManagedOmniState>,
    id: String,
) -> Result<OmniSnapshot, String> {
    let state = state.0.clone();
    blocking(move || delete_bot_profile(&state, &id)).await
}

#[tauri::command]
async fn omni_update_preferences(
    state: State<'_, ManagedOmniState>,
    preferences: OmniPreferences,
) -> Result<OmniSnapshot, String> {
    let state = state.0.clone();
    blocking(move || update_omni_preferences(&state, preferences)).await
}

#[tauri::command]
async fn omni_upsert_workspace(
    state: State<'_, ManagedOmniState>,
    workspace: WorkspaceEntry,
) -> Result<OmniSnapshot, String> {
    let state = state.0.clone();
    blocking(move || upsert_workspace_entry(&state, workspace)).await
}

#[tauri::command]
async fn omni_delete_workspace(
    state: State<'_, ManagedOmniState>,
    id: String,
) -> Result<OmniSnapshot, String> {
    let state = state.0.clone();
    blocking(move || delete_workspace_entry(&state, &id)).await
}

#[tauri::command]
async fn omni_upsert_routine(
    state: State<'_, ManagedOmniState>,
    routine: RoutineEntry,
) -> Result<OmniSnapshot, String> {
    let state = state.0.clone();
    blocking(move || upsert_routine_entry(&state, routine)).await
}

#[tauri::command]
async fn omni_delete_routine(
    state: State<'_, ManagedOmniState>,
    id: String,
) -> Result<OmniSnapshot, String> {
    let state = state.0.clone();
    blocking(move || delete_routine_entry(&state, &id)).await
}

#[tauri::command]
async fn omni_computer_overview(
    state: State<'_, ManagedOmniState>,
) -> Result<SystemOverview, String> {
    let root = workspace_root(&state.0)?;
    blocking(move || Ok(get_system_overview(&root))).await
}

#[tauri::command]
async fn omni_list_local_files(
    state: State<'_, ManagedOmniState>,
    relative_path: Option<String>,
) -> Result<Vec<LocalFileEntry>, String> {
    let root = workspace_root(&state.0)?;
    blocking(move || list_workspace_directory(&root, relative_path.as_deref())).await
}

#[tauri::command]
async fn omni_read_local_file(
    state: State<'_, ManagedOmniState>,
    path: String,
    max_bytes: Option<usize>,
) -> Result<String, String> {
    let root = workspace_root(&state.0)?;
    blocking(move || read_workspace_file(&root, &path, max_bytes.unwrap_or(64_000))).await
}

#[tauri::command]
async fn omni_open_local_item(
    state: State<'_, ManagedOmniState>,
    target: String,
    app_name: Option<String>,
    reveal_in_finder: Option<bool>,
) -> Result<String, String> {
    let root = workspace_root(&state.0)?;
    blocking(move || {
        open_on_desktop(
            &root,
            &target,
            app_name.as_deref(),
            reveal_in_finder.unwrap_or(false),
        )
    })
    .await
}

#[tauri::command]
async fn omni_open_external_url(url: String) -> Result<(), String> {
    blocking(move || computer::open_external_url(&url)).await
}

#[tauri::command]
async fn omni_test_harness(kind: CliDriverKind) -> Result<CliHarnessTestResult, String> {
    blocking(move || Ok(test_cli_harness(kind))).await
}

fn is_app_url(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "about" => url.path() == "blank",
        "http" if cfg!(debug_assertions) => {
            matches!(url.host_str(), Some("localhost" | "127.0.0.1"))
                && matches!(url.port(), Some(1420 | 1422))
        }
        _ => false,
    }
}

/// Keeps the webview on the app's own pages; web and mail links open in the default app.
fn navigation_guard<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("navigation-guard")
        .on_navigation(|_, url| {
            if is_app_url(url) {
                return true;
            }
            if matches!(url.scheme(), "http" | "https" | "mailto") {
                let url = url.to_string();
                std::thread::spawn(move || {
                    if let Err(error) = computer::open_external_url(&url) {
                        eprintln!("Couldn't open {url}: {error}");
                    }
                });
            }
            false
        })
        .build()
}

/// Shows a native alert, then exits. Text is passed as script arguments so it is never
/// interpreted as AppleScript.
fn fail_startup(message: &str, show_alert: bool) -> ! {
    eprintln!("Omnibot couldn't start: {message}");
    if show_alert {
        let _ = std::process::Command::new("/usr/bin/osascript")
            .args([
                "-e",
                "on run argv",
                "-e",
                "display alert (item 1 of argv) message (item 2 of argv) as critical",
                "-e",
                "end run",
                "Omnibot couldn't start",
                message,
            ])
            .status();
    }
    std::process::exit(1)
}

/// The single exit path for both the window app and `--server-only`.
fn shutdown(state: &SharedOmniState) {
    terminal::shutdown(state);
}

async fn wait_for_termination() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        match signal(SignalKind::terminate()) {
            Ok(mut terminate) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = terminate.recv() => {}
                }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}

pub fn run() {
    let server_only = std::env::args().any(|a| a == "--server-only");
    let runtime = tokio::runtime::Runtime::new().unwrap_or_else(|error| {
        fail_startup(
            &format!("The background runtime couldn't start: {error}"),
            !server_only,
        )
    });
    let server = runtime
        .block_on(spawn_local_server())
        .unwrap_or_else(|error| fail_startup(&error, !server_only));
    let shared_state = server.state;

    runtime.spawn(state::finish_startup_scan(shared_state.clone()));
    runtime.spawn(routines::scheduler(shared_state.clone()));

    if server_only {
        println!(
            "Omnibot server listening on http://127.0.0.1:{}",
            server.port
        );
        runtime.block_on(wait_for_termination());
        shutdown(&shared_state);
        return;
    }

    tauri::async_runtime::set(runtime.handle().clone());

    let builder = tauri::Builder::default().plugin(navigation_guard());
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_plugin_sparkle_updater::init());
    let shutdown_state = shared_state.clone();
    let event_tx = server.events;
    let api_token = server.api_token;
    let app = builder
        .setup(move |app| {
            app.manage(ManagedOmniState(shared_state.clone()));
            app.manage(ManagedApiToken(api_token.clone()));
            updates::configure(app.handle())?;

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
                    if matches!(event, state::OmniStreamEvent::StateUpdated { .. }) {
                        updates::refresh_install_permission(&app_handle);
                    }
                    let _ = app_handle.emit("omni-stream-event", &event);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            updates::omni_update_status,
            updates::omni_check_for_updates,
            updates::omni_set_automatic_updates,
            omni_api_token,
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
            omni_open_local_item,
            omni_open_external_url,
            omni_test_harness,
        ])
        .build(tauri::generate_context!())
        .unwrap_or_else(|error| {
            fail_startup(
                &format!("The app window couldn't be created: {error}"),
                true,
            )
        });
    app.run(move |_, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            shutdown(&shutdown_state);
        }
    });
}

#[cfg(test)]
mod test_support;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_stays_on_app_pages() {
        let url = |s: &str| tauri::Url::parse(s).unwrap();
        assert!(is_app_url(&url("tauri://localhost/index.html")));
        assert!(is_app_url(&url("about:blank")));
        assert!(!is_app_url(&url("tauri://elsewhere/")));
        assert!(!is_app_url(&url("https://example.com/")));
        assert!(!is_app_url(&url("http://localhost:3000/")));
        assert!(!is_app_url(&url("file:///etc/passwd")));
        assert_eq!(
            is_app_url(&url("http://localhost:1420/")),
            cfg!(debug_assertions)
        );
    }
}
