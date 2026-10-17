//! Running without a window. Connect only answers other machines while Portway
//! runs, so the app can stay in the tray (the menu bar on macOS): the close
//! button then hides the window instead of quitting, and Portway can start at
//! login without opening one.
//!
//! The tray is there whenever either "keep running in the background" is on or
//! Portway starts at login (it would otherwise start invisible). What the OS
//! says about starting at login is the truth, not `settings.json`.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Window, WindowEvent};
use tauri_plugin_autostart::ManagerExt;

use crate::error::{AppError, AppResult};
use crate::settings::SettingsStore;

/// Given to the copy the OS starts at login: no window.
pub const HIDDEN_FLAG: &str = "--hidden";
const TRAY_ID: &str = "portway";

pub fn started_hidden() -> bool {
    std::env::args().any(|a| a == HIDDEN_FLAG)
}

/// Whether closing the main window hides it. Read by the window event handler.
#[derive(Default)]
pub struct Background {
    on: AtomicBool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundView {
    /// The OS will start Portway when the user logs in.
    pub autostart: bool,
    /// The user's own choice to keep running when the window is closed.
    pub background: bool,
    /// Starting at login is on offer: not in a dev build, which would register
    /// the debug binary and open a window pointing at a dev server that is not there.
    pub can_autostart: bool,
}

fn autostart_enabled(app: &AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

pub fn view(app: &AppHandle) -> BackgroundView {
    BackgroundView { autostart: autostart_enabled(app), background: app.state::<SettingsStore>().get().background, can_autostart: !cfg!(debug_assertions) }
}

/// Bring the tray and the close behaviour in line with the settings and the OS.
/// Called at start and after anything that could change them (also the language,
/// which the tray menu is written in).
pub fn refresh(app: &AppHandle) {
    let v = view(app);
    let on = v.background || v.autostart;
    app.state::<Background>().on.store(on, Ordering::Relaxed);
    let existing = app.tray_by_id(TRAY_ID);
    match (on, existing) {
        (true, Some(tray)) => {
            if let Ok(menu) = menu(app) {
                let _ = tray.set_menu(Some(menu));
            }
        }
        (true, None) => {
            let _ = build_tray(app);
        }
        (false, Some(_)) => {
            let _ = app.remove_tray_by_id(TRAY_ID);
        }
        (false, None) => {}
    }
}

fn menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let open = MenuItem::with_id(app, "open", crate::i18n::tr("Mở Portway", "Open Portway"), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", crate::i18n::tr("Thoát Portway", "Quit Portway"), true, None::<&str>)?;
    Menu::with_items(app, &[&open, &PredefinedMenuItem::separator(app)?, &quit])
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Portway")
        .menu(&menu(app)?)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    // On macOS a click on the menu bar icon opens its menu; on Windows the
    // menu is for the right button and a left click opens the window.
    #[cfg(windows)]
    {
        builder = builder.show_menu_on_left_click(false).on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, button_state: tauri::tray::MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    }
    builder.build(app)?;
    Ok(())
}

/// The main window in front of everything, from wherever it was (hidden,
/// minimised, behind others).
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// The close button: hide the main window instead of quitting when Portway is
/// meant to keep running. Quitting stays possible from the tray and with Cmd+Q.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != "main" {
        return;
    }
    if let WindowEvent::CloseRequested { api, .. } = event {
        if window.app_handle().state::<Background>().on.load(Ordering::Relaxed) {
            api.prevent_close();
            let _ = window.hide();
        }
    }
}

#[tauri::command]
pub fn background_state(app: AppHandle) -> BackgroundView {
    view(&app)
}

/// Turn starting at login on or off, then check what the OS now says.
#[tauri::command]
pub fn background_set_autostart(app: AppHandle, on: bool) -> AppResult<BackgroundView> {
    if cfg!(debug_assertions) {
        return Err(AppError::new("autostart_dev"));
    }
    let manager = app.autolaunch();
    let done = if on { manager.enable() } else { manager.disable() };
    done.map_err(|e| AppError::detail("autostart_failed", e))?;
    if manager.is_enabled().unwrap_or(false) != on {
        return Err(AppError::new("autostart_failed"));
    }
    refresh(&app);
    Ok(view(&app))
}
