use russh_sftp::client::SftpSession;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::audit::{self, Kind, Origin};
use crate::db::Db;
use crate::error::{Error, Result};
use crate::ssh;

/// One entry in a remote directory.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFile {
    pub name: String,
    /// Bytes. `None` for directories, which is what the design prints as `—`.
    pub size: Option<u64>,
    /// Epoch seconds, or `None` when the server does not report one.
    pub modified: Option<u64>,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    /// The canonical path, so the breadcrumb shows where we really are.
    pub path: String,
    pub files: Vec<RemoteFile>,
}

/// Opens an SFTP subsystem on the session's existing connection.
///
/// A fresh channel per call rather than a cached session: SFTP here is
/// request/response and short-lived, and holding a channel open across the
/// app's lifetime buys nothing while making failures harder to reason about.
async fn open(app: &AppHandle, session_id: &str) -> Result<(SftpSession, i64)> {
    let session = ssh::session(app, session_id)?;
    let channel = session
        .handle
        .channel_open_session()
        .await
        .map_err(|e| Error::Ssh(format!("could not open an SFTP channel: {e}")))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| Error::Ssh(format!("the server refused SFTP: {e}")))?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| Error::Ssh(format!("SFTP handshake failed: {e}")))?;
    Ok((sftp, session.host_id))
}

fn log(app: &AppHandle, host_id: i64, session_id: &str, origin: Origin, command: &str) {
    let db = app.state::<Db>();
    let conn = db.0.lock().unwrap();
    audit::record(&conn, host_id, Some(session_id), origin, Kind::Sftp, command, None);
}

/// Lists a directory. `path` may be empty, meaning "wherever login lands".
///
/// `origin` is passed in by the caller because the same operation is sometimes
/// Portway opening the pane and sometimes the user clicking a folder, and the
/// audit trail has to tell those apart.
pub async fn list(
    app: &AppHandle,
    session_id: &str,
    path: &str,
    origin: Origin,
) -> Result<Listing> {
    let (sftp, host_id) = open(app, session_id).await?;

    let target = if path.trim().is_empty() { ".".to_string() } else { path.to_string() };
    let canonical = sftp
        .canonicalize(&target)
        .await
        .map_err(|e| Error::Ssh(format!("no such directory {target}: {e}")))?;

    log(app, host_id, session_id, origin, &format!("sftp ls {canonical}"));

    let mut files: Vec<RemoteFile> = sftp
        .read_dir(&canonical)
        .await
        .map_err(|e| Error::Ssh(format!("could not read {canonical}: {e}")))?
        .map(|entry| {
            let meta = entry.metadata();
            let is_dir = meta.is_dir();
            RemoteFile {
                name: entry.file_name(),
                size: if is_dir { None } else { meta.size },
                modified: meta.mtime.map(u64::from),
                kind: if is_dir { "dir".into() } else { "file".into() },
            }
        })
        .filter(|f| f.name != "." && f.name != "..")
        .collect();

    // Directories first, then by name — the order the design's mock implies.
    files.sort_by(|a, b| match (a.kind.as_str(), b.kind.as_str()) {
        ("dir", "file") => std::cmp::Ordering::Less,
        ("file", "dir") => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(Listing { path: canonical, files })
}

/// Downloads a remote file to a local path, reporting progress as it goes.
pub async fn download(
    app: &AppHandle,
    session_id: &str,
    remote: &str,
    local: &str,
) -> Result<u64> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let (sftp, host_id) = open(app, session_id).await?;
    log(app, host_id, session_id, Origin::User, &format!("sftp get {remote}"));

    let mut source = sftp
        .open(remote)
        .await
        .map_err(|e| Error::Ssh(format!("could not open {remote}: {e}")))?;
    let mut target = tokio::fs::File::create(local).await?;

    let mut buffer = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let read = source.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        target.write_all(&buffer[..read]).await?;
        total += read as u64;
    }
    target.flush().await?;

    Ok(total)
}

/// Uploads a local file to the remote directory.
pub async fn upload(
    app: &AppHandle,
    session_id: &str,
    local: &str,
    remote: &str,
) -> Result<u64> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let (sftp, host_id) = open(app, session_id).await?;
    log(app, host_id, session_id, Origin::User, &format!("sftp put {remote}"));

    let mut source = tokio::fs::File::open(local).await?;
    let mut target = sftp
        .create(remote)
        .await
        .map_err(|e| Error::Ssh(format!("could not write {remote}: {e}")))?;

    let mut buffer = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let read = source.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        target.write_all(&buffer[..read]).await?;
        total += read as u64;
    }
    target.flush().await?;

    Ok(total)
}
