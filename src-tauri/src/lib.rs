mod audit;
mod commands;
mod db;
mod error;
mod hosts;
mod keychain;
mod keys;
mod known;
mod logging;
mod models;
mod sftp;
mod ssh;
mod tunnels;

use std::sync::Mutex;

use tauri::Manager;

/// Hosts are persisted, SSH and SFTP are live, and every command that reaches
/// a host is written to the audit trail in `command_log`. Key passphrases go to
/// the OS keychain (`keychain.rs`) and never to the database. Still ahead:
/// password auth, which is refused with a message rather than guessed at.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Powers the form's "Choose file…" — the file field needs a real
        // filesystem path, and a webview <input type="file"> never yields one.
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // First, before anything that can fail. The database not opening is
            // exactly the kind of start worth having a record of, and a log
            // installed after it would miss it.
            logging::mark_start();
            logging::init(app.handle());

            let home = app
                .path()
                .home_dir()
                .expect("could not resolve the home directory");
            let path = db::database_path(home);
            let conn = match db::open(&path) {
                Ok(conn) => conn,
                Err(e) => {
                    logging::error(
                        "db",
                        "could not open the database",
                        Some(&format!("{} — {e}", path.display())),
                    );
                    return Err(e.into());
                }
            };
            logging::info("db", "database ready", Some(&path.display().to_string()));
            app.manage(db::Db(Mutex::new(conn)));
            app.manage(ssh::Sessions::default());
            app.manage(sftp::Editing::default());
            app.manage(tunnels::Tunnels::default());
            app.manage(tunnels::TunnelStates::default());

            // Tunnels that asked to come up on their own. Spawned rather than
            // awaited: a server that is slow to answer must not hold the
            // window back, and a forward that cannot start reports itself
            // through its own state rather than a startup failure.
            tunnels::autostart(app.handle(), "launch", None);

            // The window is created hidden and the frontend reveals it once it
            // has painted, so a cold start never shows a blank rectangle. This
            // is the backstop: if the webview never gets that far — a broken
            // bundle, a JS error before mount — put the window on screen
            // anyway rather than leaving the app looking like it didn't launch.
            if let Some(window) = app.get_webview_window("main") {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    if matches!(window.is_visible(), Ok(false)) {
                        // Worth a line: reaching this means the frontend never
                        // finished mounting, and the window the user is looking
                        // at was put there by a timeout rather than by the app.
                        logging::warn(
                            "app",
                            "the window was revealed by the backstop",
                            Some("the frontend did not report a first paint within 5s"),
                        );
                        let _ = window.show();
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            hosts::list_hosts,
            hosts::create_host,
            hosts::update_host,
            hosts::delete_host,
            hosts::touch_host,
            hosts::set_host_favorite,
            keys::list_ssh_keys,
            keys::read_public_key,
            known::list_known_hosts,
            known::remove_known_host,
            commands::ssh_connect,
            commands::ssh_write,
            commands::ssh_resize,
            commands::ssh_disconnect,
            commands::sftp_list,
            commands::sftp_download,
            commands::sftp_upload,
            commands::sftp_upload_path,
            commands::sftp_rename,
            commands::sftp_chmod,
            commands::sftp_chown,
            commands::sftp_remove,
            commands::sftp_edit,
            commands::open_session_window,
            commands::open_debug_window,
            commands::host_log,
            commands::open_url,
            logging::log_backlog,
            logging::log_write,
            logging::set_log_level,
            logging::debug_info,
            logging::reveal_logs,
            tunnels::list_tunnels,
            tunnels::tunnel_states,
            tunnels::create_tunnel,
            tunnels::update_tunnel,
            tunnels::delete_tunnel,
            tunnels::start_tunnel,
            tunnels::check_tunnel,
            tunnels::stop_tunnel,
        ])
        // Closing a session window has to end its connections. A tab close
        // goes through `ssh_disconnect`; a window close does not, and an
        // orphaned session in the map holds a live PTY the user can no longer
        // see or reach.
        .on_window_event(|window, event| {
            if !matches!(event, tauri::WindowEvent::Destroyed) {
                return;
            }
            let app = window.app_handle().clone();
            let label = window.label().to_string();
            tauri::async_runtime::spawn(async move {
                let owned = ssh::sessions_of_window(&app, &label);
                logging::info(
                    "app",
                    "a window closed",
                    Some(&format!("window={label} sessions={}", owned.len())),
                );
                for id in owned {
                    let _ = ssh::disconnect(&app, &id).await;
                }
            });
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
