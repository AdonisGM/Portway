//! Network side of Connect: which of this machine's networks an address is on,
//! how long a TCP connection to it takes, and why one failed.

use serde::Serialize;
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4};
use std::time::{Duration, Instant};
use tokio::net::TcpStream;

/// Port Connect listens on; another one is used when it is taken.
pub const DEFAULT_PORT: u16 = 47615;
/// mDNS service type Portways announce themselves under.
/// The mDNS TXT `s` value of a machine that only answers as a beacon, before anyone has signed in.
pub const BEACON_STATE: &str = "login";

pub const SERVICE: &str = "_portway._tcp.local.";

/// Why a connection to another machine did not happen. The first three are
/// told apart because each has a different fix, and on a different machine:
/// `Timeout` is usually the other machine's firewall dropping packets,
/// `NoRoute` is usually this Mac not having the Local Network permission,
/// `Refused` means nothing listens there (Connect is off, or Portway is closed).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Fail {
    Timeout,
    NoRoute,
    Refused,
    Other,
}

impl Fail {
    pub fn classify(e: &io::Error) -> Fail {
        match e.kind() {
            io::ErrorKind::TimedOut => return Fail::Timeout,
            io::ErrorKind::ConnectionRefused => return Fail::Refused,
            _ => {}
        }
        match e.raw_os_error() {
            // EHOSTUNREACH / ENETUNREACH on macOS and Linux, WSAEHOSTUNREACH / WSAENETUNREACH on Windows.
            Some(65) | Some(51) | Some(113) | Some(101) | Some(10065) | Some(10051) => Fail::NoRoute,
            Some(10061) => Fail::Refused,
            Some(10060) => Fail::Timeout,
            _ => Fail::Other,
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            Fail::Timeout => "connect_timeout",
            Fail::NoRoute => "connect_no_route",
            Fail::Refused => "connect_refused",
            Fail::Other => "connect_failed",
        }
    }
}

pub async fn connect(addr: SocketAddr, timeout: Duration) -> Result<TcpStream, Fail> {
    match tokio::time::timeout(timeout, TcpStream::connect(addr)).await {
        Err(_) => Err(Fail::Timeout),
        Ok(Err(e)) => Err(Fail::classify(&e)),
        Ok(Ok(s)) => {
            let _ = s.set_nodelay(true);
            Ok(s)
        }
    }
}

/// How long opening a TCP connection takes; the connection is closed again.
pub async fn tcp_rtt(addr: SocketAddr, timeout: Duration) -> Result<Duration, Fail> {
    let t = Instant::now();
    connect(addr, timeout).await.map(|_| t.elapsed())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Ethernet,
    Wifi,
    Other,
}

impl Kind {
    pub fn code(self) -> &'static str {
        match self {
            Kind::Ethernet => "ethernet",
            Kind::Wifi => "wifi",
            Kind::Other => "other",
        }
    }
}

/// A network card of this machine with an IPv4 address.
#[derive(Debug, Clone, PartialEq)]
pub struct Card {
    /// What the system calls it to the user: "Ethernet", "Wi-Fi" on Windows, a
    /// display name on macOS, else the interface name ("en0").
    pub name: String,
    /// The system's own name for the interface ("en0"; a GUID on Windows).
    pub ifname: String,
    pub ip: Ipv4Addr,
    pub mask: Ipv4Addr,
    pub mac: Option<[u8; 6]>,
    pub kind: Kind,
    /// Real hardware, not a bridge, tunnel or virtual switch.
    pub physical: bool,
    /// Negotiated link speed in Mbit/s, when the system reports one.
    pub mbps: Option<u32>,
}

/// macOS hands the placeholder 02:00:00:00:00:00 to a process that has no
/// Local Network permission (`getifaddrs` and so `ifconfig` run by it, too), so
/// there the real addresses come from `networksetup`, which still answers.
fn real_mac(ifname: &str, reported: Option<[u8; 6]>) -> Option<[u8; 6]> {
    let placeholder = [2, 0, 0, 0, 0, 0];
    match reported {
        Some(m) if m != [0; 6] && m != placeholder => Some(m),
        _ if cfg!(target_os = "macos") => hardware_port_mac(ifname),
        _ => None,
    }
}

fn hardware_port_mac(ifname: &str) -> Option<[u8; 6]> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<HashMap<String, [u8; 6]>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(hit) = cache.lock().unwrap().get(ifname) {
        return Some(*hit);
    }
    // One run fills in every interface; an interface it does not list is asked again next time.
    let out = std::process::Command::new("networksetup").arg("-listallhardwareports").output().ok()?;
    let found = hardware_ports(&String::from_utf8_lossy(&out.stdout));
    let mut cache = cache.lock().unwrap();
    cache.extend(found);
    cache.get(ifname).copied()
}

/// (device, address) pairs from `networksetup -listallhardwareports`.
fn hardware_ports(text: &str) -> Vec<(String, [u8; 6])> {
    let mut out = Vec::new();
    let mut device: Option<String> = None;
    for line in text.lines() {
        if let Some(d) = line.strip_prefix("Device: ") {
            device = Some(d.trim().to_string());
        } else if let (Some(addr), Some(d)) = (line.strip_prefix("Ethernet Address: "), device.take()) {
            if let Some(mac) = parse_mac(addr) {
                out.push((d, mac));
            }
        }
    }
    out
}

pub fn cards() -> Vec<Card> {
    let mut out = Vec::new();
    for i in netdev::get_interfaces() {
        if i.is_loopback() || !i.is_up() {
            continue;
        }
        let kind = match i.if_type {
            netdev::prelude::InterfaceType::Ethernet => Kind::Ethernet,
            netdev::prelude::InterfaceType::Wireless80211 => Kind::Wifi,
            _ => Kind::Other,
        };
        let physical = i.is_physical();
        let mbps = i.transmit_speed.filter(|b| *b > 0).map(|b| (b / 1_000_000).min(u32::MAX as u64) as u32);
        let mac = real_mac(&i.name, i.mac_addr.map(|m| m.octets()));
        let name = i.friendly_name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| i.name.clone());
        for net in &i.ipv4 {
            if net.addr().is_loopback() {
                continue;
            }
            out.push(Card { name: name.clone(), ifname: i.name.clone(), ip: net.addr(), mask: net.netmask(), mac, kind, physical, mbps });
        }
    }
    out
}

/// The card of `cards` whose network `ip` is on, if any.
pub fn card_for(cards: &[Card], ip: Ipv4Addr) -> Option<&Card> {
    let target = u32::from(ip);
    cards.iter().find(|c| {
        let mask = u32::from(c.mask);
        mask != 0 && (u32::from(c.ip) & mask) == (target & mask)
    })
}

/// "10.10.10.0/24" for a card.
pub fn network_of(card: &Card) -> String {
    let mask = u32::from(card.mask);
    format!("{}/{}", Ipv4Addr::from(u32::from(card.ip) & mask), mask.count_ones())
}

/// "10.10.10.2" or "10.10.10.2:47615"; the port falls back to `default_port`.
pub fn parse_addr(text: &str, default_port: u16) -> Option<SocketAddrV4> {
    let text = text.trim();
    if let Ok(a) = text.parse::<SocketAddrV4>() {
        return Some(a);
    }
    match text.parse::<IpAddr>().ok()? {
        IpAddr::V4(ip) if !ip.is_unspecified() && !ip.is_multicast() => Some(SocketAddrV4::new(ip, default_port)),
        _ => None,
    }
}

/// A name for this machine: the one shown in Sharing settings on macOS, the
/// computer name on Windows.
pub fn device_name() -> String {
    #[cfg(target_os = "macos")]
    if let Ok(out) = std::process::Command::new("scutil").args(["--get", "ComputerName"]).output() {
        let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !name.is_empty() {
            return name;
        }
    }
    std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).ok().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| "Portway".to_string())
}

/// "aa:bb:cc:dd:ee:ff"
pub fn format_mac(mac: [u8; 6]) -> String {
    mac.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(":")
}

pub fn parse_mac(text: &str) -> Option<[u8; 6]> {
    let parts: Vec<&str> = text.trim().split([':', '-']).collect();
    if parts.len() != 6 {
        return None;
    }
    let mut mac = [0u8; 6];
    for (i, p) in parts.iter().enumerate() {
        if p.len() != 2 {
            return None;
        }
        mac[i] = u8::from_str_radix(p, 16).ok()?;
    }
    Some(mac)
}

/// The cards another machine can be woken through: real wired or Wi-Fi
/// hardware with a MAC, one entry per MAC. Sent to paired machines so they can
/// wake this one. Wi-Fi is listed because some machines do wake over it, but
/// wired is what Wake-on-LAN is made for.
pub fn wake_cards(cards: &[Card]) -> Vec<(String, String, Kind)> {
    let mut seen = std::collections::BTreeSet::new();
    cards
        .iter()
        .filter(|c| c.physical && matches!(c.kind, Kind::Ethernet | Kind::Wifi))
        .filter_map(|c| c.mac.map(|m| (format_mac(m), c.name.clone(), c.kind)))
        .filter(|(mac, _, _)| seen.insert(mac.clone()))
        .collect()
}

/// The magic packet: six 0xFF bytes, then the MAC sixteen times.
pub fn magic_packet(mac: [u8; 6]) -> [u8; 102] {
    let mut p = [0xFFu8; 102];
    for i in 0..16 {
        p[6 + i * 6..12 + i * 6].copy_from_slice(&mac);
    }
    p
}

/// Broadcast a magic packet out of every card with an address on a real
/// network, to both the limited broadcast and the card's own subnet broadcast
/// (a socket bound to the card's address picks the card). Returns how many
/// packets were sent.
pub fn send_wake(cards: &[Card], mac: [u8; 6]) -> usize {
    let packet = magic_packet(mac);
    let mut sent = 0;
    for c in cards {
        let o = c.ip.octets();
        if (o[0] == 169 && o[1] == 254) || c.mask.is_unspecified() {
            continue;
        }
        let Ok(sock) = std::net::UdpSocket::bind((c.ip, 0)) else { continue };
        if sock.set_broadcast(true).is_err() {
            continue;
        }
        let subnet = Ipv4Addr::from(u32::from(c.ip) | !u32::from(c.mask));
        for to in [Ipv4Addr::BROADCAST, subnet] {
            for port in [9u16, 7] {
                if sock.send_to(&packet, (to, port)).is_ok() {
                    sent += 1;
                }
            }
        }
    }
    sent
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(name: &str, ip: [u8; 4], mask: [u8; 4]) -> Card {
        Card { name: name.into(), ifname: name.into(), ip: ip.into(), mask: mask.into(), mac: None, kind: Kind::Other, physical: true, mbps: None }
    }

    #[test]
    fn finds_the_card_an_address_is_reached_through() {
        let cards = [card("en0", [10, 10, 10, 1], [255, 255, 255, 0]), card("en1", [192, 168, 50, 214], [255, 255, 255, 0])];
        assert_eq!(card_for(&cards, "10.10.10.2".parse().unwrap()).map(|c| c.name.as_str()), Some("en0"));
        assert_eq!(card_for(&cards, "192.168.50.49".parse().unwrap()).map(|c| c.name.as_str()), Some("en1"));
        assert_eq!(card_for(&cards, "172.16.0.9".parse().unwrap()), None);
        assert_eq!(network_of(&cards[0]), "10.10.10.0/24");
        assert_eq!(network_of(&cards[1]), "192.168.50.0/24");
    }

    #[test]
    fn parses_manual_addresses() {
        let p = |s: &str| parse_addr(s, 47615).map(|a| a.to_string());
        assert_eq!(p("10.10.10.2").as_deref(), Some("10.10.10.2:47615"));
        assert_eq!(p(" 10.10.10.2:5000 ").as_deref(), Some("10.10.10.2:5000"));
        assert_eq!(p("fe80::1"), None);
        assert_eq!(p("0.0.0.0"), None);
        assert_eq!(p("224.0.0.251"), None);
        assert_eq!(p("not an ip"), None);
    }

    #[test]
    fn tells_failures_apart() {
        let os = |n: i32| Fail::classify(&io::Error::from_raw_os_error(n));
        assert_eq!(Fail::classify(&io::ErrorKind::TimedOut.into()), Fail::Timeout);
        assert_eq!(Fail::classify(&io::ErrorKind::ConnectionRefused.into()), Fail::Refused);
        assert_eq!(os(65), Fail::NoRoute);
        assert_eq!(os(10065), Fail::NoRoute);
        assert_eq!(os(10060), Fail::Timeout);
        assert_eq!(os(2), Fail::Other);
    }

    #[tokio::test]
    async fn connect_to_a_closed_port_is_refused() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        drop(l);
        assert_eq!(connect(addr, Duration::from_secs(1)).await.err(), Some(Fail::Refused));
    }

    #[test]
    fn magic_packet_layout() {
        let mac = [0x8c, 0x32, 0x23, 0x4f, 0x10, 0x2d];
        let p = magic_packet(mac);
        assert_eq!(p.len(), 102);
        assert!(p[..6].iter().all(|b| *b == 0xFF));
        for i in 0..16 {
            assert_eq!(p[6 + i * 6..12 + i * 6], mac);
        }
    }

    #[test]
    fn reads_hardware_ports_from_networksetup() {
        let out = "Hardware Port: Ethernet\nDevice: en0\nEthernet Address: 00:c5:85:00:64:4e\n\nHardware Port: Wi-Fi\nDevice: en1\nEthernet Address: 00:c5:85:0e:dc:b1\n\nVLAN Configurations\n===================\n";
        let ports = hardware_ports(out);
        assert_eq!(ports, vec![("en0".to_string(), [0x00, 0xc5, 0x85, 0x00, 0x64, 0x4e]), ("en1".to_string(), [0x00, 0xc5, 0x85, 0x0e, 0xdc, 0xb1])]);
        assert!(hardware_ports("Device: en9\nEthernet Address: N/A\n").is_empty());
    }

    #[test]
    fn mac_text_round_trip() {
        let mac = [0x8c, 0x32, 0x23, 0x4f, 0x10, 0x2d];
        assert_eq!(format_mac(mac), "8c:32:23:4f:10:2d");
        assert_eq!(parse_mac("8c:32:23:4f:10:2d"), Some(mac));
        assert_eq!(parse_mac("8C-32-23-4F-10-2D"), Some(mac));
        assert_eq!(parse_mac("8c:32:23:4f:10"), None);
        assert_eq!(parse_mac("zz:32:23:4f:10:2d"), None);
        assert_eq!(parse_mac("8c:32:23:4f:10:2dd"), None);
    }

    #[test]
    fn wake_cards_skip_virtual_and_duplicates() {
        let mac = Some([1, 2, 3, 4, 5, 6]);
        let eth = Card { mac, kind: Kind::Ethernet, ..card("Ethernet", [10, 0, 0, 1], [255, 255, 255, 0]) };
        let eth_again = Card { ip: [10, 0, 1, 1].into(), ..eth.clone() };
        let bridge = Card { physical: false, mac: Some([9, 9, 9, 9, 9, 9]), kind: Kind::Ethernet, ..card("bridge0", [10, 0, 2, 1], [255, 255, 255, 0]) };
        let no_mac = Card { kind: Kind::Ethernet, ..card("usb", [10, 0, 3, 1], [255, 255, 255, 0]) };
        let found = wake_cards(&[eth, eth_again, bridge, no_mac]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, "01:02:03:04:05:06");
    }

    /// Run by hand to see what this machine reports:
    /// `cargo test print_cards -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn print_cards() {
        let cards = cards();
        for c in &cards {
            println!("{:<22} {:<16} {:<10?} physical={} mac={}", c.name, c.ip, c.kind, c.physical, c.mac.map(format_mac).unwrap_or_default());
        }
        println!("wake cards: {:?}", wake_cards(&cards));
    }
}
