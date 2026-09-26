//! Debug trace: every remote command, SFTP call, connection step and file
//! transfer, from the moment it starts (or waits for a free SSH channel) until
//! it ends. Kept in memory only (the last `KEEP`), and pushed to the UI as a
//! `trace` event each time an entry changes, so a slow screen can be explained.

use serde::Serialize;
use std::collections::VecDeque;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

const KEEP: usize = 2000;
/// Start of stdout/stderr kept per entry.
const HEAD: usize = 2048;

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    /// A command over an SSH exec channel.
    Exec,
    Sftp,
    Connect,
    Transfer,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    /// Waiting for a free SSH channel (the session allows a few at once).
    Waiting,
    Running,
    Ok,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: u64,
    /// ms since epoch.
    pub at: u64,
    pub server_id: String,
    pub user: String,
    pub kind: Kind,
    /// What the app was doing, e.g. "Docker · danh sách container".
    pub label: String,
    /// The command or operation, as it ran (with sudo when it went through sudo).
    pub command: String,
    pub status: Status,
    /// Time spent waiting for a channel before running.
    pub wait_ms: Option<u64>,
    pub duration_ms: Option<u64>,
    pub exit_code: Option<u32>,
    pub out_bytes: Option<u64>,
    pub err_bytes: Option<u64>,
    pub stdout: Option<String>,
    pub stderr: Option<String>,
    pub error: Option<String>,
}

struct Tracer {
    app: Mutex<Option<AppHandle>>,
    list: Mutex<VecDeque<Entry>>,
    next: AtomicU64,
}

fn tracer() -> &'static Tracer {
    static T: OnceLock<Tracer> = OnceLock::new();
    T.get_or_init(|| Tracer { app: Mutex::new(None), list: Mutex::new(VecDeque::new()), next: AtomicU64::new(1) })
}

pub fn init(app: AppHandle) {
    *tracer().app.lock().unwrap() = Some(app);
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn emit(e: &Entry) {
    if let Some(app) = tracer().app.lock().unwrap().as_ref() {
        let _ = app.emit("trace", e.clone());
    }
}

fn update(id: u64, f: impl FnOnce(&mut Entry)) {
    let changed = {
        let mut list = tracer().list.lock().unwrap();
        list.iter_mut().rev().find(|e| e.id == id).map(|e| {
            f(e);
            e.clone()
        })
    };
    if let Some(e) = changed {
        emit(&e);
    }
}

/// Each run swaps the section mark for a random `@@PW<32 hex>@@` token (see
/// ssh::exec_with); show the mark again so outputs read the same every time.
fn unmark(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find("@@PW") {
        let tail = &rest[i + 4..];
        let is_token = tail.len() >= 34 && tail[..32].bytes().all(|b| b.is_ascii_hexdigit()) && &tail[32..34] == "@@";
        out.push_str(&rest[..i]);
        if is_token {
            out.push_str(crate::ssh::MARK);
            rest = &tail[34..];
        } else {
            out.push_str("@@PW");
            rest = tail;
        }
    }
    out.push_str(rest);
    out
}

/// Keep the head of a stream, on a character boundary.
pub fn head(s: &str) -> Option<String> {
    if s.is_empty() {
        return None;
    }
    let s = &unmark(s);
    if s.len() <= HEAD {
        return Some(s.to_string());
    }
    let mut end = HEAD;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    Some(format!("{}…", &s[..end]))
}

tokio::task_local! {
    static LABEL: String;
}

/// Run `f` with a label that the commands it sends inherit, e.g. the screen
/// part that asked for them.
pub async fn labelled<F: Future>(label: impl Into<String>, f: F) -> F::Output {
    LABEL.scope(label.into(), f).await
}

fn current_label() -> Option<String> {
    LABEL.try_with(|l| l.clone()).ok()
}

/// First meaningful line of a script, for entries without a label.
fn first_line(command: &str) -> String {
    let line = command.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with('#')).unwrap_or("");
    let mut s: String = line.chars().take(80).collect();
    if line.chars().count() > 80 {
        s.push('…');
    }
    s
}

/// One traced operation. Finish it with `ok`/`fail`; dropping it unfinished
/// (a timeout or cancelled future) records it as cut short.
pub struct Span {
    id: u64,
    started: Instant,
    done: bool,
}

pub fn start(server_id: &str, user: &str, kind: Kind, label: Option<String>, command: &str, waiting: bool) -> Span {
    let t = tracer();
    let id = t.next.fetch_add(1, Ordering::Relaxed);
    let e = Entry {
        id,
        at: now_ms(),
        server_id: server_id.to_string(),
        user: user.to_string(),
        kind,
        label: label.or_else(current_label).unwrap_or_else(|| first_line(command)),
        command: command.to_string(),
        status: if waiting { Status::Waiting } else { Status::Running },
        wait_ms: None,
        duration_ms: None,
        exit_code: None,
        out_bytes: None,
        err_bytes: None,
        stdout: None,
        stderr: None,
        error: None,
    };
    {
        let mut list = t.list.lock().unwrap();
        list.push_back(e.clone());
        while list.len() > KEEP {
            list.pop_front();
        }
    }
    emit(&e);
    Span { id, started: Instant::now(), done: false }
}

impl Span {
    /// Got its channel and started running.
    pub fn running(&self) {
        let waited = self.started.elapsed().as_millis() as u64;
        update(self.id, |e| {
            e.status = Status::Running;
            e.wait_ms = Some(waited);
        });
    }

    pub fn ok(mut self, fill: impl FnOnce(&mut Entry)) {
        self.done = true;
        let ms = self.started.elapsed().as_millis() as u64;
        update(self.id, |e| {
            e.status = Status::Ok;
            e.duration_ms = Some(ms);
            fill(e);
        });
    }

    pub fn fail(mut self, error: impl ToString, fill: impl FnOnce(&mut Entry)) {
        self.done = true;
        let ms = self.started.elapsed().as_millis() as u64;
        let error = error.to_string();
        update(self.id, |e| {
            e.status = Status::Error;
            e.duration_ms = Some(ms);
            e.error = Some(error);
            fill(e);
        });
    }
}

impl Drop for Span {
    fn drop(&mut self) {
        if !self.done {
            let ms = self.started.elapsed().as_millis() as u64;
            update(self.id, |e| {
                e.status = Status::Error;
                e.duration_ms = Some(ms);
                e.error.get_or_insert_with(|| crate::i18n::tr("Bị ngắt giữa chừng", "Interrupted"));
            });
        }
    }
}

#[tauri::command]
pub fn trace_list() -> Vec<Entry> {
    tracer().list.lock().unwrap().iter().cloned().collect()
}

#[tauri::command]
pub fn trace_clear() {
    tracer().list.lock().unwrap().retain(|e| matches!(e.status, Status::Waiting | Status::Running));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_default_to_the_first_line() {
        assert_eq!(first_line("\n# comment\n  docker ps -a\nmore"), "docker ps -a");
        assert_eq!(first_line(&"x".repeat(100)).chars().count(), 81);
    }

    #[test]
    fn shows_the_section_mark_again() {
        let token = format!("@@PW{}@@", "a1".repeat(16));
        assert_eq!(head(&format!("1\n{token}\n2 @@PWx")).unwrap(), "1\n@@PORTWAY@@\n2 @@PWx");
    }

    #[test]
    fn keeps_heads_on_char_boundaries() {
        let s = "é".repeat(HEAD);
        let h = head(&s).unwrap();
        assert!(h.ends_with('…'));
        assert!(h.len() <= HEAD + '…'.len_utf8());
        assert_eq!(head(""), None);
    }

    #[tokio::test]
    async fn spans_record_their_end() {
        let s = start("srv", "root", Kind::Exec, Some("test".into()), "true", true);
        s.running();
        let id = s.id;
        s.ok(|e| e.exit_code = Some(0));
        let e = trace_list().into_iter().find(|e| e.id == id).unwrap();
        assert_eq!(e.status, Status::Ok);
        assert!(e.wait_ms.is_some() && e.duration_ms.is_some());

        let dropped = labelled("outer", async { start("srv", "root", Kind::Exec, None, "sleep 9", false) }).await;
        let id = dropped.id;
        drop(dropped);
        let e = trace_list().into_iter().find(|e| e.id == id).unwrap();
        assert_eq!((e.status, e.label.as_str()), (Status::Error, "outer"));
    }
}
