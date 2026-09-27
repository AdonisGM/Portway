//! SSH tunnels: saved profiles and the forwards they run. Each running tunnel
//! has its own SSH connection (independent of the session tabs), opened with
//! the saved credential, and reconnects on its own when asked to.
//!
//! - local:  listen on this Mac, forward each connection to host:port as seen
//!   from the server (`ssh -L`).
//! - socks:  a SOCKS5 proxy on this Mac whose connections leave from the
//!   server (`ssh -D`).
//! - remote: the server listens on a port and forwards to host:port as seen
//!   from this Mac (`ssh -R`).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

use crate::audit::AuditLog;
use crate::error::{AppError, AppResult};
use crate::i18n::tr;
use crate::servers::ServerStore;
use crate::ssh::{open_for_tunnel, ssh_target_args, Client, Conn, Forward, Sessions};
use crate::trace;
pub(crate) use crate::tunnel_stats::Stats;
use crate::tunnel_stats::{pipe, resolve, Link, Monitor, Sample};

/// Seconds between reconnect attempts; the last one repeats.
const RETRY: [u64; 6] = [2, 4, 8, 15, 30, 60];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Local,
    Socks,
    Remote,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Spec {
    pub id: String,
    pub name: String,
    pub kind: Kind,
    pub server_id: String,
    pub user: String,
    /// Port on this Mac (local, socks) or on the server (remote).
    pub port: u16,
    /// Address the local listener binds: 127.0.0.1, or 0.0.0.0 for the LAN.
    #[serde(default = "loopback")]
    pub bind: String,
    /// host:port the traffic goes to: seen from the server (local), or from
    /// this Mac (remote). Empty for socks.
    #[serde(default)]
    pub dest: String,
    /// What "Mở" does: none, url (open in the browser), conn (copy a
    /// connection string). `{port}` in the template is the local port.
    #[serde(default = "none")]
    pub open_kind: String,
    #[serde(default)]
    pub open_template: String,
    #[serde(default)]
    pub auto_start: bool,
    #[serde(default = "yes")]
    pub auto_reconnect: bool,
}

/// User name of the SOCKS login for tunnels open to the LAN.
pub(crate) const SOCKS_USER: &str = "portway";

/// A SOCKS tunnel reachable from other machines needs a login, or anyone on
/// the network gets a proxy into the server's network.
fn needs_login(spec: &Spec) -> bool {
    spec.kind == Kind::Socks && spec.bind != "127.0.0.1"
}

fn socks_account(id: &str) -> String {
    format!("tunnel-socks:{id}")
}

/// The SOCKS password of a tunnel, from the Keychain.
fn socks_password(id: &str) -> Option<String> {
    crate::secrets::get(&socks_account(id))
}

/// Make sure a LAN SOCKS tunnel has a password (random, kept in the
/// Keychain), and that a loopback one has none left over.
fn settle_socks_password(spec: &Spec) -> AppResult<()> {
    let account = socks_account(&spec.id);
    if !needs_login(spec) {
        crate::secrets::delete(&account);
        return Ok(());
    }
    if crate::secrets::get(&account).is_some() {
        return Ok(());
    }
    let password: String = uuid::Uuid::new_v4().simple().to_string().chars().take(24).collect();
    crate::secrets::set(&account, &password)
}

fn loopback() -> String {
    "127.0.0.1".into()
}
fn none() -> String {
    "none".into()
}
fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum RunState {
    Off,
    Connecting,
    Running { since: u64, active: u32, total: u64, rx: u64, tx: u64 },
    Retrying { attempt: u32, error: String, next_at: u64 },
    Error { code: String, detail: Option<String> },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelView {
    #[serde(flatten)]
    pub spec: Spec,
    pub run: RunState,
    /// `ssh …` doing the same, for copying and the action log.
    pub command: String,
    /// Login a LAN SOCKS tunnel asks for (user, password); None otherwise.
    pub socks_login: Option<(String, String)>,
}

struct Run {
    stop: watch::Sender<bool>,
    state: RunState,
    stats: Arc<Stats>,
}

pub struct Tunnels {
    app: AppHandle,
    path: PathBuf,
    specs: Mutex<Vec<Spec>>,
    runs: Mutex<HashMap<String, Run>>,
}

#[derive(Serialize, Deserialize)]
struct StoreFile {
    version: u32,
    tunnels: Vec<Spec>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The same tunnel as an ssh command line.
pub fn command_for(spec: &Spec, target: &str) -> String {
    let fwd = match spec.kind {
        Kind::Local => format!("-L {}:{}:{}", spec.bind, spec.port, spec.dest),
        Kind::Socks => format!("-D {}:{}", spec.bind, spec.port),
        Kind::Remote => format!("-R {}:{}", spec.port, spec.dest),
    };
    let keep = if spec.auto_reconnect { " -o ServerAliveInterval=15 -o ExitOnForwardFailure=yes" } else { "" };
    format!("ssh -N {fwd}{keep} {target}")
}

/// "host:port" with the host possibly a [v6] literal.
fn split_dest(dest: &str) -> Option<(String, u16)> {
    let (host, port) = dest.rsplit_once(':')?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let port: u16 = port.parse().ok()?;
    let host_ok = !host.is_empty() && host.chars().all(|c| c.is_ascii_alphanumeric() || ".-_:".contains(c));
    (host_ok && port > 0).then(|| (host.to_string(), port))
}

fn validate(spec: &Spec) -> AppResult<()> {
    if spec.name.trim().is_empty() {
        return Err(AppError::field("name_required", "name"));
    }
    if spec.port == 0 {
        return Err(AppError::field("invalid_port", "port"));
    }
    if !matches!(spec.bind.as_str(), "127.0.0.1" | "0.0.0.0") {
        return Err(AppError::field("invalid_bind", "bind"));
    }
    if spec.kind != Kind::Socks && split_dest(&spec.dest).is_none() {
        return Err(AppError::field("invalid_dest", "dest"));
    }
    if !matches!(spec.open_kind.as_str(), "none" | "url" | "conn") {
        return Err(AppError::field("invalid_open", "openKind"));
    }
    Ok(())
}

impl Tunnels {
    pub fn load(app: AppHandle, path: PathBuf) -> AppResult<Self> {
        let specs = match fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str::<StoreFile>(&text)?.tunnels,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
        // LAN SOCKS tunnels saved before logins existed get one now.
        for s in specs.iter().filter(|s| needs_login(s)) {
            let _ = settle_socks_password(s);
        }
        Ok(Self { app, path, specs: Mutex::new(specs), runs: Mutex::new(HashMap::new()) })
    }

    fn persist(&self, specs: &[Spec]) -> AppResult<()> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(&StoreFile { version: 1, tunnels: specs.to_vec() })?)?;
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }

    fn command(&self, spec: &Spec) -> String {
        let store = self.app.state::<ServerStore>();
        let target = ssh_target_args(&store, &spec.server_id, &spec.user).unwrap_or_else(|| format!("{}@?", spec.user));
        command_for(spec, &target)
    }

    fn view(&self, spec: &Spec) -> TunnelView {
        let run = self.runs.lock().unwrap().get(&spec.id).map(|r| self.live_state(r)).unwrap_or(RunState::Off);
        let socks_login = needs_login(spec).then(|| socks_password(&spec.id).map(|p| (SOCKS_USER.to_string(), p))).flatten();
        TunnelView { command: self.command(spec), spec: spec.clone(), run, socks_login }
    }

    /// The stored state with the live counters filled in.
    fn live_state(&self, r: &Run) -> RunState {
        match &r.state {
            RunState::Running { since, .. } => RunState::Running {
                since: *since,
                active: r.stats.active.load(Ordering::Relaxed),
                total: r.stats.total.load(Ordering::Relaxed),
                rx: r.stats.rx.load(Ordering::Relaxed),
                tx: r.stats.tx.load(Ordering::Relaxed),
            },
            other => other.clone(),
        }
    }

    fn emit(&self, id: &str) {
        let spec = self.specs.lock().unwrap().iter().find(|s| s.id == id).cloned();
        if let Some(spec) = spec {
            let _ = self.app.emit("tunnel", self.view(&spec));
        }
    }

    fn set_state(&self, id: &str, state: RunState) {
        if let Some(r) = self.runs.lock().unwrap().get_mut(id) {
            r.state = state;
        }
        self.emit(id);
    }

    pub fn monitor(&self, id: &str) -> Option<Monitor> {
        self.runs.lock().unwrap().get(id).map(|r| r.stats.monitor())
    }

    /// The last minute of every running tunnel, for the sparklines.
    pub fn recent_samples(&self) -> HashMap<String, Vec<Sample>> {
        self.runs.lock().unwrap().iter().map(|(id, r)| (id.clone(), r.stats.tail(60))).collect()
    }

    pub fn list(&self) -> Vec<TunnelView> {
        let specs = self.specs.lock().unwrap().clone();
        specs.iter().map(|s| self.view(s)).collect()
    }

    /// Start every tunnel marked "tự bật khi mở Portway".
    pub fn start_auto(self: &Arc<Self>) {
        let ids: Vec<String> = self.specs.lock().unwrap().iter().filter(|s| s.auto_start).map(|s| s.id.clone()).collect();
        for id in ids {
            let _ = self.start(&id);
        }
    }

    pub fn start(self: &Arc<Self>, id: &str) -> AppResult<()> {
        let spec = self.specs.lock().unwrap().iter().find(|s| s.id == id).cloned().ok_or_else(|| AppError::new("not_found"))?;
        {
            let mut runs = self.runs.lock().unwrap();
            if runs.get(id).is_some_and(|r| !matches!(r.state, RunState::Off | RunState::Error { .. })) {
                return Ok(());
            }
            let (stop, _) = watch::channel(false);
            runs.insert(id.to_string(), Run { stop, state: RunState::Connecting, stats: Arc::new(Stats::default()) });
        }
        self.emit(id);
        let me = self.clone();
        tauri::async_runtime::spawn(async move { me.run(spec).await });
        Ok(())
    }

    pub fn stop(&self, id: &str) {
        let run = self.runs.lock().unwrap().remove(id);
        if let Some(r) = run {
            let _ = r.stop.send(true);
        }
        self.emit(id);
    }

    fn stopped(&self, id: &str, rx: &watch::Receiver<bool>) -> bool {
        *rx.borrow() || !self.runs.lock().unwrap().contains_key(id)
    }

    async fn run(self: Arc<Self>, spec: Spec) {
        let id = spec.id.clone();
        let (mut stop, stats) = match self.runs.lock().unwrap().get(&id) {
            Some(r) => (r.stop.subscribe(), r.stats.clone()),
            None => return,
        };
        let audit = self.app.state::<AuditLog>().inner().clone();
        let command = self.command(&spec);

        // A LAN SOCKS tunnel never runs without its login.
        let login = if needs_login(&spec) {
            match socks_password(&spec.id) {
                Some(p) => Some(Arc::new((SOCKS_USER.to_string(), p))),
                None => {
                    self.set_state(&id, RunState::Error { code: "socks_login_missing".into(), detail: None });
                    return;
                }
            }
        } else {
            None
        };

        // Local listeners are bound once and survive reconnects, so a busy
        // port is reported at once and apps pointed at it keep working.
        let listener = match spec.kind {
            Kind::Remote => None,
            _ => match TcpListener::bind((spec.bind.as_str(), spec.port)).await {
                Ok(l) => Some(l),
                Err(e) => {
                    let code = if e.kind() == std::io::ErrorKind::AddrInUse { "port_busy" } else { "bind_failed" };
                    self.set_state(&id, RunState::Error { code: code.into(), detail: Some(format!("{}:{}: {e}", spec.bind, spec.port)) });
                    audit.record(&spec.server_id, &spec.user, "tunnelStart", &command, false, Some(e.to_string()));
                    return;
                }
            },
        };
        let handle_slot: Arc<Mutex<Option<Arc<Conn>>>> = Arc::new(Mutex::new(None));
        let accept = listener.map(|l| {
            let slot = handle_slot.clone();
            let stats = stats.clone();
            let spec = spec.clone();
            tauri::async_runtime::spawn(accept_loop(l, spec, slot, stats, login.clone()))
        });
        let sampler = tauri::async_runtime::spawn(sample_loop(self.app.clone(), id.clone(), stats.clone(), handle_slot.clone()));

        let mut attempt = 0u32;
        let mut logged = false;
        loop {
            if self.stopped(&id, &stop) {
                break;
            }
            self.set_state(&id, if attempt == 0 { RunState::Connecting } else { RunState::Connecting });
            let forward: Option<Forward> = (spec.kind == Kind::Remote).then(|| remote_forward(spec.dest.clone(), stats.clone()));
            let span = trace::start(&spec.server_id, &spec.user, trace::Kind::Connect, Some(format!("Tunnel · {}", spec.name)), &command, false);
            let opened = {
                let store = self.app.state::<ServerStore>();
                let sessions = self.app.state::<Sessions>();
                open_for_tunnel(&store, &sessions, &spec.server_id, &spec.user, forward).await
            };
            let handle = match opened {
                Ok(h) => Arc::new(h),
                Err(e) => {
                    let text = e.detail.clone().unwrap_or_else(|| e.code.to_string());
                    span.fail(&text, |_| {});
                    // Asking the user something (password, host key) cannot be retried away.
                    let fatal = matches!(e.code, "needs_secret" | "host_key_unknown" | "auth_failed" | "key_missing" | "key_unreadable" | "not_found" | "no_account");
                    if fatal || !spec.auto_reconnect {
                        if !logged {
                            audit.record(&spec.server_id, &spec.user, "tunnelStart", &command, false, Some(text));
                        }
                        self.set_state(&id, RunState::Error { code: e.code.to_string(), detail: e.detail.clone() });
                        break;
                    }
                    let wait = RETRY[(attempt as usize).min(RETRY.len() - 1)];
                    attempt += 1;
                    self.set_state(&id, RunState::Retrying { attempt, error: text, next_at: now_ms() + wait * 1000 });
                    if sleep_or_stop(&mut stop, wait).await {
                        break;
                    }
                    continue;
                }
            };
            span.ok(|_| {});
            if spec.kind == Kind::Remote {
                if let Err(e) = handle.tcpip_forward("localhost", spec.port as u32).await {
                    let text = tr(format!("Server không cho mở cổng {} (đang bận, dưới 1024, hoặc sshd tắt AllowTcpForwarding): {e}", spec.port), format!("The server wouldn't open port {} (in use, below 1024, or sshd has AllowTcpForwarding off): {e}", spec.port));
                    audit.record(&spec.server_id, &spec.user, "tunnelStart", &command, false, Some(text.clone()));
                    self.set_state(&id, RunState::Error { code: "remote_forward_refused".into(), detail: Some(text) });
                    let _ = handle.disconnect(russh::Disconnect::ByApplication, "", "en").await;
                    break;
                }
            }
            if !logged {
                audit.record(&spec.server_id, &spec.user, "tunnelStart", &command, true, None);
                logged = true;
            }
            *handle_slot.lock().unwrap() = Some(handle.clone());
            attempt = 0;
            // Totals keep counting across reconnects; "since" is this connection.
            self.set_state(&id, RunState::Running { since: now_ms(), active: 0, total: 0, rx: 0, tx: 0 });

            // Push the counters while running; notice the connection dropping.
            let mut last = (0u64, 0u64, 0u32, 0u64);
            let dropped = loop {
                tokio::select! {
                    _ = stop.changed() => break false,
                    _ = tokio::time::sleep(Duration::from_secs(1)) => {}
                }
                if self.stopped(&id, &stop) {
                    break false;
                }
                if handle.is_closed() {
                    break true;
                }
                let now = (
                    stats.rx.load(Ordering::Relaxed),
                    stats.tx.load(Ordering::Relaxed),
                    stats.active.load(Ordering::Relaxed),
                    stats.total.load(Ordering::Relaxed),
                );
                if now != last {
                    last = now;
                    self.emit(&id);
                }
            };
            *handle_slot.lock().unwrap() = None;
            if !dropped {
                let _ = handle.disconnect(russh::Disconnect::ByApplication, "", "en").await;
                break;
            }
            if !spec.auto_reconnect {
                self.set_state(&id, RunState::Error { code: "connection_lost".into(), detail: None });
                break;
            }
            stats.reconnects.fetch_add(1, Ordering::Relaxed);
            attempt += 1;
            self.set_state(&id, RunState::Retrying { attempt, error: tr("Mất kết nối tới server", "Lost connection to the server"), next_at: now_ms() + RETRY[0] * 1000 });
            if sleep_or_stop(&mut stop, RETRY[0]).await {
                break;
            }
        }
        if let Some(a) = accept {
            a.abort();
        }
        sampler.abort();
        if self.stopped(&id, &stop) {
            audit.record(&spec.server_id, &spec.user, "tunnelStop", &command, true, None);
        }
    }

    pub fn save(self: &Arc<Self>, mut spec: Spec) -> AppResult<TunnelView> {
        validate(&spec)?;
        spec.name = spec.name.trim().to_string();
        let restart;
        {
            let mut specs = self.specs.lock().unwrap();
            if let Some(other) = specs.iter().find(|s| s.id != spec.id && s.kind != Kind::Remote && spec.kind != Kind::Remote && s.port == spec.port) {
                return Err(AppError::detail("port_taken", &other.name));
            }
            match specs.iter_mut().find(|s| s.id == spec.id) {
                Some(s) => {
                    restart = *s != spec;
                    *s = spec.clone();
                }
                None => {
                    if spec.id.is_empty() {
                        spec.id = uuid::Uuid::new_v4().to_string();
                    }
                    specs.push(spec.clone());
                    restart = false;
                }
            }
            self.persist(&specs)?;
        }
        settle_socks_password(&spec)?;
        // A running tunnel picks up its new settings.
        let running = self.runs.lock().unwrap().contains_key(&spec.id);
        if restart && running {
            self.stop(&spec.id);
            let _ = self.start(&spec.id);
        }
        Ok(self.view(&spec))
    }

    pub fn delete(&self, id: &str) -> AppResult<()> {
        self.stop(id);
        crate::secrets::delete(&socks_account(id));
        let mut specs = self.specs.lock().unwrap();
        specs.retain(|s| s.id != id);
        self.persist(&specs)
    }
}

/// Wait `secs`, or less if asked to stop; true when stopping.
async fn sleep_or_stop(stop: &mut watch::Receiver<bool>, secs: u64) -> bool {
    tokio::select! {
        _ = stop.changed() => true,
        _ = tokio::time::sleep(Duration::from_secs(secs)) => *stop.borrow(),
    }
}

#[derive(Clone, Serialize)]
struct SampleEvent<'a> {
    id: &'a str,
    sample: Sample,
}

/// Seconds to wait for an SSH ping; a slower answer is recorded as this long.
const PING_WAIT: u64 = 10;

/// Every second while the tunnel runs: a traffic sample (pushed to the UI as
/// `tunnel-sample`), and every 5 seconds an SSH ping for the round trip.
/// New connections get their process looked up as they come in.
async fn sample_loop(app: AppHandle, id: String, stats: Arc<Stats>, slot: Arc<Mutex<Option<Arc<Conn>>>>) {
    let resolver = {
        let stats = stats.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                stats.new_link.notified().await;
                // Gather a burst (a browser opens several at once) into one lsof.
                tokio::time::sleep(Duration::from_millis(30)).await;
                let todo = stats.take_unresolved();
                if !todo.is_empty() {
                    let _ = tauri::async_runtime::spawn_blocking(move || resolve(&todo)).await;
                }
            }
        })
    };
    let _guard = AbortOnDrop(resolver);
    for n in 0u64.. {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let sample = stats.tick();
        let _ = app.emit("tunnel-sample", SampleEvent { id: &id, sample });
        if n % 5 == 0 {
            let handle = slot.lock().unwrap().clone();
            match handle {
                Some(h) => {
                    let stats = stats.clone();
                    tauri::async_runtime::spawn(async move {
                        let started = Instant::now();
                        // No answer in time still says something: the server is that slow.
                        let answered = !matches!(tokio::time::timeout(Duration::from_secs(PING_WAIT), h.send_ping()).await, Ok(Err(_)));
                        stats.set_rtt(answered.then(|| started.elapsed().as_micros().min(u32::MAX as u128) as u32));
                    });
                }
                None => stats.set_rtt(None),
            }
        }
    }
}

/// Stops a helper task when the loop that owns it is aborted.
struct AbortOnDrop(tauri::async_runtime::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn accept_loop(listener: TcpListener, spec: Spec, slot: Arc<Mutex<Option<Arc<Conn>>>>, stats: Arc<Stats>, login: Option<Arc<(String, String)>>) {
    loop {
        let (sock, peer) = match listener.accept().await {
            Ok(x) => x,
            Err(_) => {
                // e.g. out of file descriptors: back off instead of spinning.
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
        };
        let target = if spec.kind == Kind::Local { spec.dest.clone() } else { String::new() };
        let link = stats.open_link(Some(peer), sock.local_addr().ok(), target);
        // Between reconnects there is no connection: refuse by closing.
        let Some(handle) = slot.lock().unwrap().clone() else {
            stats.close_link(&link, Some(tr("Từ chối: tunnel đang kết nối lại tới server", "Refused: the tunnel is reconnecting to the server")));
            continue;
        };
        let stats = stats.clone();
        let spec = spec.clone();
        let login = login.clone();
        tauri::async_runtime::spawn(async move {
            let error = match spec.kind {
                Kind::Local => serve_local(sock, peer, &spec.dest, &handle, &stats, &link).await,
                Kind::Socks => serve_socks(sock, peer, &handle, &stats, &link, login.as_deref()).await,
                Kind::Remote => None,
            };
            stats.close_link(&link, error);
        });
    }
}

/// The server could not open the connection onward.
fn unreachable(target: &str, e: impl std::fmt::Display) -> String {
    tr(format!("Server không kết nối được tới {target}: {e}"), format!("The server couldn't connect to {target}: {e}"))
}

/// Serve one connection of a local tunnel; the error says why it never
/// carried anything (a connection that breaks mid-way is not an error here).
pub(crate) async fn serve_local(sock: TcpStream, peer: SocketAddr, dest: &str, handle: &russh::client::Handle<Client>, stats: &Arc<Stats>, link: &Arc<Link>) -> Option<String> {
    let Some((host, port)) = split_dest(dest) else { return Some(unreachable(dest, "bad destination")) };
    let started = Instant::now();
    match handle.channel_open_direct_tcpip(host, port as u32, peer.ip().to_string(), peer.port() as u32).await {
        Ok(channel) => {
            link.set_open_ms(started.elapsed().as_millis() as u32);
            let _ = pipe(sock, channel.into_stream(), stats, link).await;
            None
        }
        Err(e) => Some(unreachable(dest, e)),
    }
}

/// Equal-length-independent comparison, so a wrong password takes as long as a right one.
fn same(a: &[u8], b: &[u8]) -> bool {
    let mut diff = a.len() ^ b.len();
    for (i, x) in a.iter().enumerate() {
        diff |= (*x ^ b.get(i).copied().unwrap_or(0)) as usize;
    }
    diff == 0
}

/// Minimal SOCKS5, CONNECT only. With a login (LAN tunnels) only the
/// user/password method (RFC 1929) is accepted; otherwise no authentication.
pub(crate) async fn serve_socks(
    sock: TcpStream,
    peer: SocketAddr,
    handle: &russh::client::Handle<Client>,
    stats: &Arc<Stats>,
    link: &Arc<Link>,
    login: Option<&(String, String)>,
) -> Option<String> {
    let handshake = tr("Client ngắt kết nối giữa lúc bắt tay SOCKS", "The client hung up during the SOCKS handshake");
    match socks_handshake(sock, peer, handle, stats, link, login).await {
        Ok(error) => error,
        Err(_) => Some(handshake),
    }
}

async fn socks_handshake(
    mut sock: TcpStream,
    peer: SocketAddr,
    handle: &russh::client::Handle<Client>,
    stats: &Arc<Stats>,
    link: &Arc<Link>,
    login: Option<&(String, String)>,
) -> std::io::Result<Option<String>> {
    let mut head = [0u8; 2];
    sock.read_exact(&mut head).await?;
    if head[0] != 5 {
        return Ok(Some(tr("Không phải yêu cầu SOCKS5", "Not a SOCKS5 request")));
    }
    let mut methods = vec![0u8; head[1] as usize];
    sock.read_exact(&mut methods).await?;
    let method = if login.is_some() { 2 } else { 0 };
    if !methods.contains(&method) {
        sock.write_all(&[5, 0xff]).await?;
        return Ok(Some(if login.is_some() {
            tr("Client không gửi user và mật khẩu SOCKS", "The client sent no SOCKS user and password")
        } else {
            tr("Client đòi đăng nhập SOCKS, tunnel này không dùng", "The client wants a SOCKS login, which this tunnel doesn't use")
        }));
    }
    sock.write_all(&[5, method]).await?;
    if let Some((user, password)) = login {
        let mut ver = [0u8; 2];
        sock.read_exact(&mut ver).await?;
        let mut u = vec![0u8; ver[1] as usize];
        sock.read_exact(&mut u).await?;
        let mut plen = [0u8; 1];
        sock.read_exact(&mut plen).await?;
        let mut p = vec![0u8; plen[0] as usize];
        sock.read_exact(&mut p).await?;
        let ok = ver[0] == 1 && same(&u, user.as_bytes()) & same(&p, password.as_bytes());
        sock.write_all(&[1, if ok { 0 } else { 1 }]).await?;
        if !ok {
            return Ok(Some(tr("Sai user hoặc mật khẩu SOCKS", "Wrong SOCKS user or password")));
        }
    }
    let mut req = [0u8; 4];
    sock.read_exact(&mut req).await?;
    let host = match req[3] {
        1 => {
            let mut a = [0u8; 4];
            sock.read_exact(&mut a).await?;
            IpAddr::from(a).to_string()
        }
        3 => {
            let mut len = [0u8; 1];
            sock.read_exact(&mut len).await?;
            let mut name = vec![0u8; len[0] as usize];
            sock.read_exact(&mut name).await?;
            String::from_utf8_lossy(&name).into_owned()
        }
        4 => {
            let mut a = [0u8; 16];
            sock.read_exact(&mut a).await?;
            IpAddr::from(a).to_string()
        }
        _ => {
            sock.write_all(&[5, 8, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
            return Ok(Some(tr("Kiểu địa chỉ SOCKS không hỗ trợ", "Unsupported SOCKS address type")));
        }
    };
    let mut port = [0u8; 2];
    sock.read_exact(&mut port).await?;
    let port = u16::from_be_bytes(port);
    let target = if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") };
    link.set_target(target.clone());
    if req[1] != 1 {
        // Only CONNECT; BIND and UDP ASSOCIATE are not supported.
        sock.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
        return Ok(Some(tr("Chỉ hỗ trợ SOCKS CONNECT (không có UDP, BIND)", "Only SOCKS CONNECT is supported (no UDP, BIND)")));
    }
    let started = Instant::now();
    match handle.channel_open_direct_tcpip(host, port as u32, peer.ip().to_string(), peer.port() as u32).await {
        Ok(channel) => {
            link.set_open_ms(started.elapsed().as_millis() as u32);
            sock.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
            let _ = pipe(sock, channel.into_stream(), stats, link).await;
            Ok(None)
        }
        Err(e) => {
            // General failure: the server could not reach the target.
            sock.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
            Ok(Some(unreachable(&target, e)))
        }
    }
}

/// Connections the server forwards to us go to `dest` on this Mac.
pub(crate) fn remote_forward(dest: String, stats: Arc<Stats>) -> Forward {
    Arc::new(move |channel, _port| {
        let dest = dest.clone();
        let stats = stats.clone();
        tauri::async_runtime::spawn(async move {
            let link = stats.open_link(None, None, dest.clone());
            let error = match split_dest(&dest) {
                Some((host, port)) => {
                    let started = Instant::now();
                    match TcpStream::connect((host.as_str(), port)).await {
                        Ok(sock) => {
                            link.set_open_ms(started.elapsed().as_millis() as u32);
                            let _ = pipe(sock, channel.into_stream(), &stats, &link).await;
                            None
                        }
                        Err(e) => Some(tr(format!("Không kết nối được tới {dest} trên máy bạn: {e}"), format!("Couldn't connect to {dest} on this Mac: {e}"))),
                    }
                }
                None => None,
            };
            stats.close_link(&link, error);
        });
    })
}

// ------------------------------------------------------------------ commands

#[tauri::command]
pub fn tunnel_monitor(tunnels: tauri::State<'_, Arc<Tunnels>>, id: String) -> Option<Monitor> {
    tunnels.monitor(&id)
}

#[tauri::command]
pub fn tunnel_samples(tunnels: tauri::State<'_, Arc<Tunnels>>) -> HashMap<String, Vec<Sample>> {
    tunnels.recent_samples()
}

#[tauri::command]
pub fn tunnels_list(tunnels: tauri::State<'_, Arc<Tunnels>>) -> Vec<TunnelView> {
    tunnels.list()
}

#[tauri::command]
pub fn tunnel_save(tunnels: tauri::State<'_, Arc<Tunnels>>, spec: Spec) -> AppResult<TunnelView> {
    tunnels.save(spec)
}

#[tauri::command]
pub fn tunnel_delete(tunnels: tauri::State<'_, Arc<Tunnels>>, id: String) -> AppResult<()> {
    tunnels.delete(&id)
}

#[tauri::command]
pub fn tunnel_start(tunnels: tauri::State<'_, Arc<Tunnels>>, id: String) -> AppResult<()> {
    tunnels.start(&id)
}

#[tauri::command]
pub fn tunnel_stop(tunnels: tauri::State<'_, Arc<Tunnels>>, id: String) {
    tunnels.stop(&id)
}

/// A free local port from `start` up, skipping ports other tunnels use.
#[tauri::command]
pub fn tunnel_free_port(tunnels: tauri::State<'_, Arc<Tunnels>>, start: u16, except: Option<String>) -> AppResult<u16> {
    let taken: Vec<u16> = tunnels
        .specs
        .lock()
        .unwrap()
        .iter()
        .filter(|s| Some(&s.id) != except.as_ref() && s.kind != Kind::Remote)
        .map(|s| s.port)
        .collect();
    (start.max(1024)..=65535)
        .find(|p| !taken.contains(p) && std::net::TcpListener::bind(("127.0.0.1", *p)).is_ok())
        .ok_or_else(|| AppError::new("no_free_port"))
}

/// Whether a local port can be listened on right now.
#[tauri::command]
pub fn tunnel_port_free(tunnels: tauri::State<'_, Arc<Tunnels>>, port: u16, bind: String, except: Option<String>) -> bool {
    let running_here = tunnels
        .specs
        .lock()
        .unwrap()
        .iter()
        .any(|s| Some(&s.id) == except.as_ref() && s.port == port && tunnels.runs.lock().unwrap().contains_key(&s.id));
    running_here || std::net::TcpListener::bind((bind.as_str(), port)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(kind: Kind, dest: &str) -> Spec {
        Spec {
            id: "t".into(),
            name: "db".into(),
            kind,
            server_id: "s".into(),
            user: "root".into(),
            port: 15432,
            bind: "127.0.0.1".into(),
            dest: dest.into(),
            open_kind: "none".into(),
            open_template: String::new(),
            auto_start: false,
            auto_reconnect: true,
        }
    }

    #[test]
    fn builds_equivalent_commands() {
        assert_eq!(
            command_for(&spec(Kind::Local, "127.0.0.1:5432"), "-p 2201 root@h"),
            "ssh -N -L 127.0.0.1:15432:127.0.0.1:5432 -o ServerAliveInterval=15 -o ExitOnForwardFailure=yes -p 2201 root@h"
        );
        let mut s = spec(Kind::Socks, "");
        s.auto_reconnect = false;
        assert_eq!(command_for(&s, "root@h"), "ssh -N -D 127.0.0.1:15432 root@h");
        let mut r = spec(Kind::Remote, "localhost:3000");
        r.auto_reconnect = false;
        assert_eq!(command_for(&r, "root@h"), "ssh -N -R 15432:localhost:3000 root@h");
    }

    #[test]
    fn checks_specs() {
        assert!(validate(&spec(Kind::Local, "db-internal:5432")).is_ok());
        assert!(validate(&spec(Kind::Local, "[::1]:5432")).is_ok());
        assert_eq!(validate(&spec(Kind::Local, "5432")).unwrap_err().code, "invalid_dest");
        assert_eq!(validate(&spec(Kind::Local, "a b:1")).unwrap_err().code, "invalid_dest");
        assert!(validate(&spec(Kind::Socks, "")).is_ok());
        let mut s = spec(Kind::Local, "x:1");
        s.bind = "192.168.1.5".into();
        assert_eq!(validate(&s).unwrap_err().code, "invalid_bind");
    }

    #[test]
    fn lan_socks_needs_a_login() {
        let mut s = spec(Kind::Socks, "");
        assert!(!needs_login(&s));
        s.bind = "0.0.0.0".into();
        assert!(needs_login(&s));
        s.kind = Kind::Local;
        assert!(!needs_login(&s));
        assert!(same(b"abc", b"abc") && !same(b"abc", b"abd") && !same(b"abc", b"ab") && !same(b"", b"a"));
    }
}
