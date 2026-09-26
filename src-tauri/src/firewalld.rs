//! firewalld adapter: reads zones (services, ports, rich rules) and plans
//! changes as firewall-cmd calls. While firewalld runs, a change is applied to
//! the runtime config first and written to the permanent config only once a
//! new SSH connection still works; while it is stopped, the permanent config
//! is edited with firewall-offline-cmd.

use std::collections::HashMap;

use crate::error::{AppError, AppResult};
use crate::i18n::tr;
use crate::firewall::{valid_ports, valid_source, Ctx, Op, Plan, Rule, RuleInput};
use crate::ssh::shell_quote;

pub(crate) enum Read {
    Missing,
    NeedsRoot,
    Error(String),
    Ok {
        running: bool,
        /// Where new rules go: the zone of the active interfaces, else the default.
        target_zone: String,
        zones: Vec<String>,
        /// From the target zone's `target`: reject (default), deny (DROP) or allow.
        incoming: String,
        rules: Vec<Rule>,
    },
}

/// One zone of `firewall-cmd --list-all`.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Zone {
    pub name: String,
    pub target: String,
    pub interfaces: Vec<String>,
    pub services: Vec<String>,
    pub ports: Vec<String>,
    pub rich: Vec<String>,
}

pub(crate) fn parse_zones(text: &str) -> Vec<Zone> {
    let mut zones = Vec::new();
    let mut cur: Option<Zone> = None;
    let mut in_rich = false;
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        // A zone starts at column 0: "public (default, active)".
        if !line.starts_with(char::is_whitespace) {
            if let Some(z) = cur.take() {
                zones.push(z);
            }
            let name = line.split_whitespace().next().unwrap_or("").to_string();
            cur = Some(Zone { name, ..Default::default() });
            in_rich = false;
            continue;
        }
        let Some(z) = cur.as_mut() else { continue };
        let t = line.trim();
        if in_rich && t.starts_with("rule") {
            z.rich.push(t.to_string());
            continue;
        }
        in_rich = false;
        let Some((key, value)) = t.split_once(':') else { continue };
        let words = || value.split_whitespace().map(str::to_string).collect::<Vec<_>>();
        match key.trim() {
            "target" => z.target = value.trim().to_string(),
            "interfaces" => z.interfaces = words(),
            "services" => z.services = words(),
            "ports" => z.ports = words(),
            "rich rules" => {
                in_rich = true;
                if value.trim().starts_with("rule") {
                    z.rich.push(value.trim().to_string());
                }
            }
            _ => {}
        }
    }
    if let Some(z) = cur {
        zones.push(z);
    }
    zones
}

/// `grep -H '<port '` over the service XML files: name → "22/tcp|…".
pub(crate) fn parse_services(text: &str) -> HashMap<String, String> {
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    for line in text.lines() {
        let Some((file, rest)) = line.split_once(':') else { continue };
        let name = file.rsplit('/').next().unwrap_or("").trim_end_matches(".xml").to_string();
        let attr = |a: &str| rest.split(&format!("{a}=\"")).nth(1).and_then(|v| v.split('"').next()).map(str::to_string);
        if let (Some(port), Some(proto)) = (attr("port"), attr("protocol")) {
            // Files in /etc override /usr/lib; a later line for the same name replaces.
            let entry = map.entry(name).or_default();
            let v = format!("{}/{proto}", port.replace('-', ":"));
            if !entry.contains(&v) {
                entry.push(v);
            }
        }
    }
    map.into_iter().map(|(k, v)| (k, v.join("|"))).collect()
}

/// Value of `key="…"` inside a rich rule.
fn rich_attr(rule: &str, key: &str) -> Option<String> {
    rule.split(&format!("{key}=\"")).nth(1).and_then(|v| v.split('"').next()).map(str::to_string)
}

fn rule_base(zone: &str, kind: &str, value: &str) -> Rule {
    Rule {
        spec: vec![zone.into(), kind.into(), value.into()],
        action: "allow".into(),
        direction: "in".into(),
        route: false,
        interface: None,
        port: None,
        proto: None,
        app: None,
        app_ports: None,
        from: "any".into(),
        to: "any".into(),
        comment: None,
        zone: Some(zone.into()),
        editable: false,
        native: String::new(),
    }
}

pub(crate) fn zone_rules(z: &Zone, services: &HashMap<String, String>) -> Vec<Rule> {
    let mut out = Vec::new();
    for s in &z.services {
        let mut r = rule_base(&z.name, "service", s);
        r.app = Some(s.clone());
        r.app_ports = services.get(s).cloned();
        r.native = format!("service {s}");
        out.push(r);
    }
    for p in &z.ports {
        let mut r = rule_base(&z.name, "port", p);
        let (port, proto) = p.split_once('/').unwrap_or((p, "tcp"));
        r.port = Some(port.replace('-', ":"));
        r.proto = Some(proto.to_string());
        r.editable = true;
        r.native = format!("port {p}");
        out.push(r);
    }
    for rich in &z.rich {
        let mut r = rule_base(&z.name, "rich-rule", rich);
        let words: Vec<&str> = rich.split_whitespace().collect();
        let negated = rich.contains("source NOT");
        if let Some(a) = rich_attr(rich, "address").filter(|_| rich.contains("source")) {
            r.from = if negated { format!("NOT {a}") } else { a };
        }
        if let Some(s) = rich_attr(rich, "name").filter(|_| rich.contains("service name")) {
            r.app = Some(s.clone());
            r.app_ports = services.get(&s).cloned();
        }
        if rich.contains("port port=") {
            r.port = rich_attr(rich, "port").map(|p| p.replace('-', ":"));
            r.proto = rich_attr(rich, "protocol");
        }
        let verb = words.iter().rev().find(|w| matches!(**w, "accept" | "reject" | "drop" | "mark"));
        r.action = match verb.copied() {
            Some("accept") => "allow",
            Some("reject") => "reject",
            Some("drop") => "deny",
            _ => "other",
        }
        .into();
        // What the common form can say: a source and/or a port, accept or reject.
        let plain = !negated
            && !rich.contains(" log")
            && !rich.contains(" audit")
            && !rich.contains(" limit")
            && !rich.contains("destination")
            && !rich.contains("forward-port")
            && !rich.contains("icmp")
            && r.app.is_none()
            && r.port.is_some()
            && matches!(r.action.as_str(), "allow" | "reject" | "deny");
        r.editable = plain;
        r.native = rich.clone();
        out.push(r);
    }
    out
}

fn incoming_of(target: &str) -> String {
    match target.trim().trim_matches('%').to_ascii_uppercase().as_str() {
        "ACCEPT" => "allow",
        "DROP" => "deny",
        _ => "reject",
    }
    .to_string()
}

/// The firewalld section of the state script.
pub(crate) fn read(section: &str) -> Read {
    let section = section.trim();
    if section.is_empty() || section.starts_with("nofirewalld") {
        return Read::Missing;
    }
    let parts: Vec<&str> = section.split("@@FW@@").collect();
    let head = parts.first().copied().unwrap_or("");
    let all = section;
    if all.contains("Authorization failed") || all.contains("You need to be root") || all.contains("Permission denied") {
        return Read::NeedsRoot;
    }
    let state = head.lines().find_map(|l| l.strip_prefix("state=")).unwrap_or("").trim().to_string();
    let default = head.lines().find_map(|l| l.strip_prefix("default=")).unwrap_or("public").trim().to_string();
    let running = state == "running";
    if !running && state != "not running" {
        return Read::Error(state);
    }
    let active = parts.get(1).copied().unwrap_or("");
    let zones = parse_zones(parts.get(2).copied().unwrap_or(""));
    if zones.is_empty() {
        let detail = parts.get(2).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| tr("firewall-cmd --list-all không trả về zone nào", "firewall-cmd --list-all returned no zones"));
        return Read::Error(detail);
    }
    let services = parse_services(parts.get(3).copied().unwrap_or(""));
    // A zone bound to an interface wins over the default for traffic on it.
    let mut bound = Vec::new();
    let mut last = String::new();
    for l in active.lines() {
        if !l.starts_with(char::is_whitespace) {
            last = l.trim().to_string();
        } else if l.trim().starts_with("interfaces:") && !last.is_empty() {
            bound.push(last.clone());
        }
    }
    let target_zone = if bound.is_empty() || bound.contains(&default) { default.clone() } else { bound[0].clone() };
    let incoming = zones.iter().find(|z| z.name == target_zone).map(|z| incoming_of(&z.target)).unwrap_or_else(|| "reject".into());
    let rules = zones.iter().flat_map(|z| zone_rules(z, &services)).collect();
    Read::Ok { running, target_zone, zones: zones.iter().map(|z| z.name.clone()).collect(), incoming, rules }
}

// ------------------------------------------------------------------ plans

/// firewall-cmd options that make a rule from the common form.
pub(crate) fn add_options(r: &RuleInput) -> AppResult<Vec<String>> {
    let port = r.port.replace(' ', "");
    if !valid_ports(&port) {
        return Err(AppError::field("invalid_port", "port"));
    }
    let protos: Vec<&str> = match r.proto.as_str() {
        "tcp" => vec!["tcp"],
        "udp" => vec!["udp"],
        "any" => vec!["tcp", "udp"],
        _ => return Err(AppError::field("invalid_proto", "proto")),
    };
    let from = r.from.as_deref().map(str::trim).filter(|f| !f.is_empty() && *f != "any");
    if let Some(f) = from {
        if !valid_source(f) {
            return Err(AppError::field("invalid_source", "from"));
        }
    }
    let verb = match r.action.as_str() {
        "allow" => "accept",
        "deny" | "reject" => "reject",
        // UFW's per-source rate limit has no firewalld equivalent.
        "limit" => return Err(AppError::field("limit_unsupported", "action")),
        other => return Err(AppError::detail("invalid_action", other)),
    };
    let mut out = Vec::new();
    for part in port.split(',') {
        let p = part.replace(':', "-");
        for proto in &protos {
            if from.is_none() && verb == "accept" {
                out.push(format!("--add-port={p}/{proto}"));
            } else {
                let mut rule = String::from("rule");
                if let Some(f) = from {
                    let family = if f.contains(':') { "ipv6" } else { "ipv4" };
                    rule.push_str(&format!(" family=\"{family}\" source address=\"{f}\""));
                }
                rule.push_str(&format!(" port port=\"{p}\" protocol=\"{proto}\" {verb}"));
                out.push(format!("--add-rich-rule={rule}"));
            }
        }
    }
    Ok(out)
}

fn remove_option(rule: &Rule) -> AppResult<(String, String)> {
    match rule.spec.as_slice() {
        [zone, kind, value] if matches!(kind.as_str(), "port" | "service" | "rich-rule") => Ok((zone.clone(), format!("--remove-{kind}={value}"))),
        _ => Err(AppError::new("invalid_rule")),
    }
}

fn flip(opt: &str) -> String {
    if let Some(rest) = opt.strip_prefix("--add-") {
        format!("--remove-{rest}")
    } else if let Some(rest) = opt.strip_prefix("--remove-") {
        format!("--add-{rest}")
    } else {
        opt.to_string()
    }
}

fn line(tool: &str, permanent: bool, zone: &str, opts: &[String]) -> String {
    let mut s = String::from(tool);
    if permanent {
        s.push_str(" --permanent");
    }
    s.push_str(&format!(" --zone={}", shell_quote(zone)));
    for o in opts {
        s.push(' ');
        s.push_str(&shell_quote(o));
    }
    s
}

const OPENS: [&str; 2] = ["allow", "limit"];

pub(crate) fn plan(ctx: &Ctx, op: &Op) -> AppResult<Plan> {
    let zone = ctx.zone.clone().unwrap_or_else(|| "public".into());
    // (zone, options) groups the change is made of.
    let (changes, check): (Vec<(String, Vec<String>)>, bool) = match op {
        Op::Add { rule } => (vec![(zone.clone(), add_options(rule)?)], ctx.enabled && !OPENS.contains(&rule.action.as_str())),
        Op::Delete { rule } => {
            let (z, o) = remove_option(rule)?;
            (vec![(z, vec![o])], ctx.enabled && OPENS.contains(&rule.action.as_str()))
        }
        Op::Replace { rule, with } => {
            let (z, o) = remove_option(rule)?;
            (vec![(z, vec![o]), (zone.clone(), add_options(with)?)], ctx.enabled)
        }
        Op::Enable { ssh_ports } => {
            let mut apply: Vec<String> = ssh_ports
                .iter()
                .filter(|p| **p > 0)
                .map(|p| line("firewall-offline-cmd", false, &zone, &[format!("--add-port={p}/tcp")]))
                .collect();
            apply.push("systemctl enable --now firewalld".into());
            return Ok(Plan { apply, check: true, commit: vec![], rollback: vec!["systemctl disable --now firewalld".into()] });
        }
        Op::Disable => return Ok(Plan { apply: vec!["systemctl disable --now firewalld".into()], ..Default::default() }),
    };
    if !ctx.enabled {
        // Stopped: only the permanent config exists; nothing to check.
        return Ok(Plan { apply: changes.iter().map(|(z, o)| line("firewall-offline-cmd", false, z, o)).collect(), ..Default::default() });
    }
    Ok(Plan {
        apply: changes.iter().map(|(z, o)| line("firewall-cmd", false, z, o)).collect(),
        check,
        commit: changes.iter().map(|(z, o)| line("firewall-cmd", true, z, o)).collect(),
        rollback: changes.iter().rev().map(|(z, o)| line("firewall-cmd", false, z, &o.iter().map(|x| flip(x)).collect::<Vec<_>>())).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::firewall::Backend;

    const LIST: &str = "public (default, active)\n  target: default\n  icmp-block-inversion: no\n  interfaces: eth0\n  sources: \n  services: cockpit dhcpv6-client ssh\n  ports: 8443/tcp 3000-3005/tcp\n  protocols: \n  forward: yes\n  masquerade: no\n  forward-ports: \n  source-ports: \n  icmp-blocks: \n  rich rules: \n\trule family=\"ipv4\" source address=\"10.0.0.0/8\" port port=\"5432\" protocol=\"tcp\" accept\n\trule family=\"ipv4\" source address=\"203.0.113.7\" reject\n\n";

    #[test]
    fn reads_zones_and_rules() {
        let zones = parse_zones(LIST);
        assert_eq!(zones.len(), 1);
        let z = &zones[0];
        assert_eq!((z.name.as_str(), z.target.as_str()), ("public", "default"));
        assert_eq!(z.services, vec!["cockpit", "dhcpv6-client", "ssh"]);
        assert_eq!(z.rich.len(), 2);
        let services = parse_services("/usr/lib/firewalld/services/ssh.xml:  <port protocol=\"tcp\" port=\"22\"/>\n/usr/lib/firewalld/services/http3.xml:  <port protocol=\"udp\" port=\"443\"/>\n");
        let rules = zone_rules(z, &services);
        let ssh = rules.iter().find(|r| r.app.as_deref() == Some("ssh")).unwrap();
        assert_eq!(ssh.app_ports.as_deref(), Some("22/tcp"));
        let range = rules.iter().find(|r| r.spec[2] == "3000-3005/tcp").unwrap();
        assert_eq!((range.port.as_deref(), range.editable), (Some("3000:3005"), true));
        let pg = rules.iter().find(|r| r.port.as_deref() == Some("5432")).unwrap();
        assert_eq!((pg.from.as_str(), pg.action.as_str(), pg.editable), ("10.0.0.0/8", "allow", true));
        let blocked = rules.iter().find(|r| r.from == "203.0.113.7").unwrap();
        assert_eq!((blocked.action.as_str(), blocked.port.as_deref(), blocked.editable), ("reject", None, false));
    }

    #[test]
    fn reads_the_script_section() {
        let section = format!("state=running\ndefault=public\n@@FW@@\npublic\n  interfaces: eth0\n@@FW@@\n{LIST}@@FW@@\n");
        let Read::Ok { running, target_zone, incoming, rules, .. } = read(&section) else { panic!() };
        assert!(running);
        assert_eq!((target_zone.as_str(), incoming.as_str()), ("public", "reject"));
        assert_eq!(rules.len(), 7);
        assert!(matches!(read("state=running\n@@FW@@\n@@FW@@\nAuthorization failed.\n@@FW@@\n"), Read::NeedsRoot));
        assert!(matches!(read("nofirewalld"), Read::Missing));
    }

    fn input(action: &str, port: &str, proto: &str, from: Option<&str>) -> RuleInput {
        RuleInput { action: action.into(), port: port.into(), proto: proto.into(), from: from.map(Into::into), comment: None }
    }

    #[test]
    fn plans_try_then_keep() {
        let ctx = Ctx { backend: Backend::Firewalld, zone: Some("public".into()), enabled: true };
        let p = plan(&ctx, &Op::Add { rule: input("allow", "8080", "tcp", None) }).unwrap();
        assert_eq!(p.apply, vec!["firewall-cmd --zone=public --add-port=8080/tcp"]);
        assert_eq!(p.commit, vec!["firewall-cmd --permanent --zone=public --add-port=8080/tcp"]);
        assert!(!p.check, "opening a port cannot lock anyone out");
        let p = plan(&ctx, &Op::Add { rule: input("allow", "6000:6010", "any", Some("10.0.0.0/8")) }).unwrap();
        assert_eq!(
            p.apply,
            vec!["firewall-cmd --zone=public '--add-rich-rule=rule family=\"ipv4\" source address=\"10.0.0.0/8\" port port=\"6000-6010\" protocol=\"tcp\" accept' '--add-rich-rule=rule family=\"ipv4\" source address=\"10.0.0.0/8\" port port=\"6000-6010\" protocol=\"udp\" accept'"]
        );
        let ssh = zone_rules(&parse_zones(LIST)[0], &HashMap::new()).into_iter().find(|r| r.app.as_deref() == Some("ssh")).unwrap();
        let p = plan(&ctx, &Op::Delete { rule: ssh }).unwrap();
        assert!(p.check);
        assert_eq!(p.rollback, vec!["firewall-cmd --zone=public --add-service=ssh"]);
        assert_eq!(plan(&ctx, &Op::Add { rule: input("limit", "22", "tcp", None) }).unwrap_err().code, "limit_unsupported");
        let off = Ctx { enabled: false, ..ctx };
        let p = plan(&off, &Op::Add { rule: input("allow", "80", "tcp", None) }).unwrap();
        assert_eq!((p.apply, p.check, p.commit.len()), (vec!["firewall-offline-cmd --zone=public --add-port=80/tcp".to_string()], false, 0));
    }
}
