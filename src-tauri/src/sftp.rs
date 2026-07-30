use russh_sftp::client::fs::Metadata;
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
    /// Numeric owner and group. SFTP v3 carries the *names* only in the
    /// `longname` field of a readdir reply, and russh-sftp's client drops it —
    /// so numbers are all that is reachable without reading `/etc/passwd` off
    /// the host, which is a round trip the user did not ask for.
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    /// `755` — what the user asked for by name.
    pub mode: Option<String>,
    /// `rwxr-xr-x` — the same bits, in the form that makes a wrong one obvious.
    pub mode_text: Option<String>,
}

/// The permission bits, in both forms the two columns need.
///
/// Masked to 0o7777 so the file-type bits in the high word never leak into a
/// number the user reads as a mode.
fn permissions(bits: u32) -> (String, String) {
    let bits = bits & 0o7777;
    let rwx = |shift: u32, extra: (u32, char)| {
        let p = (bits >> shift) & 0o7;
        let x = if bits & extra.0 != 0 {
            if p & 1 != 0 { extra.1 } else { extra.1.to_ascii_uppercase() }
        } else if p & 1 != 0 {
            'x'
        } else {
            '-'
        };
        format!(
            "{}{}{}",
            if p & 4 != 0 { 'r' } else { '-' },
            if p & 2 != 0 { 'w' } else { '-' },
            x
        )
    };
    (
        format!("{:o}", bits & 0o777),
        format!(
            "{}{}{}",
            rwx(6, (0o4000, 's')),
            rwx(3, (0o2000, 's')),
            rwx(0, (0o1000, 't'))
        ),
    )
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
            let (mode, mode_text) = match meta.permissions {
                Some(bits) => {
                    let (o, t) = permissions(bits);
                    (Some(o), Some(t))
                }
                None => (None, None),
            };
            RemoteFile {
                name: entry.file_name(),
                size: if is_dir { None } else { meta.size },
                modified: meta.mtime.map(u64::from),
                kind: if is_dir { "dir".into() } else { "file".into() },
                uid: meta.uid,
                gid: meta.gid,
                mode,
                mode_text,
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
    let (sftp, host_id) = open(app, session_id).await?;
    log(app, host_id, session_id, Origin::User, &format!("sftp put {remote}"));
    put_file(&sftp, std::path::Path::new(local), remote).await
}

/// Uploads whatever was dropped: a file, or a directory and everything under it.
///
/// `remote_dir` is the folder the pane is showing, so a drop lands where the
/// user is looking. Names come from the local path's last component — dropping
/// `~/site` onto `/var/www` creates `/var/www/site`.
///
/// Existing files are overwritten, because `sftp.create` truncates and there is
/// no confirmation dialog in the design to ask with. Directories are merged
/// rather than replaced: an existing one is kept and written into.
pub async fn upload_path(
    app: &AppHandle,
    session_id: &str,
    local: &str,
    remote_dir: &str,
) -> Result<u64> {
    let (sftp, host_id) = open(app, session_id).await?;
    let source = std::path::PathBuf::from(local);
    let name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| Error::Invalid(format!("cannot name {local}")))?;
    let target = join_remote(remote_dir, name);

    log(app, host_id, session_id, Origin::User, &format!("sftp put {target}"));

    // Walked iteratively: a recursive async fn needs boxing, and the explicit
    // stack also keeps the traversal order predictable in the audit trail.
    let mut total = 0u64;
    let mut stack = vec![(source, target)];
    while let Some((from, to)) = stack.pop() {
        if from.is_dir() {
            // Already existing is the ordinary case when re-uploading a tree.
            let _ = sftp.create_dir(&to).await;
            let mut entries = tokio::fs::read_dir(&from).await?;
            while let Some(entry) = entries.next_entry().await? {
                let child = entry.file_name();
                let Some(child) = child.to_str() else { continue };
                stack.push((entry.path(), join_remote(&to, child)));
            }
        } else {
            total += put_file(&sftp, &from, &to).await?;
        }
    }

    Ok(total)
}

/// Joins a remote directory and a name. Remote paths are always `/`-separated,
/// whatever the local platform uses, so this cannot go through `PathBuf`.
fn join_remote(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// One file's bytes, shared by `upload` and the directory walk.
async fn put_file(
    sftp: &russh_sftp::client::SftpSession,
    local: &std::path::Path,
    remote: &str,
) -> Result<u64> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

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

/// russh-sftp renders a status packet as `"{status_code}: {error_message}"`,
/// and servers routinely send the same words in both — "Permission denied:
/// Permission denied". Said once is the whole message.
fn tidy(e: impl std::fmt::Display) -> String {
    let text = e.to_string();
    match text.split_once(": ") {
        Some((head, tail)) if head == tail => head.to_string(),
        _ => text,
    }
}

/// An attribute change carrying *only* what is being changed.
///
/// `Metadata::default()` is emphatically not this: it is `size: Some(0)`,
/// `uid/gid: Some(0)`, `permissions: Some(0o777 | DIR)` and zeroed timestamps.
/// Building a chmod on top of it would truncate the file to nothing, hand it to
/// root and date it to 1970 — the flags word is derived from which fields are
/// `Some`, so every default that survives is a change that gets sent.
fn only(f: impl FnOnce(&mut Metadata)) -> Metadata {
    let mut meta = Metadata {
        size: None,
        uid: None,
        user: None,
        gid: None,
        group: None,
        permissions: None,
        atime: None,
        mtime: None,
    };
    f(&mut meta);
    meta
}

/// Rename, which on a remote filesystem is also "move".
pub async fn rename(app: &AppHandle, session_id: &str, from: &str, to: &str) -> Result<()> {
    let (sftp, host_id) = open(app, session_id).await?;
    log(app, host_id, session_id, Origin::User, &format!("sftp rename {from} -> {to}"));
    sftp.rename(from, to)
        .await
        .map_err(|e| Error::Ssh(format!("could not rename {from}: {}", tidy(e))))
}

/// `chmod`. `mode` is the permission bits alone; the file-type bits are the
/// server's business and must not be sent back.
pub async fn chmod(app: &AppHandle, session_id: &str, path: &str, mode: u32) -> Result<()> {
    let (sftp, host_id) = open(app, session_id).await?;
    let mode = mode & 0o7777;
    log(app, host_id, session_id, Origin::User, &format!("sftp chmod {mode:o} {path}"));
    sftp.set_metadata(path, only(|m| m.permissions = Some(mode)))
        .await
        .map_err(|e| Error::Ssh(format!("could not chmod {path}: {}", tidy(e))))
}

/// `chown`, optionally down the tree.
///
/// Recursion is off by default and has to be asked for: on a directory it is
/// the difference between changing one entry and changing every file under it,
/// and there is no undo on the far end.
pub async fn chown(
    app: &AppHandle,
    session_id: &str,
    path: &str,
    uid: u32,
    gid: u32,
    recursive: bool,
) -> Result<u64> {
    let (sftp, host_id) = open(app, session_id).await?;
    log(
        app,
        host_id,
        session_id,
        Origin::User,
        &format!("sftp chown {uid}:{gid}{} {path}", if recursive { " -R" } else { "" }),
    );

    let meta = || only(|m| {
        m.uid = Some(uid);
        m.gid = Some(gid);
    });

    sftp.set_metadata(path, meta())
        .await
        .map_err(|e| Error::Ssh(format!("could not chown {path}: {}", tidy(e))))?;
    let mut changed = 1u64;
    if !recursive {
        return Ok(changed);
    }

    // Same explicit stack as the upload walk: a recursive async fn needs boxing,
    // and an unreadable subdirectory should skip rather than abort a change that
    // has already been half applied.
    let mut stack = vec![path.to_string()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = sftp.read_dir(&dir).await else { continue };
        for entry in entries {
            let child = join_remote(&dir, &entry.file_name());
            if sftp.set_metadata(&child, meta()).await.is_ok() {
                changed += 1;
            }
            if entry.metadata().is_dir() {
                stack.push(child);
            }
        }
    }
    Ok(changed)
}
