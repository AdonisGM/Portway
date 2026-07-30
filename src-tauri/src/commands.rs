use tauri::{AppHandle, Manager, State};

use crate::audit::{self, LogEntry, Origin};
use crate::db::Db;
use crate::error::Result;
use crate::sftp::{self, Listing};
use crate::ssh::{self, SessionInfo};
use crate::hosts;

/// Opens a connection and an interactive shell. `sessionId` is chosen by the
/// UI so the tab it just created can subscribe to events before this returns.
#[tauri::command]
pub async fn ssh_connect(app: AppHandle, host_id: i64, session_id: String) -> Result<SessionInfo> {
    let host = {
        let db = app.state::<Db>();
        hosts::get(&db, host_id)?
    };
    ssh::connect(app.clone(), host, session_id).await
}

/// Sends keystrokes. The bytes are base64 so control characters survive JSON.
#[tauri::command]
pub fn ssh_write(app: AppHandle, session_id: String, data: String) -> Result<()> {
    let session = ssh::session(&app, &session_id)?;
    let _ = session.input.send(ssh::decode_base64(&data));
    Ok(())
}

#[tauri::command]
pub fn ssh_resize(app: AppHandle, session_id: String, cols: u32, rows: u32) -> Result<()> {
    let session = ssh::session(&app, &session_id)?;
    let _ = session.resize.send((cols, rows));
    Ok(())
}

#[tauri::command]
pub async fn ssh_disconnect(app: AppHandle, session_id: String) -> Result<()> {
    ssh::disconnect(&app, &session_id).await
}

/// The first listing after a pane opens is Portway's doing, not the user's —
/// hence the `system` flag the UI passes on that one call.
#[tauri::command]
pub async fn sftp_list(
    app: AppHandle,
    session_id: String,
    path: String,
    system: Option<bool>,
) -> Result<Listing> {
    let origin = if system.unwrap_or(false) { Origin::System } else { Origin::User };
    sftp::list(&app, &session_id, &path, origin).await
}

#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    session_id: String,
    remote: String,
    local: String,
) -> Result<u64> {
    sftp::download(&app, &session_id, &remote, &local).await
}

#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    session_id: String,
    local: String,
    remote: String,
) -> Result<u64> {
    sftp::upload(&app, &session_id, &local, &remote).await
}

/// A dropped path — one file, or a directory and everything under it — into the
/// folder the pane is showing.
#[tauri::command]
pub async fn sftp_upload_path(
    app: AppHandle,
    session_id: String,
    local: String,
    remote_dir: String,
) -> Result<u64> {
    sftp::upload_path(&app, &session_id, &local, &remote_dir).await
}

/// Rename, which on a remote filesystem is also move.
#[tauri::command]
pub async fn sftp_rename(
    app: AppHandle,
    session_id: String,
    from: String,
    to: String,
) -> Result<()> {
    sftp::rename(&app, &session_id, &from, &to).await
}

#[tauri::command]
pub async fn sftp_chmod(
    app: AppHandle,
    session_id: String,
    path: String,
    mode: u32,
) -> Result<()> {
    sftp::chmod(&app, &session_id, &path, mode).await
}

/// Returns how many entries were changed, which is the only way the UI can say
/// what a recursive run actually did.
#[tauri::command]
pub async fn sftp_chown(
    app: AppHandle,
    session_id: String,
    path: String,
    uid: u32,
    gid: u32,
    recursive: bool,
) -> Result<u64> {
    sftp::chown(&app, &session_id, &path, uid, gid, recursive).await
}

/// Downloads a file to a scratch copy, opens it in a local application and
/// watches it: saving there writes back to the server.
///
/// `opener` is a chosen application, or `None` for whatever the OS has
/// registered. `confirmed_large` is the user having seen the size warning.
#[tauri::command]
pub async fn sftp_edit(
    app: AppHandle,
    session_id: String,
    remote: String,
    opener: Option<String>,
    confirmed_large: bool,
) -> Result<String> {
    sftp::edit(&app, &session_id, &remote, opener, confirmed_large).await
}

/// The audit trail for one host, newest first.
#[tauri::command]
pub fn host_log(db: State<'_, Db>, host_id: i64, limit: Option<i64>) -> Result<Vec<LogEntry>> {
    let conn = db.0.lock().unwrap();
    audit::recent(&conn, host_id, limit.unwrap_or(50))
}
