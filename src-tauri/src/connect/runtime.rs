//! Connect while it runs: listening for other Portways, announcing and finding
//! them over mDNS, pairing, one live link to a paired machine, and measuring
//! the ways to reach each of them. Everything the UI shows is one `View`,
//! sent as a `connect` event after every change.

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Notify};

use super::machine::{self, LiveStats, MachineInfo, Sampler, Statics, FEATURE_SPEED};
use super::net::{self, Fail, DEFAULT_PORT, SERVICE};
use super::store::{Peer, Store};
use super::wire::{self, hex, Intent, MacInfo, Msg, Receiver, Sender, VERSION};
use crate::audit::AuditLog;
use crate::error::{AppError, AppResult};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const PAIRING_TIMEOUT: Duration = Duration::from_secs(120);
const PROBE_EVERY: Duration = Duration::from_secs(5);
const PING_EVERY: Duration = Duration::from_secs(2);
/// Incoming pairing requests closer together than this are refused, so one
/// machine on the network cannot keep popping the dialog up.
const PAIR_COOLDOWN: Duration = Duration::from_secs(5);
/// How long to wait for a machine to appear after waking it.
const WAKE_WAIT: Duration = Duration::from_secs(120);
/// Round trips of the live link kept for the graph: a minute at one ping per 2 s.
const RTT_KEEP: usize = 30;

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
    /// It announced another protocol version: it cannot talk to this one.
    pub version_mismatch: bool,
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
    /// We know a card to wake it through.
    pub can_wake: bool,
    /// It announced another protocol version: update Portway on both machines.
    pub version_mismatch: bool,
    /// Text it sends is written into this machine's clipboard.
    pub clip_receive: bool,
    /// Text copied here is sent to it as soon as it is copied.
    pub clip_send: bool,
    /// What it last told us about itself over a link, and when (ms since epoch).
    pub info: Option<MachineInfo>,
    pub info_at: u64,
    /// The last speed test with it.
    pub speed: Option<SpeedView>,
    /// Its CPU and memory use now; only while linked with it.
    pub live: Option<LiveStats>,
    /// What it does with clipboard text for this machine; only while linked with it.
    pub remote_clip: Option<ClipPrefs>,
    /// Files it copied and offered.
    pub clip_files: Option<ClipFilesView>,
    /// It is on, waiting at the sign-in screen: it will answer once somebody signs in.
    pub login_screen: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeView {
    pub peer_id: String,
    /// "waiting" for the machine to show up, then "up" or "timeout".
    pub stage: &'static str,
    /// Magic packets sent.
    pub sent: usize,
    pub since: u64,
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
    /// The last round trips, oldest first.
    pub rtt_history: Vec<f64>,
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
    pub wake: Option<WakeView>,
    pub transfers: Vec<TransferView>,
    /// The last text sent or received, without its content.
    pub clip: Option<ClipNote>,
    /// This machine, as a linked machine sees it.
    pub machine: Option<MachineInfo>,
    /// This machine's CPU and memory use now.
    pub live: Option<LiveStats>,
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
    /// Protocol version it announced, when it did.
    version: Option<u32>,
    /// A Windows machine that is on but waiting at the sign-in screen: only its
    /// beacon service answers, so nothing can be done with it yet.
    login: bool,
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
    /// The last round trips in ms, oldest first.
    rtts: VecDeque<f64>,
    cancel: Arc<Notify>,
    /// Messages for the other side from outside the session loop (copied text).
    outbox: mpsc::UnboundedSender<Msg>,
    /// Taken by the session when it starts.
    outbox_rx: Option<mpsc::UnboundedReceiver<Msg>>,
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
    wake: Option<Wake>,
    transfers: Vec<Transfer>,
    clip: ClipState,
    /// This machine's specs, read when Connect starts and refreshed now and then.
    machine: Option<MachineInfo>,
    /// Model and graphics cards, read once per run; None until then.
    statics: Option<Statics>,
    /// This machine's CPU and memory use, sampled with each probe round.
    stats: Option<LiveStats>,
    /// What the linked machine last said about its load, in memory only.
    peer_stats: Option<(String, LiveStats)>,
    /// What the linked machine does with clipboard text for this one, in memory only.
    peer_clip: Option<(String, ClipPrefs)>,
    /// Files this machine copied and announced; served to whoever was told.
    clip_out: Option<OutLease>,
    /// Files the linked machine says it copied.
    clip_in: Option<InLease>,
    /// Speed tests, the last one per machine.
    speeds: HashMap<String, SpeedState>,
    /// A machine is measuring the speed to this one right now.
    speed_serving: bool,
    next_token: u64,
}

struct Wake {
    token: u64,
    peer_id: String,
    stage: &'static str,
    sent: usize,
    since: u64,
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
    /// Kept for the whole run: a CPU figure is the change since the last sample.
    sampler: Mutex<Sampler>,
}

mod clip;
mod clipfiles;
mod clipblob;
mod speed;
mod transfer;
use super::sys_clip;
use clip::{ClipNote, ClipPrefs, ClipState};
use clipfiles::{ClipFilesView, InLease, OutLease};
use transfer::{offer_batches, pull_files, push_files, spawn_frame_reader, walk_dir, MAX_FILES};
use speed::{SpeedState, SpeedView};
use transfer::{Transfer, TransferView};

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
            wake: None,
            transfers: Vec::new(),
            clip: ClipState::new(),
            machine: None,
            statics: None,
            stats: None,
            peer_stats: None,
            peer_clip: None,
            clip_out: None,
            clip_in: None,
            speeds: HashMap::new(),
            speed_serving: false,
            next_token: 1,
        };
        let this = Self { inner: Arc::new(Inner { app, state: Mutex::new(state), sampler: Mutex::new(Sampler::new()) }) };
        this.purge_blobs();
        this
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

    /// The cards other machines can wake this one through.
    fn my_macs(&self) -> Vec<MacInfo> {
        net::wake_cards(&self.lock().cards).into_iter().map(|(mac, name, kind)| MacInfo { mac, name, kind: kind.code().to_string() }).collect()
    }

    fn remember_macs(&self, id: &str, macs: Vec<MacInfo>) {
        if macs.is_empty() {
            return;
        }
        let mut s = self.lock();
        if let Some(p) = s.store.data.peers.iter_mut().find(|p| p.id == id) {
            if p.macs != macs {
                p.macs = macs;
                let _ = s.store.save();
            }
        }
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
        self.refresh_machine().await;
        {
            let this = self.clone();
            tauri::async_runtime::spawn(async move { this.load_statics().await });
        }
        let listener = match TcpListener::bind(("0.0.0.0", DEFAULT_PORT)).await {
            Ok(l) => l,
            Err(_) => TcpListener::bind(("0.0.0.0", 0)).await.map_err(|e| AppError::detail("listen_failed", e))?,
        };
        let port = listener.local_addr().map_err(|e| AppError::detail("listen_failed", e))?.port();
        let me = self.me().ok_or_else(|| AppError::new("keychain"))?;
        // The pre-login service announces as this machine: tell it who that is.
        #[cfg(windows)]
        crate::beacon::publish_identity(&me.id, VERSION, port);

        let daemon = ServiceDaemon::new().map_err(|e| AppError::detail("mdns_failed", e))?;
        let host = format!("portway-{}.local.", me.id);
        let version = VERSION.to_string();
        let props = [("id", me.id.as_str()), ("v", version.as_str())];
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
            s.wake = None;
            for t in &s.transfers {
                t.cancel.notify_one();
            }
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
                    let version = info.get_property_val_str("v").and_then(|v| v.parse::<u32>().ok());
                    let login = info.get_property_val_str("s") == Some(net::BEACON_STATE);
                    let e = s.nearby.entry(id).or_insert_with(|| Nearby { addrs: BTreeSet::new(), port: info.get_port(), version, login });
                    e.version = version;
                    e.login = login;
                    e.addrs.extend(addrs);
                    e.port = info.get_port();
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

    /// Read this machine's specs again (off the async threads: listing disks blocks).
    async fn refresh_machine(&self) {
        let (cards, statics) = {
            let s = self.lock();
            (s.cards.clone(), s.statics.clone().unwrap_or_default())
        };
        if let Ok(info) = tokio::task::spawn_blocking(move || machine::collect(&cards, &statics)).await {
            self.lock().machine = Some(info);
        }
    }

    /// Model and graphics cards: read once, in the background, then folded into
    /// the description of this machine.
    async fn load_statics(&self) {
        if self.lock().statics.is_some() {
            return;
        }
        if let Ok(statics) = tokio::task::spawn_blocking(machine::read_statics).await {
            self.lock().statics = Some(statics);
            self.refresh_machine().await;
            self.publish();
        }
    }

    fn sample_stats(&self) {
        // The graphics load costs a program run on macOS: only while it is being drawn on a linked machine's page.
        let linked = self.lock().link.as_ref().is_some_and(|l| l.up);
        let live = self.inner.sampler.lock().unwrap().sample(linked);
        self.lock().stats = Some(live);
    }

    /// The linked machine's load, as it last said.
    fn on_stats(&self, id: &str, stats: LiveStats) {
        self.lock().peer_stats = Some((id.to_string(), stats));
        self.publish();
    }

    async fn probe_loop(&self) {
        let mut round = 0u32;
        loop {
            // Free disk space and the like change slowly.
            round += 1;
            if round % 6 == 0 {
                self.refresh_machine().await;
            }
            self.sample_stats();
            let jobs: Vec<(String, SocketAddrV4, bool)> = {
                let s = self.lock();
                let mut jobs = Vec::new();
                for p in &s.store.data.peers {
                    let mut seen = BTreeSet::new();
                    if let Some(n) = s.nearby.get(&p.id).filter(|n| !n.login) {
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
        let remote_addr = stream.peer_addr().map(|a| a.to_string()).unwrap_or_default();
        // A TCP connection that never speaks (a path probe) ends here, quietly.
        let Ok(Ok(est)) = tokio::time::timeout(HANDSHAKE_TIMEOUT, wire::respond(stream, &me.key)).await else { return };
        let remote_key = est.remote_static.clone();
        let hash = est.hash.clone();
        let (mut tx, mut rx) = est.channel.split();
        let hello = tokio::time::timeout(HANDSHAKE_TIMEOUT, rx.recv()).await;
        let Ok(Ok(Msg::Hello { id, name, os, version, intent, macs })) = hello else {
            // Something spoke after the handshake but not our protocol: most likely
            // another version. Say so, in case the other side can read it.
            if matches!(hello, Ok(Err(wire::WireError::Protocol(_)))) {
                let _ = tx.send(&Msg::Refuse { code: "version".into() }).await;
            }
            return;
        };
        if version != VERSION {
            let _ = tx.send(&Msg::Refuse { code: "version".into() }).await;
            return;
        }
        let mut hello = Msg::Hello { id: me.id.clone(), name: me.name.clone(), os: std::env::consts::OS.into(), version: VERSION, intent, macs: vec![] };
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
                        let (outbox, outbox_rx) = mpsc::unbounded_channel();
                        s.link = Some(Link { token, peer_id: id.clone(), addr: remote_addr, up: true, since: now_ms(), rtt: None, rtts: VecDeque::new(), cancel: cancel.clone(), outbox, outbox_rx: Some(outbox_rx) });
                        Some((token, cancel))
                    }
                };
                let Some((token, cancel)) = taken else {
                    let _ = tx.send(&Msg::Refuse { code: "busy".into() }).await;
                    return;
                };
                // The other side is trusted now: swap the cards each can be woken through.
                self.remember_macs(&id, macs);
                if let Msg::Hello { macs, .. } = &mut hello {
                    *macs = self.my_macs();
                }
                if tx.send(&hello).await.is_err() {
                    self.end_link(token);
                    return;
                }
                self.publish();
                self.audit("link", &name, true, Some("incoming".into()));
                self.run_session(token, tx, rx, cancel).await;
            }
            Intent::Send => {
                let peer = self.lock().store.peer(&id).filter(|p| p.public_key == hex(&remote_key)).cloned();
                let Some(peer) = peer else {
                    let _ = tx.send(&Msg::Refuse { code: "not_paired".into() }).await;
                    return;
                };
                if tx.send(&hello).await.is_err() {
                    return;
                }
                self.accept_send(tx, rx, peer).await;
            }
            Intent::Speed => {
                let known = self.lock().store.peer(&id).is_some_and(|p| p.public_key == hex(&remote_key));
                if !known {
                    let _ = tx.send(&Msg::Refuse { code: "not_paired".into() }).await;
                    return;
                }
                if tx.send(&hello).await.is_err() {
                    return;
                }
                self.accept_speed(tx, rx).await;
            }
            Intent::Fetch => {
                let peer = self.lock().store.peer(&id).filter(|p| p.public_key == hex(&remote_key)).cloned();
                let Some(peer) = peer else {
                    let _ = tx.send(&Msg::Refuse { code: "not_paired".into() }).await;
                    return;
                };
                if tx.send(&hello).await.is_err() {
                    return;
                }
                self.accept_fetch(tx, rx, peer).await;
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
                self.run_pairing(tx, rx, decide_rx, Peer { id, name, os, public_key: hex(&remote_key), paired_at: 0, manual_addrs: vec![], macs: vec![], clip_receive: false, clip_send: false, info: None, info_at: 0 }).await;
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
        let est = tokio::time::timeout(HANDSHAKE_TIMEOUT, wire::initiate(stream, &me.key)).await.map_err(|_| "no_reply".to_string())?.map_err(|_| "handshake_failed".to_string())?;
        let remote_key = est.remote_static.clone();
        let hash = est.hash.clone();
        let (mut tx, mut rx) = est.channel.split();
        tx.send(&Msg::Hello { id: me.id.clone(), name: me.name.clone(), os: std::env::consts::OS.into(), version: VERSION, intent: Intent::Pair, macs: vec![] }).await.map_err(|_| "connection_lost".to_string())?;
        let reply = tokio::time::timeout(HANDSHAKE_TIMEOUT, rx.recv()).await.map_err(|_| "no_reply".to_string())?.map_err(|_| "connection_lost".to_string())?;
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
            .map_err(|_| "no_reply".to_string())?
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
        self.run_pairing(tx, rx, decide_rx, Peer { id, name, os, public_key: hex(&remote_key), paired_at: 0, manual_addrs, macs: vec![], clip_receive: false, clip_send: false, info: None, info_at: 0 }).await;
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
                        let macs = if ok { self.my_macs() } else { vec![] };
                        let _ = tx.send(&Msg::PairConfirm { ok, macs }).await;
                        if !ok { break "declined".to_string(); }
                    }
                    None => {
                        let _ = tx.send(&Msg::PairConfirm { ok: false, macs: vec![] }).await;
                        break "aborted".to_string();
                    }
                },
                m = msgs.recv() => match m {
                    Some(Msg::PairConfirm { ok, macs }) => {
                        remote = Some(ok);
                        if ok {
                            peer.macs = macs;
                        }
                        if !ok { break "declined".to_string(); }
                    }
                    Some(Msg::Ping { .. } | Msg::Pong { .. } | Msg::Unknown) => {}
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
            // A machine that was asked and never got to show a code has nothing to report.
            if s.pairing.as_ref().is_some_and(|p| p.role == Role::Responder && p.stage == "connecting") {
                s.pairing = None;
            } else if let Some(p) = s.pairing.as_mut() {
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

    // -- waking a paired machine ------------------------------------------------

    /// Broadcast a magic packet for each card the machine told us about, then
    /// wait for it to show up on the network. Nothing here proves the machine
    /// can be woken: that depends on its firmware and settings.
    pub fn wake(&self, id: &str) -> AppResult<()> {
        let (macs, cards, name, token) = {
            let mut s = self.lock();
            let peer = s.store.peer(id).ok_or_else(|| AppError::new("peer_not_found"))?.clone();
            if peer.macs.is_empty() {
                return Err(AppError::new("no_mac"));
            }
            if s.cards.is_empty() {
                return Err(AppError::new("connect_off"));
            }
            let token = s.next_token;
            s.next_token += 1;
            (peer.macs, s.cards.clone(), peer.name, token)
        };
        let mut sent = 0;
        for m in &macs {
            if let Some(mac) = net::parse_mac(&m.mac) {
                sent += net::send_wake(&cards, mac);
            }
        }
        if sent == 0 {
            return Err(AppError::new("wake_failed"));
        }
        self.lock().wake = Some(Wake { token, peer_id: id.to_string(), stage: "waiting", sent, since: now_ms() });
        self.audit("wake", &name, true, Some(format!("{sent} packets")));
        self.publish();
        let this = self.clone();
        let id = id.to_string();
        tauri::async_runtime::spawn(async move { this.wait_for_wake(token, &id).await });
        Ok(())
    }

    async fn wait_for_wake(&self, token: u64, id: &str) {
        let deadline = Instant::now() + WAKE_WAIT;
        let stage = loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let s = self.lock();
            if s.wake.as_ref().is_none_or(|w| w.token != token) {
                return;
            }
            if is_online(&s, id) || at_login_screen(&s, id) {
                break "up";
            }
            if Instant::now() >= deadline {
                break "timeout";
            }
        };
        if let Some(w) = self.lock().wake.as_mut().filter(|w| w.token == token) {
            w.stage = stage;
        }
        self.publish();
        // Leave the result on screen for a moment, then clear it.
        tokio::time::sleep(Duration::from_secs(if stage == "up" { 6 } else { 20 })).await;
        {
            let mut s = self.lock();
            if s.wake.as_ref().is_some_and(|w| w.token == token) {
                s.wake = None;
            }
        }
        self.publish();
    }

    pub fn dismiss_wake(&self) {
        self.lock().wake = None;
        self.publish();
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
            if at_login_screen(&s, id) {
                return Err(AppError::new("peer_login_screen"));
            }
            let targets = targets_for(&s, id, &peer);
            if targets.is_empty() {
                return Err(AppError::new("peer_not_found"));
            }
            s.link_error = None;
            let token = s.next_token;
            s.next_token += 1;
            let (outbox, outbox_rx) = mpsc::unbounded_channel();
            s.link = Some(Link { token, peer_id: id.to_string(), addr: String::new(), up: false, since: now_ms(), rtt: None, rtts: VecDeque::new(), cancel: Arc::new(Notify::new()), outbox, outbox_rx: Some(outbox_rx) });
            (targets, peer.name)
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
        let est = tokio::time::timeout(HANDSHAKE_TIMEOUT, wire::initiate(stream, &me.key)).await.map_err(|_| "no_reply".to_string())?.map_err(|_| "handshake_failed".to_string())?;
        if hex(&est.remote_static) != expected_key {
            return Err("key_changed".into());
        }
        let (mut tx, mut rx) = est.channel.split();
        let macs = self.my_macs();
        tx.send(&Msg::Hello { id: me.id.clone(), name: me.name.clone(), os: std::env::consts::OS.into(), version: VERSION, intent: Intent::Link, macs }).await.map_err(|_| "connection_lost".to_string())?;
        match tokio::time::timeout(HANDSHAKE_TIMEOUT, rx.recv()).await.map_err(|_| "no_reply".to_string())?.map_err(|_| "connection_lost".to_string())? {
            Msg::Hello { id: remote_id, version, macs, .. } if remote_id == id && version == VERSION => self.remember_macs(id, macs),
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
        let (mut outbox, peer_id) = {
            let mut s = self.lock();
            match s.link.as_mut().filter(|l| l.token == token) {
                Some(l) => (l.outbox_rx.take(), l.peer_id.clone()),
                None => (None, String::new()),
            }
        };
        // Copied text can go out over this link while it is up.
        let watcher = outbox.is_some().then(|| {
            let this = self.clone();
            let id = peer_id.clone();
            tauri::async_runtime::spawn(async move { this.watch_clipboard(token, id).await })
        });
        // Both sides are trusted by now: say what this machine is.
        // The model and graphics cards are read in the background when Connect
        // starts; a link made right then waits a moment for them.
        for _ in 0..30 {
            if self.lock().statics.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let (mine, stats) = {
            let s = self.lock();
            (s.machine.clone(), s.stats)
        };
        if let Some(info) = mine {
            if tx.send(&Msg::Info { info }).await.is_err() {
                self.end_link(token);
                return;
            }
        }
        if let Some(stats) = stats {
            if tx.send(&Msg::Stats { stats }).await.is_err() {
                self.end_link(token);
                return;
            }
        }
        if let Some(prefs) = self.my_clip_prefs(&peer_id) {
            if tx.send(&prefs).await.is_err() {
                self.end_link(token);
                return;
            }
        }
        let mut tick = tokio::time::interval(PING_EVERY);
        let mut sent: HashMap<u64, Instant> = HashMap::new();
        let mut seq = 0u64;
        loop {
            tokio::select! {
                m = msgs.recv() => match m {
                    Some(Msg::Clip { text }) => {
                        let reason = self.on_clip(&peer_id, text);
                        if tx.send(&Msg::ClipAck { ok: reason.is_empty(), reason: reason.into() }).await.is_err() { break; }
                    }
                    Some(Msg::ClipFiles { lease, items }) => {
                        let reason = self.on_clip_files(&peer_id, lease, items);
                        if tx.send(&Msg::ClipAck { ok: reason.is_empty(), reason: reason.into() }).await.is_err() { break; }
                    }
                    Some(Msg::ClipImage { lease, size }) => {
                        // Accepted means on its way: the answer comes when it has arrived.
                        let reason = self.on_clip_image(&peer_id, lease, size);
                        if !reason.is_empty() && tx.send(&Msg::ClipAck { ok: false, reason: reason.into() }).await.is_err() { break; }
                    }
                    Some(Msg::ClipRich { lease, size, upgrade }) => {
                        let reason = self.on_clip_rich(&peer_id, lease, size, upgrade);
                        // As an upgrade it is the plain text that was answered.
                        if !reason.is_empty() && !upgrade && tx.send(&Msg::ClipAck { ok: false, reason: reason.into() }).await.is_err() { break; }
                    }
                    Some(Msg::ClipFilesGone { lease }) => self.on_clip_files_gone(&peer_id, &lease),
                    Some(Msg::ClipPrefs { receive, send }) => self.on_clip_prefs(&peer_id, receive, send),
                    Some(Msg::ClipAck { ok, reason }) => self.on_clip_ack(&peer_id, ok, reason),
                    Some(Msg::Info { info }) => self.on_info(&peer_id, info),
                    Some(Msg::Stats { stats }) => self.on_stats(&peer_id, stats),
                    // From a newer Portway: nothing to do with it, and no reason to drop the link.
                    Some(Msg::Unknown) => {}
                    Some(Msg::Ping { seq }) => { if tx.send(&Msg::Pong { seq }).await.is_err() { break; } }
                    Some(Msg::Pong { seq }) => {
                        if let Some(t0) = sent.remove(&seq) {
                            let rtt = t0.elapsed();
                            if let Some(l) = self.lock().link.as_mut().filter(|l| l.token == token) {
                                l.rtt = Some(rtt);
                                l.rtts.push_back((rtt.as_secs_f64() * 10_000.0).round() / 10.0);
                                while l.rtts.len() > RTT_KEEP {
                                    l.rtts.pop_front();
                                }
                            }
                            self.publish();
                        }
                    }
                    _ => break,
                },
                out = async { match outbox.as_mut() { Some(rx) => rx.recv().await, None => std::future::pending().await } } => {
                    match out {
                        Some(m) => { if tx.send(&m).await.is_err() { break; } }
                        None => outbox = None,
                    }
                }
                _ = tick.tick() => {
                    seq += 1;
                    sent.insert(seq, Instant::now());
                    sent.retain(|_, t| t.elapsed() < Duration::from_secs(30));
                    if tx.send(&Msg::Ping { seq }).await.is_err() { break; }
                    // Load changes by the second but is only worth a line every few.
                    if seq % 2 == 0 {
                        let stats = self.lock().stats;
                        if let Some(stats) = stats {
                            if tx.send(&Msg::Stats { stats }).await.is_err() { break; }
                        }
                    }
                }
                _ = cancel.notified() => {
                    let _ = tx.send(&Msg::Bye).await;
                    break;
                }
            }
        }
        if let Some(w) = watcher {
            w.abort();
        }
        self.end_link(token);
    }

    /// What the linked machine says it is: kept, so it shows when it is off too.
    fn on_info(&self, id: &str, info: MachineInfo) {
        {
            let mut s = self.lock();
            let Some(p) = s.store.data.peers.iter_mut().find(|p| p.id == id) else { return };
            p.info = Some(info);
            p.info_at = now_ms();
            let _ = s.store.save();
        }
        self.publish();
    }

    fn end_link(&self, token: u64) {
        {
            let mut s = self.lock();
            if s.link.as_ref().is_some_and(|l| l.token == token) {
                let who = s.link.as_ref().map(|l| l.peer_id.clone()).unwrap_or_default();
                s.link = None;
                s.peer_stats = None;
                s.peer_clip = None;
                // Once the link is gone what it copied cannot be revoked, and it can no longer be fetched from us.
                if s.clip_in.as_ref().is_some_and(|l| l.peer_id == who) {
                    s.clip_in = None;
                }
                if let Some(out) = s.clip_out.as_mut() {
                    out.forget(&who);
                    // A copied picture or rich text is kept only for the machine it was announced to.
                    if out.blob && out.peers.is_empty() {
                        for p in &out.paths {
                            let _ = std::fs::remove_file(p);
                        }
                        s.clip_out = None;
                    }
                }
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

/// The addresses to try for a paired machine, the one that answered fastest
/// first; those never measured go last.
fn targets_for(s: &State, id: &str, peer: &Peer) -> Vec<SocketAddrV4> {
    let mut targets: Vec<(Option<Duration>, SocketAddrV4)> = s.paths.get(id).map(|v| v.iter().map(|p| (p.result.ok(), p.addr)).collect()).unwrap_or_default();
    if targets.is_empty() {
        if let Some(n) = s.nearby.get(id) {
            targets.extend(n.addrs.iter().map(|ip| (None, SocketAddrV4::new(*ip, n.port))));
        }
        targets.extend(peer.manual_addrs.iter().filter_map(|m| net::parse_addr(m, DEFAULT_PORT)).map(|a| (None, a)));
    }
    targets.sort_by_key(|(rtt, _)| rtt.map_or(u128::MAX, |d| d.as_micros()));
    targets.into_iter().map(|(_, a)| a).collect()
}

/// A paired machine that is on the network right now: it answered on one of
/// its paths, or, before any path has been tried, announced itself over mDNS.
/// A machine is dropped from `nearby` only when mDNS says it left: announcements
/// are not repeated often, so "not heard lately" proves nothing, while a path
/// that stops answering does.
fn is_online(s: &State, id: &str) -> bool {
    // At the sign-in screen only a beacon answers: on, but nothing to connect to.
    if at_login_screen(s, id) {
        return false;
    }
    match s.paths.get(id) {
        Some(v) if !v.is_empty() => v.iter().any(|p| p.result.is_ok()),
        _ => s.nearby.contains_key(id),
    }
}

/// On and waiting for somebody to sign in (see `Nearby::login`).
fn at_login_screen(s: &State, id: &str) -> bool {
    s.nearby.get(id).is_some_and(|n| n.login)
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
        .map(|(id, n)| NearbyView { id: id.clone(), addrs: n.addrs.iter().map(|a| a.to_string()).collect(), version_mismatch: n.version.is_some_and(|v| v != VERSION) })
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
            let online = is_online(s, &p.id);
            PeerView { id: p.id.clone(), name: p.name.clone(), os: p.os.clone(), paired_at: p.paired_at, online, paths, manual_addrs: p.manual_addrs.clone(), can_wake: !p.macs.is_empty(), clip_receive: p.clip_receive, clip_send: p.clip_send, info: p.info.clone(), info_at: p.info_at, speed: s.speeds.get(&p.id).map(speed::view), live: s.peer_stats.as_ref().filter(|(id, _)| *id == p.id).map(|(_, v)| *v), remote_clip: s.peer_clip.as_ref().filter(|(id, _)| *id == p.id).map(|(_, v)| *v), clip_files: s.clip_in.as_ref().filter(|l| l.peer_id == p.id).map(clipfiles::view), login_screen: at_login_screen(s, &p.id), version_mismatch: s.nearby.get(&p.id).and_then(|n| n.version).is_some_and(|v| v != VERSION) }
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
        link: s.link.as_ref().map(|l| LinkView { peer_id: l.peer_id.clone(), addr: l.addr.clone(), stage: if l.up { "up" } else { "connecting" }, since: l.since, rtt_ms: l.rtt.map(|d| (d.as_secs_f64() * 10_000.0).round() / 10.0), rtt_history: l.rtts.iter().copied().collect() }),
        link_error: s.link_error.as_ref().map(|(peer_id, code)| LinkErrorView { peer_id: peer_id.clone(), code: code.clone() }),
        wake: s.wake.as_ref().map(|w| WakeView { peer_id: w.peer_id.clone(), stage: w.stage, sent: w.sent, since: w.since }),
        transfers: s.transfers.iter().map(transfer::view).collect(),
        clip: s.clip.note.clone(),
        machine: s.machine.clone(),
        live: s.stats,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> State {
        State {
            store: Store::load(std::env::temp_dir().join(format!("portway-runtime-{}.json", std::process::id()))),
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
            wake: None,
            transfers: Vec::new(),
            clip: ClipState::new(),
            machine: None,
            statics: None,
            stats: None,
            peer_stats: None,
            peer_clip: None,
            clip_out: None,
            clip_in: None,
            speeds: HashMap::new(),
            speed_serving: false,
            next_token: 1,
        }
    }

    fn path(ok: bool) -> PathInfo {
        PathInfo { addr: "10.0.0.2:47615".parse().unwrap(), manual: false, result: if ok { Ok(Duration::from_millis(1)) } else { Err(Fail::Timeout) } }
    }

    fn announced(s: &mut State, id: &str) {
        s.nearby.insert(id.to_string(), Nearby { addrs: BTreeSet::new(), port: 47615, version: None, login: false });
    }

    #[test]
    fn a_machine_stays_online_while_it_answers_however_long_ago_it_announced() {
        let mut s = state();
        announced(&mut s, "a");
        s.paths.insert("a".into(), vec![path(true)]);
        assert!(is_online(&s, "a"));
    }

    #[test]
    fn announced_but_not_answering_is_not_online() {
        let mut s = state();
        announced(&mut s, "a");
        s.paths.insert("a".into(), vec![path(false)]);
        assert!(!is_online(&s, "a"));
    }

    #[test]
    fn before_any_path_is_tried_the_announcement_counts() {
        let mut s = state();
        assert!(!is_online(&s, "a"));
        announced(&mut s, "a");
        assert!(is_online(&s, "a"));
    }

    #[test]
    fn a_machine_waiting_at_the_sign_in_screen_is_on_but_not_online() {
        let mut s = state();
        announced(&mut s, "a");
        s.nearby.get_mut("a").unwrap().login = true;
        assert!(at_login_screen(&s, "a"));
        assert!(!is_online(&s, "a"));
        // Once somebody signs in the app announces without the flag.
        s.nearby.get_mut("a").unwrap().login = false;
        assert!(is_online(&s, "a"));
    }
}
