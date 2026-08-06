use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use russh_sftp::client::error::Error as RawError;
use russh_sftp::client::fs::Metadata;
use russh_sftp::client::{RawSftpSession, SftpSession};
use russh_sftp::protocol::{OpenFlags, StatusCode};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::audit::{self, Kind, Origin};
use crate::db::Db;
use crate::error::{Error, Result};
use crate::logging::{self, Level, Span};
use crate::ssh;
use crate::sudo;

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

/// An account or a group, as the server names it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Principal {
    pub id: u32,
    pub name: String,
}

/// Who a file can be given to.
///
/// Both lists may be empty, and that is not an error: a server can refuse to
/// hand over either file, and the Owner dialog still has to work — the numbers
/// are what `chown` takes, and they are typed by hand when there is no list to
/// pick from.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Principals {
    pub users: Vec<Principal>,
    pub groups: Vec<Principal>,
}

/// The accounts and groups the server knows, read out of `/etc/passwd` and
/// `/etc/group` over the connection that is already open.
///
/// Read as files rather than asked for with `getent`, because SFTP is what
/// this pane already has: `getent` needs a second channel and a binary that
/// may not be there, and the pane would have to grow a shell to use it.
///
/// The cost of that choice is local accounts only. A host that gets its users
/// from LDAP or SSSD lists them nowhere in these two files, and there the
/// dialog falls back to what it does today — a number, typed.
pub async fn principals(app: &AppHandle, session_id: &str) -> Result<Principals> {
    let (sftp, host_id) = open(app, session_id).await?;

    // Two files on somebody's server, read by name. That is exactly what the
    // audit trail exists to record, and it went unrecorded here for as long as
    // this function existed — a read is still a reach onto the host, and a
    // trail that covers only writes is not one.
    for path in ["/etc/passwd", "/etc/group"] {
        log(app, host_id, session_id, Origin::System, &format!("sftp get {path}"));
    }

    // Neither file failing is fatal: a locked-down host may hand over one, the
    // other, or neither, and an Owner dialog with half a list is better than an
    // error where a dialog should be.
    let users = read_table(&sftp, "/etc/passwd", 2).await;
    let groups = read_table(&sftp, "/etc/group", 2).await;
    logging::debug(
        "sftp",
        "read the server's accounts",
        Some(&format!("users={} groups={}", users.len(), groups.len())),
    );

    Ok(Principals { users, groups })
}

/// `/etc/passwd` and `/etc/group` are the same shape: colon-separated, the name
/// first, the id at a fixed field. `id_field` says which one.
///
/// Anything that does not parse is skipped rather than reported. These files
/// carry NIS compat lines (`+@staff`), comments on some systems, and the odd
/// blank — none of which is a reason to refuse the whole list.
async fn read_table(sftp: &SftpSession, path: &str, id_field: usize) -> Vec<Principal> {
    match read_small(sftp, path).await {
        Some(text) => parse_table(&text, id_field),
        None => Vec::new(),
    }
}

fn parse_table(text: &str, id_field: usize) -> Vec<Principal> {
    let mut found: Vec<Principal> = text
        .lines()
        .filter_map(|line| {
            let mut fields = line.split(':');
            let name = fields.next()?.trim();
            if name.is_empty() || name.starts_with('#') || name.starts_with('+') {
                return None;
            }
            let id: u32 = fields.nth(id_field - 1)?.trim().parse().ok()?;
            Some(Principal { id, name: name.to_string() })
        })
        .collect();

    // By name, because that is what the picker shows and what somebody scrolls
    // it looking for. The id is the fallback, not the index.
    found.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    found.dedup_by(|a, b| a.name == b.name && a.id == b.id);
    found
}

/// Reads a small text file whole, or gives up quietly.
///
/// Capped because this reads a path the app chose but the *server* controls the
/// contents of: `/etc/passwd` is a few kilobytes on any real host, and a
/// multi-megabyte file at that path is not one worth loading into a dropdown.
async fn read_small(sftp: &SftpSession, path: &str) -> Option<String> {
    use tokio::io::AsyncReadExt;

    const MAX: u64 = 1024 * 1024;

    let file = sftp.open(path).await.ok()?;
    let mut buffer = Vec::new();
    file.take(MAX).read_to_end(&mut buffer).await.ok()?;
    // Not `from_utf8`: one stray byte in a comment must not lose the file.
    Some(String::from_utf8_lossy(&buffer).into_owned())
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

/// The audit row for one SFTP operation — and, at `debug`, the same line in the
/// application log.
///
/// Both, because they answer different questions: the audit trail is *what was
/// done to this server*, kept as long as the host exists, and the app log is
/// *what this program did just now*, which is the one you read when something
/// is not working. Putting the app-log line here rather than at each call site
/// is what makes the trail complete — every operation already comes through
/// this function.
fn log(app: &AppHandle, host_id: i64, session_id: &str, origin: Origin, command: &str) {
    // The server by name, not just the session id: a person with four hosts
    // open cannot tell `session=63151` from `session=63152`, and an SFTP line
    // that does not say which machine it touched is a line they have to go
    // looking elsewhere to understand.
    logging::debug(
        "sftp",
        command,
        Some(&format!("{} session={session_id}", ssh::label_of(app, session_id))),
    );
    let db = app.state::<Db>();
    let conn = db.0.lock().unwrap();
    audit::record(&conn, host_id, Some(session_id), origin, Kind::Sftp, command, None, None);
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
        .map_err(|e| Error::Ssh(format!("no such directory {target}: {}", tidy(e))))?
        .files
        .first()
        .map(|f| f.filename.clone())
        .ok_or_else(|| Error::Ssh(format!("no such directory {target}")))?;

    log(app, host_id, session_id, origin, &format!("sftp ls {canonical}"));

    let handle = sftp
        .opendir(canonical.clone())
        .await
        .map_err(|e| Error::Ssh(format!("could not read {canonical}: {}", tidy(e))))?
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
                return Err(Error::Ssh(format!("could not read {canonical}: {}", tidy(e))));
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
        .map_err(|e| Error::Ssh(format!("could not open {remote}: {}", tidy(e))))?;
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

    logging::info(
        "sftp",
        &format!("downloaded {remote}"),
        Some(&format!("{total} bytes → {local}")),
    );
    Ok(total)
}

/// What the transfer footer draws while something is moving.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    session_id: String,
    /// `upload` or `delete`. The footer draws the same two lines either way;
    /// only the words and whether there are bytes to measure differ.
    verb: String,
    /// The file currently on the wire, by its own name.
    name: String,
    /// Bytes sent of that file, and its size.
    bytes: u64,
    total: u64,
    /// Bytes per second.
    rate: f64,
    /// Position in the whole drop. `files_total` is 1 for a single file, which
    /// is how the UI knows not to draw a second bar for it.
    files_done: u32,
    files_total: u32,
}

/// How often the footer is told anything.
///
/// The read loop moves 64 KB at a time — on a fast link that is thousands of
/// steps a second, and a bar cannot show more than the screen refreshes. The
/// limit is on the whole transfer rather than per file, or a folder of small
/// files would emit two events each and flood exactly when it matters least.
const PROGRESS_EVERY: std::time::Duration = std::time::Duration::from_millis(120);

/// How many delete requests are allowed on the wire at once. See `remove`.
const DELETE_LANES: usize = 3;

/// Carries a transfer's progress to the window that asked for it.
///
/// Emitted to that one window rather than broadcast: with a session in a window
/// of its own, every other window would have to receive and discard these.
struct Progress {
    app: AppHandle,
    session_id: String,
    verb: &'static str,
    window: String,
    name: String,
    bytes: u64,
    total: u64,
    files_done: u32,
    files_total: u32,
    rate: f64,
    last_emit: std::time::Instant,
    /// Everything sent since the transfer began. `bytes` restarts at every file
    /// and cannot measure a rate across a folder — the bytes of each file that
    /// completed between two samples would simply not be counted.
    sent_total: u64,
    last_sent_total: u64,
}

impl Progress {
    fn new(
        app: &AppHandle,
        session_id: &str,
        verb: &'static str,
        window: &str,
        files_total: u32,
    ) -> Self {
        Self {
            app: app.clone(),
            session_id: session_id.to_string(),
            verb,
            window: window.to_string(),
            name: String::new(),
            bytes: 0,
            total: 0,
            files_done: 0,
            files_total,
            rate: 0.0,
            last_emit: std::time::Instant::now(),
            sent_total: 0,
            last_sent_total: 0,
        }
    }

    /// Starts a file. The first one is announced immediately — a transfer that
    /// spends its first tenth of a second silent looks like one that has not
    /// begun.
    fn start(&mut self, name: &str, total: u64) {
        self.name = name.to_string();
        self.bytes = 0;
        self.total = total;
        if self.files_done == 0 {
            self.emit();
        }
    }

    fn advance(&mut self, sent: u64) {
        self.bytes += sent;
        self.sent_total += sent;
        if self.last_emit.elapsed() >= PROGRESS_EVERY {
            self.emit();
        }
    }

    /// Throttled like everything else. Four hundred small files finish in a few
    /// milliseconds each, and reporting every one of them is both a flood and
    /// self-defeating: updates arriving faster than the bar's own animation
    /// leave it permanently chasing a target it never reaches.
    fn finished_file(&mut self) {
        self.files_done += 1;
        self.bytes = self.total;
        // The last file always reports, so the bar lands on full instead of
        // stopping wherever the throttle happened to leave it.
        if self.files_done == self.files_total || self.last_emit.elapsed() >= PROGRESS_EVERY {
            self.emit();
        }
    }

    fn emit(&mut self) {
        let elapsed = self.last_emit.elapsed().as_secs_f64();
        if elapsed > 0.0 {
            let instant = (self.sent_total - self.last_sent_total) as f64 / elapsed;
            // Smoothed, because the raw figure between two 120ms samples jumps
            // around enough to be unreadable. First sample seeds it outright so
            // the number does not have to climb out of zero.
            self.rate = if self.rate == 0.0 { instant } else { self.rate * 0.7 + instant * 0.3 };
        }
        self.last_emit = std::time::Instant::now();
        self.last_sent_total = self.sent_total;

        let _ = self.app.emit_to(
            self.window.as_str(),
            "sftp://progress",
            ProgressEvent {
                session_id: self.session_id.clone(),
                verb: self.verb.to_string(),
                name: self.name.clone(),
                bytes: self.bytes,
                total: self.total,
                rate: self.rate,
                files_done: self.files_done,
                files_total: self.files_total,
            },
        );
    }
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
    // No progress: the only caller is the editor writing a file back after a
    // save, and a footer that flashes on every ⌘S is noise, not information.
    put_file(&sftp, std::path::Path::new(local), remote, Create::Overwrite, None).await
}

/// Writes a local file back to a path the account cannot write, as root.
///
/// SFTP has no notion of privilege — the subsystem the server starts runs as
/// whoever logged in, and nothing in the protocol asks for more. So the bytes
/// go up the ordinary way, into a staging copy in the account's own home, and
/// one command as root moves them the last few inches.
///
/// `cp` onto a file that already exists opens it and truncates it: the target
/// keeps its inode, its owner and its mode, which is exactly what writing a
/// file back should do. `--preserve` would do the opposite and stamp the
/// staging copy's ownership onto a system file. `mv` and `install` would
/// replace the inode, taking the target's hard links and ACLs with it. `--`
/// because a filename that starts with a dash is still a filename.
///
/// Not `tee`, and not `sh -c 'cat > …'`, tempting as both look: `sudo -S` reads
/// the password from standard input, so standard input is spoken for, and there
/// is nothing left to pipe the file in on.
async fn upload_as_root(
    app: &AppHandle,
    session_id: &str,
    local: &std::path::Path,
    remote: &str,
) -> Result<u64> {
    let (sftp, host_id) = open(app, session_id).await?;
    // Before the attempt, as every other operation in this file logs: the audit
    // trail is what was done *to this server*, and a write as root that failed
    // is still something that was tried.
    log(app, host_id, session_id, Origin::User, &format!("sftp put (sudo) {remote}"));

    let name = staging_name(session_id);
    // The account's own home first. `/tmp` is a shared namespace: another
    // account on the same machine can plant a symlink at a name it guesses, and
    // the `cp` below — running as root — would follow it and write there
    // instead. Home is the account's own directory, and `/tmp` is reached only
    // where there is no home to write in at all — with `EXCLUDE` when it is.
    let home = sftp.canonicalize(".").await.unwrap_or_default();
    let mut staging = join_remote("/tmp", &name);
    let mut sent = None;
    let mut refused = None;
    if !home.is_empty() {
        let at_home = join_remote(&home, &name);
        match put_file(&sftp, local, &at_home, Create::Private, None).await {
            Ok(bytes) => {
                staging = at_home;
                sent = Some(bytes);
            }
            // Worth trying `/tmp` for rather than giving up on — but a home
            // directory that will not take a file is the real problem, so this
            // is the failure reported if both of them refuse.
            Err(e) => refused = Some(e),
        }
    }
    let sent = match sent {
        Some(bytes) => bytes,
        None => put_file(&sftp, local, &staging, Create::PrivateInTmp, None)
            .await
            .map_err(|e| refused.unwrap_or(e))?,
    };

    let outcome = sudo::run(
        app,
        session_id,
        &format!("cp -- {} {}", ssh::quoted(&staging), ssh::quoted(remote)),
        0,
        Origin::User,
    )
    .await;

    // On every way out of here, the failure included: the staging copy holds
    // the user's file, and leaving it behind is both a mess in their home
    // directory and a copy of something they were editing under sudo.
    let _ = sftp.remove_file(staging).await;
    outcome?;

    Ok(sent)
}

/// A name for the staging copy that no two saves can collide on.
///
/// The session and a clock reading, because two files open in one session can
/// be saved in the same second and a fixed name would have one overwrite the
/// other halfway through a `cp`. Leading dot so it does not clutter a home
/// directory in the moment it exists.
fn staging_name(session_id: &str) -> String {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_nanos())
        .unwrap_or(0);
    let session: String = session_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(12)
        .collect();
    format!(".portway-{session}-{stamp}")
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

    // One line for the whole drop, not one per file: four hundred files would
    // otherwise be four hundred lines saying nothing each. It starts here so
    // the walk below is inside the time — on a deep tree that is most of it.
    // The failure is the exception that names a file, because which one it
    // stopped on is the whole answer.
    let span = Span::start("sftp", format!("upload {target}"));

    // Walked before anything is sent, rather than uploaded as it is discovered.
    // The footer's second bar counts files, and it cannot count towards a total
    // that is still being found — a bar that grows its own denominator reads as
    // going backwards.
    //
    // Breadth-first, so a directory is always listed before the things inside
    // it and creating them in this order needs no sorting. Iterative because a
    // recursive async fn would need boxing.
    let mut dirs: Vec<String> = Vec::new();
    let mut queue = std::collections::VecDeque::from([(source, target)]);
    let mut sending: Vec<(std::path::PathBuf, String)> = Vec::new();
    while let Some((from, to)) = queue.pop_front() {
        if !from.is_dir() {
            sending.push((from, to));
            continue;
        }
        dirs.push(to.clone());
        // One unreadable subdirectory should cost that subdirectory, not the
        // other thirty-nine files in the drop.
        let Ok(mut entries) = tokio::fs::read_dir(&from).await else { continue };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let child = entry.file_name();
            let Some(child) = child.to_str() else { continue };
            queue.push_back((entry.path(), join_remote(&to, child)));
        }
    }

    for dir in &dirs {
        // Already existing is the ordinary case when re-uploading a tree.
        let _ = sftp.create_dir(dir).await;
    }

    let window = ssh::session(app, session_id)?.window.clone();
    let count = sending.len();
    let mut progress = Progress::new(app, session_id, "upload", &window, count as u32);

    let mut total = 0u64;
    for (from, to) in sending {
        match put_file(&sftp, &from, &to, Create::Overwrite, Some(&mut progress)).await {
            Ok(sent) => total += sent,
            Err(e) => {
                span.failed(&format!("{to} — {e}"));
                return Err(e);
            }
        }
        progress.finished_file();
    }

    span.done(
        Level::Info,
        Some(&format!("{count} files, {total} bytes, {} folders", dirs.len())),
    );
    Ok(total)
}

/// The last component of a remote path — what the footer shows while a delete
/// works through a tree, because the full path is longer than the line.
fn name_of(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// The filename to give the scratch copy of a file being edited — or a refusal.
///
/// The name comes from the far end. A remote path is `/`-separated whatever the
/// server runs, so splitting on `/` leaves one component on Unix and the check
/// below would never fire; on Windows it is not enough, and that is the whole
/// point. `\` is a path separator there, `..` is not normalised away by
/// `Path::join`, and a component like `C:\Users\Public\evil.exe` is *absolute*,
/// which makes `join` discard the scratch directory entirely and return the
/// pushed path. All three are legal characters in a Linux filename, so a
/// hostile — or merely compromised — server can name a file
/// `..\..\..\Start Menu\Programs\Startup\updater.exe`, and a single click on
/// Edit would write the server's bytes there and `launch` would run them.
///
/// So the name is required to be one ordinary component and nothing else.
/// Refusing is the right answer rather than sanitising into some nearby name:
/// the file the user asked to edit is not the file that would be opened, and
/// the honest outcome is to say what is wrong with it.
fn scratch_name(remote: &str) -> Result<&str> {
    let name = remote.rsplit('/').next().unwrap_or("");
    let refuse = |why: &str| {
        Err(Error::Invalid(format!(
            "refusing to edit {remote}: its name {why}. Rename it on the server, or download it \
             instead."
        )))
    };

    if name.is_empty() || name == "." || name == ".." {
        return refuse("is not a file name");
    }
    // `:` alongside the separators because on Windows it is what makes a
    // component drive-absolute, and a drive letter is the shortest escape of
    // all. NUL because it terminates a path before the OS ever sees the rest.
    if name.contains(['/', '\\', ':', '\0']) {
        return refuse("contains a path separator");
    }
    Ok(name)
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

/// How a file is asked for on the far end.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Create {
    /// Overwrite whatever is there, and leave the mode to the server and the
    /// account's umask. What an upload is: the result should look like a file
    /// that account wrote, because it is one.
    Overwrite,
    /// Mode `0600`, for a staging copy whose contents are on their way to a
    /// file only root can write. The mode goes in the open request rather than
    /// a `chmod` after it — between a create and a second round trip is a
    /// window in which the file exists, already has the contents in it, and is
    /// readable by whatever the umask allowed.
    Private,
    /// The same, and `EXCLUDE` as well: a path that already exists is then a
    /// failure rather than something to write through, which is what refuses a
    /// symlink planted at a guessed name.
    ///
    /// Only where it buys something, which is `/tmp` — a namespace every
    /// account on the machine can write to. `EXCLUDE` is a far less travelled
    /// flag than the three every other upload sends, and a server that
    /// mishandles the combination would break every elevated save; in the
    /// account's own home the unique name is already the defence.
    PrivateInTmp,
}

/// One file's bytes, shared by `upload`, the directory walk, and the staging
/// copy an elevated save puts up before moving it into place.
async fn put_file(
    sftp: &russh_sftp::client::SftpSession,
    local: &std::path::Path,
    remote: &str,
    create: Create,
    mut progress: Option<&mut Progress>,
) -> Result<u64> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut source = tokio::fs::File::open(local).await?;
    // Taken from the open handle rather than the path: the size has to describe
    // the bytes about to be read, and a file can change between the two.
    let size = source.metadata().await?.len();
    if let Some(p) = progress.as_deref_mut() {
        let name = local.file_name().and_then(|n| n.to_str()).unwrap_or(remote);
        p.start(name, size);
    }

    // What `SftpSession::create` does, plus the flags and attributes it has
    // nowhere to put. `Overwrite` sends byte for byte the request `create`
    // sends: `only` leaves every field `None`, so no attribute is asked for.
    let flags = match create {
        // No `TRUNCATE` beside `EXCLUDE`: there is nothing there to truncate,
        // and asking for both invites a server to decide which one was meant.
        Create::PrivateInTmp => OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
        _ => OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
    };
    let mut target = sftp
        .open_with_flags_and_attributes(
            remote,
            flags,
            only(|m| {
                m.permissions = (create != Create::Overwrite).then_some(0o600);
            }),
        )
        .await
        .map_err(|e| Error::Ssh(format!("could not write {remote}: {}", tidy(e))))?;

    let mut buffer = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let read = source.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        target.write_all(&buffer[..read]).await?;
        total += read as u64;
        if let Some(p) = progress.as_deref_mut() {
            p.advance(read as u64);
        }
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

/// A file open in a local editor.
pub struct Open {
    /// The scratch copy that editor is writing to.
    ///
    /// Kept, because a write-back that was refused is not a save that has to be
    /// made again: what is on disk here is already what the user pressed save
    /// on, and `elevate` sends exactly that.
    pub local: std::path::PathBuf,
    /// Whether the next write-back goes through `sudo`.
    ///
    /// Shared with the watcher, and atomic rather than plain, because it is set
    /// from a command while the watcher is asleep between polls. "Save this one
    /// as root" has to change where the *next* save goes — not start a second
    /// watch against the same copy, which would race two uploads.
    pub elevated: Arc<AtomicBool>,
}

/// Files opened for editing, so re-opening one does not start a second watcher
/// against the same copy.
#[derive(Default)]
pub struct Editing(pub Mutex<HashMap<String, Open>>);

/// A file the user is editing has been saved and pushed back up.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedEvent {
    session_id: String,
    remote: String,
    bytes: u64,
    /// Whether it took root to land. Shown, because "saved" and "saved as root"
    /// are different enough facts that a pane reporting only the first would be
    /// hiding the more consequential one.
    elevated: bool,
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
///
/// `sudo` is decided here, at the moment the user is looking at the pane, and
/// not at the moment a save fails. By then they are in another application and
/// have just pressed ⌘S; a password box from a background window is not
/// something to put in front of somebody who did not ask for it. What a failed
/// save gets instead is `elevate`, which the pane offers as a button.
pub async fn edit(
    app: &AppHandle,
    session_id: &str,
    remote: &str,
    opener: Option<String>,
    confirmed_large: bool,
    sudo: bool,
) -> Result<String> {
    let (sftp, host_id) = open(app, session_id).await?;

    let size = match sftp.metadata(remote).await {
        Ok(meta) => meta.size.unwrap_or(0),
        // Without sudo there is nothing else to try — the file cannot be
        // reached at all, and the message says which one.
        Err(e) if !sudo => {
            return Err(Error::Ssh(format!("no such file {remote}: {}", tidy(e))));
        }
        // With it, a refused `stat` is not the end: the read below goes through
        // sudo too, and it is capped, so an unknown size is not an unbounded one.
        Err(_) => 0,
    };
    // Enforced here rather than only in the dialog: the dialog is a courtesy,
    // this is what stops a mis-click reading a gigabyte over the wire.
    if size > LARGE_FILE && !confirmed_large {
        return Err(Error::Invalid(format!(
            "{remote} is {size} bytes — larger than the {LARGE_FILE} byte edit limit"
        )));
    }

    let name = scratch_name(remote)?;
    let dir = crate::db::app_dir().join("edit").join(session_id);
    tokio::fs::create_dir_all(&dir).await?;
    let local = dir.join(name);

    // Plain SFTP first even when root was asked for. Most files opened this way
    // are the 644 configuration files that read perfectly well and only refuse
    // to be written — and that path streams, where the sudo one does not.
    let bytes = match get_file(&sftp, remote, &local).await {
        Ok(bytes) => bytes,
        Err(_) if sudo => get_file_as_root(app, session_id, remote, &local).await?,
        Err(e) => return Err(e),
    };
    log(
        app,
        host_id,
        session_id,
        Origin::User,
        &format!(
            "sftp edit{} {remote} ({bytes} bytes)",
            if sudo { " (sudo)" } else { "" }
        ),
    );

    launch(&local, opener.as_deref())?;

    // One watcher per remote path. Opening the same file twice should hand it
    // back to the editor already holding it, not race two uploads.
    let key = format!("{session_id}\u{0}{remote}");
    let elevated = {
        let editing = app.state::<Editing>();
        let mut files = editing.0.lock().unwrap();
        match files.get(&key) {
            // Already watched. Re-opening as root raises the file that is
            // already open; re-opening it plainly leaves it where it is, because
            // "Open" is not a request to drop back to a write that cannot land.
            Some(open) => {
                if sudo {
                    open.elevated.store(true, Ordering::Relaxed);
                }
                None
            }
            None => {
                let flag = Arc::new(AtomicBool::new(sudo));
                files.insert(
                    key.clone(),
                    Open { local: local.clone(), elevated: Arc::clone(&flag) },
                );
                Some(flag)
            }
        }
    };
    let Some(elevated) = elevated else {
        return Ok(local.to_string_lossy().into_owned());
    };
    watch(
        app.clone(),
        session_id.to_string(),
        remote.to_string(),
        local.clone(),
        key,
        elevated,
    );

    Ok(local.to_string_lossy().into_owned())
}

/// Reads a file the account cannot open, as root.
///
/// `cat` rather than a copy the account could then fetch over SFTP: a copy
/// would need a second command to hand it over and a third to remove it, and it
/// would put the contents of a root-only file — a private key, `/etc/shadow` —
/// on disk somewhere the account, and anything running as it, could read. The
/// bytes come back over the channel and go straight to the scratch copy.
///
/// Capped at the ordinary edit limit, and this one is not negotiable: the
/// contents arrive in memory whole, where the SFTP path streams. "Open it
/// anyway" is for a file SFTP can read by itself.
async fn get_file_as_root(
    app: &AppHandle,
    session_id: &str,
    remote: &str,
    local: &std::path::Path,
) -> Result<u64> {
    let out = sudo::run(
        app,
        session_id,
        &format!("cat -- {}", ssh::quoted(remote)),
        // One byte over the limit, which is how "it did not fit" is told apart
        // from "it fits exactly".
        LARGE_FILE as usize + 1,
        Origin::User,
    )
    .await?;

    if out.stdout.len() as u64 > LARGE_FILE {
        return Err(Error::Invalid(format!(
            "{remote} is larger than the {LARGE_FILE} byte limit for reading a file as root"
        )));
    }
    tokio::fs::write(local, &out.stdout).await?;
    Ok(out.stdout.len() as u64)
}

/// Sends a scratch copy up again as root, and makes every save after this one
/// go the same way.
///
/// The other half of a write-back that was refused. The editor has already
/// written the file and moved on — quite possibly it has been closed — so
/// telling the user to press save again is asking them to redo something they
/// have already done. What is on disk here *is* what they saved.
pub async fn elevate(app: &AppHandle, session_id: &str, remote: &str) -> Result<u64> {
    let key = format!("{session_id}\u{0}{remote}");
    let local = {
        let editing = app.state::<Editing>();
        let files = editing.0.lock().unwrap();
        let open = files.get(&key).ok_or_else(|| {
            Error::Invalid(format!("{remote} is not open for editing in this session"))
        })?;
        open.elevated.store(true, Ordering::Relaxed);
        open.local.clone()
    };

    let bytes = upload_as_root(app, session_id, &local, remote).await?;
    logging::info(
        "sftp",
        &format!("wrote back {remote} as root"),
        Some(&format!("{bytes} bytes, after a save the server refused")),
    );
    let _ = app.emit(
        "sftp://saved",
        SavedEvent {
            session_id: session_id.to_string(),
            remote: remote.to_string(),
            bytes,
            elevated: true,
        },
    );
    Ok(bytes)
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
fn watch(
    app: AppHandle,
    session_id: String,
    remote: String,
    local: std::path::PathBuf,
    key: String,
    elevated: Arc<AtomicBool>,
) {
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

            // Read once per save rather than captured: `elevate` can raise a
            // file between two polls, and the point of that is the very next
            // save.
            let as_root = elevated.load(Ordering::Relaxed);
            let written = if as_root {
                upload_as_root(&app, &session_id, &local, &remote).await
            } else {
                upload(&app, &session_id, &local.to_string_lossy(), &remote).await
            };

            match written {
                Ok(bytes) => {
                    logging::info(
                        "sftp",
                        &format!("wrote back {remote}{}", if as_root { " as root" } else { "" }),
                        Some(&format!("{bytes} bytes, after a save in the local editor")),
                    );
                    let _ = app.emit(
                        "sftp://saved",
                        SavedEvent {
                            session_id: session_id.clone(),
                            remote: remote.clone(),
                            bytes,
                            elevated: as_root,
                        },
                    );
                }
                Err(e) => {
                    // This one runs with nobody watching — the user is in
                    // another application and has just pressed save. If the
                    // banner is missed, the log is the only trace.
                    logging::error(
                        "sftp",
                        &format!("could not write back {remote}"),
                        Some(&e.to_string()),
                    );
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
    // A wrapper purely so the timing survives every `?` inside. A delete over a
    // slow link is the operation most likely to leave somebody wondering
    // whether anything is happening, and "6314 entries in 71.2s" is the answer.
    let span = Span::start("sftp", format!("delete {path}"));
    match removing(app, session_id, path, is_dir).await {
        Ok(count) => {
            span.done(Level::Info, Some(&format!("{count} entries")));
            Ok(count)
        }
        Err(e) => {
            span.failed(&e.to_string());
            Err(e)
        }
    }
}

async fn removing(app: &AppHandle, session_id: &str, path: &str, is_dir: bool) -> Result<u64> {
    let (sftp, host_id) = open(app, session_id).await?;
    log(
        app,
        host_id,
        session_id,
        Origin::User,
        &format!("sftp rm{} {path}", if is_dir { " -r" } else { "" }),
    );

    let window = ssh::session(app, session_id)?.window.clone();

    if !is_dir {
        let mut progress = Progress::new(app, session_id, "delete", &window, 1);
        progress.start(name_of(path), 0);
        sftp.remove_file(path)
            .await
            .map_err(|e| Error::Ssh(format!("could not delete {path}: {}", tidy(e))))?;
        progress.finished_file();
        return Ok(1);
    }

    // The whole tree is walked before anything is deleted, rather than files
    // being removed as they are discovered. Two reasons, and the second is the
    // one that matters: a count cannot be shown against a total that is still
    // being found, and a directory that turns out to be unreadable now fails
    // before a single file has gone rather than half way through.
    //
    // Breadth-first, so a directory is always found before its contents and the
    // order they come out in is already parents-first.
    let mut dirs = vec![path.to_string()];
    let mut files: Vec<String> = Vec::new();
    let mut queue = std::collections::VecDeque::from([path.to_string()]);
    while let Some(dir) = queue.pop_front() {
        let entries = sftp
            .read_dir(&dir)
            .await
            .map_err(|e| Error::Ssh(format!("could not read {dir}: {}", tidy(e))))?;
        for entry in entries {
            let child = join_remote(&dir, &entry.file_name());
            if entry.metadata().is_dir() {
                dirs.push(child.clone());
                queue.push_back(child);
            } else {
                files.push(child);
            }
        }
    }

    let total = (files.len() + dirs.len()) as u32;
    let removed = total as u64;
    let progress = Arc::new(Mutex::new(Progress::new(
        app,
        session_id,
        "delete",
        &window,
        total,
    )));

    // Files go three at a time. SFTP has no recursive delete — the protocol
    // offers one file and one empty directory per request and nothing else — so
    // a tree of six thousand entries is six thousand round trips, and sending
    // them one after another means paying the network's latency six thousand
    // times over. On a link 40ms from the server that is four minutes of
    // waiting for work the server itself does instantly.
    //
    // Replies are matched to requests by id, and ids come from an atomic, so
    // several can be in flight on the one session. Three rather than more
    // because the gain flattens quickly and a server is entitled to its own
    // limits: this is somebody's box, not a benchmark.
    let sftp = Arc::new(sftp);
    let files = Arc::new(files);
    let cursor = Arc::new(AtomicUsize::new(0));
    let mut lanes = tokio::task::JoinSet::new();
    for _ in 0..DELETE_LANES {
        let sftp = Arc::clone(&sftp);
        let files = Arc::clone(&files);
        let cursor = Arc::clone(&cursor);
        let progress = Arc::clone(&progress);
        lanes.spawn(async move {
            loop {
                let next = cursor.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let Some(file) = files.get(next) else { return Ok(()) };
                sftp.remove_file(file)
                    .await
                    .map_err(|e| Error::Ssh(format!("could not delete {file}: {}", tidy(e))))?;
                // Held only to count — no await happens inside the lock.
                let mut p = progress.lock().unwrap();
                p.start(name_of(file), 0);
                p.finished_file();
            }
        });
    }

    // The first failure ends the whole delete: the other lanes would be
    // emptying a tree that is not going to come out anyway.
    while let Some(joined) = lanes.join_next().await {
        match joined {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                lanes.abort_all();
                return Err(e);
            }
            Err(e) => {
                lanes.abort_all();
                return Err(Error::Ssh(format!("a delete did not finish: {e}")));
            }
        }
    }

    // Directories stay one at a time, deepest first. A directory can only be
    // removed once it is empty, so this order is a real dependency rather than
    // a preference — and the walk found them the other way round. There are
    // always far fewer of these than files, which is why the lanes above are
    // where the time actually was.
    for dir in dirs.iter().rev() {
        {
            let mut p = progress.lock().unwrap();
            p.start(name_of(dir), 0);
        }
        sftp.remove_dir(dir)
            .await
            .map_err(|e| Error::Ssh(format!("could not delete {dir}: {}", tidy(e))))?;
        progress.lock().unwrap().finished_file();
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::{owner_group, parse_table, scratch_name, staging_name};

    /// The staging copy is named by us and read back by a `sudo cp`, so two
    /// things about the name are load-bearing: it is one ordinary path
    /// component, and no two saves in a session can land on the same one.
    #[test]
    fn names_a_staging_copy_that_cannot_collide() {
        let first = staging_name("d7f3-9a1c-session");
        let second = staging_name("d7f3-9a1c-session");
        assert_ne!(first, second);

        for name in [first, staging_name(""), staging_name("../../etc/passwd")] {
            assert!(name.starts_with(".portway-"), "{name}");
            assert!(!name.contains(['/', '\\', ':', '\0']), "{name}");
            assert!(!name.contains(".."), "{name}");
        }
    }

    #[test]
    fn keeps_an_ordinary_name() {
        assert_eq!(scratch_name("/var/log/nginx/access.log").unwrap(), "access.log");
        assert_eq!(scratch_name("notes.txt").unwrap(), "notes.txt");
        // Legal, and not an escape: only a *leading* pair of dots as the whole
        // name is a parent reference.
        assert_eq!(scratch_name("/tmp/..hidden").unwrap(), "..hidden");
        assert_eq!(scratch_name("/tmp/report.2026.tar.gz").unwrap(), "report.2026.tar.gz");
    }

    /// The names a server would choose if it wanted to write outside the
    /// scratch directory. Every one of them is a legal Linux filename, and on
    /// Windows every one of them escapes.
    #[test]
    fn refuses_a_name_that_is_a_path() {
        for hostile in [
            r"/home/user/..\..\..\Start Menu\Programs\Startup\updater.exe",
            r"/home/user/C:\Users\Public\evil.exe",
            r"/home/user/subdir\payload.dll",
            "/home/user/..",
            "/home/user/.",
            "/home/user/",
            "",
        ] {
            let refused = scratch_name(hostile).unwrap_err().to_string();
            assert!(refused.contains("refusing to edit"), "{hostile:?} → {refused}");
        }
    }

    /// A real `/etc/passwd`, including the lines that are not accounts.
    #[test]
    fn reads_the_accounts_out_of_passwd() {
        let passwd = "\
root:x:0:0:root:/root:/bin/bash
bin:x:1:1:bin:/bin:/sbin/nologin
opc:x:1000:1000::/home/opc:/bin/bash

# a comment some distributions leave in
+@staff::::::
broken-line-with-no-fields
nobody:x:65534:65534:Kernel Overflow User:/:/sbin/nologin
";
        let users = parse_table(passwd, 2);
        let names: Vec<_> = users.iter().map(|u| (u.name.as_str(), u.id)).collect();
        // Sorted by name, and the comment, the NIS compat line and the
        // unparseable one are all gone rather than taking the file with them.
        assert_eq!(names, vec![("bin", 1), ("nobody", 65534), ("opc", 1000), ("root", 0)]);
    }

    /// `/etc/group` puts the id one field later than `/etc/passwd` does, which
    /// is the only reason the field number is a parameter.
    #[test]
    fn reads_the_groups_out_of_group() {
        let group = "root:x:0:\nwheel:x:10:opc,deploy\nopc:x:1000:\n";
        let groups = parse_table(group, 2);
        let names: Vec<_> = groups.iter().map(|g| (g.name.as_str(), g.id)).collect();
        assert_eq!(names, vec![("opc", 1000), ("root", 0), ("wheel", 10)]);
    }

    /// A server that hands over something else entirely — the read is capped
    /// and the parse must simply find nothing, not panic or invent an id.
    #[test]
    fn finds_nothing_in_a_file_that_is_not_one() {
        assert!(parse_table("", 2).is_empty());
        assert!(parse_table("not a passwd file at all\n\n", 2).is_empty());
        assert!(parse_table("name:x:not-a-number:0:\n", 2).is_empty());
    }

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
