use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use chrono::{Local, NaiveDate};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::db::{app_dir, now_ms};
use crate::error::{Error, Result};

/// What the application itself did, as opposed to what was done to a host.
///
/// There are two separate records in Portway and confusing them would ruin
/// both:
///
///   · `audit.rs` writes to the database, one row per **command that reached a
///     server** — a trail of what was run where, kept for as long as the host
///     exists.
///   · this writes to a **file**, one line per thing the app did — connections,
///     transfers, tunnels, failures, and how long each took. It is a diagnostic,
///     rotated and thrown away after a week.
///
/// The rule that keeps this file safe to hand to somebody: **it never carries
/// input.** `ssh_write` sees every keystroke, including whatever is typed at a
/// remote `sudo` prompt, and none of it comes here. Nor do passphrases, key
/// material or keychain values — a lookup logs that it happened and for which
/// key, never what came back. Paths and hostnames do appear: they are the
/// user's own machine and their own servers, and a log that will not say which
/// file failed cannot be used to work out why.
///
/// Everything goes three places at once: the file, a ring buffer so a debug
/// panel opened later still has the last few thousand lines, and a `log://line`
/// event so one already open is live. The event is broadcast rather than aimed,
/// because every window can open the panel.

/// How many lines the in-memory ring keeps for a panel that opens late.
const RING: usize = 3000;

/// One file rolls at 8 MB. Daily rotation alone does not bound a loop that logs
/// in a retry — this does.
const MAX_FILE: u64 = 8 * 1024 * 1024;

/// How long a day's file survives.
const KEEP_DAYS: u64 = 7;

/// Longest message or detail accepted, mainly to cap what the *frontend* can
/// send: a stack trace is worth keeping, a megabyte of one is not.
const MAX_TEXT: usize = 4000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    /// Detail nobody needs until something is wrong. Off by default.
    Debug,
    /// The ordinary narrative: connected, transferred, started, stopped.
    Info,
    /// Worked, but not the way it should have.
    Warn,
    /// Did not work.
    Error,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Debug => "debug",
            Level::Info => "info",
            Level::Warn => "warn",
            Level::Error => "error",
        }
    }

    fn rank(self) -> u8 {
        match self {
            Level::Debug => 10,
            Level::Info => 20,
            Level::Warn => 30,
            Level::Error => 40,
        }
    }

    /// Unknown names become `info` rather than failing: this parses a string
    /// from an environment variable and from the webview, and neither is worth
    /// refusing to start over.
    pub fn parse(name: &str) -> Level {
        match name.trim().to_ascii_lowercase().as_str() {
            "debug" | "trace" => Level::Debug,
            "warn" | "warning" => Level::Warn,
            "error" => Level::Error,
            _ => Level::Info,
        }
    }
}

/// One line, as the panel receives it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    /// Monotonic within a run. The panel fetches a backlog and listens at the
    /// same time; ordering and de-duplicating by this is what makes the race
    /// between those two harmless.
    pub seq: u64,
    /// Epoch ms, formatted for display on the JS side so it follows the
    /// machine's locale.
    pub at: i64,
    pub level: String,
    /// Which part of the app: `app`, `db`, `ssh`, `sftp`, `tunnel`, `ui`…
    pub target: String,
    pub message: String,
    /// The numbers. Kept out of the message so a line reads as a sentence and
    /// the panel can put the arithmetic in its own column.
    pub detail: Option<String>,
}

struct Logger {
    app: AppHandle,
    seq: AtomicU64,
    level: AtomicU8,
    ring: Mutex<VecDeque<Record>>,
    writer: Mutex<Writer>,
}

static LOG: OnceLock<Logger> = OnceLock::new();

/// Where the panic hook writes, kept outside the writer's mutex — see `init`.
static CURRENT: OnceLock<Mutex<PathBuf>> = OnceLock::new();

pub fn logs_dir() -> PathBuf {
    app_dir().join("logs")
}

/// `portway-2026-08-02.log`, and `portway-2026-08-02.2.log` once that one has
/// rolled.
fn path_for(dir: &Path, day: NaiveDate, part: u32) -> PathBuf {
    if part <= 1 {
        dir.join(format!("portway-{day}.log"))
    } else {
        dir.join(format!("portway-{day}.{part}.log"))
    }
}

/// The open file, plus what it would take to notice it should be a different
/// one. Rolling is checked on every write rather than on a timer, so an app
/// left open overnight starts a new file at midnight without anything ticking.
struct Writer {
    dir: PathBuf,
    day: NaiveDate,
    part: u32,
    size: u64,
    file: Option<File>,
}

impl Writer {
    fn new(dir: PathBuf) -> Writer {
        Writer {
            dir,
            day: Local::now().date_naive(),
            part: 1,
            size: 0,
            file: None,
        }
    }

    fn write(&mut self, line: &str) {
        let today = Local::now().date_naive();
        if today != self.day {
            self.day = today;
            self.part = 1;
            self.file = None;
        }
        if self.file.is_some() && self.size >= MAX_FILE {
            self.part += 1;
            self.file = None;
        }

        if self.file.is_none() {
            let _ = fs::create_dir_all(&self.dir);
            let path = path_for(&self.dir, self.day, self.part);
            let Ok(file) = OpenOptions::new().create(true).append(true).open(&path) else {
                return;
            };
            self.size = file.metadata().map(|m| m.len()).unwrap_or(0);
            self.file = Some(file);
            if let Some(slot) = CURRENT.get() {
                if let Ok(mut current) = slot.lock() {
                    *current = path;
                }
            }
            if self.size == 0 {
                let banner = format!(
                    "— portway {} · {} {} · log opened {} —\n",
                    env!("CARGO_PKG_VERSION"),
                    std::env::consts::OS,
                    std::env::consts::ARCH,
                    Local::now().format("%Y-%m-%d %H:%M:%S%.3f %:z"),
                );
                self.put(&banner);
            }
        }

        self.put(line);
    }

    fn put(&mut self, text: &str) {
        if let Some(file) = self.file.as_mut() {
            // Written and flushed line by line. A log that is still in a buffer
            // when the process dies is a log that is missing exactly the part
            // worth reading, and at this volume the cost does not show.
            if file.write_all(text.as_bytes()).is_ok() {
                let _ = file.flush();
                self.size += text.len() as u64;
            }
        }
    }
}

/// Starts the log. Called first thing in `setup`, before the database is
/// opened, so a failure to open the database is itself logged.
pub fn init(app: &AppHandle) {
    let dir = logs_dir();
    let _ = fs::create_dir_all(&dir);
    prune(&dir);

    let _ = CURRENT.set(Mutex::new(path_for(&dir, Local::now().date_naive(), 1)));

    // `PORTWAY_LOG=debug` for a run that needs the detail. The panel can also
    // raise it at runtime, which is the usual way in.
    let level = std::env::var("PORTWAY_LOG")
        .map(|v| Level::parse(&v))
        .unwrap_or(Level::Info);

    let _ = LOG.set(Logger {
        app: app.clone(),
        seq: AtomicU64::new(0),
        level: AtomicU8::new(level.rank()),
        ring: Mutex::new(VecDeque::with_capacity(RING)),
        writer: Mutex::new(Writer::new(dir)),
    });

    install_panic_hook();

    info(
        "app",
        "Portway started",
        Some(&format!(
            "version={} os={} arch={} level={}",
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH,
            level.as_str(),
        )),
    );
}

/// Deletes day-files older than a week. By modification time rather than by
/// parsing the name, so a file left behind by an older naming scheme still goes.
fn prune(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let cutoff = std::time::Duration::from_secs(KEEP_DAYS * 24 * 60 * 60);

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("portway-") || !name.ends_with(".log") {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|t| t.elapsed().map(|age| age > cutoff).unwrap_or(false))
            .unwrap_or(false);
        if old {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// A panic is the one event that has to reach the disk before anything else
/// happens, because in a release build it does not survive the moment:
/// `panic = "abort"` means the process is gone as soon as this returns.
///
/// So the hook writes the file *itself* rather than going through the shared
/// writer. Taking that mutex would be a deadlock if the panicking thread were
/// already holding it, and a deadlock inside a panic hook is an abort with an
/// empty log — the exact case the log exists for.
fn install_panic_hook() {
    let previous = std::panic::take_hook();

    std::panic::set_hook(Box::new(move |info| {
        let path = CURRENT
            .get()
            .and_then(|slot| slot.try_lock().ok().map(|p| p.clone()))
            .unwrap_or_else(|| path_for(&logs_dir(), Local::now().date_naive(), 1));

        let where_at = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "unknown".into());

        // Flattened by hand rather than through `clip`: a panic's payload is
        // multi-line — `panicked at src/lib.rs:37:\n<message>` — and a stray
        // newline here would forge a second line in a file whose whole format
        // is one event per line.
        let line = format!(
            "{} ERROR app      panicked | at={} thread={} · {}\n",
            Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
            where_at,
            std::thread::current().name().unwrap_or("unnamed"),
            info.to_string().replace(['\r', '\n'], " "),
        );

        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
            let _ = file.write_all(line.as_bytes());
            let _ = file.flush();
        }

        previous(info);
    }));
}

/// One line, everywhere it goes.
///
/// A no-op until `init` has run, which is what lets `db.rs` and the unit tests
/// call it without knowing whether an app exists yet.
pub fn record(level: Level, target: &str, message: &str, detail: Option<&str>) {
    let Some(log) = LOG.get() else { return };
    if level.rank() < log.level.load(Ordering::Relaxed) {
        return;
    }

    let entry = Record {
        seq: log.seq.fetch_add(1, Ordering::Relaxed) + 1,
        at: now_ms(),
        level: level.as_str().to_string(),
        target: clip(target, 24),
        message: clip(message, MAX_TEXT),
        detail: detail.map(|d| clip(d, MAX_TEXT)),
    };

    if let Ok(mut writer) = log.writer.lock() {
        writer.write(&line_for(&entry));
    }

    if let Ok(mut ring) = log.ring.lock() {
        if ring.len() == RING {
            ring.pop_front();
        }
        ring.push_back(entry.clone());
    }

    // Never logged if this fails. A window that has gone away is the ordinary
    // reason, and reporting it would be a line about a line.
    let _ = log.app.emit("log://line", entry);
}

/// `14:22:07.482  INFO  ssh      connected | 812ms`
fn line_for(entry: &Record) -> String {
    let stamp = Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let mut line = format!(
        "{stamp} {:<5} {:<8} {}",
        entry.level.to_uppercase(),
        entry.target,
        entry.message
    );
    if let Some(detail) = &entry.detail {
        line.push_str(" | ");
        line.push_str(detail);
    }
    line.push('\n');
    line
}

/// Truncated on a character boundary — a message can hold a path with an
/// accented letter in it, and cutting one in half would put a broken byte in
/// the file.
fn clip(text: &str, max: usize) -> String {
    let text = text.replace(['\r', '\n'], " ");
    if text.chars().count() <= max {
        return text;
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

/// Wraps one command from the webview: a line for every call, whichever way it
/// went.
///
/// The rule this exists to enforce is that **nothing the frontend asks the
/// backend to do happens without a line saying so**. Before this, a command
/// that succeeded left no trace at all, so the log answered "what went wrong"
/// and could not answer "what did it do" — and the second question is the one
/// somebody has when the app did something they did not expect.
///
/// `debug` on success rather than `info`, and that is not the level being
/// timid. Every keystroke and every window resize comes through a command; at
/// `info` the ordinary narrative would be buried under them within seconds,
/// which is how a log stops being read at all. The console's Verbose button is
/// the way in, and it is one click.
///
/// A failure is `error` regardless: those are rare, and every one of them is
/// something a person may need to see without having known to turn anything on
/// first.
pub fn call<T>(command: &str, detail: Option<&str>, outcome: crate::error::Result<T>) -> crate::error::Result<T> {
    match &outcome {
        Ok(_) => debug("cmd", command, detail),
        Err(e) => {
            let note = match detail {
                Some(text) => format!("{text} · {e}"),
                None => e.to_string(),
            };
            error("cmd", command, Some(&note));
        }
    }
    outcome
}

pub fn debug(target: &str, message: &str, detail: Option<&str>) {
    record(Level::Debug, target, message, detail)
}

pub fn info(target: &str, message: &str, detail: Option<&str>) {
    record(Level::Info, target, message, detail)
}

pub fn warn(target: &str, message: &str, detail: Option<&str>) {
    record(Level::Warn, target, message, detail)
}

pub fn error(target: &str, message: &str, detail: Option<&str>) {
    record(Level::Error, target, message, detail)
}

/// Something that takes time, timed.
///
/// The reason the log is worth having rather than a list of events: a
/// connection that took forty-five seconds and one that took four hundred
/// milliseconds print the same words, and only the number tells them apart.
/// Reading a key can block on an OS permission prompt, a handshake can sit on a
/// dead network, and a span is how that shows up as something other than "it
/// felt slow".
pub struct Span {
    target: &'static str,
    what: String,
    start: Instant,
}

/// Past this, a step is interesting whatever level it asked for.
const SLOW: std::time::Duration = std::time::Duration::from_millis(400);

impl Span {
    pub fn start(target: &'static str, what: impl Into<String>) -> Span {
        Span {
            target,
            what: what.into(),
            start: Instant::now(),
        }
    }

    /// Finished, as intended.
    ///
    /// A span asked to whisper is promoted to `info` if it took longer than
    /// `SLOW`. Reading a private key is a millisecond and not worth a line —
    /// until the day it takes forty-five seconds because macOS is holding a
    /// permission dialog in front of it, and then it is the only line that
    /// matters. That must not be hidden behind a verbose flag nobody had set at
    /// the time.
    pub fn done(self, level: Level, detail: Option<&str>) {
        let taken = self.start.elapsed();
        let level = if taken >= SLOW && level < Level::Info { Level::Info } else { level };
        let elapsed = took(taken);
        let detail = match detail {
            Some(text) => format!("{elapsed} · {text}"),
            None => elapsed,
        };
        record(level, self.target, &self.what, Some(&detail));
    }

    /// Did not. Always an error line — a failure nobody sees at the default
    /// level is a log that lied by omission.
    pub fn failed(self, reason: &str) {
        let elapsed = took(self.start.elapsed());
        record(
            Level::Error,
            self.target,
            &self.what,
            Some(&format!("{elapsed} · failed: {reason}")),
        );
    }
}

fn took(elapsed: std::time::Duration) -> String {
    let ms = elapsed.as_millis();
    if ms < 1000 {
        format!("{ms}ms")
    } else {
        format!("{:.1}s", elapsed.as_secs_f64())
    }
}

/* ---------------------------------------------------------------------------
   Commands
--------------------------------------------------------------------------- */

/// Everything the ring still holds after `after`, oldest first.
///
/// `after` is the highest sequence the panel has already seen, so a panel that
/// registered its listener first and then asked for the backlog gets exactly
/// the gap and no duplicates.
#[tauri::command]
pub fn log_backlog(after: Option<u64>) -> Vec<Record> {
    let Some(log) = LOG.get() else { return Vec::new() };
    let after = after.unwrap_or(0);
    log.ring
        .lock()
        .map(|ring| ring.iter().filter(|r| r.seq > after).cloned().collect())
        .unwrap_or_default()
}

/// A line from the webview: a caught error, a failed command, a lifecycle note.
///
/// It goes through Rust rather than being drawn straight into the panel so that
/// there is one file, one sequence and one order — with two windows each
/// running their own copy of the frontend, a locally rendered line would be
/// missing from the file and out of order with everything else.
#[tauri::command]
pub fn log_write(level: String, target: String, message: String, detail: Option<String>) {
    record(
        Level::parse(&level),
        &target,
        &message,
        detail.as_deref(),
    )
}

#[tauri::command]
pub fn set_log_level(level: String) -> String {
    let Some(log) = LOG.get() else { return "info".into() };
    let level = Level::parse(&level);
    log.level.store(level.rank(), Ordering::Relaxed);
    info("app", "log level changed", Some(level.as_str()));
    level.as_str().to_string()
}

/// What the debug panel shows above the stream: where things are, what is
/// running, and which window is asking.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugInfo {
    pub version: String,
    pub os: String,
    pub arch: String,
    pub level: String,
    pub window: String,
    pub started_at: i64,
    pub database: String,
    pub log_file: String,
    pub logs_dir: String,
    pub sessions: usize,
    pub tunnels_active: usize,
    pub windows: Vec<String>,
    /// Hosts whose private key sits in a folder macOS gates behind a permission
    /// prompt. Empty everywhere else — see `gated_keys`.
    pub gated_keys: Vec<String>,
}

/// When the process started, so the panel can show an uptime. Set by `init`'s
/// caller rather than measured, because `Instant` cannot be turned into a wall
/// clock time.
static STARTED_AT: OnceLock<i64> = OnceLock::new();

pub fn mark_start() {
    let _ = STARTED_AT.set(now_ms());
}

#[tauri::command]
pub fn debug_info(app: AppHandle, window: tauri::Window) -> Result<DebugInfo> {
    let sessions = app
        .state::<crate::ssh::Sessions>()
        .0
        .lock()
        .map(|map| map.len())
        .unwrap_or(0);

    let tunnels_active = crate::tunnels::active_count(&app);

    let level = LOG
        .get()
        .map(|log| match log.level.load(Ordering::Relaxed) {
            r if r <= 10 => "debug",
            r if r <= 20 => "info",
            r if r <= 30 => "warn",
            _ => "error",
        })
        .unwrap_or("info");

    let log_file = CURRENT
        .get()
        .and_then(|slot| slot.lock().ok().map(|p| p.display().to_string()))
        .unwrap_or_default();

    Ok(DebugInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        level: level.to_string(),
        window: window.label().to_string(),
        started_at: *STARTED_AT.get().unwrap_or(&0),
        database: crate::db::database_path(dirs::home_dir().unwrap_or_default())
            .display()
            .to_string(),
        log_file,
        logs_dir: logs_dir().display().to_string(),
        sessions,
        tunnels_active,
        windows: app.webview_windows().keys().cloned().collect(),
        gated_keys: gated_keys(&app),
    })
}

/// Opens the log folder in the file manager.
///
/// No argument, deliberately. This is a process launcher reachable from the
/// webview, and the same reasoning as `open_url` applies: what it can point at
/// is the whole question. Here it can point at exactly one directory, computed
/// on this side, so there is nothing to aim.
#[tauri::command]
pub fn reveal_logs() -> Result<()> {
    let dir = logs_dir();
    let _ = fs::create_dir_all(&dir);

    let mut command = if cfg!(target_os = "macos") {
        let mut c = std::process::Command::new("open");
        c.arg(&dir);
        c
    } else if cfg!(target_os = "windows") {
        let mut c = std::process::Command::new("explorer");
        c.arg(&dir);
        c
    } else {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&dir);
        c
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|e| Error::Invalid(format!("could not open {}: {e}", dir.display())))
}

/* ---------------------------------------------------------------------------
   macOS permission gates
--------------------------------------------------------------------------- */

/// The folders macOS puts behind a consent prompt.
///
/// A private key in one of them makes the *first* read of it block until
/// somebody answers a system dialog — which is drawn outside the app, so from
/// inside all you see is a connection that sits on "connecting…" for a minute.
/// Worse, an ad-hoc signed build gets a fresh identity every time it is built,
/// so a grant does not survive the next version.
///
/// Naming it costs nothing and turns a mystery into a sentence.
const GATED: [&str; 3] = ["Documents", "Desktop", "Downloads"];

pub fn is_gated_path(path: &Path) -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    let Some(home) = dirs::home_dir() else { return false };
    GATED
        .iter()
        .any(|folder| path.starts_with(home.join(folder)))
}

/// Saved hosts whose key is in one of those folders.
fn gated_keys(app: &AppHandle) -> Vec<String> {
    if !cfg!(target_os = "macos") {
        return Vec::new();
    }
    let Some(db) = app.try_state::<crate::db::Db>() else { return Vec::new() };
    let Ok(conn) = db.0.lock() else { return Vec::new() };
    let Ok(mut stmt) = conn.prepare("SELECT name, key_path FROM hosts WHERE key_path IS NOT NULL")
    else {
        return Vec::new();
    };
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    });
    let Ok(rows) = rows else { return Vec::new() };

    rows.flatten()
        .filter(|(_, path)| is_gated_path(&crate::ssh::expand_home(path)))
        .map(|(name, _)| name)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_day_file_and_its_rolls_are_named_in_order() {
        let dir = Path::new("/tmp/logs");
        let day = NaiveDate::from_ymd_opt(2026, 8, 2).unwrap();
        assert_eq!(path_for(dir, day, 1), dir.join("portway-2026-08-02.log"));
        assert_eq!(path_for(dir, day, 2), dir.join("portway-2026-08-02.2.log"));
    }

    #[test]
    fn a_line_carries_its_detail_after_a_bar() {
        let entry = Record {
            seq: 1,
            at: 0,
            level: "info".into(),
            target: "ssh".into(),
            message: "connected".into(),
            detail: Some("812ms".into()),
        };
        let line = line_for(&entry);
        assert!(line.contains("INFO  ssh      connected | 812ms"), "{line}");
        assert!(line.ends_with('\n'));
    }

    /// A newline in a message would otherwise forge a second line in the file.
    #[test]
    fn a_message_stays_on_one_line() {
        assert_eq!(clip("two\nlines", 40), "two lines");
    }

    #[test]
    fn a_long_message_is_cut_on_a_character() {
        let cut = clip("ó".repeat(10).as_str(), 4);
        assert_eq!(cut.chars().count(), 5);
        assert!(cut.ends_with('…'));
    }

    /// The one part of this that cannot be checked by reading it: daily
    /// rotation is obvious, but the size roll only happens after eight
    /// megabytes, which is exactly the amount nobody ever produces on purpose.
    /// A file that never rolls is a log that eventually fills a disk.
    #[test]
    fn a_file_rolls_when_it_passes_the_size_limit() {
        let dir = std::env::temp_dir().join(format!("portway-log-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);

        let mut writer = Writer::new(dir.clone());
        let chunk = "x".repeat(1024 * 1024);
        // Nine writes of a megabyte: the roll must happen inside this, not at
        // the end, so the ninth lands in the second file.
        for _ in 0..9 {
            writer.write(&chunk);
        }

        let day = Local::now().date_naive();
        let first = path_for(&dir, day, 1);
        let second = path_for(&dir, day, 2);

        assert!(first.exists(), "the first file was never written");
        assert!(second.exists(), "it did not roll past {MAX_FILE} bytes");
        assert!(
            fs::metadata(&first).unwrap().len() < MAX_FILE + chunk.len() as u64,
            "the first file grew past the limit instead of rolling"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_level_names_read_as_info() {
        assert_eq!(Level::parse("WARN"), Level::Warn);
        assert_eq!(Level::parse("nonsense"), Level::Info);
    }

    #[test]
    fn under_a_second_reads_in_milliseconds() {
        assert_eq!(took(std::time::Duration::from_millis(812)), "812ms");
        assert_eq!(took(std::time::Duration::from_millis(45_200)), "45.2s");
    }
}
