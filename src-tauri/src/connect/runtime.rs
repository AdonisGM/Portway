//! Connect while it runs: listening for other Portways, announcing and finding
//! them over mDNS, pairing, one live link to a paired machine, and measuring
//! the ways to reach each of them. Everything the UI shows is one `View`,
//! sent as a `connect` event after every change.

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Notify};

use super::net::{self, Fail, DEFAULT_PORT, SERVICE};
use super::store::{Peer, Store};
use super::wire::{self, hex, Intent, Msg, Receiver, Sender, VERSION};
use crate::audit::AuditLog;
use crate::error::{AppError, AppResult};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const PAIRING_TIMEOUT: Duration = Duration::from_secs(120);
const PROBE_EVERY: Duration = Duration::from_secs(5);
const PING_EVERY: Duration = Duration::from_secs(2);
/// A machine that announced itself this long ago and has not since counts as gone.
const NEARBY_TTL: Duration = Duration::from_secs(120);
/// Incoming pairing requests closer together than this are refused, so one
/// machine on the network cannot keep popping the dialog up.
const PAIR_COOLDOWN: Duration = Duration::from_secs(5);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// ---------------------------------------------------------------------------
// What the UI sees

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    pub id: String,
    pub name: String,
    pub os: String,
    pub version: String,
    /// The port Connect listens on, while it is on.
    pub port: Option<u16>,
    /// Start of this machine's public key, to read out when pairing is in doubt.
    pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathView {
    pub addr: String,
    /// The card this machine reaches it through, when one matches.
    pub card: Option<String>,
    pub network: Option<String>,
    pub rtt_ms: Option<f64>,
    pub fail: Option<Fail>,
    pub manual: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearbyView {
    pub id: String,
    pub addrs: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerView {
    pub id: String,
    pub name: String,
    pub os: String,
    pub paired_at: u64,
    /// Seen on the network just now (mDNS or a path that answers).
    pub online: bool,
    pub paths: Vec<PathView>,
    pub manual_addrs: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingView {
    /// "initiator" asked; "responder" was asked.
    pub role: &'static str,
    /// "connecting" until both sides have said hello, then "compare", then "done".
    pub stage: &'static str,
    pub peer_id: String,
    pub peer_name: String,
    pub peer_os: String,
    pub code: String,
    pub local_ok: Option<bool>,
    pub remote_ok: Option<bool>,
    /// Set when stage is "done": "paired", "declined", "timeout", or an error code.
    pub outcome: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkView {
    pub peer_id: String,
    pub addr: String,
    /// "connecting" or "up".
    pub stage: &'static str,
    pub since: u64,
    pub rtt_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkErrorView {
    pub peer_id: String,
    pub code: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub enabled: bool,
    pub device: Option<DeviceView>,
    /// Why Connect is on but not listening (`listen_failed`).
    pub error: Option<String>,
    /// This machine's own announcement came back over mDNS: multicast works here.
    pub self_seen: bool,
    /// Machines announcing themselves that are not paired yet.
    pub nearby: Vec<NearbyView>,
    pub peers: Vec<PeerView>,
    pub pairing: Option<PairingView>,
    pub link: Option<LinkView>,
    pub link_error: Option<LinkErrorView>,
}

// ---------------------------------------------------------------------------
// State

#[derive(Clone, Copy, PartialEq)]
enum Role {
    Initiator,
    Responder,
}

struct Nearby {
    addrs: BTreeSet<Ipv4Addr>,
    port: u16,
    seen: Instant,
}

#[derive(Clone)]
struct PathInfo {
    addr: SocketAddrV4,
    manual: bool,
    result: Result<Duration, Fail>,
}

struct Pairing {
    role: Role,
    stage: &'static str,
    peer_id: String,
    peer_name: String,
    peer_os: String,
    code: String,
    local_ok: Option<bool>,
    remote_ok: Option<bool>,
    outcome: Option<String>,
    /// The user's answer to the code, once given.
    decide: Option<mpsc::UnboundedSender<bool>>,
}

struct Link {
    token: u64,
    peer_id: String,
    addr: String,
    up: bool,
    since: u64,
    rtt: Option<Duration>,
    cancel: Arc<Notify>,
}

struct Running {
    port: u16,
    daemon: ServiceDaemon,
    tasks: Vec<tauri::async_runtime::JoinHandle<()>>,
    self_seen: bool,
}

struct State {
    store: Store,
    /// This machine's name and cards, read when Connect starts and refreshed
    /// with each probe round, not on every change (reading the name runs a command).
    name: String,
    cards: Vec<net::Card>,
    run: Option<Running>,
    error: Option<String>,
    nearby: HashMap<String, Nearby>,
    paths: HashMap<String, Vec<PathInfo>>,
    pairing: Option<Pairing>,
    link: Option<Link>,
    link_error: Option<(String, String)>,
    last_pair_request: Option<Instant>,
    next_token: u64,
}

/// This machine as other machines are told about it.
#[derive(Clone)]
struct Me {
    id: String,
    name: String,
    key: Vec<u8>,
}

#[derive(Clone)]
pub struct Connect {
    inner: Arc<Inner>,
}

struct Inner {
    app: AppHandle,
    state: Mutex<State>,
}

type Stream = TcpStream;

impl Connect {
    pub fn load(app: AppHandle, path: std::path::PathBuf) -> Self {
        let store = Store::load(path);
        let state = State {
            store,
            name: String::new(),
            cards: Vec::new(),
            run: None,
            error: None,
            nearby: HashMap::new(),
            paths: HashMap::new(),
            pairing: None,
            link: None,
            link_error: None,
            last_pair_request: None,
            next_token: 1,
        };
        Self { inner: Arc::new(Inner { app, state: Mutex::new(state) }) }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.inner.state.lock().unwrap()
    }

    /// Turn Connect back on at launch when it was on last time.
    pub async fn resume(&self) {
        if self.lock().store.data.enabled {
            if let Err(e) = self.start().await {
                self.lock().error = Some(e.code.to_string());
                self.publish();
            }
        }
    }

    pub fn view(&self) -> View {
        build_view(&self.lock())
    }

    fn publish(&self) {
        let view = self.view();
        let _ = self.inner.app.emit("connect", view);
    }

    fn audit(&self, action: &str, who: &str, ok: bool, detail: Option<String>) {
        if let Some(log) = self.inner.app.try_state::<AuditLog>() {
            log.record("connect", who, action, action, ok, detail);
        }
    }

    fn me(&self) -> Option<Me> {
        let s = self.lock();
        Some(Me { id: s.store.data.id.clone(), name: s.name.clone(), key: s.store.private_key.clone()? })
    }

    // -- turning on and off --------------------------------------------------

    pub async fn set_enabled(&self, on: bool) -> AppResult<()> {
        if on {
            self.lock().store.data.enabled = true;
            self.lock().store.save()?;
            self.start().await?;
        } else {
            self.stop();
            let mut s = self.lock();
            s.store.data.enabled = false;
            s.store.save()?;
            drop(s);
            self.publish();
        }
        Ok(())
    }

    async fn start(&self) -> AppResult<()> {
        if self.lock().run.is_some() {
            return Ok(());
        }
        let (name, cards) = (net::device_name(), net::cards());
        {
            let mut s = self.lock();
            s.error = None;
            s.name = name;
            s.cards = cards;
            s.store.ensure_identity()?;
        }
        let listener = match TcpListener::bind(("0.0.0.0", DEFAULT_PORT)).await {
            Ok(l) => l,
            Err(_) => TcpListener::bind(("0.0.0.0", 0)).await.map_err(|e| AppError::detail("listen_failed", e))?,
        };
        let port = listener.local_addr().map_err(|e| AppError::detail("listen_failed", e))?.port();
        let me = self.me().ok_or_else(|| AppError::new("keychain"))?;

        let daemon = ServiceDaemon::new().map_err(|e| AppError::detail("mdns_failed", e))?;
        let host = format!("portway-{}.local.", me.id);
        let props = [("id", me.id.as_str()), ("v", "1")];
        let info = ServiceInfo::new(SERVICE, &me.id, &host, "", port, &props[..]).map_err(|e| AppError::detail("mdns_failed", e))?.enable_addr_auto();
        daemon.register(info).map_err(|e| AppError::detail("mdns_failed", e))?;
        let events = daemon.browse(SERVICE).map_err(|e| AppError::detail("mdns_failed", e))?;

        // mdns-sd hands over events on a blocking channel.
        let (tx, mut rx) = mpsc::unbounded_channel::<ServiceEvent>();
        std::thread::spawn(move || {
            while let Ok(ev) = events.recv() {
                if tx.send(ev).is_err() {
                    break;
                }
            }
        });

        let mut tasks = Vec::new();
        let this = self.clone();
        tasks.push(tauri::async_runtime::spawn(async move {
            loop {
                let Ok((stream, _from)) = listener.accept().await else {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    continue;
                };
                let _ = stream.set_nodelay(true);
                let this = this.clone();
                tauri::async_runtime::spawn(async move { this.handle_incoming(stream).await });
            }
        }));
        let this = self.clone();
        let my_id = me.id.clone();
        tasks.push(tauri::async_runtime::spawn(async move {
            while let Some(ev) = rx.recv().await {
                this.on_mdns(&my_id, ev);
            }
        }));
        let this = self.clone();
        tasks.push(tauri::async_runtime::spawn(async move { this.probe_loop().await }));

        self.lock().run = Some(Running { port, daemon, tasks, self_seen: false });
        self.publish();
        Ok(())
    }

    fn stop(&self) {
        let (run, link, pairing) = {
            let mut s = self.lock();
            s.nearby.clear();
            s.paths.clear();
            s.link_error = None;
            (s.run.take(), s.link.take(), s.pairing.take())
        };
        if let Some(l) = link {
            l.cancel.notify_one();
        }
        drop(pairing);
        if let Some(r) = run {
            for t in r.tasks {
                t.abort();
            }
            let _ = r.daemon.shutdown();
        }
    }

    // -- mDNS ----------------------------------------------------------------

    fn on_mdns(&self, my_id: &str, ev: ServiceEvent) {
        let suffix = format!(".{SERVICE}");
        match ev {
            ServiceEvent::ServiceResolved(info) => {
                let Some(id) = info.get_fullname().strip_suffix(&suffix).map(str::to_string) else { return };
                let addrs: BTreeSet<Ipv4Addr> = info.get_addresses().iter().filter_map(|a| a.to_string().parse::<Ipv4Addr>().ok()).filter(|a| !a.is_loopback()).collect();
                let mut s = self.lock();
                if id == my_id {
                    if let Some(r) = s.run.as_mut() {
                        r.self_seen = true;
                    }
                } else {
                    let e = s.nearby.entry(id).or_insert_with(|| Nearby { addrs: BTreeSet::new(), port: info.get_port(), seen: Instant::now() });
                    e.addrs.extend(addrs);
                    e.port = info.get_port();
                    e.seen = Instant::now();
                }
            }
            ServiceEvent::ServiceRemoved(_, fullname) => {
                if let Some(id) = fullname.strip_suffix(&suffix) {
                    self.lock().nearby.remove(id);
                }
            }
            _ => return,
        }
        self.publish();
    }

    // -- measuring the ways to reach paired machines ---------------------------

    async fn probe_loop(&self) {
        loop {
            let jobs: Vec<(String, SocketAddrV4, bool)> = {
                let mut s = self.lock();
                s.nearby.retain(|_, n| n.seen.elapsed() < NEARBY_TTL);
                let mut jobs = Vec::new();
                for p in &s.store.data.peers {
                    let mut seen = BTreeSet::new();
                    if let Some(n) = s.nearby.get(&p.id) {
                        for ip in &n.addrs {
                            let a = SocketAddrV4::new(*ip, n.port);
                            if seen.insert(a) {
                                jobs.push((p.id.clone(), a, false));
                            }
                        }
                    }
                    for m in &p.manual_addrs {
                        if let Some(a) = net::parse_addr(m, DEFAULT_PORT) {
                            if seen.insert(a) {
                                jobs.push((p.id.clone(), a, true));
                            }
                        }
                    }
                }
                jobs
            };
            let mut set = tokio::task::JoinSet::new();
            for (id, addr, manual) in jobs {
                set.spawn(async move { (id, PathInfo { addr, manual, result: net::tcp_rtt(SocketAddr::V4(addr), Duration::from_secs(2)).await }) });
            }
            let mut paths: HashMap<String, Vec<PathInfo>> = HashMap::new();
            while let Some(Ok((id, info))) = set.join_next().await {
                paths.entry(id).or_default().push(info);
            }
            let cards = net::cards();
            {
                let mut s = self.lock();
                s.paths = paths;
                s.cards = cards;
            }
            self.publish();
            tokio::time::sleep(PROBE_EVERY).await;
        }
    }

    // -- an incoming connection ------------------------------------------------

    async fn handle_incoming(&self, stream: Stream) {
        let Some(me) = self.me() else { return };
        // A TCP connection that never speaks (a path probe) ends here, quietly.
        let Ok(Ok(est)) = tokio::time::timeout(HANDSHAKE_TIMEOUT, wire::respond(stream, &me.key)).await else { return };
        let remote_key = est.remote_static.clone();
        let hash = est.hash.clone();
        let (mut tx, mut rx) = est.channel.split();
        let Ok(Ok(Msg::Hello { id, name, os, version, intent })) = tokio::time::timeout(HANDSHAKE_TIMEOUT, rx.recv()).await else { return };
        if version != VERSION {
            let _ = tx.send(&Msg::Refuse { code: "version".into() }).await;
            return;
        }
        let hello = Msg::Hello { id: me.id.clone(), name: me.name.clone(), os: std::env::consts::OS.into(), version: VERSION, intent };
        match intent {
            Intent::Link => {
                let known = self.lock().store.peer(&id).is_some_and(|p| p.public_key == hex(&remote_key));
                if !known {
                    let _ = tx.send(&Msg::Refuse { code: "not_paired".into() }).await;
                    return;
                }
                // The lock is released before anything is awaited.
                let taken = {
                    let mut s = self.lock();
                    if s.link.is_some() {
                        None
                    } else {
                        let (token, cancel) = (s.next_token, Arc::new(Notify::new()));
                        s.next_token += 1;
                        s.link = Some(Link { token, peer_id: id.clone(), addr: String::new(), up: true, since: now_ms(), rtt: None, cancel: cancel.clone() });
                        Some((token, cancel))
                    }
                };
                let Some((token, cancel)) = taken else {
                    let _ = tx.send(&Msg::Refuse { code: "busy".into() }).await;
                    return;
                };
                if tx.send(&hello).await.is_err() {
                    self.end_link(token);
                    return;
                }
                self.publish();
                self.audit("link", &name, true, Some("incoming".into()));
                self.run_session(token, tx, rx, cancel).await;
            }
            Intent::Pair => {
                let (decide_tx, decide_rx) = mpsc::unbounded_channel();
                let busy = {
                    let mut s = self.lock();
                    let busy = s.pairing.as_ref().is_some_and(|p| p.outcome.is_none()) || s.last_pair_request.is_some_and(|t| t.elapsed() < PAIR_COOLDOWN);
                    if !busy {
                        s.last_pair_request = Some(Instant::now());
                        s.pairing = Some(Pairing {
                            role: Role::Responder,
                            stage: "connecting",
                            peer_id: id.clone(),
                            peer_name: name.clone(),
                            peer_os: os.clone(),
                            code: String::new(),
                            local_ok: None,
                            remote_ok: None,
                            outcome: None,
                            decide: Some(decide_tx),
                        });
                    }
                    busy
                };
                if busy {
                    let _ = tx.send(&Msg::Refuse { code: "busy".into() }).await;
                    return;
                }
                // The code is shown only after both sides have given their number.
                let numbers = async {
                    tx.send(&hello).await?;
                    wire::code_as_responder(&mut tx, &mut rx, &hash).await
                };
                let Ok(Ok(code)) = tokio::time::timeout(HANDSHAKE_TIMEOUT, numbers).await else {
                    self.finish_pairing("handshake_failed".into());
                    return;
                };
                {
                    let mut s = self.lock();
                    match s.pairing.as_mut() {
                        Some(p) if p.outcome.is_none() => {
                            p.stage = "compare";
                            p.code = code;
                        }
                        // Closed or replaced while the numbers were exchanged.
                        _ => return,
                    }
                }
                self.publish();
                self.run_pairing(tx, rx, decide_rx, Peer { id, name, os, public_key: hex(&remote_key), paired_at: 0, manual_addrs: vec![] }).await;
            }
        }
    }

    // -- pairing ---------------------------------------------------------------

    /// Ask the machine with this id (found over mDNS), or at this address, to pair.
    pub fn pair(&self, id: Option<String>, addr: Option<String>) -> AppResult<()> {
        let targets: Vec<SocketAddrV4> = {
            let s = self.lock();
            if s.run.is_none() {
                return Err(AppError::new("connect_off"));
            }
            if s.pairing.as_ref().is_some_and(|p| p.outcome.is_none()) {
                return Err(AppError::new("pairing_busy"));
            }
            match (&id, &addr) {
                (_, Some(a)) => vec![net::parse_addr(a, DEFAULT_PORT).ok_or_else(|| AppError::field("invalid_address", "addr"))?],
                (Some(id), None) => {
                    let n = s.nearby.get(id).ok_or_else(|| AppError::new("peer_not_found"))?;
                    n.addrs.iter().map(|ip| SocketAddrV4::new(*ip, n.port)).collect()
                }
                (None, None) => return Err(AppError::new("peer_not_found")),
            }
        };
        let me = self.me().ok_or_else(|| AppError::new("keychain"))?;
        let manual = addr.is_some();
        {
            let mut s = self.lock();
            s.pairing = Some(Pairing {
                role: Role::Initiator,
                stage: "connecting",
                peer_id: id.clone().unwrap_or_default(),
                peer_name: String::new(),
                peer_os: String::new(),
                code: String::new(),
                local_ok: None,
                remote_ok: None,
                outcome: None,
                decide: None,
            });
        }
        self.publish();
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(code) = this.pair_initiate(me, id, targets, manual).await {
                this.finish_pairing(code);
            }
        });
        Ok(())
    }

    async fn pair_initiate(&self, me: Me, expected: Option<String>, targets: Vec<SocketAddrV4>, manual: bool) -> Result<(), String> {
        let (stream, used) = connect_any(&targets).await.map_err(|f| f.code().to_string())?;
        let est = tokio::time::timeout(HANDSHAKE_TIMEOUT, wire::initiate(stream, &me.key)).await.map_err(|_| "connect_timeout".to_string())?.map_err(|_| "handshake_failed".to_string())?;
        let remote_key = est.remote_static.clone();
        let hash = est.hash.clone();
        let (mut tx, mut rx) = est.channel.split();
        tx.send(&Msg::Hello { id: me.id.clone(), name: me.name.clone(), os: std::env::consts::OS.into(), version: VERSION, intent: Intent::Pair }).await.map_err(|_| "connection_lost".to_string())?;
        let reply = tokio::time::timeout(HANDSHAKE_TIMEOUT, rx.recv()).await.map_err(|_| "connect_timeout".to_string())?.map_err(|_| "connection_lost".to_string())?;
        let (id, name, os) = match reply {
            Msg::Hello { id, name, os, version, .. } if version == VERSION => (id, name, os),
            Msg::Hello { .. } => return Err("version".into()),
            Msg::Refuse { code } => return Err(format!("refused_{code}")),
            _ => return Err("handshake_failed".into()),
        };
        if expected.as_deref().is_some_and(|e| e != id) {
            return Err("peer_mismatch".into());
        }
        let code = tokio::time::timeout(HANDSHAKE_TIMEOUT, wire::code_as_initiator(&mut tx, &mut rx, &hash))
            .await
            .map_err(|_| "connect_timeout".to_string())?
            .map_err(|_| "handshake_failed".to_string())?;
        let (decide_tx, decide_rx) = mpsc::unbounded_channel();
        {
            let mut s = self.lock();
            match s.pairing.as_mut() {
                Some(p) if p.outcome.is_none() => {
                    p.stage = "compare";
                    p.peer_id = id.clone();
                    p.peer_name = name.clone();
                    p.peer_os = os.clone();
                    p.code = code;
                    p.decide = Some(decide_tx);
                }
                _ => return Err("aborted".into()),
            }
        }
        self.publish();
        let manual_addrs = if manual { vec![used.to_string()] } else { vec![] };
        self.run_pairing(tx, rx, decide_rx, Peer { id, name, os, public_key: hex(&remote_key), paired_at: 0, manual_addrs }).await;
        Ok(())
    }

    /// Both roles: wait for the user's answer and the other machine's, and
    /// trust the machine only when both said yes.
    async fn run_pairing(&self, mut tx: Sender<Stream>, rx: Receiver<Stream>, mut decide: mpsc::UnboundedReceiver<bool>, mut peer: Peer) {
        let mut msgs = spawn_reader(rx);
        let deadline = tokio::time::sleep(PAIRING_TIMEOUT);
        tokio::pin!(deadline);
        let (mut local, mut remote): (Option<bool>, Option<bool>) = (None, None);
        let outcome = loop {
            tokio::select! {
                d = decide.recv() => match d {
                    Some(ok) => {
                        local = Some(ok);
                        let _ = tx.send(&Msg::PairConfirm { ok }).await;
                        if !ok { break "declined".to_string(); }
                    }
                    None => {
                        let _ = tx.send(&Msg::PairConfirm { ok: false }).await;
                        break "aborted".to_string();
                    }
                },
                m = msgs.recv() => match m {
                    Some(Msg::PairConfirm { ok }) => {
                        remote = Some(ok);
                        if !ok { break "declined".to_string(); }
                    }
                    Some(Msg::Ping { .. } | Msg::Pong { .. }) => {}
                    _ => break "connection_lost".to_string(),
                },
                _ = &mut deadline => break "timeout".to_string(),
            }
            if let Some(p) = self.lock().pairing.as_mut() {
                p.local_ok = local;
                p.remote_ok = remote;
            }
            self.publish();
            if local == Some(true) && remote == Some(true) {
                break "paired".to_string();
            }
        };
        if outcome == "paired" {
            peer.paired_at = now_ms();
            let name = peer.name.clone();
            let saved = self.lock().store.upsert(peer);
            match saved {
                Ok(()) => self.audit("pair", &name, true, None),
                Err(e) => return self.finish_pairing(e.code.to_string()),
            }
        } else {
            let name = self.lock().pairing.as_ref().map(|p| p.peer_name.clone()).unwrap_or_default();
            self.audit("pair", &name, false, Some(outcome.clone()));
        }
        self.finish_pairing(outcome);
        // Closing now could drop the other side's last message; give it a moment.
        tokio::time::sleep(Duration::from_millis(300)).await;
    }

    fn finish_pairing(&self, outcome: String) {
        {
            let mut s = self.lock();
            if let Some(p) = s.pairing.as_mut() {
                p.stage = "done";
                p.decide = None;
                if p.outcome.is_none() {
                    p.outcome = Some(outcome);
                }
            }
        }
        self.publish();
    }

    pub fn pair_decide(&self, ok: bool) -> AppResult<()> {
        let s = self.lock();
        let tx = s.pairing.as_ref().filter(|p| p.stage == "compare" && p.outcome.is_none()).and_then(|p| p.decide.clone()).ok_or_else(|| AppError::new("no_pairing"))?;
        drop(s);
        let _ = tx.send(ok);
        Ok(())
    }

    /// Close the pairing dialog; also gives up a pairing still waiting.
    pub fn pair_close(&self) {
        self.lock().pairing = None;
        self.publish();
    }

    pub fn unpair(&self, id: &str) -> AppResult<()> {
        let (name, link) = {
            let mut s = self.lock();
            let name = s.store.peer(id).map(|p| p.name.clone()).unwrap_or_default();
            s.store.remove(id)?;
            s.paths.remove(id);
            let link = if s.link.as_ref().is_some_and(|l| l.peer_id == id) { s.link.take() } else { None };
            (name, link)
        };
        if let Some(l) = link {
            l.cancel.notify_one();
        }
        self.audit("unpair", &name, true, None);
        self.publish();
        Ok(())
    }

    // -- addresses added by hand ---------------------------------------------

    pub fn add_address(&self, id: &str, addr: &str) -> AppResult<()> {
        let parsed = net::parse_addr(addr, DEFAULT_PORT).ok_or_else(|| AppError::field("invalid_address", "addr"))?;
        {
            let mut s = self.lock();
            let peer = s.store.data.peers.iter_mut().find(|p| p.id == id).ok_or_else(|| AppError::new("peer_not_found"))?;
            let text = parsed.to_string();
            if !peer.manual_addrs.contains(&text) {
                peer.manual_addrs.push(text);
            }
            s.store.save()?;
        }
        self.publish();
        Ok(())
    }

    pub fn remove_address(&self, id: &str, addr: &str) -> AppResult<()> {
        {
            let mut s = self.lock();
            let peer = s.store.data.peers.iter_mut().find(|p| p.id == id).ok_or_else(|| AppError::new("peer_not_found"))?;
            peer.manual_addrs.retain(|a| a != addr);
            s.store.save()?;
        }
        self.publish();
        Ok(())
    }

    // -- a live link ------------------------------------------------------------

    /// Connect to a paired machine, over the way that answers fastest.
    pub fn link(&self, id: &str) -> AppResult<()> {
        let (targets, name) = {
            let mut s = self.lock();
            if s.run.is_none() {
                return Err(AppError::new("connect_off"));
            }
            if s.link.is_some() {
                return Err(AppError::new("link_busy"));
            }
            let peer = s.store.peer(id).ok_or_else(|| AppError::new("peer_not_found"))?.clone();
            let mut targets: Vec<(Option<Duration>, SocketAddrV4)> = s.paths.get(id).map(|v| v.iter().map(|p| (p.result.ok(), p.addr)).collect()).unwrap_or_default();
            if targets.is_empty() {
                if let Some(n) = s.nearby.get(id) {
                    targets.extend(n.addrs.iter().map(|ip| (None, SocketAddrV4::new(*ip, n.port))));
                }
                targets.extend(peer.manual_addrs.iter().filter_map(|m| net::parse_addr(m, DEFAULT_PORT)).map(|a| (None, a)));
            }
            if targets.is_empty() {
                return Err(AppError::new("peer_not_found"));
            }
            // Fastest known first; addresses never measured go last.
            targets.sort_by_key(|(rtt, _)| rtt.map_or(u128::MAX, |d| d.as_micros()));
            s.link_error = None;
            let token = s.next_token;
            s.next_token += 1;
            s.link = Some(Link { token, peer_id: id.to_string(), addr: String::new(), up: false, since: now_ms(), rtt: None, cancel: Arc::new(Notify::new()) });
            (targets.into_iter().map(|(_, a)| a).collect::<Vec<_>>(), peer.name)
        };
        let me = self.me().ok_or_else(|| AppError::new("keychain"))?;
        self.publish();
        let this = self.clone();
        let id = id.to_string();
        tauri::async_runtime::spawn(async move {
            if let Err(code) = this.link_initiate(me, &id, &name, targets).await {
                {
                    let mut s = this.lock();
                    s.link = None;
                    s.link_error = Some((id.clone(), code.clone()));
                }
                this.audit("link", &name, false, Some(code));
                this.publish();
            }
        });
        Ok(())
    }

    async fn link_initiate(&self, me: Me, id: &str, name: &str, targets: Vec<SocketAddrV4>) -> Result<(), String> {
        let expected_key = self.lock().store.peer(id).map(|p| p.public_key.clone()).ok_or("peer_not_found")?;
        let (stream, used) = connect_any(&targets).await.map_err(|f| f.code().to_string())?;
        let est = tokio::time::timeout(HANDSHAKE_TIMEOUT, wire::initiate(stream, &me.key)).await.map_err(|_| "connect_timeout".to_string())?.map_err(|_| "handshake_failed".to_string())?;
        if hex(&est.remote_static) != expected_key {
            return Err("key_changed".into());
        }
        let (mut tx, mut rx) = est.channel.split();
        tx.send(&Msg::Hello { id: me.id.clone(), name: me.name.clone(), os: std::env::consts::OS.into(), version: VERSION, intent: Intent::Link }).await.map_err(|_| "connection_lost".to_string())?;
        match tokio::time::timeout(HANDSHAKE_TIMEOUT, rx.recv()).await.map_err(|_| "connect_timeout".to_string())?.map_err(|_| "connection_lost".to_string())? {
            Msg::Hello { id: remote_id, version, .. } if remote_id == id && version == VERSION => {}
            Msg::Refuse { code } => return Err(format!("refused_{code}")),
            _ => return Err("handshake_failed".into()),
        }
        let (token, cancel) = {
            let mut s = self.lock();
            match s.link.as_mut() {
                Some(l) if l.peer_id == id && !l.up => {
                    l.up = true;
                    l.addr = used.to_string();
                    l.since = now_ms();
                    (l.token, l.cancel.clone())
                }
                _ => return Err("aborted".into()),
            }
        };
        self.publish();
        self.audit("link", name, true, Some(used.to_string()));
        self.run_session(token, tx, rx, cancel).await;
        Ok(())
    }

    pub fn unlink(&self) {
        let link = self.lock().link.as_ref().map(|l| l.cancel.clone());
        if let Some(c) = link {
            c.notify_one();
        }
        let mut s = self.lock();
        // A link still connecting has nothing to close: drop it.
        if s.link.as_ref().is_some_and(|l| !l.up) {
            s.link = None;
        }
        drop(s);
        self.publish();
    }

    pub fn dismiss_link_error(&self) {
        self.lock().link_error = None;
        self.publish();
    }

    /// Keep the link alive: answer pings, ping back, and note how long a round
    /// trip takes. Ends when either side closes, or `cancel` fires.
    async fn run_session(&self, token: u64, mut tx: Sender<Stream>, rx: Receiver<Stream>, cancel: Arc<Notify>) {
        let mut msgs = spawn_reader(rx);
        let mut tick = tokio::time::interval(PING_EVERY);
        let mut sent: HashMap<u64, Instant> = HashMap::new();
        let mut seq = 0u64;
        loop {
            tokio::select! {
                m = msgs.recv() => match m {
                    Some(Msg::Ping { seq }) => { if tx.send(&Msg::Pong { seq }).await.is_err() { break; } }
                    Some(Msg::Pong { seq }) => {
                        if let Some(t0) = sent.remove(&seq) {
                            let rtt = t0.elapsed();
                            if let Some(l) = self.lock().link.as_mut().filter(|l| l.token == token) {
                                l.rtt = Some(rtt);
                            }
                            self.publish();
                        }
                    }
                    _ => break,
                },
                _ = tick.tick() => {
                    seq += 1;
                    sent.insert(seq, Instant::now());
                    sent.retain(|_, t| t.elapsed() < Duration::from_secs(30));
                    if tx.send(&Msg::Ping { seq }).await.is_err() { break; }
                }
                _ = cancel.notified() => {
                    let _ = tx.send(&Msg::Bye).await;
                    break;
                }
            }
        }
        self.end_link(token);
    }

    fn end_link(&self, token: u64) {
        {
            let mut s = self.lock();
            if s.link.as_ref().is_some_and(|l| l.token == token) {
                s.link = None;
            }
        }
        self.publish();
    }
}

/// Read messages on their own task, so that waiting for one never cuts a
/// message in half when another event wins a `select!`.
fn spawn_reader(mut rx: Receiver<Stream>) -> mpsc::UnboundedReceiver<Msg> {
    let (tx, out) = mpsc::unbounded_channel();
    tauri::async_runtime::spawn(async move {
        while let Ok(m) = rx.recv().await {
            if tx.send(m).is_err() {
                break;
            }
        }
    });
    out
}

/// The first of these addresses that accepts a connection; else why the last one did not.
async fn connect_any(targets: &[SocketAddrV4]) -> Result<(Stream, SocketAddrV4), Fail> {
    let mut last = Fail::Other;
    for a in targets {
        match net::connect(SocketAddr::V4(*a), CONNECT_TIMEOUT).await {
            Ok(s) => return Ok((s, *a)),
            Err(f) => last = f,
        }
    }
    Err(last)
}

fn build_view(s: &State) -> View {
    let cards = &s.cards;
    let device = (!s.store.data.id.is_empty() && !s.name.is_empty()).then(|| DeviceView {
        id: s.store.data.id.clone(),
        name: s.name.clone(),
        os: std::env::consts::OS.to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        port: s.run.as_ref().map(|r| r.port),
        fingerprint: s.store.data.public_key.chars().take(16).collect::<Vec<_>>().chunks(4).map(|c| c.iter().collect::<String>()).collect::<Vec<_>>().join(" "),
    });
    let paired = |id: &str| s.store.peer(id).is_some();
    let mut nearby: Vec<NearbyView> = s
        .nearby
        .iter()
        .filter(|(id, _)| !paired(id))
        .map(|(id, n)| NearbyView { id: id.clone(), addrs: n.addrs.iter().map(|a| a.to_string()).collect() })
        .collect();
    nearby.sort_by(|a, b| a.id.cmp(&b.id));
    let peers = s
        .store
        .data
        .peers
        .iter()
        .map(|p| {
            let mut paths: Vec<PathView> = s
                .paths
                .get(&p.id)
                .map(|v| {
                    v.iter()
                        .map(|i| {
                            let card = net::card_for(cards, *i.addr.ip());
                            PathView {
                                addr: i.addr.to_string(),
                                card: card.map(|c| c.name.clone()),
                                network: card.map(net::network_of),
                                rtt_ms: i.result.ok().map(|d| (d.as_secs_f64() * 10_000.0).round() / 10.0),
                                fail: i.result.err(),
                                manual: i.manual,
                            }
                        })
                        .collect()
                })
                .unwrap_or_default();
            // Reachable first, fastest first.
            paths.sort_by(|a, b| a.rtt_ms.unwrap_or(f64::MAX).total_cmp(&b.rtt_ms.unwrap_or(f64::MAX)));
            let online = s.nearby.contains_key(&p.id) || paths.iter().any(|x| x.rtt_ms.is_some());
            PeerView { id: p.id.clone(), name: p.name.clone(), os: p.os.clone(), paired_at: p.paired_at, online, paths, manual_addrs: p.manual_addrs.clone() }
        })
        .collect();
    View {
        enabled: s.store.data.enabled,
        device,
        error: s.error.clone(),
        self_seen: s.run.as_ref().is_some_and(|r| r.self_seen),
        nearby,
        peers,
        pairing: s.pairing.as_ref().map(|p| PairingView {
            role: if p.role == Role::Initiator { "initiator" } else { "responder" },
            stage: p.stage,
            peer_id: p.peer_id.clone(),
            peer_name: p.peer_name.clone(),
            peer_os: p.peer_os.clone(),
            code: p.code.clone(),
            local_ok: p.local_ok,
            remote_ok: p.remote_ok,
            outcome: p.outcome.clone(),
        }),
        link: s.link.as_ref().map(|l| LinkView { peer_id: l.peer_id.clone(), addr: l.addr.clone(), stage: if l.up { "up" } else { "connecting" }, since: l.since, rtt_ms: l.rtt.map(|d| (d.as_secs_f64() * 10_000.0).round() / 10.0) }),
        link_error: s.link_error.as_ref().map(|(peer_id, code)| LinkErrorView { peer_id: peer_id.clone(), code: code.clone() }),
    }
}
