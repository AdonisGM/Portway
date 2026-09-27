//! Edit a server's file in an app on this Mac (VS Code, TextEdit…): Portway
//! downloads it to a folder of its own under the cache directory, opens it,
//! and uploads it again each time the app saves it.
//!
//! The local folder is named after the server, the user and a hash of the
//! server, host, port, user and remote path, so files with the same name on
//! two servers never share a copy. Uploads write the file in place (owner and
//! mode stay), and stop when the file on the server changed since Portway
//! read it: the user decides between overwriting and taking the server's.

use base64::Engine;
use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::watch;

use crate::audit::AuditLog;
use crate::error::{AppError, AppResult};
use crate::i18n::tr;
use crate::files::{sftp, sftp_err};
use crate::servers::ServerStore;
use crate::ssh::{exec, exec_input, exec_priv, shell_quote, Session, Sessions};

/// Bigger files are not text anyone edits by hand.
const MAX_SIZE: u64 = 20 * 1024 * 1024;
const POLL: Duration = Duration::from_millis(700);
/// Local copies left from an earlier run are removed after this long.
const STALE: Duration = Duration::from_secs(3 * 24 * 3600);

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    /// The local copy matches what is on the server.
    Synced,
    Uploading,
    /// Saved locally, not uploaded yet (no connection); retried on its own.
    Pending,
    /// The file on the server changed since Portway read it.
    Conflict,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Edit {
    pub id: String,
    pub server_id: String,
    pub user: String,
    pub server_name: String,
    pub remote_path: String,
    pub local_path: String,
    /// App it was opened with, for display; None is the default text editor.
    pub app: Option<String>,
    /// Read and written through sudo (the user could not read it).
    pub sudo: bool,
    pub status: Status,
    pub uploads: u32,
    /// Last time local and server matched, ms since epoch.
    pub synced_at: u64,
    pub error: Option<String>,
}

/// What Portway last saw of the file on the server and of the local copy.
#[derive(Clone)]
struct Known {
    remote: (Option<u32>, u64),
    local: (Option<SystemTime>, u64),
    hash: u64,
}

struct Entry {
    edit: Edit,
    known: Known,
    stop: watch::Sender<bool>,
    /// Upload even though the server's copy changed (after "Ghi đè").
    force: bool,
}

pub struct Edits {
    app: AppHandle,
    map: Mutex<HashMap<String, Entry>>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn hash_bytes(b: &[u8]) -> u64 {
    let mut h = DefaultHasher::new();
    b.hash(&mut h);
    h.finish()
}

/// Letters, digits, `-` and `.` of a name, for a folder name.
fn tidy(s: &str) -> String {
    let t: String = s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '.' { c } else { '_' }).collect();
    t.trim_matches('_').chars().take(40).collect()
}

/// The folder for one remote file: `<server>_<user>_<hash>`.
pub(crate) fn local_dir(root: &Path, server_id: &str, server_name: &str, host: &str, port: u16, user: &str, remote: &str) -> PathBuf {
    let mut h = DefaultHasher::new();
    (server_id, host, port, user, remote).hash(&mut h);
    root.join(format!("{}_{}_{:012x}", tidy(server_name), tidy(user), h.finish() & 0xffff_ffff_ffff))
}

/// The local copy's file name: the remote one, made valid for this disk
/// (on Windows "a:b.conf" would write into a hidden stream of "a"). The
/// extension stays, so the editor still picks the right syntax.
fn local_name(remote: &str) -> String {
    if crate::transfers::safe_local_name(remote) {
        return remote.to_string();
    }
    if remote.is_empty() || remote == "." || remote == ".." {
        return "file".into();
    }
    let mut name: String = remote.chars().map(|c| if c < ' ' || "<>:\"/\\|?*".contains(c) { '_' } else { c }).collect();
    // Windows drops a trailing dot or space; keep the name as seen instead.
    if name.ends_with(['.', ' ']) {
        name.pop();
        name.push('_');
    }
    if !crate::transfers::safe_local_name(&name) {
        // A device name such as CON or NUL.
        name.insert(0, '_');
    }
    name
}

fn local_state(path: &Path) -> (Option<SystemTime>, u64) {
    std::fs::metadata(path).map(|m| (m.modified().ok(), m.len())).unwrap_or((None, 0))
}

impl Edits {
    pub fn new(app: AppHandle) -> Self {
        Self { app, map: Mutex::new(HashMap::new()) }
    }

    fn root(&self) -> PathBuf {
        self.app.path().app_cache_dir().unwrap_or_else(|_| std::env::temp_dir()).join("edit")
    }

    /// Remove local copies from earlier runs that nobody touched for days.
    pub fn clean_stale(&self) {
        let Ok(dirs) = std::fs::read_dir(self.root()) else { return };
        for d in dirs.flatten() {
            let old = d.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > STALE);
            if old {
                let _ = std::fs::remove_dir_all(d.path());
            }
        }
    }

    fn emit(&self, e: &Edit) {
        let _ = self.app.emit("edit", e.clone());
    }

    fn update(&self, id: &str, f: impl FnOnce(&mut Entry)) -> Option<Edit> {
        let snapshot = {
            let mut map = self.map.lock().unwrap();
            let entry = map.get_mut(id)?;
            f(entry);
            entry.edit.clone()
        };
        self.emit(&snapshot);
        Some(snapshot)
    }
}

/// Size and mtime of the remote file; None when it is gone.
async fn remote_stat(session: &Session, path: &str, sudo: bool) -> AppResult<Option<(Option<u32>, u64)>> {
    if sudo {
        let out = exec_priv(session, &format!("stat -c '%Y %s' -- {} 2>/dev/null || echo gone", shell_quote(path)), Duration::from_secs(20)).await?;
        let t = out.stdout.trim();
        if t == "gone" {
            return Ok(None);
        }
        let mut it = t.split_whitespace();
        let mtime = it.next().and_then(|v| v.parse().ok());
        let size = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        return Ok(Some((mtime, size)));
    }
    let s = sftp(session).await?;
    match s.metadata(path).await {
        Ok(a) => Ok(Some((a.mtime, a.size.unwrap_or(0)))),
        Err(russh_sftp::client::error::Error::Status(st)) if st.status_code == russh_sftp::protocol::StatusCode::NoSuchFile => Ok(None),
        Err(e) => Err(sftp_err(e, session, path).await),
    }
}

async fn read_remote(session: &Session, path: &str, sudo: bool) -> AppResult<Vec<u8>> {
    if sudo {
        let out = exec_priv(session, &format!("base64 -- {}", shell_quote(path)), Duration::from_secs(60)).await?;
        if out.code != Some(0) {
            return Err(AppError::detail("permission_denied", out.stderr.trim()));
        }
        let text: String = out.stdout.split_whitespace().collect();
        return base64::engine::general_purpose::STANDARD.decode(text).map_err(|e| AppError::detail("remote_command", e));
    }
    let s = sftp(session).await?;
    let mut f = match s.open(path).await {
        Ok(f) => f,
        Err(e) => return Err(sftp_err(e, session, path).await),
    };
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).await.map_err(|e| AppError::detail("sftp", e))?;
    Ok(buf)
}

/// Replace the file's content, keeping its owner, group and mode (the file is
/// rewritten in place, not replaced). The new content first goes, over the
/// network, into a private temporary file on the server; only once all of it
/// arrived (size checked) is it copied over the file, on the server's own disk.
/// A connection that drops mid-upload leaves the file untouched.
pub(crate) async fn write_remote(session: &Session, path: &str, data: &[u8], sudo: bool) -> AppResult<()> {
    let size = data.len();
    let finish = |tmp: &str| finish_script(tmp, path, size);
    if sudo {
        let b64 = base64::engine::general_purpose::STANDARD.encode(data);
        let script = format!(r#"t=$(mktemp) || exit 1; base64 -d > "$t" || {{ rm -f "$t"; exit 1; }}; {}"#, finish(r#""$t""#));
        let out = exec_input(session, &script, &format!("{b64}\n"), true, Duration::from_secs(60)).await?;
        if out.code != Some(0) {
            return Err(AppError::detail("remote_command", out.stderr.trim()));
        }
        return Ok(());
    }
    let tmp = exec(session, "mktemp").await?.stdout_or_err()?.trim().to_string();
    if !tmp.starts_with('/') || tmp.contains(char::is_whitespace) {
        return Err(AppError::detail("remote_command", format!("mktemp: {tmp}")));
    }
    let s = sftp(session).await?;
    let uploaded: AppResult<()> = async {
        let mut f = match s.open_with_flags(&tmp, OpenFlags::WRITE | OpenFlags::TRUNCATE).await {
            Ok(f) => f,
            Err(e) => return Err(sftp_err(e, session, &tmp).await),
        };
        f.write_all(data).await.map_err(|e| AppError::detail("sftp", e))?;
        f.shutdown().await.map_err(|e| AppError::detail("sftp", e))?;
        Ok(())
    }
    .await;
    if let Err(e) = uploaded {
        let _ = s.remove_file(&tmp).await;
        return Err(e);
    }
    let out = exec(session, &finish(&shell_quote(&tmp))).await?;
    if out.code != Some(0) {
        return Err(AppError::detail("remote_command", out.stderr.trim()));
    }
    Ok(())
}

/// Copy a fully uploaded temporary file over `path` (in place, so owner and
/// mode stay), or refuse when it is not `size` bytes long. `tmp` is already
/// shell-quoted (or a quoted "$t").
pub(crate) fn finish_script(tmp: &str, path: &str, size: usize) -> String {
    format!(
        r#"if [ "$(wc -c < {tmp} | tr -d ' ')" = "{size}" ]; then cat {tmp} > {path}; rc=$?; else echo "incomplete upload" >&2; rc=3; fi; rm -f {tmp}; exit $rc"#,
        path = shell_quote(path)
    )
}

/// Whether `path` is an app that can open files: a .app bundle on macOS, an
/// .exe on Windows.
pub(crate) fn is_app(path: &Path) -> bool {
    let ext = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase());
    if cfg!(windows) {
        path.is_file() && ext.as_deref() == Some("exe")
    } else {
        path.is_dir() && ext.as_deref() == Some("app")
    }
}

/// Open the local copy in `app` or the default text editor.
#[cfg(target_os = "macos")]
fn open_in(app: Option<&str>, file: &Path) -> AppResult<()> {
    let mut cmd = std::process::Command::new("open");
    match app {
        Some(a) => cmd.arg("-a").arg(a),
        None => cmd.arg("-t"),
    };
    let status = cmd.arg(file).status()?;
    if !status.success() {
        return Err(AppError::detail("open_failed", format!("open exited with {status}")));
    }
    Ok(())
}

/// Open the local copy in `app` (an .exe) or Notepad. Not "the app for this
/// extension": server files often have none (sites-available/shop), and
/// Windows would only ask which app to use.
#[cfg(windows)]
fn open_in(app: Option<&str>, file: &Path) -> AppResult<()> {
    let exe = app.map(PathBuf::from).unwrap_or_else(notepad);
    std::process::Command::new(&exe)
        .arg(file)
        .spawn()
        .map(|_| ())
        .map_err(|e| AppError::detail("open_failed", format!("{}: {e}", exe.display())))
}

#[cfg(not(any(target_os = "macos", windows)))]
fn open_in(app: Option<&str>, file: &Path) -> AppResult<()> {
    let mut cmd = std::process::Command::new(app.unwrap_or("xdg-open"));
    cmd.arg(file).spawn().map(|_| ()).map_err(|e| AppError::detail("open_failed", e))
}

#[cfg_attr(not(windows), allow(dead_code))]
fn notepad() -> PathBuf {
    let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    root.join("notepad.exe")
}

fn app_label(app: Option<&str>) -> Option<String> {
    app.map(|a| known_name(Path::new(a)).unwrap_or_else(|| Path::new(a).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| a.to_string())))
}

/// One upload attempt of the local copy, if it changed.
async fn sync_once(edits: &Arc<Edits>, sessions: &Sessions, audit: &AuditLog, id: &str) {
    let Some((edit, known, force)) = edits.map.lock().unwrap().get(id).map(|e| (e.edit.clone(), e.known.clone(), e.force)) else { return };
    let local = PathBuf::from(&edit.local_path);
    let now_local = local_state(&local);
    // Unchanged since the last look (editors that save by rename still change mtime).
    if now_local == known.local && !matches!(edit.status, Status::Pending) && !force {
        return;
    }
    let Ok(data) = std::fs::read(&local) else { return }; // Mid-save or deleted: next round.
    let hash = hash_bytes(&data);
    if hash == known.hash && !force {
        edits.update(id, |e| e.known.local = now_local);
        return;
    }
    if matches!(edit.status, Status::Conflict) && !force {
        return;
    }
    let session = match sessions.get(&edit.server_id, &edit.user) {
        Ok(s) => s,
        Err(_) => {
            edits.update(id, |e| {
                e.edit.status = Status::Pending;
                e.edit.error = Some(tr("Chưa có kết nối tới server; sẽ tải lên khi kết nối lại", "Not connected to the server; will upload when reconnected"));
            });
            return;
        }
    };
    edits.update(id, |e| {
        e.edit.status = Status::Uploading;
        e.edit.error = None;
    });
    let result: AppResult<Option<(Option<u32>, u64)>> = async {
        let remote = remote_stat(&session, &edit.remote_path, edit.sudo).await?;
        if !force && remote != Some(known.remote) {
            return Ok(None);
        }
        write_remote(&session, &edit.remote_path, &data, edit.sudo).await?;
        Ok(remote_stat(&session, &edit.remote_path, edit.sudo).await?)
    }
    .await;
    let cmd = format!("{}sftp put {} {}", if edit.sudo { "sudo " } else { "" }, shell_quote(&edit.local_path), shell_quote(&edit.remote_path));
    match result {
        Ok(Some(stat)) => {
            audit.record(&edit.server_id, &edit.user, "editUpload", &cmd, true, None);
            edits.update(id, |e| {
                e.known = Known { remote: stat, local: now_local, hash };
                e.force = false;
                e.edit.status = Status::Synced;
                e.edit.uploads += 1;
                e.edit.synced_at = now_ms();
                e.edit.error = None;
            });
        }
        Ok(None) => {
            edits.update(id, |e| {
                e.edit.status = Status::Conflict;
                e.edit.error = Some(tr("Tệp trên server đã đổi từ lúc Portway mở nó", "The file on the server changed since Portway opened it"));
            });
        }
        Err(err) => {
            let text = err.detail.clone().unwrap_or_else(|| err.code.to_string());
            audit.record(&edit.server_id, &edit.user, "editUpload", &cmd, false, Some(text.clone()));
            let lost = matches!(err.code, "connection_lost" | "not_connected");
            edits.update(id, |e| {
                e.edit.status = if lost { Status::Pending } else { Status::Error };
                e.edit.error = Some(if lost { tr("Mất kết nối; sẽ tải lên khi kết nối lại", "Connection lost; will upload when reconnected") } else { text });
                // Try this content again next round only when the network is back.
                if !lost {
                    e.known.local = now_local;
                }
            });
        }
    }
}

fn spawn_watch(edits: Arc<Edits>, id: String, mut stop: watch::Receiver<bool>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = stop.changed() => break,
                _ = tokio::time::sleep(POLL) => {}
            }
            let sessions = edits.app.state::<Sessions>();
            let audit = edits.app.state::<AuditLog>();
            sync_once(&edits, &sessions, &audit, &id).await;
        }
    });
}

/// Download a file and open it in an app; saving it there uploads it back.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn edit_open(
    edits: tauri::State<'_, Arc<Edits>>,
    sessions: tauri::State<'_, Sessions>,
    store: tauri::State<'_, ServerStore>,
    settings: tauri::State<'_, crate::settings::SettingsStore>,
    server_id: String,
    user: String,
    path: String,
    app: Option<String>,
) -> AppResult<Edit> {
    let app = app.or_else(|| settings.get().editor);
    // Already open: bring it up again rather than downloading over local edits.
    let existing = edits.map.lock().unwrap().values().find(|e| e.edit.server_id == server_id && e.edit.user == user && e.edit.remote_path == path).map(|e| e.edit.clone());
    if let Some(e) = existing {
        open_in(app.as_deref(), Path::new(&e.local_path))?;
        return Ok(edits.update(&e.id, |x| x.edit.app = app_label(app.as_deref())).unwrap_or(e));
    }

    let server = store.list().into_iter().find(|s| s.id == server_id).ok_or_else(|| AppError::new("not_found"))?;
    let session = sessions.get(&server_id, &user)?;
    // Read as the user when it can, else through sudo when that is on.
    let s = sftp(&session).await?;
    let attrs = match s.metadata(&path).await {
        Ok(a) => Some(a),
        Err(russh_sftp::client::error::Error::Status(st)) if st.status_code == russh_sftp::protocol::StatusCode::PermissionDenied => None,
        Err(e) => return Err(sftp_err(e, &session, &path).await),
    };
    if let Some(a) = &attrs {
        if a.is_dir() {
            return Err(AppError::detail("not_a_file", &path));
        }
        if a.size.unwrap_or(0) > MAX_SIZE {
            return Err(AppError::detail("too_big", a.size.unwrap_or(0)));
        }
    }
    // Opening for writing without truncating changes nothing and answers the
    // question exactly (ACLs, read-only mounts included).
    let can = |flags| {
        let s = s.clone();
        let path = path.clone();
        async move {
            match s.open_with_flags(&path, flags).await {
                Ok(_) => Ok(true),
                Err(russh_sftp::client::error::Error::Status(st))
                    if matches!(st.status_code, russh_sftp::protocol::StatusCode::PermissionDenied | russh_sftp::protocol::StatusCode::Failure) =>
                {
                    Ok(false)
                }
                Err(e) => Err(e),
            }
        }
    };
    let readable = match can(OpenFlags::READ).await {
        Ok(r) => r,
        Err(e) => return Err(sftp_err(e, &session, &path).await),
    };
    let writable = readable
        && match can(OpenFlags::WRITE).await {
            Ok(w) => w,
            Err(e) => return Err(sftp_err(e, &session, &path).await),
        };
    // A file the user may read but not write (root's /etc configs) is edited
    // through sudo too, or saving would fail every time.
    // With files as root, SFTP says yes to everything but the final copy runs
    // in a shell, so it has to go through sudo as well.
    let sudo = !(readable && writable) || session.files_root();
    if sudo && !session.sudo_on() {
        return Err(AppError::detail(if readable { "read_only" } else { "permission_denied" }, &path));
    }
    let remote = remote_stat(&session, &path, sudo).await?.ok_or_else(|| AppError::detail("not_found", &path))?;
    if remote.1 > MAX_SIZE {
        return Err(AppError::detail("too_big", remote.1));
    }
    let data = read_remote(&session, &path, sudo).await?;

    let dir = local_dir(&edits.root(), &server_id, &server.name, &server.host, server.port, &user, &path);
    std::fs::create_dir_all(&dir)?;
    let local = dir.join(local_name(path.rsplit('/').next().unwrap_or("")));
    std::fs::write(&local, &data)?;

    let (stop_tx, stop_rx) = watch::channel(false);
    let edit = Edit {
        id: uuid::Uuid::new_v4().to_string(),
        server_id,
        user,
        server_name: server.name.clone(),
        remote_path: path,
        local_path: local.to_string_lossy().into_owned(),
        app: app_label(app.as_deref()),
        sudo,
        status: Status::Synced,
        uploads: 0,
        synced_at: now_ms(),
        error: None,
    };
    let known = Known { remote, local: local_state(&local), hash: hash_bytes(&data) };
    edits.map.lock().unwrap().insert(edit.id.clone(), Entry { edit: edit.clone(), known, stop: stop_tx, force: false });
    edits.emit(&edit);
    spawn_watch(edits.inner().clone(), edit.id.clone(), stop_rx);
    if let Err(e) = open_in(app.as_deref(), &local) {
        // Downloaded but no app opened: keep watching, say why.
        edits.update(&edit.id, |x| x.edit.error = Some(e.detail.clone().unwrap_or_else(|| e.code.to_string())));
    }
    Ok(edit)
}

/// Stop watching and remove the local copy. Changes saved after this stay local only.
#[tauri::command]
pub fn edit_stop(edits: tauri::State<'_, Arc<Edits>>, id: String) {
    if let Some(e) = edits.map.lock().unwrap().remove(&id) {
        let _ = e.stop.send(true);
        if let Some(dir) = Path::new(&e.edit.local_path).parent() {
            let _ = std::fs::remove_dir_all(dir);
        }
        let _ = edits.app.emit("editClosed", id);
    }
}

/// After a conflict: `overwrite` uploads the local copy anyway; otherwise the
/// server's version replaces the local copy (local changes are lost).
#[tauri::command]
pub async fn edit_resolve(
    edits: tauri::State<'_, Arc<Edits>>,
    sessions: tauri::State<'_, Sessions>,
    audit: tauri::State<'_, AuditLog>,
    id: String,
    overwrite: bool,
) -> AppResult<()> {
    if overwrite {
        edits.update(&id, |e| {
            e.force = true;
            e.edit.status = Status::Pending;
        });
        sync_once(edits.inner(), &sessions, &audit, &id).await;
        return Ok(());
    }
    let edit = edits.map.lock().unwrap().get(&id).map(|e| e.edit.clone()).ok_or_else(|| AppError::new("not_found"))?;
    let session = sessions.get(&edit.server_id, &edit.user)?;
    let remote = remote_stat(&session, &edit.remote_path, edit.sudo).await?.ok_or_else(|| AppError::detail("not_found", &edit.remote_path))?;
    let data = read_remote(&session, &edit.remote_path, edit.sudo).await?;
    let local = PathBuf::from(&edit.local_path);
    std::fs::write(&local, &data)?;
    edits.update(&id, |e| {
        e.known = Known { remote, local: local_state(&local), hash: hash_bytes(&data) };
        e.force = false;
        e.edit.status = Status::Synced;
        e.edit.synced_at = now_ms();
        e.edit.error = None;
    });
    Ok(())
}

#[tauri::command]
pub fn edit_reopen(edits: tauri::State<'_, Arc<Edits>>, id: String, app: Option<String>) -> AppResult<()> {
    let local = edits.map.lock().unwrap().get(&id).map(|e| e.edit.local_path.clone()).ok_or_else(|| AppError::new("not_found"))?;
    open_in(app.as_deref(), Path::new(&local))?;
    edits.update(&id, |e| e.edit.app = app_label(app.as_deref()));
    Ok(())
}

#[tauri::command]
pub fn edit_list(edits: tauri::State<'_, Arc<Edits>>) -> Vec<Edit> {
    edits.map.lock().unwrap().values().map(|e| e.edit.clone()).collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorApp {
    pub name: String,
    pub path: String,
    /// macOS opens plain text with it by default.
    pub default: bool,
}

/// Well-known editors, in the order they are offered. Anything else macOS
/// reports comes after them, alphabetically.
#[cfg(not(windows))]
const KNOWN: &[&str] = &[
    "Visual Studio Code",
    "Cursor",
    "Zed",
    "Sublime Text",
    "Nova",
    "BBEdit",
    "CotEditor",
    "TextMate",
    "Windsurf",
    "VSCodium",
    "IntelliJ IDEA",
    "IntelliJ IDEA CE",
    "WebStorm",
    "PhpStorm",
    "PyCharm",
    "PyCharm CE",
    "GoLand",
    "Fleet",
    "Xcode",
    "TextEdit",
];

/// Apps macOS lists for text files that are not editors: browsers run or
/// show the file, terminals run scripts.
#[cfg(not(windows))]
fn not_an_editor(name: &str) -> bool {
    const NOT: &[&str] = &[
        "Safari", "Google Chrome", "Chromium", "Firefox", "Microsoft Edge", "Arc", "Brave Browser", "Opera", "Vivaldi", "Orion",
        "Terminal", "iTerm", "Warp", "Ghostty", "Alacritty", "kitty", "WezTerm", "Hyper", "Script Editor", "Archive Utility",
        "Preview", "Notes", "Pages", "Numbers", "Keynote", "Microsoft Word", "Console", "Python Launcher", "Installer",
    ];
    NOT.iter().any(|n| n.eq_ignore_ascii_case(name))
}

fn app_name(path: &Path) -> String {
    path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Apps LaunchServices says can open these kinds of text files, and the one
/// it opens plain text with. Sample files are made in a temporary folder so
/// the answer follows their real types (.txt, .json, .yml, .sh…).
#[cfg(target_os = "macos")]
fn registered_text_apps() -> (Vec<PathBuf>, Option<PathBuf>) {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSString, NSURL};
    let dir = std::env::temp_dir().join(format!("portway-editors-{}", std::process::id()));
    if std::fs::create_dir_all(&dir).is_err() {
        return (Vec::new(), None);
    }
    let ws = NSWorkspace::sharedWorkspace();
    let url_of = |name: &str| {
        let f = dir.join(name);
        let _ = std::fs::write(&f, "");
        NSURL::fileURLWithPath(&NSString::from_str(&f.to_string_lossy()))
    };
    let mut apps: Vec<PathBuf> = Vec::new();
    for name in ["sample.txt", "sample.json", "sample.yml", "sample.sh", "sample.py", "sample.js", "sample.conf", "sample.md", "sample.xml"] {
        for u in ws.URLsForApplicationsToOpenURL(&url_of(name)).iter() {
            if let Some(p) = u.path() {
                let p = PathBuf::from(p.to_string());
                if !apps.contains(&p) {
                    apps.push(p);
                }
            }
        }
    }
    let default = ws.URLForApplicationToOpenURL(&url_of("sample.txt")).and_then(|u| u.path()).map(|p| PathBuf::from(p.to_string()));
    let _ = std::fs::remove_dir_all(&dir);
    (apps, default)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn registered_text_apps() -> (Vec<PathBuf>, Option<PathBuf>) {
    (Vec::new(), None)
}

/// Where well-known editors install on Windows, per user or for everyone.
#[cfg(windows)]
fn windows_editors() -> Vec<(&'static str, PathBuf)> {
    let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
    let local = env("LOCALAPPDATA");
    let pf = env("ProgramFiles");
    let pf86 = env("ProgramFiles(x86)");
    let under = |root: &Option<PathBuf>, rel: &str| root.as_ref().map(|r| r.join(rel));
    let candidates: Vec<(&'static str, Option<PathBuf>)> = vec![
        ("Visual Studio Code", under(&local, r"Programs\Microsoft VS Code\Code.exe")),
        ("Visual Studio Code", under(&pf, r"Microsoft VS Code\Code.exe")),
        ("Cursor", under(&local, r"Programs\cursor\Cursor.exe")),
        ("Zed", under(&local, r"Programs\Zed\Zed.exe")),
        ("Sublime Text", under(&pf, r"Sublime Text\sublime_text.exe")),
        ("Sublime Text", under(&pf, r"Sublime Text 3\sublime_text.exe")),
        ("Notepad++", under(&pf, r"Notepad++\notepad++.exe")),
        ("Notepad++", under(&pf86, r"Notepad++\notepad++.exe")),
        ("Windsurf", under(&local, r"Programs\Windsurf\Windsurf.exe")),
        ("VSCodium", under(&local, r"Programs\VSCodium\VSCodium.exe")),
        ("VSCodium", under(&pf, r"VSCodium\VSCodium.exe")),
    ];
    let mut out: Vec<(&'static str, PathBuf)> = Vec::new();
    for (name, path) in candidates {
        if let Some(p) = path.filter(|p| p.is_file()) {
            if !out.iter().any(|(n, _)| *n == name) {
                out.push((name, p));
            }
        }
    }
    out
}

/// The display name of a well-known editor at `path` (Windows exe names
/// like Code.exe say little).
#[cfg(windows)]
fn known_name(path: &Path) -> Option<String> {
    if path == notepad() {
        return Some("Notepad".into());
    }
    windows_editors().into_iter().find(|(_, p)| p == path).map(|(n, _)| n.to_string())
}

#[cfg(not(windows))]
fn known_name(_path: &Path) -> Option<String> {
    None
}

/// Code and text editors on this computer: on macOS what LaunchServices
/// registers for text files plus well-known editors found installed; on
/// Windows well-known editors and Notepad (the default). The one chosen in
/// Cài đặt is always on the list.
#[tauri::command]
pub fn editor_apps(settings: tauri::State<'_, crate::settings::SettingsStore>) -> Vec<EditorApp> {
    list_editors(settings.get().editor.map(PathBuf::from).filter(|p| is_app(p)))
}

#[cfg(windows)]
fn list_editors(chosen: Option<PathBuf>) -> Vec<EditorApp> {
    let mut out: Vec<EditorApp> = windows_editors().into_iter().map(|(name, p)| EditorApp { name: name.into(), path: p.to_string_lossy().into_owned(), default: false }).collect();
    out.push(EditorApp { name: "Notepad".into(), path: notepad().to_string_lossy().into_owned(), default: true });
    if let Some(c) = chosen {
        let path = c.to_string_lossy().into_owned();
        if !out.iter().any(|a| a.path.eq_ignore_ascii_case(&path)) {
            out.push(EditorApp { name: app_name(&c), path, default: false });
        }
    }
    out
}

#[cfg(not(windows))]
fn list_editors(chosen: Option<PathBuf>) -> Vec<EditorApp> {
    let (registered, default) = registered_text_apps();
    let home = crate::paths::home_dir();
    let roots = [PathBuf::from("/Applications"), home.join("Applications"), PathBuf::from("/System/Applications")];
    let mut found: Vec<PathBuf> = registered.into_iter().filter(|p| p.is_dir() && !not_an_editor(&app_name(p))).collect();
    for name in KNOWN {
        if let Some(p) = roots.iter().map(|r| r.join(format!("{name}.app"))).find(|p| p.is_dir()) {
            if !found.iter().any(|f| app_name(f) == *name) {
                found.push(p);
            }
        }
    }
    // An app picked by hand stays on the list even if macOS does not list it.
    if let Some(c) = chosen {
        if !found.contains(&c) {
            found.push(c);
        }
    }
    let rank = |p: &PathBuf| KNOWN.iter().position(|k| *k == app_name(p)).unwrap_or(KNOWN.len() - 1);
    found.sort_by(|a, b| rank(a).cmp(&rank(b)).then_with(|| app_name(a).to_lowercase().cmp(&app_name(b).to_lowercase())));
    found
        .into_iter()
        .map(|p| EditorApp { name: app_name(&p), default: default.as_ref() == Some(&p), path: p.to_string_lossy().into_owned() })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folders_differ_per_server_user_and_path() {
        let root = Path::new("/tmp/edit");
        let a = local_dir(root, "id1", "web-01", "10.0.0.1", 22, "root", "/etc/nginx/nginx.conf");
        let b = local_dir(root, "id2", "web-02", "10.0.0.2", 22, "root", "/etc/nginx/nginx.conf");
        let c = local_dir(root, "id1", "web-01", "10.0.0.1", 22, "deploy", "/etc/nginx/nginx.conf");
        let d = local_dir(root, "id1", "web-01", "10.0.0.1", 22, "root", "/etc/nginx/sites/nginx.conf");
        assert_eq!(a, local_dir(root, "id1", "web-01", "10.0.0.1", 22, "root", "/etc/nginx/nginx.conf"));
        assert!(a != b && a != c && a != d);
        let name = a.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with("web-01_root_"), "{name}");
        assert_eq!(tidy("Máy chủ / A"), "M_y_ch____A");
    }

    #[test]
    fn local_copy_names() {
        assert_eq!(local_name("nginx.conf"), "nginx.conf");
        assert_eq!(local_name(""), "file");
        assert_eq!(local_name(".."), "file");
        if cfg!(windows) {
            assert_eq!(local_name("a:b.conf"), "a_b.conf");
            assert_eq!(local_name("notes."), "notes_");
            assert_eq!(local_name("con.txt"), "_con.txt");
            assert_eq!(local_name("what?.log"), "what_.log");
        } else {
            assert_eq!(local_name("a:b.conf"), "a:b.conf");
        }
    }

    /// Prints what LaunchServices reports on this Mac: `cargo test -- --ignored --nocapture lists_text_apps`
    #[cfg(not(windows))]
    #[test]
    #[ignore]
    fn lists_text_apps() {
        let (apps, default) = registered_text_apps();
        for a in &apps {
            println!("{} {}", if not_an_editor(&app_name(a)) { "skip" } else { "keep" }, a.display());
        }
        println!("default: {default:?}");
        assert!(!apps.is_empty());
    }
}
