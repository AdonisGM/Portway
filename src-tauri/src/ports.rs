//! Listening sockets, UFW rules and the warnings drawn from comparing them.
//! Sockets come from /proc/net (present on every Linux, unlike ss/netstat);
//! owning processes from /proc/<pid>/fd, readable for other users only as root.

use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::net::{Ipv4Addr, Ipv6Addr};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    Loopback,
    Private,
    Public,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listen {
    pub proto: String,
    pub port: u16,
    /// The most exposed address this port is bound on ("0.0.0.0", "127.0.0.1", "::"…).
    pub bind: String,
    pub scope: Scope,
    /// Process name; None when it belongs to another user and we are not root.
    pub process: Option<String>,
    /// Docker container publishing this port, if any.
    pub container: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UfwRule {
    /// As ufw prints it: "22/tcp", "Nginx Full", "6000:6010/udp".
    pub to: String,
    /// "ALLOW IN", "DENY IN", "REJECT IN", "LIMIT IN"…
    pub action: String,
    pub from: String,
    /// Present for both IPv4 and IPv6.
    pub both: bool,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Firewall {
    /// ufw is not installed (firewalld/nftables are not read yet).
    NotInstalled,
    NeedsRoot,
    /// ufw ran but failed (e.g. no permission to read iptables in a container).
    Error { detail: String },
    Inactive,
    Active { default_incoming: String, rules: Vec<UfwRule> },
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum PortWarning {
    /// A database listens on a public address.
    /// `guessed`: recognised by its usual port only, not by the process name.
    DatabasePublic { name: String, port: u16, bind: String, via: Option<String>, docker: bool, guessed: bool },
    /// Docker publishes the port through iptables, before UFW sees it.
    DockerBypass { port: u16, container: String },
    /// UFW limits the sources of a port Docker publishes to everyone.
    RuleIneffective { port: u16, from: String, container: String },
    /// UFW allows a port nothing listens on.
    RuleUnused { to: String },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ports {
    pub listening: Vec<Listen>,
    pub firewall: Firewall,
    pub warnings: Vec<PortWarning>,
    /// False when sockets of other users could not be mapped to processes.
    pub processes_complete: bool,
}

pub const PORTS_SCRIPT: &str = r#"
for f in tcp tcp6 udp udp6; do echo "@@NET $f"; cat /proc/net/$f 2>/dev/null; done
echo @@PORTWAY@@
ls -l /proc/[0-9]*/fd 2>/dev/null | grep -E '^/proc|socket:'
echo @@PORTWAY@@
awk '{print FILENAME, $0}' /proc/[0-9]*/comm 2>/dev/null
echo @@PORTWAY@@
id -u
echo @@PORTWAY@@
if command -v ufw >/dev/null 2>&1; then ufw status verbose 2>&1; else echo notinstalled; fi
echo @@PORTWAY@@
docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null
"#;

/// Hex address from /proc/net: IPv4 is one little-endian u32, IPv6 four of them.
fn decode_addr(hex: &str) -> Option<String> {
    match hex.len() {
        8 => Some(Ipv4Addr::from(u32::from_str_radix(hex, 16).ok()?.swap_bytes()).to_string()),
        32 => {
            let mut bytes = [0u8; 16];
            for i in 0..4 {
                let word = u32::from_str_radix(&hex[i * 8..i * 8 + 8], 16).ok()?.swap_bytes();
                bytes[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
            }
            let v6 = Ipv6Addr::from(bytes);
            Some(match v6.to_ipv4_mapped() {
                Some(v4) => v4.to_string(),
                None => v6.to_string(),
            })
        }
        _ => None,
    }
}

fn scope_of(addr: &str) -> Scope {
    if let Ok(v4) = addr.parse::<Ipv4Addr>() {
        return if v4.is_loopback() {
            Scope::Loopback
        } else if v4.is_unspecified() {
            Scope::Public
        } else if v4.is_private() || v4.is_link_local() {
            Scope::Private
        } else {
            Scope::Public
        };
    }
    if let Ok(v6) = addr.parse::<Ipv6Addr>() {
        let seg = v6.segments()[0];
        return if v6.is_loopback() {
            Scope::Loopback
        } else if v6.is_unspecified() {
            Scope::Public
        } else if (seg & 0xfe00) == 0xfc00 || (seg & 0xffc0) == 0xfe80 {
            Scope::Private
        } else {
            Scope::Public
        };
    }
    Scope::Public
}

/// (proto, addr, port, inode) of listening sockets.
fn parse_net(section: &str) -> Vec<(String, String, u16, String)> {
    let mut out = Vec::new();
    for block in section.split("@@NET ").skip(1) {
        let mut lines = block.lines();
        let file = lines.next().unwrap_or("").trim();
        let proto = if file.starts_with("tcp") { "tcp" } else { "udp" };
        for line in lines.skip(1) {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() < 10 {
                continue;
            }
            let (Some((addr, port)), rem, st) = (f[1].split_once(':'), f[2], f[3]) else { continue };
            // TCP LISTEN is 0A; an unconnected UDP socket (07) with no peer is a listener.
            let listening = if proto == "tcp" { st == "0A" } else { st == "07" && rem.ends_with(":0000") };
            if !listening {
                continue;
            }
            let (Some(addr), Ok(port)) = (decode_addr(addr), u16::from_str_radix(port, 16)) else { continue };
            out.push((proto.to_string(), addr, port, f[9].to_string()));
        }
    }
    out
}

/// inode -> pid from `ls -l /proc/*/fd` output.
fn parse_fd_links(section: &str) -> HashMap<String, u32> {
    let mut out = HashMap::new();
    let mut pid = None;
    for line in section.lines() {
        if let Some(rest) = line.strip_prefix("/proc/") {
            pid = rest.split('/').next().and_then(|p| p.parse().ok());
        } else if let (Some(p), Some(i)) = (pid, line.find("socket:[")) {
            let inode = line[i + 8..].trim_end_matches(']').trim_end_matches(|c: char| !c.is_ascii_digit());
            out.insert(inode.to_string(), p);
        }
    }
    out
}

fn parse_comms(section: &str) -> HashMap<u32, String> {
    section
        .lines()
        .filter_map(|l| {
            let (file, name) = l.split_once(' ')?;
            Some((file.strip_prefix("/proc/")?.split('/').next()?.parse().ok()?, name.trim().to_string()))
        })
        .collect()
}

pub fn parse_ufw(section: &str) -> Firewall {
    let text = section.trim();
    if text == "notinstalled" {
        return Firewall::NotInstalled;
    }
    if text.contains("You need to be root") {
        return Firewall::NeedsRoot;
    }
    if text.starts_with("ERROR") {
        return Firewall::Error { detail: text.lines().next().unwrap_or(text).to_string() };
    }
    if text.lines().any(|l| l.trim() == "Status: inactive") {
        return Firewall::Inactive;
    }
    let default_incoming = text
        .lines()
        .find_map(|l| l.strip_prefix("Default: "))
        .and_then(|d| d.split(',').find(|p| p.contains("(incoming)")))
        .map(|p| p.replace("(incoming)", "").trim().to_string())
        .unwrap_or_default();
    let mut rules: Vec<UfwRule> = Vec::new();
    let mut in_table = false;
    for line in text.lines() {
        if line.starts_with("--") {
            in_table = true;
            continue;
        }
        if !in_table || line.trim().is_empty() {
            continue;
        }
        // Columns are separated by runs of two or more spaces.
        let cols: Vec<&str> = line.split("  ").map(str::trim).filter(|c| !c.is_empty()).collect();
        if cols.len() < 3 {
            continue;
        }
        let to = cols[0].trim_end_matches("(v6)").trim().to_string();
        let from = cols[2].trim_end_matches("(v6)").trim().to_string();
        let action = cols[1].to_string();
        match rules.iter_mut().find(|r| r.to == to && r.action == action && r.from == from) {
            Some(r) => r.both = true,
            None => rules.push(UfwRule { to, action, from, both: false }),
        }
    }
    Firewall::Active { default_incoming, rules }
}

/// Ports of a numeric UFW rule ("22/tcp", "80,443/tcp", "6000:6010/udp");
/// None for app profiles like "Nginx Full".
fn rule_ports(to: &str) -> Option<Vec<(u16, u16)>> {
    let spec = to.split('/').next()?;
    spec.split(',')
        .map(|p| {
            let (a, b) = p.split_once(':').unwrap_or((p, p));
            Some((a.trim().parse().ok()?, b.trim().parse().ok()?))
        })
        .collect()
}

/// Docker "0.0.0.0:8080->8080/tcp, :::8080->8080/tcp" -> (host ip, host port, container port).
fn parse_docker_ports(section: &str) -> Vec<(String, String, u16, u16)> {
    let mut out = Vec::new();
    for line in section.lines() {
        let Some((name, ports)) = line.split_once('\t') else { continue };
        for mapping in ports.split(", ") {
            let Some((host, target)) = mapping.split_once("->") else { continue };
            let Some((ip, port)) = host.rsplit_once(':') else { continue };
            let (Ok(port), Some(Ok(target))) = (port.parse(), target.split('/').next().map(str::parse)) else { continue };
            let ip = ip.trim_matches(|c| c == '[' || c == ']');
            out.push((name.to_string(), if ip.is_empty() { "::".into() } else { ip.to_string() }, port, target));
        }
    }
    out
}

const DATABASES: [(&str, &[&str], u16); 8] = [
    ("Postgres", &["postgres"], 5432),
    ("MySQL", &["mysqld", "mariadbd"], 3306),
    ("MongoDB", &["mongod"], 27017),
    ("Redis", &["redis-server"], 6379),
    ("Memcached", &["memcached"], 11211),
    ("Elasticsearch", &["elasticsearch"], 9200),
    ("ClickHouse", &["clickhouse-serv"], 8123),
    ("CouchDB", &["beam.smp"], 5984),
];

/// Database name and whether it was only guessed from the port.
fn database_name(process: Option<&str>, port: u16) -> Option<(&'static str, bool)> {
    let by_process = DATABASES.iter().find(|(_, procs, _)| process.is_some_and(|n| procs.iter().any(|x| n.starts_with(x))));
    if let Some((name, _, _)) = by_process {
        return Some((name, false));
    }
    DATABASES.iter().find(|(_, _, p)| *p == port).map(|(name, _, _)| (*name, true))
}

pub fn parse_ports(text: &str) -> Ports {
    let parts: Vec<&str> = text.split(crate::ssh::MARK).collect();
    let get = |i: usize| parts.get(i).copied().unwrap_or("");
    let sockets = parse_net(get(0));
    let inodes = parse_fd_links(get(1));
    let comms = parse_comms(get(2));
    let root = get(3).trim() == "0";
    let firewall = parse_ufw(get(4));
    let docker = parse_docker_ports(get(5));

    // One entry per proto+port, keeping the most exposed address.
    let mut by_port: BTreeMap<(u16, String), Listen> = BTreeMap::new();
    let mut unmapped = false;
    for (proto, addr, port, inode) in sockets {
        let process = inodes.get(&inode).and_then(|pid| comms.get(pid)).cloned();
        unmapped |= process.is_none();
        let container = docker.iter().find(|d| d.2 == port).map(|d| d.0.clone());
        let scope = scope_of(&addr);
        let entry = by_port.entry((port, proto.clone())).or_insert(Listen {
            proto,
            port,
            bind: addr.clone(),
            scope,
            process: process.clone(),
            container: container.clone(),
        });
        let rank = |s: Scope| match s {
            Scope::Loopback => 0,
            Scope::Private => 1,
            Scope::Public => 2,
        };
        if rank(scope) > rank(entry.scope) {
            entry.scope = scope;
            entry.bind = addr;
        }
        entry.process = entry.process.take().or(process);
    }
    let listening: Vec<Listen> = by_port.into_values().collect();

    let mut warnings = Vec::new();
    for l in listening.iter().filter(|l| l.scope == Scope::Public && l.proto == "tcp") {
        let target = docker.iter().find(|d| d.2 == l.port).map(|d| d.3).unwrap_or(l.port);
        // Inside a container the process is docker-proxy; the container port says more.
        let process = if l.container.is_some() { None } else { l.process.as_deref() };
        if let Some((name, guessed)) = database_name(process, target) {
            warnings.push(PortWarning::DatabasePublic {
                name: name.to_string(),
                port: l.port,
                bind: l.bind.clone(),
                via: l.container.clone().or_else(|| l.process.clone()),
                docker: l.container.is_some(),
                guessed: guessed && l.container.is_none(),
            });
        }
    }
    if let Firewall::Active { rules, .. } = &firewall {
        let published: Vec<&(String, String, u16, u16)> = docker.iter().filter(|d| scope_of(&d.1) == Scope::Public).collect();
        let mut seen = Vec::new();
        for (container, _, port, _) in &published {
            if seen.contains(port) {
                continue;
            }
            seen.push(*port);
            let scoped = rules.iter().find(|r| {
                r.action.starts_with("ALLOW")
                    && r.from != "Anywhere"
                    && rule_ports(&r.to).is_some_and(|ps| ps.iter().any(|(a, b)| (*a..=*b).contains(port)))
            });
            match scoped {
                Some(r) => warnings.push(PortWarning::RuleIneffective { port: *port, from: r.from.clone(), container: container.clone() }),
                None => warnings.push(PortWarning::DockerBypass { port: *port, container: container.clone() }),
            }
        }
        for r in rules.iter().filter(|r| r.action.starts_with("ALLOW")) {
            let Some(ranges) = rule_ports(&r.to) else { continue };
            let used = ranges.iter().any(|(a, b)| {
                listening.iter().any(|l| (*a..=*b).contains(&l.port)) || docker.iter().any(|d| (*a..=*b).contains(&d.2))
            });
            if !used {
                warnings.push(PortWarning::RuleUnused { to: r.to.clone() });
            }
        }
    }

    Ports { listening, firewall, warnings, processes_complete: root || !unmapped }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_proc_net_addresses() {
        assert_eq!(decode_addr("0100007F").as_deref(), Some("127.0.0.1"));
        assert_eq!(decode_addr("00000000").as_deref(), Some("0.0.0.0"));
        assert_eq!(decode_addr("00000000000000000000000000000000").as_deref(), Some("::"));
        assert_eq!(decode_addr("00000000000000000000000001000000").as_deref(), Some("::1"));
        assert_eq!(decode_addr("0000000000000000FFFF00000100007F").as_deref(), Some("127.0.0.1"));
        assert_eq!(scope_of("10.0.0.5"), Scope::Private);
        assert_eq!(scope_of("103.21.44.10"), Scope::Public);
        assert_eq!(scope_of("::1"), Scope::Loopback);
    }

    #[test]
    fn parses_ufw_status() {
        let text = "Status: active\nLogging: on (low)\nDefault: deny (incoming), allow (outgoing), disabled (routed)\nNew profiles: skip\n\n\
To                         Action      From\n--                         ------      ----\n\
22/tcp                     ALLOW IN    Anywhere\nNginx Full                 ALLOW IN    Anywhere\n\
3001/tcp                   ALLOW IN    113.161.0.0/16\n9000/tcp                   ALLOW IN    Anywhere\n\
22/tcp (v6)                ALLOW IN    Anywhere (v6)\n";
        match parse_ufw(text) {
            Firewall::Active { default_incoming, rules } => {
                assert_eq!(default_incoming, "deny");
                assert_eq!(rules.len(), 4);
                assert!(rules[0].both && !rules[1].both);
                assert_eq!(rules[2].from, "113.161.0.0/16");
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(parse_ufw("ERROR: You need to be root to run this script"), Firewall::NeedsRoot));
        assert!(matches!(parse_ufw("Status: inactive"), Firewall::Inactive));
        assert!(matches!(
            parse_ufw("ERROR: problem running iptables: … Permission denied (you must be root)"),
            Firewall::Error { .. }
        ));
        assert_eq!(rule_ports("80,443/tcp"), Some(vec![(80, 80), (443, 443)]));
        assert_eq!(rule_ports("6000:6010/udp"), Some(vec![(6000, 6010)]));
        assert_eq!(rule_ports("Nginx Full"), None);
    }

    #[test]
    fn builds_ports_and_warnings() {
        let text = "@@NET tcp\n  sl  local rem st\n   0: 00000000:0016 00000000:0000 0A 0:0 0:0 0 0 0 100 1\n\
   1: 0100007F:0CEA 00000000:0000 0A 0:0 0:0 0 0 0 101 1\n   2: 00000000:1538 00000000:0000 0A 0:0 0:0 0 0 0 102 1\n\
   3: 00000000:1F90 00000000:0000 0A 0:0 0:0 0 0 0 103 1\n   4: 00000000:0BB9 00000000:0000 0A 0:0 0:0 0 0 0 104 1\n\
@@NET tcp6\n  sl\n   0: 00000000000000000000000000000000:0016 00000000000000000000000000000000:0000 0A 0:0 0:0 0 0 0 105 1\n\
@@NET udp\n  sl\n@@NET udp6\n  sl\n\
@@PORTWAY@@\n/proc/1/fd:\nlrwx 1 root root 64 3 -> socket:[100]\nlrwx 1 root root 64 4 -> socket:[105]\n/proc/40/fd:\nl 5 -> socket:[102]\n\
@@PORTWAY@@\n/proc/1/comm sshd\n/proc/40/comm docker-proxy\n\
@@PORTWAY@@\n0\n\
@@PORTWAY@@\nStatus: active\nDefault: deny (incoming), allow (outgoing)\n\nTo  Action  From\n--  ------  ----\n\
22/tcp                     ALLOW IN    Anywhere\n3001/tcp                   ALLOW IN    113.161.0.0/16\n9000/tcp                   ALLOW IN    Anywhere\n\
@@PORTWAY@@\npostgres\t0.0.0.0:5432->5432/tcp, :::5432->5432/tcp\numami\t0.0.0.0:3001->3000/tcp\napi\t0.0.0.0:8080->8080/tcp\n";
        let p = parse_ports(text);
        let ports: Vec<u16> = p.listening.iter().map(|l| l.port).collect();
        assert_eq!(ports, [22, 3001, 3306, 5432, 8080]);
        let ssh = &p.listening[0];
        assert_eq!((ssh.scope, ssh.process.as_deref()), (Scope::Public, Some("sshd")));
        assert_eq!(p.listening[2].scope, Scope::Loopback, "3306 on 127.0.0.1");
        let kinds: Vec<String> = p.warnings.iter().map(|w| format!("{w:?}")).collect();
        assert!(kinds.iter().any(|k| k.contains("DatabasePublic") && k.contains("Postgres") && k.contains("5432")), "{kinds:?}");
        assert!(!kinds.iter().any(|k| k.contains("MySQL")), "MySQL is loopback only");
        assert!(kinds.iter().any(|k| k.contains("RuleIneffective") && k.contains("3001")));
        assert!(kinds.iter().any(|k| k.contains("DockerBypass") && k.contains("8080")));
        assert!(kinds.iter().any(|k| k.contains("RuleUnused") && k.contains("9000")));
        assert!(p.processes_complete);
    }
}
