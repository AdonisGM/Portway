use std::collections::HashSet;
use std::sync::Mutex;

use russh_sftp::client::error::Error as RawError;
use russh_sftp::client::fs::Metadata;
use russh_sftp::client::{RawSftpSession, SftpSession};
use russh_sftp::protocol::StatusCode;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

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
    /// Numeric owner and group, straight from the file attributes. These stay
    /// even when the names below are known, because `chown` takes numbers.
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    /// Owner and group as the *server* names them, read out of the `longname`
    /// line — `None` when it did not parse, or when the server has no name for
    /// that id and printed the number instead.
    pub owner: Option<String>,
    pub group: Option<String>,
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

/// Pulls the owner and group *names* out of a readdir `longname`.
///
/// SFTP v3 sends the numeric ids in the attributes and the resolved names
/// nowhere else — they exist only inside this one human-readable line, which
/// OpenSSH builds like `ls -l`:
///
/// ```text
/// -rw-r--r--    ? deployment-svc longgroupname12        0 Aug  1 09:07 notes.txt
/// ```
///
/// The format is a convention rather than a rule, so this validates before
/// trusting it and gives up rather than guessing: whatever it cannot read, the
/// caller still has the numbers for. Fields are taken by whitespace splitting
/// and never by character offset — the columns are padded, not aligned, and
/// OpenSSH prints `?` where it has no link count.
///
/// A server with no name for an id prints the number there, which is exactly
/// what the numbers would have shown anyway — so it is passed through rather
/// than special-cased, and a user genuinely called `4242` still reads right.
fn owner_group(longname: &str) -> Option<(String, String)> {
    let fields: Vec<&str> = longname.split_whitespace().collect();
    // mode, links, owner, group, size, and at least a date and a name.
    if fields.len() < 7 {
        return None;
    }

    // `drwxr-xr-x`, sometimes with a trailing `.` or `+` for SELinux or an ACL.
    let mode = fields[0];
    if !(10..=11).contains(&mode.len()) {
        return None;
    }
    let mut chars = mode.chars();
    if !matches!(chars.next()?, '-' | 'd' | 'l' | 'b' | 'c' | 'p' | 's' | 'D' | '?') {
        return None;
    }
    if !chars.clone().take(9).all(|c| matches!(c, 'r' | 'w' | 'x' | 's' | 'S' | 't' | 'T' | '-')) {
        return None;
    }
    if mode.len() == 11 && !matches!(mode.chars().last()?, '.' | '+') {
        return None;
    }

    // The size is the one field after the names that must be a number. Checking
    // it is what rules out a line whose shape only happens to resemble `ls -l`.
    fields[4].parse::<u64>().ok()?;

    Some((fields[2].to_string(), fields[3].to_string()))
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

/// The same channel, opened onto the raw protocol instead. Only `list` wants
/// this, and only because the convenience layer discards the field it needs.
async fn open_raw(app: &AppHandle, session_id: &str) -> Result<(RawSftpSession, i64)> {
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
    let sftp = RawSftpSession::new(channel.into_stream());
    sftp.init()
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
    // The one operation that goes through the raw protocol rather than the
    // convenience layer. `SftpSession::read_dir` keeps `(filename, attrs)` and
    // throws the `longname` away, and the owner and group names exist nowhere
    // else in an SFTP v3 reply — so a listing built on it can only ever show
    // numbers. Everything else in this file stays on the high-level session.
    let (sftp, host_id) = open_raw(app, session_id).await?;

    let target = if path.trim().is_empty() { ".".to_string() } else { path.to_string() };
    let canonical = sftp
        .realpath(&target)
        .await
        .map_err(|e| Error::Ssh(format!("no such directory {target}: {e}")))?
        .files
        .first()
        .map(|f| f.filename.clone())
        .ok_or_else(|| Error::Ssh(format!("no such directory {target}")))?;

    log(app, host_id, session_id, origin, &format!("sftp ls {canonical}"));

    let handle = sftp
        .opendir(canonical.clone())
        .await
        .map_err(|e| Error::Ssh(format!("could not read {canonical}: {e}")))?
        .handle;

    // A directory arrives over as many replies as the server feels like using,
    // ending in an EOF status. Reading one and stopping looks right on every
    // small directory and quietly truncates the big ones.
    let mut entries = Vec::new();
    loop {
        match sftp.readdir(handle.as_str()).await {
            Ok(name) => entries.extend(name.files),
            Err(RawError::Status(status)) if status.status_code == StatusCode::Eof => break,
            Err(e) => {
                let _ = sftp.close(handle).await;
                return Err(Error::Ssh(format!("could not read {canonical}: {e}")));
            }
        }
    }
    let _ = sftp.close(handle).await;

    let mut files: Vec<RemoteFile> = entries
        .into_iter()
        .map(|entry| {
            let meta = entry.attrs;
            let is_dir = meta.is_dir();
            let (mode, mode_text) = match meta.permissions {
                Some(bits) => {
                    let (o, t) = permissions(bits);
                    (Some(o), Some(t))
                }
                None => (None, None),
            };
            let (owner, group) = match owner_group(&entry.longname) {
                Some((o, g)) => (Some(o), Some(g)),
                None => (None, None),
            };
            RemoteFile {
                name: entry.filename,
                size: if is_dir { None } else { meta.size },
                modified: meta.mtime.map(u64::from),
                kind: if is_dir { "dir".into() } else { "file".into() },
                uid: meta.uid,
                gid: meta.gid,
                owner,
                group,
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

/// Files opened for editing, so re-opening one does not start a second watcher
/// against the same copy.
#[derive(Default)]
pub struct Editing(pub Mutex<HashSet<String>>);

/// A file the user is editing has been saved and pushed back up.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedEvent {
    session_id: String,
    remote: String,
    bytes: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveFailedEvent {
    session_id: String,
    remote: String,
    error: String,
}

/// Anything larger than this needs the user to have said so. It is not about
/// what the transfer can carry — it is that "edit" implies opening the thing in
/// a text editor, and a 200MB log opened by accident freezes whatever opens it.
pub const LARGE_FILE: u64 = 5 * 1024 * 1024;

/// Downloads a file to a scratch copy, opens it in a local application, and
/// watches it so that saving in that application writes back to the server.
///
/// This is the alternative to embedding an editor: the user already has one
/// they like, with their own keybindings and language support, and a few
/// megabytes of bundled editor would still be the wrong one. The cost is that
/// "save" has to be noticed rather than handled, which is what the watcher does.
pub async fn edit(
    app: &AppHandle,
    session_id: &str,
    remote: &str,
    opener: Option<String>,
    confirmed_large: bool,
) -> Result<String> {
    let (sftp, host_id) = open(app, session_id).await?;

    let size = sftp
        .metadata(remote)
        .await
        .map_err(|e| Error::Ssh(format!("no such file {remote}: {}", tidy(e))))?
        .size
        .unwrap_or(0);
    // Enforced here rather than only in the dialog: the dialog is a courtesy,
    // this is what stops a mis-click reading a gigabyte over the wire.
    if size > LARGE_FILE && !confirmed_large {
        return Err(Error::Invalid(format!(
            "{remote} is {size} bytes — larger than the {LARGE_FILE} byte edit limit"
        )));
    }

    let name = remote.rsplit('/').next().unwrap_or("file");
    let dir = crate::db::app_dir().join("edit").join(session_id);
    tokio::fs::create_dir_all(&dir).await?;
    let local = dir.join(name);

    let bytes = get_file(&sftp, remote, &local).await?;
    log(
        app,
        host_id,
        session_id,
        Origin::User,
        &format!("sftp edit {remote} ({bytes} bytes)"),
    );

    launch(&local, opener.as_deref())?;

    // One watcher per remote path. Opening the same file twice should hand it
    // back to the editor already holding it, not race two uploads.
    let key = format!("{session_id}\u{0}{remote}");
    {
        let editing = app.state::<Editing>();
        let mut open_files = editing.0.lock().unwrap();
        if !open_files.insert(key.clone()) {
            return Ok(local.to_string_lossy().into_owned());
        }
    }
    watch(app.clone(), session_id.to_string(), remote.to_string(), local.clone(), key);

    Ok(local.to_string_lossy().into_owned())
}

/// Hands the scratch copy to a local application.
///
/// Three cases, and the macOS one is the reason this is not a one-liner: a Mac
/// application is a *bundle directory*, not an executable, so a chosen app has
/// to go through `open -a` — exec'ing `TextEdit.app` fails. Everywhere else a
/// chosen application is an executable and is run directly, which avoids
/// `cmd /C start` re-parsing the arguments and applying its own quoting rules
/// to a path that may contain spaces.
///
/// With nothing chosen, each platform's own "use whatever is registered for
/// this" is what double-clicking would do, so the user's existing preference is
/// honoured without being asked for.
fn launch(local: &std::path::Path, opener: Option<&str>) -> Result<()> {
    let mut command = match opener {
        Some(app) if cfg!(target_os = "macos") => {
            let mut c = std::process::Command::new("open");
            c.arg("-a").arg(app).arg(local);
            c
        }
        Some(app) => {
            let mut c = std::process::Command::new(app);
            c.arg(local);
            c
        }
        None if cfg!(target_os = "macos") => {
            let mut c = std::process::Command::new("open");
            c.arg(local);
            c
        }
        None if cfg!(target_os = "windows") => {
            // The empty argument is `start`'s window title. Without it `start`
            // reads the first quoted argument as the title and opens nothing.
            let mut c = std::process::Command::new("cmd");
            c.arg("/C").arg("start").arg("").arg(local);
            c
        }
        None => {
            let mut c = std::process::Command::new("xdg-open");
            c.arg(local);
            c
        }
    };
    command
        .spawn()
        .map(|_| ())
        .map_err(|e| Error::Invalid(format!("could not open {}: {e}", local.display())))
}

/// Polls the scratch copy's mtime and uploads it back when it moves.
///
/// Polling rather than a filesystem watcher: editors save by writing a new file
/// and renaming it over the old one at least as often as they write in place,
/// and a rename fires events a naive watcher misses while a stat does not care
/// which happened. One second is under the threshold where a save feels
/// unacknowledged.
fn watch(app: AppHandle, session_id: String, remote: String, local: std::path::PathBuf, key: String) {
    tokio::spawn(async move {
        let mut last = tokio::fs::metadata(&local).await.ok().and_then(|m| m.modified().ok());

        loop {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;

            // The session going away is what ends the watch — there is nothing
            // to upload to any more.
            if ssh::session(&app, &session_id).is_err() {
                break;
            }
            let Ok(meta) = tokio::fs::metadata(&local).await else { continue };
            let Ok(modified) = meta.modified() else { continue };
            if Some(modified) == last {
                continue;
            }
            last = Some(modified);

            match upload(&app, &session_id, &local.to_string_lossy(), &remote).await {
                Ok(bytes) => {
                    let _ = app.emit(
                        "sftp://saved",
                        SavedEvent { session_id: session_id.clone(), remote: remote.clone(), bytes },
                    );
                }
                Err(e) => {
                    let _ = app.emit(
                        "sftp://save-failed",
                        SaveFailedEvent {
                            session_id: session_id.clone(),
                            remote: remote.clone(),
                            error: e.to_string(),
                        },
                    );
                }
            }
        }

        app.state::<Editing>().0.lock().unwrap().remove(&key);
    });
}

/// Downloads to a local path, shared by `download` and `edit`.
async fn get_file(
    sftp: &SftpSession,
    remote: &str,
    local: &std::path::Path,
) -> Result<u64> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut source = sftp
        .open(remote)
        .await
        .map_err(|e| Error::Ssh(format!("could not read {remote}: {}", tidy(e))))?;
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

/// Deletes a file, or a directory and everything under it.
///
/// SFTP's `remove_dir` only takes empty directories, so a tree has to be
/// emptied from the leaves up. The walk collects directories on the way down
/// and removes them in reverse afterwards, which is the same order `rm -r`
/// uses and the only one the protocol permits.
///
/// There is no undo on the far end. The caller is expected to have asked.
pub async fn remove(app: &AppHandle, session_id: &str, path: &str, is_dir: bool) -> Result<u64> {
    let (sftp, host_id) = open(app, session_id).await?;
    log(
        app,
        host_id,
        session_id,
        Origin::User,
        &format!("sftp rm{} {path}", if is_dir { " -r" } else { "" }),
    );

    if !is_dir {
        sftp.remove_file(path)
            .await
            .map_err(|e| Error::Ssh(format!("could not delete {path}: {}", tidy(e))))?;
        return Ok(1);
    }

    // Descend first, recording directories in the order they are found.
    let mut removed = 0u64;
    let mut dirs = vec![path.to_string()];
    let mut queue = vec![path.to_string()];
    while let Some(dir) = queue.pop() {
        let entries = sftp
            .read_dir(&dir)
            .await
            .map_err(|e| Error::Ssh(format!("could not read {dir}: {}", tidy(e))))?;
        for entry in entries {
            let child = join_remote(&dir, &entry.file_name());
            if entry.metadata().is_dir() {
                dirs.push(child.clone());
                queue.push(child);
            } else {
                sftp.remove_file(&child)
                    .await
                    .map_err(|e| Error::Ssh(format!("could not delete {child}: {}", tidy(e))))?;
                removed += 1;
            }
        }
    }

    // Deepest last in, first out: a directory is only empty once everything
    // discovered beneath it has gone.
    for dir in dirs.into_iter().rev() {
        sftp.remove_dir(&dir)
            .await
            .map_err(|e| Error::Ssh(format!("could not delete {dir}: {}", tidy(e))))?;
        removed += 1;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::owner_group;

    /// Captured from a real OpenSSH sftp-server, which is where the shape of
    /// this string is actually decided.
    #[test]
    fn reads_the_names_openssh_sends() {
        let long = "-rw-r--r--    ? deployment-svc longgroupname12        0 Aug  1 09:07 notes.txt";
        assert_eq!(
            owner_group(long),
            Some(("deployment-svc".into(), "longgroupname12".into()))
        );
    }

    /// A server with no name for an id prints the number, and that is the right
    /// answer to show — not a reason to fall back.
    #[test]
    fn passes_numbers_through_when_the_server_has_no_name() {
        let long = "-rw-r--r--    ? 4242     4243            0 Aug  1 09:07 orphan.txt";
        assert_eq!(owner_group(long), Some(("4242".into(), "4243".into())));
    }

    #[test]
    fn survives_a_name_with_spaces_in_it() {
        let long = "-rw-r--r--    1 root     root            0 Aug  1 09:07 name with spaces.txt";
        assert_eq!(owner_group(long), Some(("root".into(), "root".into())));
    }

    #[test]
    fn accepts_the_selinux_and_acl_suffixes() {
        for mode in ["drwxr-xr-x.", "-rw-rw-r--+"] {
            let long = format!("{mode} 2 alice devs 4096 Aug  1 09:07 thing");
            assert_eq!(owner_group(&long), Some(("alice".into(), "devs".into())));
        }
    }

    #[test]
    fn keeps_the_special_bit_modes() {
        let long = "-rwsr-xr-t    1 root     root         1234 Aug  1 09:07 sudo";
        assert_eq!(owner_group(long), Some(("root".into(), "root".into())));
    }

    /// Anything that is not an `ls -l` line gives up rather than inventing an
    /// owner: the caller still has the numeric ids.
    #[test]
    fn gives_up_on_anything_else() {
        for long in [
            "",
            "notes.txt",
            "some server that formats its own way entirely here ok",
            // Right shape, but the size field is not a number.
            "-rw-r--r--    1 root     root         many Aug  1 09:07 notes.txt",
            // Mode is the wrong length.
            "-rw-r--r 1 root root 0 Aug  1 09:07 notes.txt",
            // Mode has a character that is not a permission bit.
            "-rw-r--q--    1 root     root            0 Aug  1 09:07 notes.txt",
        ] {
            assert_eq!(owner_group(long), None, "{long:?}");
        }
    }
}
