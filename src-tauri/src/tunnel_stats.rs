//! Live numbers of a running tunnel: bytes per second, every connection going
//! through it (with the process on this Mac at the other end), and the SSH
//! round trip. Kept in memory only, from the moment the tunnel starts.

use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::pin::Pin;
use std::process::Command;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;

/// One sample a second: 15 minutes.
const HISTORY: usize = 900;
/// Closed connections kept for "Kết nối gần đây".
const RECENT: usize = 100;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub at: u64,
    /// Bytes during this second, to this Mac / from this Mac.
    pub rx: u64,
    pub tx: u64,
    pub active: u32,
    /// Last SSH round trip, in microseconds.
    pub rtt_us: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Process {
    pub pid: u32,
    /// Executable name, e.g. "Google Chrome Helper" or "curl".
    pub name: String,
    /// The app bundle it belongs to, e.g. "Google Chrome".
    pub app: Option<String>,
}

#[derive(Default)]
struct Meta {
    target: String,
    /// Time to open the SSH channel, i.e. for the server to reach the target.
    open_ms: Option<u32>,
    process: Option<Process>,
    /// lsof was asked once already (found or not).
    looked: bool,
    error: Option<String>,
    /// Totals at the previous tick, and the rate over the last second.
    last: (u64, u64),
    rate: (u64, u64),
}

/// One connection through the tunnel.
pub(crate) struct Link {
    id: u64,
    /// Where it came from; None when the server forwarded it (remote tunnels).
    peer: Option<SocketAddr>,
    /// Our end of it (the tunnel's listener), to find the process with lsof.
    local: Option<SocketAddr>,
    opened_at: u64,
    rx: AtomicU64,
    tx: AtomicU64,
    meta: Mutex<Meta>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkView {
    pub id: u64,
    pub peer: Option<String>,
    pub target: String,
    pub opened_at: u64,
    pub closed_at: Option<u64>,
    pub open_ms: Option<u32>,
    pub rx: u64,
    pub tx: u64,
    pub rate_rx: u64,
    pub rate_tx: u64,
    pub process: Option<Process>,
    pub error: Option<String>,
}

impl Link {
    pub(crate) fn set_target(&self, target: String) {
        self.meta.lock().unwrap().target = target;
    }

    pub(crate) fn set_open_ms(&self, ms: u32) {
        self.meta.lock().unwrap().open_ms = Some(ms);
    }

    fn view(&self, closed_at: Option<u64>) -> LinkView {
        let m = self.meta.lock().unwrap();
        LinkView {
            id: self.id,
            peer: self.peer.map(|p| p.to_string()),
            target: m.target.clone(),
            opened_at: self.opened_at,
            closed_at,
            open_ms: m.open_ms,
            rx: self.rx.load(Ordering::Relaxed),
            tx: self.tx.load(Ordering::Relaxed),
            rate_rx: if closed_at.is_some() { 0 } else { m.rate.0 },
            rate_tx: if closed_at.is_some() { 0 } else { m.rate.1 },
            process: m.process.clone(),
            error: m.error.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Monitor {
    pub samples: Vec<Sample>,
    pub open: Vec<LinkView>,
    pub recent: Vec<LinkView>,
    pub rtt_us: Option<u32>,
    pub reconnects: u32,
    pub total: u64,
    pub rx: u64,
    pub tx: u64,
}

#[derive(Default)]
pub(crate) struct Stats {
    pub(crate) active: AtomicU32,
    pub(crate) total: AtomicU64,
    /// Bytes to this Mac / from this Mac.
    pub(crate) rx: AtomicU64,
    pub(crate) tx: AtomicU64,
    /// Last SSH round trip in microseconds; 0 when unknown.
    rtt_us: AtomicU32,
    pub(crate) reconnects: AtomicU32,
    next_id: AtomicU64,
    open: Mutex<Vec<Arc<Link>>>,
    recent: Mutex<VecDeque<LinkView>>,
    samples: Mutex<VecDeque<Sample>>,
    last: Mutex<(u64, u64)>,
    /// A connection came in: look its process up now, before it may be gone.
    pub(crate) new_link: tokio::sync::Notify,
}

impl Stats {
    pub(crate) fn open_link(&self, peer: Option<SocketAddr>, local: Option<SocketAddr>, target: String) -> Arc<Link> {
        self.active.fetch_add(1, Ordering::Relaxed);
        self.total.fetch_add(1, Ordering::Relaxed);
        let link = Arc::new(Link {
            id: self.next_id.fetch_add(1, Ordering::Relaxed),
            peer,
            local,
            opened_at: now_ms(),
            rx: AtomicU64::new(0),
            tx: AtomicU64::new(0),
            meta: Mutex::new(Meta { target, ..Default::default() }),
        });
        self.open.lock().unwrap().push(link.clone());
        self.new_link.notify_one();
        link
    }

    /// The connection ended; `error` says why it never carried anything.
    pub(crate) fn close_link(&self, link: &Arc<Link>, error: Option<String>) {
        self.active.fetch_sub(1, Ordering::Relaxed);
        self.open.lock().unwrap().retain(|l| l.id != link.id);
        if error.is_some() {
            link.meta.lock().unwrap().error = error;
        }
        let mut recent = self.recent.lock().unwrap();
        recent.push_front(link.view(Some(now_ms())));
        recent.truncate(RECENT);
    }

    pub(crate) fn set_rtt(&self, us: Option<u32>) {
        self.rtt_us.store(us.map_or(0, |v| v.max(1)), Ordering::Relaxed);
    }

    fn rtt(&self) -> Option<u32> {
        Some(self.rtt_us.load(Ordering::Relaxed)).filter(|&v| v > 0)
    }

    /// Once a second: the traffic since the last tick, overall and per connection.
    pub(crate) fn tick(&self) -> Sample {
        let (rx, tx) = (self.rx.load(Ordering::Relaxed), self.tx.load(Ordering::Relaxed));
        let mut last = self.last.lock().unwrap();
        let sample = Sample {
            at: now_ms(),
            rx: rx.saturating_sub(last.0),
            tx: tx.saturating_sub(last.1),
            active: self.active.load(Ordering::Relaxed),
            rtt_us: self.rtt(),
        };
        *last = (rx, tx);
        for l in self.open.lock().unwrap().iter() {
            let (rx, tx) = (l.rx.load(Ordering::Relaxed), l.tx.load(Ordering::Relaxed));
            let mut m = l.meta.lock().unwrap();
            m.rate = (rx.saturating_sub(m.last.0), tx.saturating_sub(m.last.1));
            m.last = (rx, tx);
        }
        let mut samples = self.samples.lock().unwrap();
        samples.push_back(sample.clone());
        while samples.len() > HISTORY {
            samples.pop_front();
        }
        sample
    }

    /// The last `n` samples, for the sparkline on the tunnel list.
    pub(crate) fn tail(&self, n: usize) -> Vec<Sample> {
        let s = self.samples.lock().unwrap();
        s.iter().skip(s.len().saturating_sub(n)).cloned().collect()
    }

    pub(crate) fn monitor(&self) -> Monitor {
        Monitor {
            samples: self.samples.lock().unwrap().iter().cloned().collect(),
            open: self.open.lock().unwrap().iter().map(|l| l.view(None)).collect(),
            recent: self.recent.lock().unwrap().iter().cloned().collect(),
            rtt_us: self.rtt(),
            reconnects: self.reconnects.load(Ordering::Relaxed),
            total: self.total.load(Ordering::Relaxed),
            rx: self.rx.load(Ordering::Relaxed),
            tx: self.tx.load(Ordering::Relaxed),
        }
    }

    /// Connections from this Mac whose process is not looked up yet; marked
    /// as looked, so each one costs a single lsof at most.
    pub(crate) fn take_unresolved(&self) -> Vec<Arc<Link>> {
        self.open
            .lock()
            .unwrap()
            .iter()
            .filter(|l| {
                let mut m = l.meta.lock().unwrap();
                let todo = !m.looked && l.local.is_some() && l.peer.is_some_and(|p| is_this_mac(p.ip()));
                m.looked |= todo;
                todo
            })
            .cloned()
            .collect()
    }
}

fn is_this_mac(ip: std::net::IpAddr) -> bool {
    ip.is_loopback() || local_ips().contains(&ip)
}

/// Addresses of this Mac's interfaces, so a LAN tunnel used from this Mac
/// through its own LAN address is still looked up.
fn local_ips() -> Vec<std::net::IpAddr> {
    let mut out = Vec::new();
    unsafe {
        let mut ifs: *mut libc::ifaddrs = std::ptr::null_mut();
        if libc::getifaddrs(&mut ifs) != 0 {
            return out;
        }
        let mut cur = ifs;
        while !cur.is_null() {
            let a = (*cur).ifa_addr;
            if !a.is_null() {
                match (*a).sa_family as i32 {
                    libc::AF_INET => {
                        let sin = &*(a as *const libc::sockaddr_in);
                        out.push(std::net::IpAddr::from(u32::from_be(sin.sin_addr.s_addr).to_be_bytes()));
                    }
                    libc::AF_INET6 => {
                        let sin6 = &*(a as *const libc::sockaddr_in6);
                        out.push(std::net::IpAddr::from(sin6.sin6_addr.s6_addr));
                    }
                    _ => {}
                }
            }
            cur = (*cur).ifa_next;
        }
        libc::freeifaddrs(ifs);
    }
    out
}

/// Find the process on the client end of each connection: one lsof over the
/// tunnels' ports, matching "client->listener" socket pairs. Blocking.
pub(crate) fn resolve(links: &[Arc<Link>]) {
    let mut ports: Vec<u16> = links.iter().filter_map(|l| l.local.map(|a| a.port())).collect();
    ports.sort_unstable();
    ports.dedup();
    if ports.is_empty() {
        return;
    }
    let mut cmd = Command::new("/usr/sbin/lsof");
    cmd.args(["-nP", "-sTCP:ESTABLISHED", "-Fpn"]);
    for p in &ports {
        cmd.arg(format!("-iTCP:{p}"));
    }
    let Ok(out) = cmd.output() else { return };
    let owners = parse_lsof(&String::from_utf8_lossy(&out.stdout), std::process::id());
    for l in links {
        let (Some(peer), Some(local)) = (l.peer, l.local) else { continue };
        if let Some(&pid) = owners.get(&format!("{peer}->{local}")) {
            l.meta.lock().unwrap().process = Some(process_of(pid));
        }
    }
}

/// "local->remote" of each socket → pid, leaving out our own process.
fn parse_lsof(text: &str, own: u32) -> HashMap<String, u32> {
    let mut map = HashMap::new();
    let mut pid = 0u32;
    for line in text.lines() {
        if let Some(p) = line.strip_prefix('p') {
            pid = p.parse().unwrap_or(0);
        } else if let Some(n) = line.strip_prefix('n') {
            if pid != 0 && pid != own {
                map.insert(n.to_string(), pid);
            }
        }
    }
    map
}

fn process_of(pid: u32) -> Process {
    let mut buf = vec![0u8; 4096];
    let n = unsafe { libc::proc_pidpath(pid as i32, buf.as_mut_ptr().cast(), buf.len() as u32) };
    let path = if n > 0 { String::from_utf8_lossy(&buf[..n as usize]).into_owned() } else { String::new() };
    let (name, app) = names_of(&path);
    Process { pid, name: if name.is_empty() { format!("pid {pid}") } else { name }, app }
}

/// Executable name and outermost app bundle of a path:
/// ".../Google Chrome.app/.../Google Chrome Helper.app/.../Google Chrome Helper"
/// → ("Google Chrome Helper", Some("Google Chrome")).
fn names_of(path: &str) -> (String, Option<String>) {
    let name = path.rsplit('/').next().unwrap_or("").to_string();
    let app = path.split('/').find_map(|c| c.strip_suffix(".app")).map(str::to_string);
    (name, app)
}

/// Copy both ways until either side closes, counting bytes for the tunnel
/// and for this connection.
pub(crate) async fn pipe<S: AsyncRead + AsyncWrite + Unpin>(sock: TcpStream, mut remote: S, stats: &Arc<Stats>, link: &Arc<Link>) -> std::io::Result<()> {
    let mut local = Counted { inner: sock, stats: stats.clone(), link: link.clone() };
    tokio::io::copy_bidirectional(&mut local, &mut remote).await.map(|_| ())
}

/// The local socket, counting what it reads (sent out: tx) and writes (rx).
struct Counted {
    inner: TcpStream,
    stats: Arc<Stats>,
    link: Arc<Link>,
}

impl AsyncRead for Counted {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let r = Pin::new(&mut self.inner).poll_read(cx, buf);
        let n = (buf.filled().len() - before) as u64;
        self.stats.tx.fetch_add(n, Ordering::Relaxed);
        self.link.tx.fetch_add(n, Ordering::Relaxed);
        r
    }
}

impl AsyncWrite for Counted {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        let r = Pin::new(&mut self.inner).poll_write(cx, buf);
        if let Poll::Ready(Ok(n)) = &r {
            self.stats.rx.fetch_add(*n as u64, Ordering::Relaxed);
            self.link.rx.fetch_add(*n as u64, Ordering::Relaxed);
        }
        r
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn counts_bytes_both_ways() {
        let stats = Arc::new(Stats::default());
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let client = tokio::spawn(async move {
            let mut c = TcpStream::connect(addr).await.unwrap();
            c.write_all(b"ping!").await.unwrap();
            let mut buf = [0u8; 4];
            c.read_exact(&mut buf).await.unwrap();
            buf
        });
        let (sock, peer) = l.accept().await.unwrap();
        let link = stats.open_link(Some(peer), Some(addr), "db:5432".into());
        let (mut a, b) = tokio::io::duplex(64);
        let (st, ln) = (stats.clone(), link.clone());
        let piping = tokio::spawn(async move { pipe(sock, b, &st, &ln).await });
        let mut got = [0u8; 5];
        a.read_exact(&mut got).await.unwrap();
        a.write_all(b"pong").await.unwrap();
        assert_eq!(&client.await.unwrap(), b"pong");
        assert_eq!(&got, b"ping!");
        drop(a);
        let _ = piping.await;
        assert_eq!((stats.tx.load(Ordering::Relaxed), stats.rx.load(Ordering::Relaxed)), (5, 4));

        let s = stats.tick();
        assert_eq!((s.rx, s.tx, s.active), (4, 5, 1));
        assert_eq!(stats.monitor().open[0].rate_rx, 4);
        stats.close_link(&link, None);
        let m = stats.monitor();
        assert!(m.open.is_empty());
        assert_eq!((m.recent[0].rx, m.recent[0].tx, m.recent[0].target.as_str()), (4, 5, "db:5432"));
        assert_eq!(stats.tick().rx, 0);
    }

    #[test]
    fn keeps_fifteen_minutes() {
        let stats = Stats::default();
        for _ in 0..HISTORY + 20 {
            stats.tick();
        }
        assert_eq!(stats.monitor().samples.len(), HISTORY);
        assert_eq!(stats.tail(60).len(), 60);
    }

    #[test]
    fn reads_lsof_and_app_names() {
        let text = "p100\nn127.0.0.1:50001->127.0.0.1:15001\np200\nn127.0.0.1:15001->127.0.0.1:50001\np300\nn[::1]:50002->[::1]:15001\n";
        let map = parse_lsof(text, 200);
        assert_eq!(map.get("127.0.0.1:50001->127.0.0.1:15001"), Some(&100));
        assert_eq!(map.get("[::1]:50002->[::1]:15001"), Some(&300));
        assert!(!map.contains_key("127.0.0.1:15001->127.0.0.1:50001"));
        let peer: SocketAddr = "[::1]:50002".parse().unwrap();
        let local: SocketAddr = "[::1]:15001".parse().unwrap();
        assert!(map.contains_key(&format!("{peer}->{local}")));

        assert_eq!(
            names_of("/Applications/Google Chrome.app/Contents/Frameworks/x/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper"),
            ("Google Chrome Helper".to_string(), Some("Google Chrome".to_string()))
        );
        assert_eq!(names_of("/usr/bin/curl"), ("curl".to_string(), None));
    }

    #[test]
    fn finds_the_client_process() {
        // This test process connects to itself; the lookup skips our own pid,
        // so a child `nc` stands in for a client app.
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        let mut child = match Command::new("/usr/bin/nc").args([&addr.ip().to_string(), &addr.port().to_string()]).stdin(std::process::Stdio::piped()).spawn() {
            Ok(c) => c,
            Err(_) => return,
        };
        let (_sock, peer) = l.accept().unwrap();
        let stats = Stats::default();
        let link = stats.open_link(Some(peer), Some(addr), String::new());
        let todo = stats.take_unresolved();
        assert_eq!(todo.len(), 1);
        assert!(stats.take_unresolved().is_empty());
        resolve(&todo);
        let p = link.meta.lock().unwrap().process.clone();
        let _ = child.kill();
        let p = p.expect("nc found");
        assert_eq!((p.pid, p.name.as_str()), (child.id(), "nc"));
    }
}
