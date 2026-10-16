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

/// A network card of this machine with an IPv4 address.
#[derive(Debug, Clone, PartialEq)]
pub struct Card {
    pub name: String,
    pub ip: Ipv4Addr,
    pub mask: Ipv4Addr,
}

pub fn cards() -> Vec<Card> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|i| match i.addr {
            if_addrs::IfAddr::V4(v4) if !v4.ip.is_loopback() => Some(Card { name: i.name, ip: v4.ip, mask: v4.netmask }),
            _ => None,
        })
        .collect()
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

#[cfg(test)]
mod tests {
    use super::*;

    fn card(name: &str, ip: [u8; 4], mask: [u8; 4]) -> Card {
        Card { name: name.into(), ip: ip.into(), mask: mask.into() }
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
}
