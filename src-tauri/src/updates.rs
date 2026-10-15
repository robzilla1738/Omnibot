//! Native Sparkle updates. Feed URLs and trust keys are fixed in Info.plist.
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager};
#[cfg(target_os = "macos")]
use tauri_plugin_sparkle_updater::SparkleUpdaterExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    version: String,
    available: bool,
    automatically_checks: bool,
}

pub struct DraftPersistenceBlocked(pub AtomicBool);

#[tauri::command]
pub fn omni_set_draft_persistence_blocked(app: AppHandle, blocked: bool) {
    app.state::<DraftPersistenceBlocked>()
        .0
        .store(blocked, Ordering::SeqCst);
    refresh_install_permission(&app);
}

fn idle(app: &AppHandle) -> bool {
    if app
        .try_state::<DraftPersistenceBlocked>()
        .is_none_or(|state| state.0.load(Ordering::SeqCst))
    {
        return false;
    }
    app.try_state::<crate::ManagedOmniState>()
        .and_then(|state| {
            state
                .0
                .read()
                .ok()
                .map(|s| s.active_workflows.is_empty() && s.storage_error.is_none())
        })
        .unwrap_or(false)
}

#[tauri::command]
pub async fn omni_update_status(app: AppHandle) -> Result<UpdateStatus, String> {
    let mut status = UpdateStatus {
        version: app.package_info().version.to_string(),
        available: false,
        automatically_checks: false,
    };
    #[cfg(target_os = "macos")]
    if let Some(updater) = app.sparkle_updater() {
        status.available = true;
        status.automatically_checks = updater
            .automatically_checks_for_updates()
            .map_err(|e| e.to_string())?;
    }
    Ok(status)
}

#[tauri::command]
pub async fn omni_check_for_updates(app: AppHandle) -> Result<(), String> {
    check(&app)
}

fn check(app: &AppHandle) -> Result<(), String> {
    if !idle(app) {
        return Err("Finish or stop running tasks and resolve any unsaved draft or storage errors before updating.".into());
    }
    #[cfg(target_os = "macos")]
    if let Some(updater) = app.sparkle_updater() {
        return updater.check_for_updates().map_err(|e| e.to_string());
    }
    Err("Updates are available in the installed macOS app.".into())
}

#[tauri::command]
pub async fn omni_set_automatic_updates(app: AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if let Some(updater) = app.sparkle_updater() {
        return updater
            .set_automatically_checks_for_updates(enabled)
            .map_err(|e| e.to_string());
    }
    Err("Updates are available in the installed macOS app.".into())
}

/// Refresh Sparkle's install/relaunch veto whenever workflow state changes.
pub fn refresh_install_permission(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            // Read at application time: concurrently queued callbacks must not reopen
            // installation using a stale value captured before a workflow/draft change.
            let allowed = idle(&handle);
            if let Some(updater) = handle.sparkle_updater() {
                let _ = updater.set_should_proceed_with_update(allowed);
                let _ = updater.set_should_relaunch_application(allowed);
            }
        });
    }
}

pub fn configure(app: &AppHandle) -> tauri::Result<()> {
    // The frontend clears this after loading its durable drafts successfully.
    app.manage(DraftPersistenceBlocked(AtomicBool::new(true)));
    #[cfg(target_os = "macos")]
    {
        use tauri::menu::{Menu, MenuItem};
        let menu = Menu::default(app)?;
        if let Some(tauri::menu::MenuItemKind::Submenu(app_menu)) = menu.items()?.first() {
            let item = MenuItem::with_id(
                app,
                "check-for-updates",
                "Check for Updates…",
                app.sparkle_updater().is_some(),
                None::<&str>,
            )?;
            app_menu.insert(&item, 1)?;
        }
        app.set_menu(menu)?;
        app.on_menu_event(|app, event| {
            if event.id().as_ref() == "check-for-updates" {
                if let Err(error) = check(app) {
                    use tauri::Emitter;
                    let _ = app.emit("app-update-error", error);
                }
            }
        });
        refresh_install_permission(app);
    }
    Ok(())
}
