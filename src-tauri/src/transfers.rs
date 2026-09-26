//! Upload and download queue over SFTP, with progress sent to the UI as
//! `transfer` events. Directories are copied recursively.

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::audit::AuditLog;
use crate::error::{AppError, AppResult};
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
    pub server_id: String,
    pub user: String,
    pub direction: Direction,
    /// File or directory name, directories end with "/".
    pub name: String,
    pub from: String,
    pub to: String,
    /// Where the result lives: the local file for a download, the remote path for an upload.
    pub target: String,
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

#[derive(Debug, Clone)]
enum Job {
    Download { remote: String, local_dir: PathBuf },
    Upload { local: PathBuf, remote_dir: String, overwrite: bool },
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

/// Files under a remote path, as (remote path, path relative to the root), plus directories to create.
fn walk_remote<'a>(
    s: &'a SftpSession,
    path: &'a str,
    rel: &'a str,
    files: &'a mut Vec<(String, String, u64)>,
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
            files.push((path.to_string(), rel.to_string(), a.size.unwrap_or(0)));
        }
        Ok(())
    })
}

fn walk_local(path: &Path, rel: &str, files: &mut Vec<(PathBuf, String, u64)>, dirs: &mut Vec<String>) -> std::io::Result<()> {
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
        files.push((path.to_path_buf(), rel.to_string(), meta.len()));
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

async fn run(t: &Transfers, session: &Session, id: &str, job: &Job) -> AppResult<()> {
    let s = sftp(session).await?;
    let mut p = Progress { t, id: id.to_string(), done: 0, window: (Instant::now(), 0), last_emit: Instant::now(), speed: 0.0 };
    let mut buf = vec![0u8; CHUNK];
    match job {
        Job::Download { remote, local_dir } => {
            let (mut files, mut dirs) = (Vec::new(), Vec::new());
            if let Err(e) = walk_remote(&s, remote, "", &mut files, &mut dirs).await {
                return Err(sftp_err(e, session, remote).await);
            }
            let size: u64 = files.iter().map(|f| f.2).sum();
            let name = remote.trim_end_matches('/').rsplit('/').next().unwrap_or("download").to_string();
            let root = unique_local(local_dir, &name);
            t.update(id, |x| {
                x.size = size;
                x.target = root.to_string_lossy().into_owned();
                x.to = crate::paths::contract_tilde(&root);
            });
            for d in &dirs {
                std::fs::create_dir_all(if d.is_empty() { root.clone() } else { root.join(d) })?;
            }
            for (rpath, rel, _) in files {
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
        Job::Upload { local, remote_dir, overwrite } => {
            let (mut files, mut dirs) = (Vec::new(), Vec::new());
            walk_local(local, "", &mut files, &mut dirs)?;
            let size: u64 = files.iter().map(|f| f.2).sum();
            let name = local.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let root = join(remote_dir, &name);
            t.update(id, |x| {
                x.size = size;
                x.target = root.clone();
            });
            for d in &dirs {
                let path = if d.is_empty() { root.clone() } else { join(&root, d) };
                if !s.try_exists(&path).await.unwrap_or(false) {
                    if let Err(e) = s.create_dir(&path).await {
                        return Err(sftp_err(e, session, &path).await);
                    }
                }
            }
            for (lpath, rel, _) in files {
                let remote = if rel.is_empty() { root.clone() } else { join(&root, &rel) };
                let flags = OpenFlags::CREATE | OpenFlags::WRITE | if *overwrite { OpenFlags::TRUNCATE } else { OpenFlags::EXCLUDE };
                let mut dst = match s.open_with_flags(&remote, flags).await {
                    Ok(f) => f,
                    Err(russh_sftp::client::error::Error::Status(st)) if !*overwrite && st.status_code == russh_sftp::protocol::StatusCode::Failure => {
                        return Err(AppError::detail("exists", &remote));
                    }
                    Err(e) => return Err(sftp_err(e, session, &remote).await),
                };
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
            }
        }
    }
    let done = p.done;
    t.update(id, |x| x.done = done);
    Ok(())
}

fn spawn(state: Arc<Transfers>, session: Arc<Session>, audit: AuditLog, id: String) {
    tauri::async_runtime::spawn(async move {
        let Some(job) = state.list.lock().unwrap().iter().find(|t| t.id == id).map(|t| t.job.clone()) else { return };
        let _permit = state.slots.clone().acquire_owned().await;
        if state.cancelled(&id) {
            state.update(&id, |t| {
                t.status = Status::Cancelled;
                t.finished_at = Some(now_ms());
            });
            return;
        }
        state.update(&id, |t| {
            t.status = Status::Running;
            t.started_at = now_ms();
        });
        let result = run(&state, &session, &id, &job).await;
        let snapshot = state.list.lock().unwrap().iter().find(|t| t.id == id).cloned();
        let (action, cmd) = match &job {
            Job::Download { remote, .. } => ("download", format!("sftp get -r {} {}", shell_quote(remote), snapshot.as_ref().map(|t| t.to.clone()).unwrap_or_default())),
            Job::Upload { local, remote_dir, .. } => ("upload", format!("sftp put -r {} {}", shell_quote(&local.to_string_lossy()), shell_quote(remote_dir))),
        };
        match result {
            Ok(()) => {
                state.update(&id, |t| {
                    t.status = Status::Done;
                    t.speed = 0.0;
                    t.finished_at = Some(now_ms());
                });
                audit.record(&session_server(&snapshot), &session.user, action, cmd, true, None);
            }
            Err(e) => {
                let cancelled = e.code == "cancelled";
                let msg = e.detail.clone().map(|d| format!("{}: {d}", e.code)).unwrap_or_else(|| e.code.to_string());
                state.update(&id, |t| {
                    t.status = if cancelled { Status::Cancelled } else { Status::Error };
                    t.error = (!cancelled).then(|| msg.clone());
                    t.speed = 0.0;
                    t.finished_at = Some(now_ms());
                });
                if !cancelled {
                    audit.record(&session_server(&snapshot), &session.user, action, cmd, false, Some(msg));
                }
            }
        }
        state.cancels.lock().unwrap().remove(&id);
    });
}

fn session_server(t: &Option<Transfer>) -> String {
    t.as_ref().map(|t| t.server_id.clone()).unwrap_or_default()
}

fn enqueue(state: &Arc<Transfers>, session: Arc<Session>, audit: AuditLog, server_id: &str, user: &str, direction: Direction, name: String, from: String, to: String, job: Job) -> Transfer {
    let t = Transfer {
        id: uuid::Uuid::new_v4().to_string(),
        server_id: server_id.to_string(),
        user: user.to_string(),
        direction,
        name,
        from,
        to,
        target: String::new(),
        size: 0,
        done: 0,
        speed: 0.0,
        status: Status::Queued,
        error: None,
        started_at: now_ms(),
        finished_at: None,
        job,
    };
    state.list.lock().unwrap().push(t.clone());
    state.cancels.lock().unwrap().insert(t.id.clone(), Arc::new(AtomicBool::new(false)));
    let _ = state.app.emit("transfer", t.clone());
    spawn(state.clone(), session, audit, t.id.clone());
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

/// Download remote paths into `dest`, a local folder the user picked.
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
    let session = sessions.get(&server_id, &user)?;
    let dir = PathBuf::from(&dest);
    if !dir.is_dir() {
        return Err(AppError::detail("not_a_dir", &dest));
    }
    let shown = tilde(&dir);
    Ok(paths
        .into_iter()
        .map(|remote| {
            let name = remote.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string();
            let from = format!("{server_name}:{remote}");
            enqueue(
                &state,
                session.clone(),
                audit.inner().clone(),
                &server_id,
                &user,
                Direction::Down,
                name,
                from,
                shown.clone(),
                Job::Download { remote, local_dir: dir.clone() },
            )
        })
        .collect())
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
    let session = sessions.get(&server_id, &user)?;
    local_paths
        .into_iter()
        .map(|p| {
            let local = PathBuf::from(&p);
            if !local.exists() {
                return Err(AppError::detail("not_found", &p));
            }
            let name = local.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default() + if local.is_dir() { "/" } else { "" };
            Ok(enqueue(
                &state,
                session.clone(),
                audit.inner().clone(),
                &server_id,
                &user,
                Direction::Up,
                name,
                crate::paths::contract_tilde(&local),
                format!("{server_name}:{remote_dir}"),
                Job::Upload { local, remote_dir: remote_dir.clone(), overwrite },
            ))
        })
        .collect()
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
    let (server_id, user) = {
        let list = state.list.lock().unwrap();
        let t = list.iter().find(|t| t.id == id).ok_or_else(|| AppError::new("not_found"))?;
        if !matches!(t.status, Status::Error | Status::Cancelled) {
            return Ok(());
        }
        (t.server_id.clone(), t.user.clone())
    };
    let session = sessions.get(&server_id, &user)?;
    state.cancels.lock().unwrap().insert(id.clone(), Arc::new(AtomicBool::new(false)));
    state.update(&id, |t| {
        t.status = Status::Queued;
        t.error = None;
        t.done = 0;
        t.finished_at = None;
    });
    spawn(state.inner().clone(), session, audit.inner().clone(), id);
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
