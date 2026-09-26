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
use crate::files::{sftp, sftp_err};
use crate::servers::ServerStore;
use crate::ssh::{exec_input, exec_priv, shell_quote, Session, Sessions};

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

/// Replace the file's content in place, so its owner, group and mode stay.
async fn write_remote(session: &Session, path: &str, data: &[u8], sudo: bool) -> AppResult<()> {
    if sudo {
        let b64 = base64::engine::general_purpose::STANDARD.encode(data);
        let out = exec_input(session, &format!("base64 -d > {}", shell_quote(path)), &format!("{b64}\n"), true, Duration::from_secs(60)).await?;
        if out.code != Some(0) {
            return Err(AppError::detail("remote_command", out.stderr.trim()));
        }
        return Ok(());
    }
    let s = sftp(session).await?;
    let mut f = match s.open_with_flags(path, OpenFlags::WRITE | OpenFlags::TRUNCATE).await {
        Ok(f) => f,
        Err(e) => return Err(sftp_err(e, session, path).await),
    };
    f.write_all(data).await.map_err(|e| AppError::detail("sftp", e))?;
    f.shutdown().await.map_err(|e| AppError::detail("sftp", e))?;
    Ok(())
}

/// Open the local copy in `app` (a .app path) or the default text editor.
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

fn app_label(app: Option<&str>) -> Option<String> {
    app.map(|a| Path::new(a).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| a.to_string()))
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
                e.edit.error = Some("Chưa có kết nối tới server; sẽ tải lên khi kết nối lại".into());
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
                e.edit.error = Some("Tệp trên server đã đổi từ lúc Portway mở nó".into());
            });
        }
        Err(err) => {
            let text = err.detail.clone().unwrap_or_else(|| err.code.to_string());
            audit.record(&edit.server_id, &edit.user, "editUpload", &cmd, false, Some(text.clone()));
            let lost = matches!(err.code, "connection_lost" | "not_connected");
            edits.update(id, |e| {
                e.edit.status = if lost { Status::Pending } else { Status::Error };
                e.edit.error = Some(if lost { "Mất kết nối; sẽ tải lên khi kết nối lại".into() } else { text });
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
    let plain = match s.open(&path).await {
        Ok(_) => true,
        Err(russh_sftp::client::error::Error::Status(st)) if st.status_code == russh_sftp::protocol::StatusCode::PermissionDenied => false,
        Err(e) => return Err(sftp_err(e, &session, &path).await),
    };
    let sudo = !plain;
    if sudo && !session.sudo_on() {
        return Err(AppError::detail("permission_denied", &path));
    }
    let remote = remote_stat(&session, &path, sudo).await?.ok_or_else(|| AppError::detail("not_found", &path))?;
    if remote.1 > MAX_SIZE {
        return Err(AppError::detail("too_big", remote.1));
    }
    let data = read_remote(&session, &path, sudo).await?;

    let dir = local_dir(&edits.root(), &server_id, &server.name, &server.host, server.port, &user, &path);
    std::fs::create_dir_all(&dir)?;
    let name = path.rsplit('/').next().filter(|n| !n.is_empty()).unwrap_or("file");
    let local = dir.join(name);
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
}

/// Code and text editors installed on this Mac, in a sensible order.
#[tauri::command]
pub fn editor_apps() -> Vec<EditorApp> {
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
    let home = crate::paths::home_dir();
    let roots = [PathBuf::from("/Applications"), home.join("Applications"), PathBuf::from("/System/Applications")];
    KNOWN
        .iter()
        .filter_map(|name| {
            roots.iter().map(|r| r.join(format!("{name}.app"))).find(|p| p.is_dir()).map(|p| EditorApp { name: name.to_string(), path: p.to_string_lossy().into_owned() })
        })
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
}
