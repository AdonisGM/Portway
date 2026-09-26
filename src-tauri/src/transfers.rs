//! Upload, download and server-to-server copy queue over SFTP, with progress
//! sent to the UI as `transfer` events. Directories are copied recursively.
//! A copy between two servers streams through this Mac: read from one SFTP
//! session, write to the other, no temporary file.

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::audit::AuditLog;
use crate::error::{AppError, AppResult};
use crate::i18n::tr;
use crate::trace;
use crate::files::{join, sftp, sftp_err};
use crate::paths::home_dir;
use crate::ssh::{shell_quote, Session, Sessions};

const CHUNK: usize = 256 * 1024;
/// Transfers running at once; the rest wait.
const PARALLEL: usize = 3;

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    Up,
    Down,
    /// Server to server, through this Mac.
    Copy,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Queued,
    Running,
    Done,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    pub id: String,
    /// The server read from for a download or copy, written to for an upload.
    pub server_id: String,
    pub user: String,
    /// The server written to by a copy.
    pub dest_server_id: Option<String>,
    pub dest_user: Option<String>,
    pub direction: Direction,
    /// File or directory name, directories end with "/".
    pub name: String,
    pub from: String,
    pub to: String,
    /// Where the result lives: the local file for a download, the remote path otherwise.
    pub target: String,
    /// Still walking the source to find what to copy; size is not known yet.
    pub counting: bool,
    pub size: u64,
    pub done: u64,
    /// Bytes per second over the last second.
    pub speed: f64,
    pub status: Status,
    pub error: Option<String>,
    pub started_at: u64,
    pub finished_at: Option<u64>,
    #[serde(skip)]
    job: Job,
}

/// `name` is the name at the destination when it differs from the source's
/// ("Giữ cả hai"). Without `overwrite`, an existing destination is an error,
/// except for downloads from the Tệp screen, which pick a free local name.
#[derive(Debug, Clone)]
enum Job {
    Download { remote: String, local_dir: PathBuf, name: Option<String>, overwrite: bool },
    Upload { local: PathBuf, remote_dir: String, name: Option<String>, overwrite: bool },
    Copy { remote: String, dest_dir: String, name: Option<String>, overwrite: bool },
}

pub struct Transfers {
    app: AppHandle,
    list: Mutex<Vec<Transfer>>,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    slots: Arc<tokio::sync::Semaphore>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl Transfers {
    pub fn new(app: AppHandle) -> Self {
        Self { app, list: Mutex::new(Vec::new()), cancels: Mutex::new(HashMap::new()), slots: Arc::new(tokio::sync::Semaphore::new(PARALLEL)) }
    }

    fn update(&self, id: &str, f: impl FnOnce(&mut Transfer)) {
        let snapshot = {
            let mut list = self.list.lock().unwrap();
            let Some(t) = list.iter_mut().find(|t| t.id == id) else { return };
            f(t);
            t.clone()
        };
        let _ = self.app.emit("transfer", snapshot);
    }

    fn cancelled(&self, id: &str) -> bool {
        self.cancels.lock().unwrap().get(id).is_some_and(|c| c.load(Ordering::Relaxed))
    }
}

/// `name.ext`, `name (1).ext`, `name (2).ext`… whichever does not exist yet.
fn unique_local(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (1..).map(|n| dir.join(format!("{stem} ({n}){ext}"))).find(|p| !p.exists()).unwrap()
}

/// Files under a remote path, as (remote path, path relative to the root, size,
/// permission bits), plus directories to create.
fn walk_remote<'a>(
    s: &'a SftpSession,
    path: &'a str,
    rel: &'a str,
    files: &'a mut Vec<(String, String, u64, Option<u32>)>,
    dirs: &'a mut Vec<String>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), russh_sftp::client::error::Error>> + Send + 'a>> {
    Box::pin(async move {
        let a = s.metadata(path).await?;
        if a.is_dir() {
            dirs.push(rel.to_string());
            for item in s.read_dir(path).await? {
                let name = item.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                let child_rel = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
                walk_remote(s, &join(path, &name), &child_rel, files, dirs).await?;
            }
        } else {
            files.push((path.to_string(), rel.to_string(), a.size.unwrap_or(0), a.permissions));
        }
        Ok(())
    })
}

fn walk_local(path: &Path, rel: &str, files: &mut Vec<(PathBuf, String, u64, u32)>, dirs: &mut Vec<String>) -> std::io::Result<()> {
    let meta = std::fs::metadata(path)?;
    if meta.is_dir() {
        dirs.push(rel.to_string());
        let mut children: Vec<_> = std::fs::read_dir(path)?.flatten().collect();
        children.sort_by_key(|e| e.file_name());
        for e in children {
            let name = e.file_name().to_string_lossy().into_owned();
            let child_rel = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            walk_local(&e.path(), &child_rel, files, dirs)?;
        }
    } else {
        files.push((path.to_path_buf(), rel.to_string(), meta.len(), std::os::unix::fs::PermissionsExt::mode(&meta.permissions())));
    }
    Ok(())
}

struct Progress<'a> {
    t: &'a Transfers,
    id: String,
    done: u64,
    window: (Instant, u64),
    last_emit: Instant,
    speed: f64,
}

impl Progress<'_> {
    fn add(&mut self, n: usize) {
        self.done += n as u64;
        let now = Instant::now();
        let dt = now.duration_since(self.window.0).as_secs_f64();
        if dt >= 1.0 {
            self.speed = (self.done - self.window.1) as f64 / dt;
            self.window = (now, self.done);
        }
        if now.duration_since(self.last_emit) >= Duration::from_millis(200) {
            self.last_emit = now;
            let (done, speed) = (self.done, self.speed);
            self.t.update(&self.id, |t| {
                t.done = done;
                t.speed = speed;
            });
        }
    }
}

/// Name of the last path component.
fn base_name(path: &str) -> String {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string()
}

async fn run(t: &Transfers, session: &Session, dest: Option<&Session>, id: &str, job: &Job) -> AppResult<()> {
    let s = sftp(session).await?;
    let mut p = Progress { t, id: id.to_string(), done: 0, window: (Instant::now(), 0), last_emit: Instant::now(), speed: 0.0 };
    let mut buf = vec![0u8; CHUNK];
    match job {
        Job::Download { remote, local_dir, name, overwrite } => {
            let (mut files, mut dirs) = (Vec::new(), Vec::new());
            if let Err(e) = walk_remote(&s, remote, "", &mut files, &mut dirs).await {
                return Err(sftp_err(e, session, remote).await);
            }
            let size: u64 = files.iter().map(|f| f.2).sum();
            let name = name.clone().unwrap_or_else(|| base_name(remote));
            let root = if *overwrite { local_dir.join(&name) } else { unique_local(local_dir, &name) };
            t.update(id, |x| {
                x.size = size;
                x.counting = false;
                x.target = root.to_string_lossy().into_owned();
                x.to = crate::paths::contract_tilde(&root);
            });
            for d in &dirs {
                std::fs::create_dir_all(if d.is_empty() { root.clone() } else { root.join(d) })?;
            }
            for (rpath, rel, _, _) in files {
                let local = if rel.is_empty() { root.clone() } else { root.join(&rel) };
                let mut src = match s.open(&rpath).await {
                    Ok(f) => f,
                    Err(e) => return Err(sftp_err(e, session, &rpath).await),
                };
                let mut dst = tokio::fs::File::create(&local).await?;
                loop {
                    if t.cancelled(id) {
                        drop(dst);
                        let _ = std::fs::remove_file(&local);
                        return Err(AppError::new("cancelled"));
                    }
                    let n = src.read(&mut buf).await.map_err(|e| AppError::detail("sftp", e))?;
                    if n == 0 {
                        break;
                    }
                    dst.write_all(&buf[..n]).await?;
                    p.add(n);
                }
                dst.flush().await?;
            }
        }
        Job::Upload { local, remote_dir, name, overwrite } => {
            let (mut files, mut dirs) = (Vec::new(), Vec::new());
            walk_local(local, "", &mut files, &mut dirs)?;
            let size: u64 = files.iter().map(|f| f.2).sum();
            let name = name.clone().unwrap_or_else(|| local.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
            let root = join(remote_dir, &name);
            t.update(id, |x| {
                x.size = size;
                x.counting = false;
                x.target = root.clone();
            });
            if !*overwrite && s.try_exists(&root).await.unwrap_or(false) {
                return Err(AppError::detail("exists", &root));
            }
            make_dirs(&s, session, &root, &dirs).await?;
            for (lpath, rel, _, mode) in files {
                let remote = if rel.is_empty() { root.clone() } else { join(&root, &rel) };
                let mut dst = create_remote(&s, session, &remote, *overwrite).await?;
                let mut src = tokio::fs::File::open(&lpath).await?;
                loop {
                    if t.cancelled(id) {
                        let _ = dst.shutdown().await;
                        let _ = s.remove_file(&remote).await;
                        return Err(AppError::new("cancelled"));
                    }
                    let n = src.read(&mut buf).await?;
                    if n == 0 {
                        break;
                    }
                    dst.write_all(&buf[..n]).await.map_err(|e| AppError::detail("sftp", e))?;
                    p.add(n);
                }
                dst.shutdown().await.map_err(|e| AppError::detail("sftp", e))?;
                keep_mode(&s, &remote, Some(mode)).await;
            }
        }
        Job::Copy { remote, dest_dir, name, overwrite } => {
            let dest = dest.ok_or_else(|| AppError::new("not_connected"))?;
            let d = sftp(dest).await?;
            let (mut files, mut dirs) = (Vec::new(), Vec::new());
            if let Err(e) = walk_remote(&s, remote, "", &mut files, &mut dirs).await {
                return Err(sftp_err(e, session, remote).await);
            }
            let size: u64 = files.iter().map(|f| f.2).sum();
            let name = name.clone().unwrap_or_else(|| base_name(remote));
            let root = join(dest_dir, &name);
            t.update(id, |x| {
                x.size = size;
                x.counting = false;
                x.target = root.clone();
            });
            if !*overwrite && d.try_exists(&root).await.unwrap_or(false) {
                return Err(AppError::detail("exists", &root));
            }
            make_dirs(&d, dest, &root, &dirs).await?;
            for (rpath, rel, _, mode) in files {
                let target = if rel.is_empty() { root.clone() } else { join(&root, &rel) };
                let mut src = match s.open(&rpath).await {
                    Ok(f) => f,
                    Err(e) => return Err(sftp_err(e, session, &rpath).await),
                };
                let mut dst = create_remote(&d, dest, &target, *overwrite).await?;
                loop {
                    if t.cancelled(id) {
                        let _ = dst.shutdown().await;
                        let _ = d.remove_file(&target).await;
                        return Err(AppError::new("cancelled"));
                    }
                    let n = src.read(&mut buf).await.map_err(|e| AppError::detail("sftp", e))?;
                    if n == 0 {
                        break;
                    }
                    dst.write_all(&buf[..n]).await.map_err(|e| AppError::detail("sftp", e))?;
                    p.add(n);
                }
                dst.shutdown().await.map_err(|e| AppError::detail("sftp", e))?;
                keep_mode(&d, &target, mode).await;
            }
        }
    }
    let done = p.done;
    t.update(id, |x| x.done = done);
    Ok(())
}

/// Give a copied file the source's permission bits (a script stays
/// executable), like scp. Best effort: the copy itself already succeeded.
async fn keep_mode(s: &SftpSession, path: &str, mode: Option<u32>) {
    if let Some(mode) = mode {
        let mut attrs = FileAttributes::empty();
        attrs.permissions = Some(mode & 0o777);
        let _ = s.set_metadata(path, attrs).await;
    }
}

/// Create the destination root and the directories under it, keeping those
/// that exist (a directory copied onto one with the same name merges into it).
async fn make_dirs(s: &SftpSession, session: &Session, root: &str, dirs: &[String]) -> AppResult<()> {
    for d in dirs {
        let path = if d.is_empty() { root.to_string() } else { join(root, d) };
        if !s.try_exists(&path).await.unwrap_or(false) {
            if let Err(e) = s.create_dir(&path).await {
                return Err(sftp_err(e, session, &path).await);
            }
        }
    }
    Ok(())
}

async fn create_remote(s: &SftpSession, session: &Session, path: &str, overwrite: bool) -> AppResult<russh_sftp::client::fs::File> {
    let flags = OpenFlags::CREATE | OpenFlags::WRITE | if overwrite { OpenFlags::TRUNCATE } else { OpenFlags::EXCLUDE };
    match s.open_with_flags(path, flags).await {
        Ok(f) => Ok(f),
        Err(russh_sftp::client::error::Error::Status(st)) if !overwrite && st.status_code == russh_sftp::protocol::StatusCode::Failure => {
            Err(AppError::detail("exists", path))
        }
        Err(e) => Err(sftp_err(e, session, path).await),
    }
}

fn spawn(state: Arc<Transfers>, session: Arc<Session>, dest: Option<Arc<Session>>, audit: AuditLog, id: String) {
    tauri::async_runtime::spawn(async move {
        let Some(first) = state.list.lock().unwrap().iter().find(|t| t.id == id).cloned() else { return };
        let job = first.job.clone();
        let (action, cmd, label) = match &job {
            Job::Download { remote, .. } => ("download", format!("sftp get -r {} {}", shell_quote(remote), first.to), tr(format!("Tải xuống {}", first.name), format!("Download {}", first.name))),
            Job::Upload { local, remote_dir, .. } => (
                "upload",
                format!("sftp put -r {} {}", shell_quote(&local.to_string_lossy()), shell_quote(remote_dir)),
                tr(format!("Tải lên {}", first.name), format!("Upload {}", first.name)),
            ),
            Job::Copy { remote, dest_dir, .. } => {
                let d = dest.as_deref();
                (
                    "copy",
                    format!(
                        "sftp get -r {} | sftp put -r {}@{}:{}  {}",
                        shell_quote(remote),
                        d.map(|d| d.user.as_str()).unwrap_or("?"),
                        first.to.split(':').next().unwrap_or("?"),
                        shell_quote(dest_dir),
                        tr("(qua máy này)", "(via this Mac)")
                    ),
                    tr(format!("Chép {} sang {}", first.name, first.to), format!("Copy {} to {}", first.name, first.to)),
                )
            }
        };
        // Waits here while the other transfers hold every slot.
        let span = trace::start(&session.server_id, &session.user, trace::Kind::Transfer, Some(label), &cmd, true);
        let _permit = state.slots.clone().acquire_owned().await;
        if state.cancelled(&id) {
            state.update(&id, |t| {
                t.status = Status::Cancelled;
                t.finished_at = Some(now_ms());
            });
            span.fail(tr("Đã huỷ trước khi chạy", "Cancelled before it started"), |_| {});
            return;
        }
        span.running();
        state.update(&id, |t| {
            t.status = Status::Running;
            t.counting = true;
            t.started_at = now_ms();
        });
        let result = run(&state, &session, dest.as_deref(), &id, &job).await;
        let done = state.list.lock().unwrap().iter().find(|t| t.id == id).map(|t| t.done).unwrap_or(0);
        // The change is made on the server written to.
        let (audit_server, audit_user) = match &dest {
            Some(d) => (d.server_id.clone(), d.user.clone()),
            None => (first.server_id.clone(), session.user.clone()),
        };
        match result {
            Ok(()) => {
                state.update(&id, |t| {
                    t.status = Status::Done;
                    t.counting = false;
                    t.speed = 0.0;
                    t.finished_at = Some(now_ms());
                });
                span.ok(|e| e.out_bytes = Some(done));
                audit.record(&audit_server, &audit_user, action, cmd, true, None);
            }
            Err(e) => {
                let cancelled = e.code == "cancelled";
                let msg = e.detail.clone().map(|d| format!("{}: {d}", e.code)).unwrap_or_else(|| e.code.to_string());
                state.update(&id, |t| {
                    t.status = if cancelled { Status::Cancelled } else { Status::Error };
                    t.error = (!cancelled).then(|| msg.clone());
                    t.counting = false;
                    t.speed = 0.0;
                    t.finished_at = Some(now_ms());
                });
                span.fail(if cancelled { tr("Đã huỷ", "Cancelled") } else { msg.clone() }, |e| e.out_bytes = Some(done));
                if !cancelled {
                    audit.record(&audit_server, &audit_user, action, cmd, false, Some(msg));
                }
            }
        }
        state.cancels.lock().unwrap().remove(&id);
    });
}

struct NewTransfer {
    server_id: String,
    user: String,
    dest: Option<Arc<Session>>,
    direction: Direction,
    name: String,
    from: String,
    to: String,
    job: Job,
}

fn enqueue(state: &Arc<Transfers>, session: Arc<Session>, audit: AuditLog, n: NewTransfer) -> Transfer {
    let t = Transfer {
        id: uuid::Uuid::new_v4().to_string(),
        server_id: n.server_id,
        user: n.user,
        dest_server_id: n.dest.as_ref().map(|d| d.server_id.clone()),
        dest_user: n.dest.as_ref().map(|d| d.user.clone()),
        direction: n.direction,
        name: n.name,
        from: n.from,
        to: n.to,
        target: String::new(),
        counting: false,
        size: 0,
        done: 0,
        speed: 0.0,
        status: Status::Queued,
        error: None,
        started_at: now_ms(),
        finished_at: None,
        job: n.job,
    };
    state.list.lock().unwrap().push(t.clone());
    state.cancels.lock().unwrap().insert(t.id.clone(), Arc::new(AtomicBool::new(false)));
    let _ = state.app.emit("transfer", t.clone());
    spawn(state.clone(), session, n.dest, audit, t.id.clone());
    t
}

/// "~/Downloads/x" for a path under the home directory, as shown in the queue.
fn tilde(path: &Path) -> String {
    match path.strip_prefix(home_dir()) {
        Ok(rest) if rest.as_os_str().is_empty() => "~".into(),
        Ok(rest) => format!("~/{}", rest.display()),
        Err(_) => path.display().to_string(),
    }
}

/// Download remote paths into `dest`, a local folder the user picked. Names
/// that exist there get " (1)", " (2)"…
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn transfer_download(
    state: tauri::State<'_, Arc<Transfers>>,
    sessions: tauri::State<'_, Sessions>,
    audit: tauri::State<'_, AuditLog>,
    server_name: String,
    server_id: String,
    user: String,
    paths: Vec<String>,
    dest: String,
) -> AppResult<Vec<Transfer>> {
    let items = paths.into_iter().map(|path| Item { path, name: None, overwrite: false }).collect();
    transfer_copy(state, sessions, audit, End::Remote { server_id, user, name: server_name }, End::Local, dest, items)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn transfer_upload(
    state: tauri::State<'_, Arc<Transfers>>,
    sessions: tauri::State<'_, Sessions>,
    audit: tauri::State<'_, AuditLog>,
    server_name: String,
    server_id: String,
    user: String,
    local_paths: Vec<String>,
    remote_dir: String,
    overwrite: bool,
) -> AppResult<Vec<Transfer>> {
    let items = local_paths.into_iter().map(|path| Item { path, name: None, overwrite }).collect();
    transfer_copy(state, sessions, audit, End::Local, End::Remote { server_id, user, name: server_name }, remote_dir, items)
}

/// One side of a copy: this Mac, or a server session.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum End {
    Local,
    Remote { server_id: String, user: String, name: String },
}

/// A file or directory to copy. `name` renames it at the destination.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub path: String,
    pub name: Option<String>,
    pub overwrite: bool,
}

/// Copy items from one side into the directory `dir` on the other: upload,
/// download, or server to server through this Mac.
#[tauri::command]
pub fn transfer_copy(
    state: tauri::State<'_, Arc<Transfers>>,
    sessions: tauri::State<'_, Sessions>,
    audit: tauri::State<'_, AuditLog>,
    from: End,
    to: End,
    dir: String,
    items: Vec<Item>,
) -> AppResult<Vec<Transfer>> {
    let audit = audit.inner().clone();
    match (from, to) {
        (End::Local, End::Local) => Err(AppError::new("same_side")),
        (End::Local, End::Remote { server_id, user, name: server_name }) => {
            let session = sessions.get(&server_id, &user)?;
            items
                .into_iter()
                .map(|item| {
                    let local = PathBuf::from(&item.path);
                    if !local.exists() {
                        return Err(AppError::detail("not_found", &item.path));
                    }
                    let base = item.name.clone().unwrap_or_else(|| local.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
                    Ok(enqueue(
                        &state,
                        session.clone(),
                        audit.clone(),
                        NewTransfer {
                            server_id: server_id.clone(),
                            user: user.clone(),
                            dest: None,
                            direction: Direction::Up,
                            name: base + if local.is_dir() { "/" } else { "" },
                            from: crate::paths::contract_tilde(&local),
                            to: format!("{server_name}:{dir}"),
                            job: Job::Upload { local, remote_dir: dir.clone(), name: item.name, overwrite: item.overwrite },
                        },
                    ))
                })
                .collect()
        }
        (End::Remote { server_id, user, name: server_name }, End::Local) => {
            let session = sessions.get(&server_id, &user)?;
            let local_dir = crate::paths::expand_tilde(&dir);
            if !local_dir.is_dir() {
                return Err(AppError::detail("not_a_dir", &dir));
            }
            let shown = tilde(&local_dir);
            Ok(items
                .into_iter()
                .map(|item| {
                    enqueue(
                        &state,
                        session.clone(),
                        audit.clone(),
                        NewTransfer {
                            server_id: server_id.clone(),
                            user: user.clone(),
                            dest: None,
                            direction: Direction::Down,
                            name: item.name.clone().unwrap_or_else(|| base_name(&item.path)),
                            from: format!("{server_name}:{}", item.path),
                            to: shown.clone(),
                            job: Job::Download { remote: item.path, local_dir: local_dir.clone(), name: item.name, overwrite: item.overwrite },
                        },
                    )
                })
                .collect())
        }
        (End::Remote { server_id, user, name: src_name }, End::Remote { server_id: dest_id, user: dest_user, name: dest_name }) => {
            let session = sessions.get(&server_id, &user)?;
            let dest = sessions.get(&dest_id, &dest_user)?;
            Ok(items
                .into_iter()
                .map(|item| {
                    enqueue(
                        &state,
                        session.clone(),
                        audit.clone(),
                        NewTransfer {
                            server_id: server_id.clone(),
                            user: user.clone(),
                            dest: Some(dest.clone()),
                            direction: Direction::Copy,
                            name: item.name.clone().unwrap_or_else(|| base_name(&item.path)),
                            from: format!("{src_name}:{}", item.path),
                            to: format!("{dest_name}:{dir}"),
                            job: Job::Copy { remote: item.path, dest_dir: dir.clone(), name: item.name, overwrite: item.overwrite },
                        },
                    )
                })
                .collect())
        }
    }
}

#[tauri::command]
pub fn transfer_list(state: tauri::State<'_, Arc<Transfers>>) -> Vec<Transfer> {
    state.list.lock().unwrap().clone()
}

#[tauri::command]
pub fn transfer_cancel(state: tauri::State<'_, Arc<Transfers>>, id: String) {
    if let Some(c) = state.cancels.lock().unwrap().get(&id) {
        c.store(true, Ordering::Relaxed);
    }
}

/// Run a failed or cancelled transfer again.
#[tauri::command]
pub fn transfer_retry(
    state: tauri::State<'_, Arc<Transfers>>,
    sessions: tauri::State<'_, Sessions>,
    audit: tauri::State<'_, AuditLog>,
    id: String,
) -> AppResult<()> {
    let (server_id, user, dest) = {
        let list = state.list.lock().unwrap();
        let t = list.iter().find(|t| t.id == id).ok_or_else(|| AppError::new("not_found"))?;
        if !matches!(t.status, Status::Error | Status::Cancelled) {
            return Ok(());
        }
        (t.server_id.clone(), t.user.clone(), t.dest_server_id.clone().zip(t.dest_user.clone()))
    };
    let session = sessions.get(&server_id, &user)?;
    let dest = match dest {
        Some((d, u)) => Some(sessions.get(&d, &u)?),
        None => None,
    };
    state.cancels.lock().unwrap().insert(id.clone(), Arc::new(AtomicBool::new(false)));
    state.update(&id, |t| {
        t.status = Status::Queued;
        t.error = None;
        t.done = 0;
        t.finished_at = None;
    });
    spawn(state.inner().clone(), session, dest, audit.inner().clone(), id);
    Ok(())
}

/// Forget finished transfers (done, failed, cancelled).
#[tauri::command]
pub fn transfer_clear(state: tauri::State<'_, Arc<Transfers>>) -> Vec<Transfer> {
    let mut list = state.list.lock().unwrap();
    list.retain(|t| matches!(t.status, Status::Queued | Status::Running));
    list.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unique_names() {
        let dir = std::env::temp_dir().join(format!("portway-unique-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(unique_local(&dir, "a.tar.gz"), dir.join("a.tar.gz"));
        std::fs::write(dir.join("a.tar.gz"), "").unwrap();
        assert_eq!(unique_local(&dir, "a.tar.gz"), dir.join("a.tar (1).gz"));
        std::fs::write(dir.join("notes"), "").unwrap();
        assert_eq!(unique_local(&dir, "notes"), dir.join("notes (1)"));
        std::fs::remove_dir_all(dir).ok();
    }
}
