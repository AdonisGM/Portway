mod audit;
mod disks;
mod docker;
mod error;
mod files;
mod keys;
mod paths;
mod ports;
mod servers;
mod ssh;
mod ssh_config;
mod transfers;

use tauri::Manager;

/// Show or hide the native macOS traffic lights. The splash screen hides them so
/// the launch screen is only the logo, and brings them back as it fades out.
#[tauri::command]
fn set_window_controls_visible(window: tauri::WebviewWindow, visible: bool) {
    #[cfg(target_os = "macos")]
    macos::set_window_controls_visible(&window, visible);
    #[cfg(not(target_os = "macos"))]
    let _ = (window, visible);
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2_app_kit::{NSWindow, NSWindowButton};

    pub fn set_window_controls_visible(window: &tauri::WebviewWindow, visible: bool) {
        let Ok(ptr) = window.ns_window() else { return };
        // AppKit views may only be touched on the main thread.
        let ptr = ptr as usize;
        let _ = window.run_on_main_thread(move || {
            // SAFETY: the pointer comes from Tauri for a live window and is used on
            // the main thread, as AppKit requires.
            let ns_window = unsafe { &*(ptr as *const NSWindow) };
            for kind in [
                NSWindowButton::CloseButton,
                NSWindowButton::MiniaturizeButton,
                NSWindowButton::ZoomButton,
            ] {
                if let Some(button) = ns_window.standardWindowButton(kind) {
                    button.setHidden(!visible);
                }
            }
        });
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            set_window_controls_visible,
            servers::servers_list,
            servers::server_save,
            servers::server_delete,
            servers::server_set_pinned,
            servers::servers_import_ssh_config,
            keys::ssh_keys_list,
            keys::ssh_key_public,
            keys::ssh_key_generate,
            ssh::ssh_connect,
            ssh::ssh_reconnect,
            ssh::ssh_disconnect,
            ssh::ssh_sudo,
            ssh::ssh_sudo_off,
            audit::audit_list,
            files::sftp_list,
            files::sftp_mkdir,
            files::sftp_touch,
            files::sftp_rename,
            files::sftp_remove,
            files::sftp_chmod,
            files::sftp_chown,
            transfers::transfer_download,
            transfers::transfer_upload,
            transfers::transfer_list,
            transfers::transfer_cancel,
            transfers::transfer_retry,
            transfers::transfer_clear,
            ssh::ssh_disconnect_all,
            ssh::ssh_forget_secret,
            ssh::server_stats,
            ssh::server_processes,
            ssh::server_health,
            ssh::server_ports,
            ssh::server_disks,
            ssh::server_docker_disk,
            ssh::open_terminal,
            docker::docker_overview,
            docker::docker_stats,
            docker::docker_container,
            docker::docker_compose,
            docker::docker_start_daemon,
            docker::docker_logs,
            docker::docker_images,
            docker::docker_image_prune,
            docker::docker_volumes,
            docker::docker_volume_sizes,
            docker::docker_volume_remove,
        ])
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let store = servers::ServerStore::load(data_dir.join("servers.json"))
                .map_err(|e| format!("cannot load servers.json: {} {}", e.code, e.detail.unwrap_or_default()))?;
            app.manage(store);
            app.manage(ssh::Sessions::default());
            app.manage(audit::AuditLog::load(data_dir.join("audit.jsonl")));
            app.manage(std::sync::Arc::new(transfers::Transfers::new(app.handle().clone())));

            // Hidden from the first frame; the splash shows them again when it fades.
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "macos")]
                macos::set_window_controls_visible(&window, false);
                #[cfg(not(target_os = "macos"))]
                let _ = window;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
