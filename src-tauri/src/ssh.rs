//! SSH sessions to saved servers, one per server × user, built on russh.
//!
//! Host keys are checked against ~/.ssh/known_hosts like OpenSSH: an unknown
//! key is only added after the user confirmed its fingerprint, a changed key is
//! refused. Passwords and key passphrases can be kept in the macOS Keychain.

use russh::client::{self, Handle};
use russh::keys::{self, HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use russh::ChannelMsg;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::error::{AppError, AppResult};
use crate::paths::{expand_tilde, ssh_dir};
use crate::servers::{Auth, ServerStore};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const EXEC_TIMEOUT: Duration = Duration::from_secs(20);
/// Leaves room under OpenSSH's default MaxSessions (10) for a terminal or SFTP.
const CHANNELS_PER_SESSION: usize = 6;
const KEYCHAIN_SERVICE: &str = "com.portway.app";

/// What the host key check saw, kept so a refused connection can be explained.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum HostKeyIssue {
    /// Not in known_hosts yet; the user must confirm the fingerprint.
    Unknown { fingerprint: String, algorithm: String },
    /// known_hosts has a different key for this host: possible MITM or a reinstall.
    Changed { fingerprint: String, algorithm: String, line: usize },
}

struct Client {
    host: String,
    port: u16,
    known_hosts: PathBuf,
    /// Fingerprint the user accepted for an unknown host, if any.
    trust: Option<String>,
    issue: Arc<Mutex<Option<HostKeyIssue>>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let key: PublicKey = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(cert) => PublicKey::from(cert.public_key().clone()),
        };
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        let algorithm = key.algorithm().to_string();
        let known_hosts = &self.known_hosts;
        match keys::check_known_hosts_path(&self.host, self.port, &key, known_hosts) {
            Ok(true) => Ok(true),
            Ok(false) => {
                if self.trust.as_deref() == Some(fingerprint.as_str()) {
                    keys::known_hosts::learn_known_hosts_path(&self.host, self.port, &key, known_hosts)?;
                    return Ok(true);
                }
                *self.issue.lock().unwrap() = Some(HostKeyIssue::Unknown { fingerprint, algorithm });
                Ok(false)
            }
            Err(keys::Error::KeyChanged { line }) => {
                *self.issue.lock().unwrap() = Some(HostKeyIssue::Changed { fingerprint, algorithm, line });
                Ok(false)
            }
            Err(e) => Err(e.into()),
        }
    }
}

/// Facts read from the server right after connecting.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    /// e.g. "Ubuntu 24.04", from /etc/os-release.
    pub os: Option<String>,
    pub hostname: String,
    pub kernel: String,
    pub uptime_secs: u64,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ConnectResult {
    Connected { info: HostInfo },
    HostKey { issue: HostKeyIssue },
    /// Password auth and no usable password; `retry` when the last one was rejected.
    NeedPassword { retry: bool },
    /// The key file is encrypted; `retry` when the last passphrase was wrong.
    NeedPassphrase { key_path: String, retry: bool },
}

struct Session {
    handle: Handle<Client>,
    /// Limits channels open at once. OpenSSH allows 10 per connection
    /// (MaxSessions); the overview alone reads six things in parallel.
    channels: tokio::sync::Semaphore,
    /// Previous counters, to turn totals into CPU % and network rates.
    last: Mutex<Option<(Instant, Counters)>>,
    /// Previous CPU ticks per pid, for per-process CPU %.
    last_procs: Mutex<Option<(Instant, HashMap<u32, u64>)>>,
}

impl Session {
    fn new(handle: Handle<Client>) -> Self {
        Self { handle, channels: tokio::sync::Semaphore::new(CHANNELS_PER_SESSION), last: Mutex::new(None), last_procs: Mutex::new(None) }
    }
}

#[derive(Default)]
pub struct Sessions {
    map: Mutex<HashMap<String, Arc<Session>>>,
}

fn session_key(server_id: &str, user: &str) -> String {
    format!("{server_id}|{user}")
}

impl Sessions {
    fn get(&self, server_id: &str, user: &str) -> AppResult<Arc<Session>> {
        let map = self.map.lock().unwrap();
        match map.get(&session_key(server_id, user)) {
            Some(s) if !s.handle.is_closed() => Ok(s.clone()),
            _ => Err(AppError::new("not_connected")),
        }
    }
}

fn keychain(account: &str) -> Option<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, account).ok()
}
fn password_account(server_id: &str, user: &str) -> String {
    format!("password:{server_id}:{user}")
}
fn passphrase_account(key_path: &str) -> String {
    format!("passphrase:{key_path}")
}

fn map_connect_error(e: russh::Error, host: &str, port: u16) -> AppError {
    use std::io::ErrorKind;
    match e {
        russh::Error::IO(io) => match io.kind() {
            ErrorKind::ConnectionRefused => AppError::detail("refused", format!("connect to host {host} port {port}: Connection refused")),
            ErrorKind::TimedOut => AppError::detail("timeout", format!("connect to host {host} port {port}: Operation timed out")),
            _ if io.to_string().contains("failed to lookup") || io.to_string().contains("nodename nor servname") => {
                AppError::detail("dns", format!("Could not resolve hostname {host}"))
            }
            _ => AppError::detail("network", io),
        },
        other => AppError::detail("ssh", other),
    }
}


pub struct Target {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub known_hosts: PathBuf,
}

pub enum Credential {
    Key(Arc<keys::PrivateKey>),
    Password(String),
}

enum Opened {
    Ready(Handle<Client>),
    HostKey(HostKeyIssue),
    /// The server refused the credential.
    Rejected,
}

/// Connect, check the host key and authenticate.
async fn open(target: &Target, credential: Credential, trust: Option<String>) -> AppResult<Opened> {
    let issue = Arc::new(Mutex::new(None));
    let handler = Client {
        host: target.host.clone(),
        port: target.port,
        known_hosts: target.known_hosts.clone(),
        trust,
        issue: issue.clone(),
    };
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 3,
        nodelay: true,
        ..Default::default()
    });

    let connecting = client::connect(config, (target.host.as_str(), target.port), handler);
    let mut handle = match tokio::time::timeout(CONNECT_TIMEOUT, connecting).await {
        Err(_) => {
            return Err(AppError::detail(
                "timeout",
                format!("connect to host {} port {}: Operation timed out", target.host, target.port),
            ))
        }
        Ok(Err(e)) => {
            if let Some(issue) = issue.lock().unwrap().take() {
                return Ok(Opened::HostKey(issue));
            }
            return Err(map_connect_error(e, &target.host, target.port));
        }
        Ok(Ok(h)) => h,
    };

    let auth = match credential {
        Credential::Key(k) => {
            let hash = if k.algorithm().is_rsa() {
                handle.best_supported_rsa_hash().await.ok().flatten().unwrap_or(Some(HashAlg::Sha256))
            } else {
                None
            };
            handle.authenticate_publickey(&target.user, PrivateKeyWithHashAlg::new(k, hash)).await
        }
        Credential::Password(p) => handle.authenticate_password(&target.user, p).await,
    }
    .map_err(|e| AppError::detail("ssh", e))?;

    if !auth.success() {
        let _ = handle.disconnect(russh::Disconnect::ByApplication, "", "en").await;
        return Ok(Opened::Rejected);
    }
    Ok(Opened::Ready(handle))
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn ssh_connect(
    store: tauri::State<'_, ServerStore>,
    sessions: tauri::State<'_, Sessions>,
    server_id: String,
    user: String,
    password: Option<String>,
    passphrase: Option<String>,
    remember: Option<bool>,
    trust_fingerprint: Option<String>,
) -> AppResult<ConnectResult> {
    let server = store.list().into_iter().find(|s| s.id == server_id).ok_or_else(|| AppError::new("not_found"))?;
    let account = server.accounts.iter().find(|a| a.user == user).cloned().ok_or_else(|| AppError::new("no_account"))?;
    let remember = remember.unwrap_or(true);

    // Load the key before connecting, so a missing or encrypted key is reported
    // without touching the network.
    let key = match &account.auth {
        Auth::Key { path } => {
            let file = expand_tilde(path);
            if !file.is_file() {
                return Err(AppError::detail("key_missing", path));
            }
            let stored = keychain(&passphrase_account(path)).and_then(|e| e.get_password().ok());
            let given = passphrase.clone().filter(|p| !p.is_empty());
            let attempt = given.clone().or(stored.clone());
            match keys::load_secret_key(&file, attempt.as_deref()) {
                Ok(k) => {
                    if remember {
                        if let (Some(p), Some(entry)) = (given, keychain(&passphrase_account(path))) {
                            let _ = entry.set_password(&p);
                        }
                    }
                    Some(Arc::new(k))
                }
                Err(keys::Error::KeyIsEncrypted) => {
                    return Ok(ConnectResult::NeedPassphrase { key_path: path.clone(), retry: false });
                }
                Err(e) if attempt.is_some() => {
                    // Wrong passphrase: forget a stored one so it is not retried forever.
                    if passphrase.is_none() {
                        if let Some(entry) = keychain(&passphrase_account(path)) {
                            let _ = entry.delete_credential();
                        }
                    }
                    let _ = e;
                    return Ok(ConnectResult::NeedPassphrase { key_path: path.clone(), retry: true });
                }
                Err(e) => return Err(AppError::detail("key_unreadable", e)),
            }
        }
        Auth::Password => None,
    };

    let stored_password = || keychain(&password_account(&server_id, &user)).and_then(|e| e.get_password().ok());
    let pw = if key.is_none() {
        match password.clone().filter(|p| !p.is_empty()).or_else(stored_password) {
            Some(p) => Some(p),
            None => return Ok(ConnectResult::NeedPassword { retry: false }),
        }
    } else {
        None
    };

    let credential = match (&key, &pw) {
        (Some(k), _) => Credential::Key(k.clone()),
        (None, Some(p)) => Credential::Password(p.clone()),
        (None, None) => unreachable!("either a key or a password is set above"),
    };
    let target = Target { host: server.host.clone(), port: server.port, user: user.clone(), known_hosts: ssh_dir().join("known_hosts") };
    let handle = match open(&target, credential, trust_fingerprint).await? {
        Opened::Ready(h) => h,
        Opened::HostKey(issue) => return Ok(ConnectResult::HostKey { issue }),
        Opened::Rejected => {
            if key.is_none() {
                // Drop a stored password the server no longer accepts.
                if password.is_none() {
                    if let Some(entry) = keychain(&password_account(&server_id, &user)) {
                        let _ = entry.delete_credential();
                    }
                }
                return Ok(ConnectResult::NeedPassword { retry: true });
            }
            return Err(AppError::detail("auth_failed", format!("{user}@{}: Permission denied (publickey)", server.host)));
        }
    };
    if remember {
        if let (Some(p), Some(entry)) = (password.filter(|p| !p.is_empty()), keychain(&password_account(&server_id, &user))) {
            let _ = entry.set_password(&p);
        }
    }

    let session = Arc::new(Session::new(handle));
    let info = read_host_info(&session).await?;
    if let Some(os) = &info.os {
        store.set_os(&server_id, os)?;
    }
    sessions.map.lock().unwrap().insert(session_key(&server_id, &user), session);
    Ok(ConnectResult::Connected { info })
}

#[tauri::command]
pub async fn ssh_disconnect(sessions: tauri::State<'_, Sessions>, server_id: String, user: String) -> AppResult<()> {
    let session = sessions.map.lock().unwrap().remove(&session_key(&server_id, &user));
    if let Some(s) = session {
        let _ = s.handle.disconnect(russh::Disconnect::ByApplication, "", "en").await;
    }
    Ok(())
}

/// Close every session. The UI calls this when it starts, since a reloaded
/// webview no longer knows about sessions opened before.
#[tauri::command]
pub async fn ssh_disconnect_all(sessions: tauri::State<'_, Sessions>) -> AppResult<()> {
    let all: Vec<Arc<Session>> = sessions.map.lock().unwrap().drain().map(|(_, s)| s).collect();
    for s in all {
        let _ = s.handle.disconnect(russh::Disconnect::ByApplication, "", "en").await;
    }
    Ok(())
}

/// Forget the password or passphrase stored for this account.
#[tauri::command]
pub fn ssh_forget_secret(server_id: String, user: String, key_path: Option<String>) {
    let account = match key_path {
        Some(p) => passphrase_account(&p),
        None => password_account(&server_id, &user),
    };
    if let Some(e) = keychain(&account) {
        let _ = e.delete_credential();
    }
}

pub struct ExecOutput {
    pub stdout: String,
    pub stderr: String,
    pub code: Option<u32>,
}

impl ExecOutput {
    /// Output of a command that must print something; a failure with no stdout
    /// becomes an error carrying stderr.
    fn stdout_or_err(self) -> AppResult<String> {
        if self.stdout.trim().is_empty() && self.code != Some(0) {
            return Err(AppError::detail("remote_command", self.stderr.trim()));
        }
        Ok(self.stdout)
    }
}

/// Run a script in a new channel and collect its output, with the default timeout.
async fn exec(session: &Session, command: &str) -> AppResult<ExecOutput> {
    exec_with(session, command, EXEC_TIMEOUT).await
}

/// Run a script on the server.
///
/// Scripts separate their sections with `MARK`. Each run swaps it for a random
/// token and swaps it back in the output, so a script that prints command lines
/// (the process list) cannot be confused by another Portway script running at
/// the same time. Everything runs with PORTWAY_PROBE=1 in its environment, so
/// Portway's own commands can be left out of the process list.
async fn exec_with(session: &Session, command: &str, timeout: Duration) -> AppResult<ExecOutput> {
    let handle = &session.handle;
    // Waiting for a free channel counts towards the timeout too.
    let _permit = tokio::time::timeout(timeout, session.channels.acquire())
        .await
        .map_err(|_| AppError::new("exec_timeout"))?
        .map_err(|e| AppError::detail("ssh", e))?;
    let token = format!("@@PW{}@@", uuid::Uuid::new_v4().simple());
    let wrapped = format!("env PORTWAY_PROBE=1 sh -c {}", shell_quote(&command.replace(MARK, &token)));
    let run = async {
        let mut channel = handle.channel_open_session().await?;
        channel.exec(true, wrapped.as_str()).await?;
        let (mut out, mut err, mut code) = (Vec::new(), Vec::new(), None);
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => out.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, .. } => err.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                _ => {}
            }
        }
        Ok::<_, russh::Error>(ExecOutput {
            stdout: String::from_utf8_lossy(&out).replace(&token, MARK),
            stderr: String::from_utf8_lossy(&err).into_owned(),
            code,
        })
    };
    match tokio::time::timeout(timeout, run).await {
        Err(_) => Err(AppError::new("exec_timeout")),
        Ok(Err(e)) if handle.is_closed() => Err(AppError::detail("connection_lost", e)),
        Ok(Err(e)) => Err(AppError::detail("ssh", e)),
        Ok(Ok(o)) => Ok(o),
    }
}

pub const MARK: &str = "@@PORTWAY@@";

async fn read_host_info(session: &Session) -> AppResult<HostInfo> {
    let script = format!(
        "cat /etc/os-release 2>/dev/null; echo {MARK}; hostname 2>/dev/null || cat /etc/hostname; echo {MARK}; uname -sr; echo {MARK}; cat /proc/uptime 2>/dev/null"
    );
    let out = exec(session, &script).await?.stdout_or_err()?;
    let parts: Vec<&str> = out.split(MARK).map(str::trim).collect();
    let get = |i: usize| parts.get(i).copied().unwrap_or("");
    Ok(HostInfo {
        os: os_name(get(0)),
        hostname: get(1).to_string(),
        kernel: get(2).to_string(),
        uptime_secs: get(3).split_whitespace().next().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0) as u64,
    })
}

/// "Ubuntu 24.04", "Debian 12", "Alpine 3.20.8" from /etc/os-release.
fn os_name(os_release: &str) -> Option<String> {
    let field = |key: &str| {
        os_release.lines().find_map(|l| l.strip_prefix(&format!("{key}="))).map(|v| v.trim().trim_matches('"').to_string())
    };
    let name = field("NAME").or_else(|| field("ID"))?;
    let name = name.trim_end_matches(" GNU/Linux").trim_end_matches(" Linux").to_string();
    Some(match field("VERSION_ID") {
        Some(v) if !v.is_empty() => format!("{name} {v}"),
        _ => name,
    })
}

/// Raw totals read from /proc; rates need two samples.
#[derive(Clone, Copy, Default)]
struct Counters {
    cpu_total: u64,
    cpu_idle: u64,
    net_rx: u64,
    net_tx: u64,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    /// Busy CPU over the last interval, 0–100. None on the very first sample.
    pub cpu_percent: Option<f64>,
    pub load: [f64; 3],
    pub cores: u32,
    pub mem_total: u64,
    pub mem_used: u64,
    pub disk_total: u64,
    pub disk_used: u64,
    pub disk_avail: u64,
    /// Bytes per second over the last interval, all interfaces except lo.
    pub net_rx_rate: Option<f64>,
    pub net_tx_rate: Option<f64>,
    pub uptime_secs: u64,
}

const STATS_SCRIPT: &str = "head -n1 /proc/stat; echo @@PORTWAY@@; cat /proc/loadavg; echo @@PORTWAY@@; \
grep -c ^processor /proc/cpuinfo; echo @@PORTWAY@@; cat /proc/meminfo; echo @@PORTWAY@@; df -kP / | tail -n1; \
echo @@PORTWAY@@; cat /proc/net/dev; echo @@PORTWAY@@; cat /proc/uptime";

fn parse_stats(text: &str) -> (Stats, Counters) {
    let parts: Vec<&str> = text.split(MARK).map(str::trim).collect();
    let get = |i: usize| parts.get(i).copied().unwrap_or("");
    let mut stats = Stats::default();
    let mut c = Counters::default();

    // cpu  user nice system idle iowait irq softirq steal …
    let cpu: Vec<u64> = get(0).split_whitespace().skip(1).filter_map(|v| v.parse().ok()).collect();
    c.cpu_total = cpu.iter().take(8).sum();
    c.cpu_idle = cpu.get(3).copied().unwrap_or(0) + cpu.get(4).copied().unwrap_or(0);

    let load: Vec<f64> = get(1).split_whitespace().take(3).filter_map(|v| v.parse().ok()).collect();
    if load.len() == 3 {
        stats.load = [load[0], load[1], load[2]];
    }
    stats.cores = get(2).parse().unwrap_or(0);

    let mem = |key: &str| -> Option<u64> {
        get(3).lines().find_map(|l| l.strip_prefix(key)).and_then(|v| v.split_whitespace().next()?.parse::<u64>().ok()).map(|kb| kb * 1024)
    };
    stats.mem_total = mem("MemTotal:").unwrap_or(0);
    let avail = mem("MemAvailable:").unwrap_or_else(|| {
        mem("MemFree:").unwrap_or(0) + mem("Buffers:").unwrap_or(0) + mem("Cached:").unwrap_or(0)
    });
    stats.mem_used = stats.mem_total.saturating_sub(avail);

    // Filesystem 1024-blocks Used Available Capacity Mounted
    let df: Vec<u64> = get(4).split_whitespace().skip(1).take(3).filter_map(|v| v.parse().ok()).collect();
    if df.len() == 3 {
        stats.disk_total = df[0] * 1024;
        stats.disk_used = df[1] * 1024;
        stats.disk_avail = df[2] * 1024;
    }

    // "  eth0: rx_bytes rx_packets … (8 rx fields) tx_bytes …"
    for line in get(5).lines().skip(2) {
        let Some((iface, rest)) = line.split_once(':') else { continue };
        if iface.trim() == "lo" {
            continue;
        }
        let f: Vec<u64> = rest.split_whitespace().filter_map(|v| v.parse().ok()).collect();
        c.net_rx += f.first().copied().unwrap_or(0);
        c.net_tx += f.get(8).copied().unwrap_or(0);
    }

    stats.uptime_secs = get(6).split_whitespace().next().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0) as u64;
    (stats, c)
}

async fn sample(session: &Session) -> AppResult<(Stats, Counters, Instant)> {
    let out = exec(&session, STATS_SCRIPT).await?.stdout_or_err()?;
    let (stats, counters) = parse_stats(&out);
    Ok((stats, counters, Instant::now()))
}

/// Live resource numbers for the overview. The first call samples twice, one
/// second apart, so CPU % and network rates are available straight away.
#[tauri::command]
pub async fn server_stats(sessions: tauri::State<'_, Sessions>, server_id: String, user: String) -> AppResult<Stats> {
    let session = sessions.get(&server_id, &user)?;
    let previous = *session.last.lock().unwrap();
    let previous = match previous {
        Some(p) => p,
        None => {
            let (_, c, t) = sample(&session).await?;
            tokio::time::sleep(Duration::from_secs(1)).await;
            (t, c)
        }
    };
    let (mut stats, now_c, now_t) = sample(&session).await?;
    let (prev_t, prev_c) = previous;
    let secs = now_t.duration_since(prev_t).as_secs_f64().max(0.001);
    let total = now_c.cpu_total.saturating_sub(prev_c.cpu_total);
    let idle = now_c.cpu_idle.saturating_sub(prev_c.cpu_idle);
    if total > 0 {
        stats.cpu_percent = Some(100.0 * (total - idle.min(total)) as f64 / total as f64);
    }
    stats.net_rx_rate = Some(now_c.net_rx.saturating_sub(prev_c.net_rx) as f64 / secs);
    stats.net_tx_rate = Some(now_c.net_tx.saturating_sub(prev_c.net_tx) as f64 / secs);
    *session.last.lock().unwrap() = Some((now_t, now_c));
    Ok(stats)
}

/// One row of the "top processes" table.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProcessRow {
    pub pid: u32,
    /// Full command line, or `[name]` for kernel threads.
    pub command: String,
    /// User name from the server's /etc/passwd; None when the uid is not there
    /// (typically a user that only exists inside a container).
    pub user: Option<String>,
    pub uid: Option<u32>,
    /// Docker container name (or short id when the name cannot be read).
    pub container: Option<String>,
    /// CPU over the last interval, % of one core like top (can exceed 100).
    pub cpu_percent: f64,
    /// Resident memory in bytes.
    pub rss: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Processes {
    /// When the second sample was taken (ms since epoch).
    pub at: u64,
    pub rows: Vec<ProcessRow>,
}

const TOP_N: usize = 6;

/// `pid -> (utime + stime, rss pages, comm)` from concatenated /proc/<pid>/stat.
fn parse_proc_stats(text: &str) -> HashMap<u32, (u64, u64, String)> {
    let mut out = HashMap::new();
    for line in text.lines() {
        // "pid (comm) state …": comm may contain spaces and parentheses.
        let (Some(open), Some(close)) = (line.find('('), line.rfind(')')) else { continue };
        let Ok(pid) = line[..open].trim().parse::<u32>() else { continue };
        let comm = line[open + 1..close].to_string();
        let f: Vec<&str> = line[close + 1..].split_whitespace().collect();
        // f[0] is field 3 (state); utime is field 14, stime 15, rss 24.
        let num = |i: usize| f.get(i).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
        out.insert(pid, (num(11) + num(12), num(21), comm));
    }
    out
}

/// A 64-hex container id in a /proc/<pid>/cgroup line (docker, containerd, podman).
fn container_id(cgroup: &str) -> Option<String> {
    let bytes = cgroup.as_bytes();
    (0..bytes.len().saturating_sub(63)).find_map(|i| {
        let s = &cgroup[i..i + 64];
        let bounded = (i == 0 || !bytes[i - 1].is_ascii_hexdigit()) && bytes.get(i + 64).is_none_or(|b| !b.is_ascii_hexdigit());
        (bounded && s.bytes().all(|b| b.is_ascii_hexdigit())).then(|| s.to_string())
    })
}

/// `pid -> (uid, command line, container id)` from the per-pid detail lines.
/// Portway's own probes and processes that exited come back without a uid.
fn parse_proc_details(section: &str) -> HashMap<u32, (Option<u32>, String, Option<String>)> {
    section
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.strip_prefix("@@P ")?.splitn(4, '\t').collect();
            let pid = f.first()?.trim().parse().ok()?;
            if f.get(1) == Some(&"probe") {
                return Some((pid, (None, String::new(), None)));
            }
            let uid = f.get(1).and_then(|u| u.trim().parse().ok());
            let cmdline = f.get(2).map(|c| c.trim().to_string()).unwrap_or_default();
            Some((pid, (uid, cmdline, f.get(3).and_then(|g| container_id(g)))))
        })
        .collect()
}

async fn sample_procs(session: &Session) -> AppResult<(Instant, u64, u64, HashMap<u32, (u64, u64, String)>)> {
    let script = format!(
        "getconf CLK_TCK 2>/dev/null || echo 100; echo {MARK}; getconf PAGESIZE 2>/dev/null || echo 4096; echo {MARK}; cat /proc/[0-9]*/stat 2>/dev/null"
    );
    let out = exec(&session, &script).await?.stdout_or_err()?;
    let now = Instant::now();
    let parts: Vec<&str> = out.split(MARK).map(str::trim).collect();
    let hz = parts.first().and_then(|v| v.parse().ok()).filter(|v| *v > 0).unwrap_or(100);
    let page = parts.get(1).and_then(|v| v.parse().ok()).filter(|v| *v > 0).unwrap_or(4096);
    Ok((now, hz, page, parse_proc_stats(parts.get(2).copied().unwrap_or(""))))
}

/// The busiest processes right now. The first call samples twice, one second
/// apart; later calls compare with the previous call.
#[tauri::command]
pub async fn server_processes(sessions: tauri::State<'_, Sessions>, server_id: String, user: String) -> AppResult<Processes> {
    let session = sessions.get(&server_id, &user)?;
    top_processes(&session).await
}

async fn top_processes(session: &Session) -> AppResult<Processes> {
    let previous = session.last_procs.lock().unwrap().clone();
    let previous = match previous {
        Some(p) => p,
        None => {
            let (t, _, _, s) = sample_procs(session).await?;
            tokio::time::sleep(Duration::from_secs(1)).await;
            (t, s.into_iter().map(|(pid, (ticks, _, _))| (pid, ticks)).collect())
        }
    };
    let (now, hz, page, current) = sample_procs(session).await?;
    let secs = now.duration_since(previous.0).as_secs_f64().max(0.001);

    let mut ranked: Vec<(u32, f64, u64, String)> = current
        .iter()
        .map(|(pid, (ticks, rss, comm))| {
            // A pid that was not there before started during the interval.
            let delta = ticks.saturating_sub(previous.1.get(pid).copied().unwrap_or(*ticks));
            (*pid, 100.0 * delta as f64 / hz as f64 / secs, rss * page, comm.clone())
        })
        .collect();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then(b.2.cmp(&a.2)));
    // Take extra candidates: some are gone by the time details are read (the
    // short-lived shells of this very sampling, for one).
    ranked.truncate(TOP_N * 2);
    *session.last_procs.lock().unwrap() = Some((now, current.iter().map(|(pid, (t, _, _))| (*pid, *t)).collect()));

    // Details for the few rows shown: uid, command line, container.
    let pids: Vec<String> = ranked.iter().map(|r| r.0.to_string()).collect();
    let detail = format!(
        r#"for p in {pids}; do
  if tr '\000' '\n' < /proc/$p/environ 2>/dev/null | grep -q '^PORTWAY_PROBE=1$'; then printf '@@P %s\tprobe\n' "$p"; continue; fi
  u=$(awk '/^Uid:/{{print $2}}' /proc/$p/status 2>/dev/null)
  c=$(tr '\000\t\n' '   ' < /proc/$p/cmdline 2>/dev/null)
  g=$(head -n 5 /proc/$p/cgroup 2>/dev/null | tr '\t\n' '  ')
  printf '@@P %s\t%s\t%s\t%s\n' "$p" "$u" "$c" "$g"
done
echo {MARK}; cat /etc/passwd 2>/dev/null; echo {MARK}; docker ps --no-trunc --format '{{{{.ID}}}} {{{{.Names}}}}' 2>/dev/null"#,
        pids = pids.join(" ")
    );
    let out = exec(&session, &detail).await?.stdout;
    let parts: Vec<&str> = out.split(MARK).collect();
    let passwd: HashMap<u32, String> = parts
        .get(1)
        .unwrap_or(&"")
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split(':').collect();
            Some((f.get(2)?.parse().ok()?, f.first()?.to_string()))
        })
        .collect();
    let names: HashMap<String, String> = parts
        .get(2)
        .unwrap_or(&"")
        .lines()
        .filter_map(|l| l.trim().split_once(' ').map(|(id, name)| (id.to_string(), name.to_string())))
        .collect();
    let mut details = parse_proc_details(parts.first().unwrap_or(&""));

    let rows = ranked
        .into_iter()
        // No uid: the process exited, or it is one of Portway's own probes.
        .filter_map(|(pid, cpu, rss, comm)| Some((pid, cpu, rss, comm, details.remove(&pid).filter(|d| d.0.is_some())?)))
        .take(TOP_N)
        .map(|(pid, cpu, rss, comm, (uid, cmdline, cid))| {
            ProcessRow {
                pid,
                command: if cmdline.is_empty() { format!("[{comm}]") } else { cmdline },
                user: uid.and_then(|u| passwd.get(&u).cloned()),
                uid,
                container: cid.map(|id| names.get(&id).cloned().unwrap_or_else(|| id[..12].to_string())),
                cpu_percent: cpu,
                rss,
            }
        })
        .collect();
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    Ok(Processes { at, rows })
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ContainerBrief {
    pub name: String,
    pub state: String,
    /// "Up 3 hours", "Exited (1) 2 hours ago" as docker prints it.
    pub status: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DockerHealth {
    NotInstalled,
    /// The user may not talk to the daemon (not root, not in the docker group).
    NoAccess { detail: String },
    DaemonDown { detail: String },
    Ok { running: u32, total: u32, failed: Vec<ContainerBrief>, finished: Vec<ContainerBrief> },
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SystemdHealth {
    /// Init is not systemd (containers, Alpine with OpenRC…).
    NotSystemd,
    Ok { services: u32, failed: Vec<String> },
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Upgrade {
    pub name: String,
    pub version: String,
    pub security: bool,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum UpdatesHealth {
    Unsupported,
    /// The package index was never downloaded (apt update / apk update).
    NoIndex { manager: String },
    Ok {
        manager: String,
        upgrades: Vec<Upgrade>,
        /// When the package index was last refreshed (ms since epoch).
        index_at: Option<u64>,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub docker: DockerHealth,
    pub systemd: SystemdHealth,
    pub updates: UpdatesHealth,
}

const HEALTH_SCRIPT: &str = r#"
if command -v docker >/dev/null 2>&1; then
  out=$(docker ps -a --format '{{.Names}}\t{{.State}}\t{{.Status}}' 2>&1); echo "rc=$?"; echo "$out"
else echo notinstalled; fi
echo @@PORTWAY@@
if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
  echo "total=$(systemctl list-units --type=service --no-legend --plain 2>/dev/null | wc -l)"
  systemctl list-units --type=service --state=failed --no-legend --plain 2>/dev/null | awk '{print $1}'
else echo notsystemd; fi
echo @@PORTWAY@@
if command -v apt >/dev/null 2>&1; then
  echo mgr=apt
  # List files keep the repository's publish time as mtime; the directory itself
  # (and the cache/stamp files when present) change when apt update runs.
  if ls /var/lib/apt/lists/*_Packages* >/dev/null 2>&1; then
    echo "stamp=$(stat -c %Y /var/lib/apt/periodic/update-success-stamp /var/cache/apt/pkgcache.bin /var/lib/apt/lists 2>/dev/null | sort -n | tail -n1)"
  else echo "stamp="; fi
  apt list --upgradable 2>/dev/null | tail -n +2
elif command -v apk >/dev/null 2>&1; then
  echo mgr=apk
  echo "stamp=$(stat -c %Y /var/cache/apk/APKINDEX.*.tar.gz 2>/dev/null | sort -n | tail -n1)"
  apk version -l '<' 2>/dev/null | tail -n +2
else echo mgr=none; fi
"#;

fn parse_docker(section: &str) -> DockerHealth {
    let mut lines = section.lines();
    let first = lines.next().unwrap_or("").trim();
    if first == "notinstalled" {
        return DockerHealth::NotInstalled;
    }
    let rest: Vec<&str> = lines.collect();
    if first != "rc=0" {
        let detail = rest.join("\n").trim().to_string();
        return if detail.contains("permission denied") {
            DockerHealth::NoAccess { detail }
        } else {
            DockerHealth::DaemonDown { detail }
        };
    }
    let (mut running, mut total, mut failed, mut finished) = (0, 0, Vec::new(), Vec::new());
    for line in rest.iter().filter(|l| !l.trim().is_empty()) {
        let mut f = line.splitn(3, '\t');
        let c = ContainerBrief {
            name: f.next().unwrap_or("").to_string(),
            state: f.next().unwrap_or("").to_string(),
            status: f.next().unwrap_or("").to_string(),
        };
        total += 1;
        match c.state.as_str() {
            "running" => running += 1,
            "restarting" | "dead" => failed.push(c),
            "exited" if c.status.starts_with("Exited (0)") => finished.push(c),
            "exited" => failed.push(c),
            _ => {}
        }
    }
    DockerHealth::Ok { running, total, failed, finished }
}

fn parse_systemd(section: &str) -> SystemdHealth {
    let mut lines = section.lines().map(str::trim).filter(|l| !l.is_empty());
    match lines.next() {
        Some(first) if first.starts_with("total=") => SystemdHealth::Ok {
            services: first[6..].trim().parse().unwrap_or(0),
            failed: lines.map(str::to_string).collect(),
        },
        _ => SystemdHealth::NotSystemd,
    }
}

fn parse_updates(section: &str) -> UpdatesHealth {
    let mut lines = section.lines().map(str::trim).filter(|l| !l.is_empty());
    let manager = match lines.next().and_then(|l| l.strip_prefix("mgr=")) {
        Some(m) if m == "apt" || m == "apk" => m.to_string(),
        _ => return UpdatesHealth::Unsupported,
    };
    let stamp = lines.next().and_then(|l| l.strip_prefix("stamp=")).unwrap_or("");
    let index_at = stamp.split('.').next().and_then(|s| s.parse::<u64>().ok()).map(|s| s * 1000);
    if index_at.is_none() {
        return UpdatesHealth::NoIndex { manager };
    }
    let upgrades = lines
        .filter_map(|l| {
            if manager == "apt" {
                // "openssl/noble-updates,noble-security 3.0.13-0ubuntu3.5 amd64 [upgradable from: …]"
                let (name, rest) = l.split_once('/')?;
                let mut f = rest.split_whitespace();
                let suites = f.next()?;
                Some(Upgrade { name: name.to_string(), version: f.next()?.to_string(), security: suites.contains("security") })
            } else {
                // "busybox-1.36.1-r29 < 1.36.1-r31"
                let (current, newer) = l.split_once('<')?;
                let current = current.trim();
                // The name is everything before the "-<version>-r<n>" suffix.
                let name = current.rsplitn(3, '-').nth(2).unwrap_or(current);
                Some(Upgrade { name: name.to_string(), version: newer.trim().to_string(), security: false })
            }
        })
        .collect();
    UpdatesHealth::Ok { manager, upgrades, index_at }
}

async fn read_health(session: &Session) -> AppResult<Health> {
    let out = exec(&session, HEALTH_SCRIPT).await?.stdout;
    let parts: Vec<&str> = out.split(MARK).collect();
    Ok(Health {
        docker: parse_docker(parts.first().unwrap_or(&"")),
        systemd: parse_systemd(parts.get(1).unwrap_or(&"")),
        updates: parse_updates(parts.get(2).unwrap_or(&"")),
    })
}

/// Docker, systemd and package-update status for the overview.
#[tauri::command]
pub async fn server_health(sessions: tauri::State<'_, Sessions>, server_id: String, user: String) -> AppResult<Health> {
    let session = sessions.get(&server_id, &user)?;
    read_health(&session).await
}

/// Mounted filesystems and Docker disk usage for the overview.
#[tauri::command]
pub async fn server_disks(sessions: tauri::State<'_, Sessions>, server_id: String, user: String) -> AppResult<crate::disks::Disks> {
    let session = sessions.get(&server_id, &user)?;
    let out = exec(&session, crate::disks::DISKS_SCRIPT).await?.stdout;
    Ok(crate::disks::parse_disks(&out))
}

/// Docker disk usage. `docker system df` sizes every volume, which can take
/// tens of seconds, so it gets its own call and a long timeout.
#[tauri::command]
pub async fn server_docker_disk(sessions: tauri::State<'_, Sessions>, server_id: String, user: String) -> AppResult<crate::disks::DockerDisk> {
    let session = sessions.get(&server_id, &user)?;
    let out = exec_with(&session, crate::disks::DOCKER_DF_SCRIPT, Duration::from_secs(120)).await?.stdout;
    Ok(crate::disks::parse_docker_df(out.trim_start()))
}

/// Listening ports, UFW rules and exposure warnings for the overview.
#[tauri::command]
pub async fn server_ports(sessions: tauri::State<'_, Sessions>, server_id: String, user: String) -> AppResult<crate::ports::Ports> {
    let session = sessions.get(&server_id, &user)?;
    let out = exec(&session, crate::ports::PORTS_SCRIPT).await?.stdout;
    Ok(crate::ports::parse_ports(&out))
}

/// Quote a value for a POSIX shell.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Open Terminal.app running `ssh` for this account, through a temporary
/// .command file so no Automation permission is needed. The command is built
/// here with every argument quoted, never taken as a string from the UI.
#[tauri::command]
pub fn open_terminal(store: tauri::State<ServerStore>, server_id: String, user: String, tool: Option<String>) -> AppResult<()> {
    // Remote commands are fixed here; the UI only picks one by name.
    let remote = match tool.as_deref() {
        None => None,
        Some("htop") => Some("command -v htop >/dev/null 2>&1 && exec htop || exec top"),
        Some(_) => return Err(AppError::new("unknown_tool")),
    };
    let server = store.list().into_iter().find(|s| s.id == server_id).ok_or_else(|| AppError::new("not_found"))?;
    let account = server.accounts.iter().find(|a| a.user == user).ok_or_else(|| AppError::new("no_account"))?;
    let mut args = vec!["ssh".to_string()];
    if remote.is_some() {
        args.push("-t".into());
    }
    if server.port != 22 {
        args.push(format!("-p {}", server.port));
    }
    if let Auth::Key { path } = &account.auth {
        args.push(format!("-i {}", shell_quote(&expand_tilde(path).to_string_lossy())));
    }
    args.push(shell_quote(&format!("{}@{}", account.user, server.host)));
    if let Some(cmd) = remote {
        args.push(shell_quote(cmd));
    }

    let dir = std::env::temp_dir().join("portway");
    std::fs::create_dir_all(&dir)?;
    let file = dir.join(format!("ssh-{}.command", uuid::Uuid::new_v4()));
    std::fs::write(&file, format!("#!/bin/sh\nrm -f \"$0\"\nexec {}\n", args.join(" ")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o700))?;
    }
    let status = std::process::Command::new("open").arg("-a").arg("Terminal").arg(&file).status()?;
    if !status.success() {
        return Err(AppError::detail("terminal", format!("open exited with {status}")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Against the Docker test servers (scripts/test-servers.sh up):
    /// `cargo test -- --ignored live_`
    #[tokio::test]
    #[ignore]
    async fn live_docker_servers() {
        let known_hosts = std::env::temp_dir().join(format!("portway-known-hosts-{}", std::process::id()));
        let _ = std::fs::remove_file(&known_hosts);
        let key = Arc::new(keys::load_secret_key(expand_tilde("~/.ssh/id_ed25519"), None).expect("~/.ssh/id_ed25519"));
        let target = |port: u16, user: &str| Target { host: "127.0.0.1".into(), port, user: user.into(), known_hosts: known_hosts.clone() };

        // Unknown host key: refused and reported with its fingerprint.
        let fp = match open(&target(2201, "root"), Credential::Key(key.clone()), None).await.unwrap() {
            Opened::HostKey(HostKeyIssue::Unknown { fingerprint, .. }) => fingerprint,
            _ => panic!("expected an unknown host key"),
        };
        assert!(fp.starts_with("SHA256:"));

        // Trusting that fingerprint records it and connects.
        let Opened::Ready(handle) = open(&target(2201, "root"), Credential::Key(key.clone()), Some(fp.clone())).await.unwrap() else {
            panic!("expected to connect after trusting the key");
        };
        assert!(std::fs::read_to_string(&known_hosts).unwrap().trim_start().starts_with("[127.0.0.1]:2201 "));
        let session = Arc::new(Session::new(handle));
        let info = read_host_info(&session).await.unwrap();
        assert!(info.os.as_deref().unwrap().starts_with("Ubuntu 24.04"), "{:?}", info.os);
        assert_eq!(info.hostname, "pw-ubuntu");

        // More parallel reads than OpenSSH's MaxSessions (10) still succeed.
        let tasks: Vec<_> = (0..16)
            .map(|_| {
                let s = session.clone();
                tokio::spawn(async move { exec(&s, "sleep 1; echo ok").await.map(|o| o.stdout) })
            })
            .collect();
        for task in tasks {
            assert_eq!(task.await.unwrap().unwrap().trim(), "ok");
        }
        let (s, c, _) = sample(&session).await.unwrap();
        assert!(s.cores > 0 && s.mem_total > 0 && s.disk_total > 0 && c.cpu_total > 0);

        let procs = top_processes(&session).await.unwrap();
        assert!(!procs.rows.is_empty());
        let sshd = procs.rows.iter().find(|r| r.command.contains("sshd")).expect("sshd among the top processes");
        assert_eq!(sshd.user.as_deref(), Some("root"));
        assert!(sshd.rss > 0);
        assert!(procs.rows.iter().all(|r| r.container.is_none()), "no docker inside the test server");

        let out = exec(&session, crate::ports::PORTS_SCRIPT).await.unwrap().stdout;
        let ports = crate::ports::parse_ports(&out);
        let ssh = ports.listening.iter().find(|l| l.port == 22).expect("sshd listens on 22");
        assert_eq!((ssh.scope, ssh.process.as_deref()), (crate::ports::Scope::Public, Some("sshd")));
        // pw-ubuntu has ufw enabled inside its container (see dev/test-servers).
        assert!(matches!(ports.firewall, crate::ports::Firewall::Active { .. }), "{:?}", ports.firewall);
        assert!(ports.processes_complete, "root sees every process");

        let out = exec(&session, crate::disks::DISKS_SCRIPT).await.unwrap().stdout;
        let disks = crate::disks::parse_disks(&out);
        assert_eq!(disks.mounts.first().map(|m| m.path.as_str()), Some("/"));
        assert!(disks.mounts.iter().all(|m| m.path != "/etc/hosts" && m.path != "/dev/shm"), "{:?}", disks.mounts);
        let out = exec_with(&session, crate::disks::DOCKER_DF_SCRIPT, Duration::from_secs(120)).await.unwrap().stdout;
        assert!(matches!(crate::disks::parse_docker_df(out.trim_start()), crate::disks::DockerDisk::Ok { .. }), "root on pw-ubuntu reaches the host Docker");

        let health = read_health(&session).await.unwrap();
        assert!(matches!(health.systemd, SystemdHealth::NotSystemd), "containers do not run systemd");

        // A known host now connects without asking.
        assert!(matches!(open(&target(2201, "deploy"), Credential::Key(key.clone()), None).await.unwrap(), Opened::Ready(_)));

        // Another host that reuses a recorded key line for its address: key changed.
        let ubuntu_line = std::fs::read_to_string(&known_hosts).unwrap();
        std::fs::write(&known_hosts, ubuntu_line.replace("[127.0.0.1]:2201", "[127.0.0.1]:2202")).unwrap();
        assert!(matches!(
            open(&target(2202, "deploy"), Credential::Key(key.clone()), None).await.unwrap(),
            Opened::HostKey(HostKeyIssue::Changed { .. })
        ));

        // Password auth on Debian: wrong password is rejected, the right one works.
        std::fs::write(&known_hosts, "").unwrap();
        let fp = match open(&target(2202, "deploy"), Credential::Password("nope".into()), None).await.unwrap() {
            Opened::HostKey(HostKeyIssue::Unknown { fingerprint, .. }) => fingerprint,
            _ => panic!("expected an unknown host key"),
        };
        assert!(matches!(open(&target(2202, "deploy"), Credential::Password("nope".into()), Some(fp)).await.unwrap(), Opened::Rejected));
        assert!(matches!(open(&target(2202, "deploy"), Credential::Password("portway".into()), None).await.unwrap(), Opened::Ready(_)));

        // Nothing listening: refused.
        let err = open(&target(2299, "root"), Credential::Key(key), None).await.err().unwrap();
        assert_eq!(err.code, "refused");

        std::fs::remove_file(&known_hosts).ok();
    }

    #[test]
    fn quotes_for_shell() {
        assert_eq!(shell_quote("root@1.2.3.4"), "'root@1.2.3.4'");
        assert_eq!(shell_quote("a'b; rm -rf ~"), "'a'\\''b; rm -rf ~'");
    }

    #[test]
    fn parses_proc_stat_lines() {
        let text = "1 (systemd) S 0 1 1 0 -1 4194560 100 200 0 0 150 50 0 0 20 0 1 0 5 1000 300 18446744073709551615\n\
1234 (node server.js) R 1 1234 1234 0 -1 0 0 0 0 0 900 100 0 0 20 0 11 0 99 5000 5120 0\n\
77 (weird) name)) S 1 77 77 0 -1 0 0 0 0 0 7 3 0 0 20 0 1 0 9 100 10 0\n";
        let m = parse_proc_stats(text);
        assert_eq!(m[&1], (200, 300, "systemd".into()));
        assert_eq!(m[&1234], (1000, 5120, "node server.js".into()));
        assert_eq!(m[&77], (10, 10, "weird) name)".into()));
    }

    #[test]
    fn parses_process_details() {
        let d = parse_proc_details("@@P 12\t0\tnginx: master process\t0::/system.slice/nginx.service \n@@P 99\tprobe\n@@P 7\t\t\t\n");
        assert_eq!(d[&12].0, Some(0));
        assert_eq!(d[&12].1, "nginx: master process");
        assert_eq!(d[&99].0, None, "Portway's own probe");
        assert_eq!(d[&7].0, None, "exited");
    }

    #[test]
    fn finds_container_ids() {
        let id = "a".repeat(64);
        assert_eq!(container_id(&format!("0::/system.slice/docker-{id}.scope")), Some(id.clone()));
        assert_eq!(container_id(&format!("12:cpu:/docker/{id}")), Some(id));
        assert_eq!(container_id("0::/user.slice/user-1000.slice/session-3.scope"), None);
    }

    #[test]
    fn parses_docker_section() {
        assert!(matches!(parse_docker("notinstalled\n"), DockerHealth::NotInstalled));
        assert!(matches!(
            parse_docker("rc=1\npermission denied while trying to connect to the Docker daemon socket\n"),
            DockerHealth::NoAccess { .. }
        ));
        assert!(matches!(parse_docker("rc=1\nCannot connect to the Docker daemon at unix:///var/run/docker.sock\n"), DockerHealth::DaemonDown { .. }));
        let ok = "rc=0\nweb\trunning\tUp 3 hours\nmigrate\texited\tExited (0) 2 hours ago\nworker\texited\tExited (1) 5 minutes ago\numami\trestarting\tRestarting (1) 3 seconds ago\n";
        match parse_docker(ok) {
            DockerHealth::Ok { running, total, failed, finished } => {
                assert_eq!((running, total), (1, 4));
                assert_eq!(failed.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["worker", "umami"]);
                assert_eq!(finished[0].name, "migrate");
            }
            _ => panic!(),
        }
    }

    #[test]
    fn parses_systemd_and_updates() {
        assert!(matches!(parse_systemd("notsystemd\n"), SystemdHealth::NotSystemd));
        match parse_systemd("total=42\nportway-queue.service\n") {
            SystemdHealth::Ok { services, failed } => assert_eq!((services, failed), (42, vec!["portway-queue.service".to_string()])),
            _ => panic!(),
        }
        assert!(matches!(parse_updates("mgr=none\n"), UpdatesHealth::Unsupported));
        assert!(matches!(parse_updates("mgr=apt\nstamp=\n"), UpdatesHealth::NoIndex { .. }));
        let apt = "mgr=apt\nstamp=1790000000.123\nopenssl/noble-updates,noble-security 3.0.13-0ubuntu3.5 amd64 [upgradable from: 3.0.13-0ubuntu3.4]\ncurl/noble-updates 8.5.0-2ubuntu10.6 amd64 [upgradable from: 8.5.0-2ubuntu10.5]\n";
        match parse_updates(apt) {
            UpdatesHealth::Ok { upgrades, index_at, .. } => {
                assert_eq!(index_at, Some(1_790_000_000_000));
                assert_eq!(upgrades.len(), 2);
                assert!(upgrades[0].security && !upgrades[1].security);
                assert_eq!((upgrades[0].name.as_str(), upgrades[0].version.as_str()), ("openssl", "3.0.13-0ubuntu3.5"));
            }
            _ => panic!(),
        }
        match parse_updates("mgr=apk\nstamp=1790000000\nbusybox-1.36.1-r29 < 1.36.1-r31\nlibcrypto3-3.3.2-r0 < 3.3.3-r0\n") {
            UpdatesHealth::Ok { upgrades, .. } => {
                assert_eq!(upgrades.iter().map(|u| u.name.as_str()).collect::<Vec<_>>(), ["busybox", "libcrypto3"]);
            }
            _ => panic!(),
        }
    }

    #[test]
    fn serializes_fields_in_camel_case() {
        let r = ConnectResult::NeedPassphrase { key_path: "~/.ssh/k".into(), retry: true };
        assert_eq!(serde_json::to_value(&r).unwrap(), serde_json::json!({ "status": "needPassphrase", "keyPath": "~/.ssh/k", "retry": true }));
        let u = UpdatesHealth::Ok { manager: "apt".into(), upgrades: vec![], index_at: Some(1) };
        assert_eq!(serde_json::to_value(&u).unwrap()["indexAt"], 1);
    }

    #[test]
    fn os_names() {
        assert_eq!(os_name("NAME=\"Ubuntu\"\nVERSION_ID=\"24.04\"\n").as_deref(), Some("Ubuntu 24.04"));
        assert_eq!(os_name("NAME=\"Debian GNU/Linux\"\nVERSION_ID=\"12\"").as_deref(), Some("Debian 12"));
        assert_eq!(os_name("NAME=\"Alpine Linux\"\nID=alpine\nVERSION_ID=3.20.8").as_deref(), Some("Alpine 3.20.8"));
        assert_eq!(os_name(""), None);
    }

    #[test]
    fn parses_proc_output() {
        let text = "cpu  100 0 50 800 50 0 0 0 0 0\n@@PORTWAY@@\n0.82 0.50 0.40 1/200 999\n@@PORTWAY@@\n4\n@@PORTWAY@@\n\
MemTotal:        8000000 kB\nMemFree:         1000000 kB\nMemAvailable:    3000000 kB\n@@PORTWAY@@\n\
overlay 83000000 60000000 23000000 73% /\n@@PORTWAY@@\n\
Inter-|   Receive |  Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes\n\
    lo: 500 5 0 0 0 0 0 0 500 5 0 0 0 0 0 0\n  eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0\n@@PORTWAY@@\n3542400.12 100.0\n";
        let (s, c) = parse_stats(text);
        assert_eq!((c.cpu_total, c.cpu_idle), (1000, 850));
        assert_eq!(s.load, [0.82, 0.50, 0.40]);
        assert_eq!(s.cores, 4);
        assert_eq!(s.mem_total, 8_000_000 * 1024);
        assert_eq!(s.mem_used, 5_000_000 * 1024);
        assert_eq!((s.disk_total, s.disk_used, s.disk_avail), (83_000_000 * 1024, 60_000_000 * 1024, 23_000_000 * 1024));
        assert_eq!((c.net_rx, c.net_tx), (1000, 2000), "lo is excluded");
        assert_eq!(s.uptime_secs, 3_542_400);
    }
}
