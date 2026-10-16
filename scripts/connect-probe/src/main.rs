//! Throwaway probe for Portway Connect. Answers, on real machines:
//!   1. which network profile / interfaces does this OS see (cable vs Wi-Fi)?
//!   2. can this machine see itself over mDNS (proxy for "local network permission granted")?
//!   3. does a peer show up over mDNS, and on how many paths (cable + Wi-Fi => twice)?
//!   4. does a plain TCP connect to the peer work on each address, and how fast?
//!
//! Run the same binary on both machines:  connect-probe [--peer IP] [--port N]
//! Nothing is written to disk. Ctrl+C to stop.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};

const SERVICE: &str = "_portway-probe._tcp.local.";
const DEFAULT_PORT: u16 = 47615;

#[derive(Default)]
struct Seen {
    // peer id -> addresses announced over mDNS
    peers: BTreeMap<String, BTreeSet<String>>,
    // peer id -> (hostname)
    hosts: BTreeMap<String, String>,
}

fn main() {
    let mut port = DEFAULT_PORT;
    let mut manual: Vec<String> = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--port" => port = args.next().and_then(|v| v.parse().ok()).unwrap_or(DEFAULT_PORT),
            "--peer" => {
                if let Some(v) = args.next() {
                    manual.push(v)
                }
            }
            _ => {}
        }
    }

    let id = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
    let os = std::env::consts::OS;
    println!("== connect-probe  id={id}  os={os}  port={port}");

    section("1. Interfaces");
    let ifaces = list_interfaces();
    for (name, ip, kind) in &ifaces {
        println!("  {name:<22} {ip:<40} {kind}");
    }
    os_specific();

    section("2. TCP listener");
    match TcpListener::bind(("0.0.0.0", port)) {
        Ok(l) => {
            println!("  listening on 0.0.0.0:{port}");
            println!("  (a firewall prompt now = the OS wants a decision; note what it says)");
            let id2 = id.clone();
            thread::spawn(move || serve(l, id2));
        }
        Err(e) => println!("  FAILED to bind: {e}"),
    }

    section("3. mDNS");
    let seen = Arc::new(Mutex::new(Seen::default()));
    let daemon = ServiceDaemon::new().expect("mDNS daemon");
    let host = format!("probe-{id}.local.");
    let props = [("id", id.as_str()), ("os", os)];
    match ServiceInfo::new(SERVICE, &id, &host, "", port, &props[..]) {
        Ok(info) => {
            if let Err(e) = daemon.register(info.enable_addr_auto()) {
                println!("  register FAILED: {e}");
            } else {
                println!("  advertising {id} on {SERVICE}");
            }
        }
        Err(e) => println!("  service info FAILED: {e}"),
    }
    let rx = daemon.browse(SERVICE).expect("browse");
    {
        let seen = seen.clone();
        let me = id.clone();
        thread::spawn(move || {
            let t0 = Instant::now();
            while let Ok(ev) = rx.recv() {
                if let ServiceEvent::ServiceResolved(info) = ev {
                    let pid = info.get_property_val_str("id").unwrap_or("?").to_string();
                    let addrs: Vec<String> = info.get_addresses().iter().map(|a| a.to_string()).collect();
                    let who = if pid == me { "SELF" } else { "PEER" };
                    println!(
                        "  [{:>5.1}s] {who} {pid} host={} os={} addrs={:?}",
                        t0.elapsed().as_secs_f32(),
                        info.get_hostname(),
                        info.get_property_val_str("os").unwrap_or("?"),
                        addrs
                    );
                    let mut s = seen.lock().unwrap();
                    s.hosts.insert(pid.clone(), info.get_hostname().to_string());
                    s.peers.entry(pid).or_default().extend(addrs);
                }
            }
        });
    }

    section("4. Reachability (every 4 s)");
    println!("  waiting for the other machine; start the same binary there");
    let t0 = Instant::now();
    let mut self_report_done = false;
    loop {
        thread::sleep(Duration::from_secs(4));
        let snapshot: Vec<(String, BTreeSet<String>)> = {
            let s = seen.lock().unwrap();
            s.peers.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
        };
        let saw_self = snapshot.iter().any(|(k, _)| *k == id);
        if !self_report_done && t0.elapsed() > Duration::from_secs(8) {
            self_report_done = true;
            println!(
                "  [self-check] mDNS sees myself: {}",
                if saw_self { "YES" } else { "NO  <- multicast blocked or no local-network permission?" }
            );
        }
        let mut any = false;
        for (pid, addrs) in &snapshot {
            if *pid == id {
                continue;
            }
            any = true;
            let v4: Vec<&String> = addrs.iter().filter(|a| a.parse::<Ipv4Addr>().is_ok()).collect();
            println!("  peer {pid}: {} address(es) over mDNS{}", addrs.len(), if v4.len() > 1 { "  <- appears on multiple paths" } else { "" });
            for a in addrs {
                if let Ok(ip) = a.parse::<IpAddr>() {
                    if ip.is_ipv4() {
                        println!("    {a:<18} {}", tcp_rtt(&SocketAddr::new(ip, port)));
                    } else {
                        println!("    {a:<18} (IPv6, not tried)");
                    }
                }
            }
        }
        if !any && manual.is_empty() {
            println!("  no peer seen over mDNS yet");
        }
        for m in &manual {
            if let Ok(ip) = m.parse::<IpAddr>() {
                println!("  manual {m}: {}", tcp_rtt(&SocketAddr::new(ip, port)));
            }
        }
    }
}

fn section(t: &str) {
    println!("\n-- {t}");
}

fn list_interfaces() -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    if let Ok(list) = if_addrs::get_if_addrs() {
        for i in list {
            let ip = i.ip();
            if ip.is_loopback() {
                continue;
            }
            let kind = match ip {
                IpAddr::V4(v4) if v4.octets()[0] == 169 && v4.octets()[1] == 254 => "IPv4 link-local (169.254)".to_string(),
                IpAddr::V4(v4) => {
                    let o = v4.octets();
                    let private = o[0] == 10 || (o[0] == 172 && (16..32).contains(&o[1])) || (o[0] == 192 && o[1] == 168);
                    format!("IPv4 {}", if private { "private" } else { "other" })
                }
                IpAddr::V6(v6) if (v6.segments()[0] & 0xffc0) == 0xfe80 => "IPv6 link-local".to_string(),
                IpAddr::V6(_) => "IPv6".to_string(),
            };
            out.push((i.name, ip.to_string(), kind));
        }
    }
    out
}

fn os_specific() {
    #[cfg(windows)]
    {
        println!("\n  Windows network profile (Public blocks inbound by default):");
        run(
            "powershell",
            &["-NoProfile", "-Command", "Get-NetConnectionProfile | Format-Table InterfaceAlias,NetworkCategory,IPv4Connectivity -AutoSize | Out-String -Width 200"],
        );
        println!("  Adapters:");
        run(
            "powershell",
            &["-NoProfile", "-Command", "Get-NetAdapter | Where-Object Status -eq Up | Format-Table Name,InterfaceDescription,LinkSpeed,MacAddress -AutoSize | Out-String -Width 200"],
        );
    }
    #[cfg(target_os = "macos")]
    {
        println!("\n  Service order (top = preferred route):");
        run("networksetup", &["-listnetworkserviceorder"]);
    }
}

fn run(cmd: &str, args: &[&str]) {
    match Command::new(cmd).args(args).output() {
        Ok(o) => {
            for l in String::from_utf8_lossy(&o.stdout).lines().filter(|l| !l.trim().is_empty()) {
                println!("    {l}");
            }
        }
        Err(e) => println!("    ({cmd} failed: {e})"),
    }
}

fn serve(l: TcpListener, id: String) {
    for s in l.incoming().flatten() {
        let id = id.clone();
        thread::spawn(move || {
            let mut s = s;
            let mut buf = [0u8; 16];
            let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
            if s.read(&mut buf).is_ok() {
                let _ = s.write_all(format!("pong {id}\n").as_bytes());
            }
        });
    }
}

fn tcp_rtt(addr: &SocketAddr) -> String {
    let t = Instant::now();
    match TcpStream::connect_timeout(addr, Duration::from_secs(2)) {
        Ok(mut s) => {
            let connect = t.elapsed();
            let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
            let _ = s.write_all(b"ping\n");
            let mut b = [0u8; 32];
            let ok = s.read(&mut b).map(|n| n > 0).unwrap_or(false);
            format!("TCP OK connect={:.1} ms{}", connect.as_secs_f64() * 1000.0, if ok { "" } else { " (no reply)" })
        }
        Err(e) => format!("TCP FAIL ({e})"),
    }
}
