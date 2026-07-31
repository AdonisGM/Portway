mod audit;
mod commands;
mod db;
mod error;
mod hosts;
mod keychain;
mod keys;
mod models;
mod sftp;
mod ssh;

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
            let home = app
                .path()
                .home_dir()
                .expect("could not resolve the home directory");
            let path = db::database_path(home);
            let conn = db::open(&path)?;
            app.manage(db::Db(Mutex::new(conn)));
            app.manage(ssh::Sessions::default());
            app.manage(sftp::Editing::default());

            // The window is created hidden and the frontend reveals it once it
            // has painted, so a cold start never shows a blank rectangle. This
            // is the backstop: if the webview never gets that far — a broken
            // bundle, a JS error before mount — put the window on screen
            // anyway rather than leaving the app looking like it didn't launch.
            if let Some(window) = app.get_webview_window("main") {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    if matches!(window.is_visible(), Ok(false)) {
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
            commands::host_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
