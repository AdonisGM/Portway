//! Firewall through UFW: state, default policies and the user rules exactly as
//! they were added (`ufw show added`, which also works while UFW is off), and
//! the changes (add, replace, delete, enable, disable). Rules are deleted by
//! their own spec, never by number, and only when the server still lists them.
//! Everything needs root: ufw refuses otherwise.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::IpAddr;
use std::time::Duration;

use crate::audit::AuditLog;
use crate::error::{AppError, AppResult};
use crate::ssh::{exec_priv, shell_quote, shown_as_run, Session, Sessions, MARK};
use crate::trace;

const READ_TIMEOUT: Duration = Duration::from_secs(30);
const WRITE_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    /// The rule as `ufw show added` prints it, without "ufw" and without the
    /// comment: what `ufw delete` takes to remove it.
    pub spec: Vec<String>,
    /// allow, deny, reject, limit
    pub action: String,
    /// in or out
    pub direction: String,
    /// `ufw route …`: forwarded traffic, not traffic to this server.
    pub route: bool,
    pub interface: Option<String>,
    /// Destination ports: "22", "80,443", "6000:6010"; None for every port.
    pub port: Option<String>,
    /// tcp, udp…; None for both.
    pub proto: Option<String>,
    /// App profile ("Nginx Full") and the ports it stands for.
    pub app: Option<String>,
    pub app_ports: Option<String>,
    /// Source: "any" or an address / network.
    pub from: String,
    /// Destination address when not "any".
    pub to: String,
    pub comment: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum FirewallState {
    /// No ufw. `firewalld` tells whether firewalld runs instead.
    NoUfw { firewalld: bool },
    /// ufw is there but this session is not root and has no sudo.
    NeedsRoot,
    Error { detail: String },
    Ufw {
        active: bool,
        /// Default policies: allow, deny, reject.
        incoming: String,
        outgoing: String,
        rules: Vec<Rule>,
    },
}

pub(crate) const STATE_SCRIPT: &str = r#"
if command -v ufw >/dev/null 2>&1; then
  echo ufw; ufw status verbose 2>&1
  echo @@PORTWAY@@; ufw show added 2>&1
  echo @@PORTWAY@@; cat /etc/ufw/applications.d/* 2>/dev/null || true
  echo @@PORTWAY@@; grep -E '^DEFAULT_(INPUT|OUTPUT)_POLICY=' /etc/default/ufw 2>/dev/null || true
else
  echo noufw
  echo @@PORTWAY@@; echo @@PORTWAY@@; echo @@PORTWAY@@
fi
echo @@PORTWAY@@
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then echo firewalld; fi
"#;

/// Split like sh does for the simple quoting ufw prints ('…' and "…").
fn tokens(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;
    for c in line.chars() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => cur.push(c),
            (None, '\'' | '"') => {
                quote = Some(c);
                started = true;
            }
            (None, c) if c.is_whitespace() => {
                if started || !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                    started = false;
                }
            }
            (None, c) => cur.push(c),
        }
    }
    if started || !cur.is_empty() {
        out.push(cur);
    }
    out
}

const ACTIONS: [&str; 4] = ["allow", "deny", "reject", "limit"];

/// One `ufw show added` line into a rule; None when it is not a rule.
pub(crate) fn parse_rule(line: &str, apps: &HashMap<String, String>) -> Option<Rule> {
    let mut t = tokens(line.trim());
    if t.first().map(String::as_str) != Some("ufw") {
        return None;
    }
    t.remove(0);
    // The comment is not part of what identifies the rule.
    let mut comment = None;
    if let Some(i) = t.iter().position(|x| x == "comment") {
        comment = t.get(i + 1).cloned();
        t.truncate(i);
    }
    let spec = t.clone();
    let mut it = t.into_iter().peekable();
    let mut rule = Rule {
        spec,
        action: String::new(),
        direction: "in".into(),
        route: false,
        interface: None,
        port: None,
        proto: None,
        app: None,
        app_ports: None,
        from: "any".into(),
        to: "any".into(),
        comment,
    };
    if it.peek().map(String::as_str) == Some("route") {
        rule.route = true;
        it.next();
    }
    let action = it.next()?;
    if !ACTIONS.contains(&action.as_str()) {
        return None;
    }
    rule.action = action;
    if matches!(it.peek().map(String::as_str), Some("in" | "out")) {
        rule.direction = it.next()?;
    }
    if it.peek().map(String::as_str) == Some("on") {
        it.next();
        rule.interface = it.next();
    }
    if matches!(it.peek().map(String::as_str), Some("log" | "log-all")) {
        it.next();
    }
    let rest: Vec<String> = it.collect();
    let full = rest.first().is_some_and(|w| matches!(w.as_str(), "from" | "to" | "proto"));
    if full {
        let mut i = 0;
        let mut side = "";
        while i < rest.len() {
            match rest[i].as_str() {
                "from" | "to" => {
                    side = if rest[i] == "from" { "from" } else { "to" };
                    let v = rest.get(i + 1).cloned().unwrap_or_default();
                    if side == "from" {
                        rule.from = v;
                    } else {
                        rule.to = v;
                    }
                    i += 2;
                }
                "port" => {
                    if side == "to" {
                        rule.port = rest.get(i + 1).cloned();
                    }
                    i += 2;
                }
                "app" => {
                    if side == "to" {
                        rule.app = rest.get(i + 1).cloned();
                    }
                    i += 2;
                }
                "proto" => {
                    rule.proto = rest.get(i + 1).cloned();
                    i += 2;
                }
                _ => i += 1,
            }
        }
    } else if let Some(target) = rest.first() {
        // Simple syntax: "22/tcp", "80", "Nginx Full".
        match target.split_once('/') {
            Some((p, proto)) if p.chars().all(|c| c.is_ascii_digit() || c == ',' || c == ':') => {
                rule.port = Some(p.to_string());
                rule.proto = Some(proto.to_string());
            }
            _ if target.chars().all(|c| c.is_ascii_digit() || c == ',' || c == ':') => rule.port = Some(target.clone()),
            _ => rule.app = Some(target.clone()),
        }
    }
    if let Some(app) = &rule.app {
        rule.app_ports = apps.get(app).cloned();
    }
    Some(rule)
}

/// `[Name]` sections of /etc/ufw/applications.d with their `ports=`.
pub(crate) fn parse_apps(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut current: Option<String> = None;
    for l in text.lines().map(str::trim) {
        if let Some(name) = l.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            current = Some(name.to_string());
        } else if let (Some(name), Some(ports)) = (&current, l.strip_prefix("ports=")) {
            out.insert(name.clone(), ports.trim().to_string());
        }
    }
    out
}

fn policy_word(p: &str) -> String {
    match p.trim().trim_matches('"').to_ascii_uppercase().as_str() {
        "ACCEPT" | "ALLOW" => "allow",
        "REJECT" => "reject",
        _ => "deny",
    }
    .to_string()
}

pub(crate) fn parse_state(out: &str) -> FirewallState {
    let parts: Vec<&str> = out.split(MARK).map(str::trim).collect();
    let get = |i: usize| parts.get(i).copied().unwrap_or("");
    let first = get(0);
    if first.starts_with("noufw") {
        return FirewallState::NoUfw { firewalld: get(4) == "firewalld" };
    }
    let status = first.strip_prefix("ufw").unwrap_or(first).trim();
    if status.contains("You need to be root") || get(1).contains("You need to be root") {
        return FirewallState::NeedsRoot;
    }
    if status.starts_with("ERROR") {
        return FirewallState::Error { detail: status.lines().next().unwrap_or(status).to_string() };
    }
    let active = status.lines().any(|l| l.trim() == "Status: active");
    // Defaults: from the running status when active, else from the config file.
    let from_status = |dir: &str| {
        status
            .lines()
            .find_map(|l| l.strip_prefix("Default: "))
            .and_then(|d| d.split(',').find(|p| p.contains(&format!("({dir})"))))
            .map(|p| p.replace(&format!("({dir})"), "").trim().to_string())
    };
    let from_file = |key: &str| get(3).lines().find_map(|l| l.strip_prefix(key)).map(policy_word);
    let incoming = from_status("incoming").or_else(|| from_file("DEFAULT_INPUT_POLICY=")).unwrap_or_else(|| "deny".into());
    let outgoing = from_status("outgoing").or_else(|| from_file("DEFAULT_OUTPUT_POLICY=")).unwrap_or_else(|| "allow".into());
    let apps = parse_apps(get(2));
    let rules = get(1).lines().filter_map(|l| parse_rule(l, &apps)).collect();
    FirewallState::Ufw { active, incoming, outgoing, rules }
}

#[tauri::command]
pub async fn firewall_state(sessions: tauri::State<'_, Sessions>, server_id: String, user: String) -> AppResult<FirewallState> {
    let session = sessions.get(&server_id, &user)?;
    let out = trace::labelled("Firewall · đọc rule UFW", exec_priv(&session, STATE_SCRIPT, READ_TIMEOUT)).await?;
    Ok(parse_state(&out.stdout))
}

// -------------------------------------------------------------------- changes

/// A rule to add, from the "Mở cổng" form.
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RuleInput {
    pub action: String,
    pub port: String,
    /// "tcp", "udp" or "any".
    pub proto: String,
    /// Source address or network; None for anywhere.
    pub from: Option<String>,
    pub comment: Option<String>,
}

fn valid_ports(p: &str) -> bool {
    !p.is_empty()
        && p.split(',').all(|part| {
            let (a, b) = part.split_once(':').unwrap_or((part, part));
            match (a.parse::<u32>(), b.parse::<u32>()) {
                (Ok(a), Ok(b)) => (1..=65535).contains(&a) && (1..=65535).contains(&b) && a <= b,
                _ => false,
            }
        })
}

fn valid_source(s: &str) -> bool {
    let (addr, prefix) = s.split_once('/').unwrap_or((s, ""));
    let Ok(ip) = addr.parse::<IpAddr>() else { return false };
    prefix.is_empty() || prefix.parse::<u8>().is_ok_and(|n| n <= if ip.is_ipv4() { 32 } else { 128 })
}

/// The ufw arguments for a rule, checked; the same line the UI previews.
pub fn add_args(r: &RuleInput) -> AppResult<Vec<String>> {
    if !matches!(r.action.as_str(), "allow" | "deny" | "reject" | "limit") {
        return Err(AppError::detail("invalid_action", &r.action));
    }
    let port = r.port.replace(' ', "");
    if !valid_ports(&port) {
        return Err(AppError::field("invalid_port", "port"));
    }
    let proto = match r.proto.as_str() {
        "tcp" | "udp" => Some(r.proto.clone()),
        "any" => None,
        _ => return Err(AppError::field("invalid_proto", "proto")),
    };
    // ufw refuses ranges and lists without a protocol.
    if proto.is_none() && (port.contains(':') || port.contains(',')) {
        return Err(AppError::field("range_needs_proto", "proto"));
    }
    let from = r.from.as_deref().map(str::trim).filter(|f| !f.is_empty() && *f != "any");
    if let Some(f) = from {
        if !valid_source(f) {
            return Err(AppError::field("invalid_source", "from"));
        }
    }
    let mut args = vec![r.action.clone()];
    match from {
        None => args.push(match &proto {
            Some(p) => format!("{port}/{p}"),
            None => port,
        }),
        Some(f) => {
            args.extend(["from".into(), f.to_string(), "to".into(), "any".into(), "port".into(), port]);
            if let Some(p) = proto {
                args.extend(["proto".into(), p]);
            }
        }
    }
    if let Some(c) = r.comment.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        if c.len() > 200 || c.contains('\n') {
            return Err(AppError::field("invalid_comment", "comment"));
        }
        args.extend(["comment".into(), c.to_string()]);
    }
    Ok(args)
}

fn ufw_line(args: &[String]) -> String {
    let mut s = String::from("ufw");
    for a in args {
        s.push(' ');
        s.push_str(&shell_quote(a));
    }
    s
}

/// The rules the server has now, to check a delete targets one of them.
async fn current_rules(session: &Session) -> AppResult<Vec<Rule>> {
    let out = exec_priv(session, "ufw show added 2>&1", READ_TIMEOUT).await?;
    if out.stdout.contains("You need to be root") {
        return Err(AppError::new("needs_root"));
    }
    Ok(out.stdout.lines().filter_map(|l| parse_rule(l, &HashMap::new())).collect())
}


async fn run(session: &Session, audit: &AuditLog, server_id: &str, user: &str, action: &str, cmd: &str) -> AppResult<String> {
    if !session.is_root() && !session.sudo_on() {
        return Err(AppError::new("needs_root"));
    }
    let shown = shown_as_run(session, cmd);
    let out = match exec_priv(session, &format!("{{ {cmd}; }} 2>&1"), WRITE_TIMEOUT).await {
        Ok(o) => o,
        Err(e) => {
            audit.record(server_id, user, action, &shown, false, e.detail.clone().or(Some(e.code.to_string())));
            return Err(e);
        }
    };
    let text = out.stdout.trim().to_string();
    // ufw reports some refusals with exit status 0.
    let ok = out.code == Some(0) && !text.lines().any(|l| l.starts_with("ERROR"));
    audit.record(server_id, user, action, &shown, ok, (!ok).then(|| text.clone()));
    if ok {
        Ok(text)
    } else {
        Err(AppError::detail("ufw", if text.is_empty() { "exit status != 0".into() } else { text }))
    }
}

#[tauri::command]
pub async fn firewall_add(
    sessions: tauri::State<'_, Sessions>,
    audit: tauri::State<'_, AuditLog>,
    server_id: String,
    user: String,
    rule: RuleInput,
) -> AppResult<String> {
    let args = add_args(&rule)?;
    let session = sessions.get(&server_id, &user)?;
    trace::labelled("Firewall · thêm rule", run(&session, &audit, &server_id, &user, "ufwAdd", &ufw_line(&args))).await
}

fn delete_line(spec: &[String]) -> String {
    let mut args = vec!["delete".to_string()];
    args.extend(spec.iter().cloned());
    ufw_line(&args)
}

/// Remove a rule by its spec, or replace it (remove, then add the new one).
#[tauri::command]
pub async fn firewall_delete(
    sessions: tauri::State<'_, Sessions>,
    audit: tauri::State<'_, AuditLog>,
    server_id: String,
    user: String,
    spec: Vec<String>,
    replace_with: Option<RuleInput>,
) -> AppResult<String> {
    let session = sessions.get(&server_id, &user)?;
    let rules = current_rules(&session).await?;
    if !rules.iter().any(|r| r.spec == spec) {
        return Err(AppError::new("rule_gone"));
    }
    let mut cmd = delete_line(&spec);
    let action = match &replace_with {
        Some(r) => {
            cmd = format!("{cmd} && {}", ufw_line(&add_args(r)?));
            "ufwReplace"
        }
        None => "ufwDelete",
    };
    trace::labelled("Firewall · xoá/sửa rule", run(&session, &audit, &server_id, &user, action, &cmd)).await
}

/// Turn UFW on, first allowing the SSH ports that no rule allows yet, so the
/// session does not cut itself off.
#[tauri::command]
pub async fn firewall_enable(
    sessions: tauri::State<'_, Sessions>,
    audit: tauri::State<'_, AuditLog>,
    server_id: String,
    user: String,
    ssh_ports: Vec<u16>,
) -> AppResult<String> {
    let session = sessions.get(&server_id, &user)?;
    let mut parts: Vec<String> = ssh_ports
        .iter()
        .filter(|p| **p > 0)
        .map(|p| ufw_line(&["allow".into(), format!("{p}/tcp"), "comment".into(), "SSH (Portway)".into()]))
        .collect();
    parts.push("ufw --force enable".into());
    trace::labelled("Firewall · bật", run(&session, &audit, &server_id, &user, "ufwEnable", &parts.join(" && "))).await
}

#[tauri::command]
pub async fn firewall_disable(sessions: tauri::State<'_, Sessions>, audit: tauri::State<'_, AuditLog>, server_id: String, user: String) -> AppResult<String> {
    let session = sessions.get(&server_id, &user)?;
    trace::labelled("Firewall · tắt", run(&session, &audit, &server_id, &user, "ufwDisable", "ufw disable")).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apps() -> HashMap<String, String> {
        parse_apps("[OpenSSH]\ntitle=Secure shell\nports=22/tcp\n\n[Nginx Full]\nports=80,443/tcp\n")
    }

    #[test]
    fn parses_show_added() {
        let a = apps();
        let r = parse_rule("ufw allow 22/tcp", &a).unwrap();
        assert_eq!((r.port.as_deref(), r.proto.as_deref(), r.from.as_str()), (Some("22"), Some("tcp"), "any"));
        let r = parse_rule("ufw allow from 113.161.0.0/16 to any port 3001 proto tcp", &a).unwrap();
        assert_eq!((r.port.as_deref(), r.proto.as_deref(), r.from.as_str()), (Some("3001"), Some("tcp"), "113.161.0.0/16"));
        let r = parse_rule("ufw allow 8443/tcp comment 'Admin panel'", &a).unwrap();
        assert_eq!(r.comment.as_deref(), Some("Admin panel"));
        assert_eq!(r.spec, vec!["allow", "8443/tcp"]);
        let r = parse_rule("ufw allow 'Nginx Full'", &a).unwrap();
        assert_eq!((r.app.as_deref(), r.app_ports.as_deref()), (Some("Nginx Full"), Some("80,443/tcp")));
        assert_eq!(r.spec, vec!["allow", "Nginx Full"]);
        let r = parse_rule("ufw deny from 203.0.113.7", &a).unwrap();
        assert_eq!((r.action.as_str(), r.port, r.from.as_str()), ("deny", None, "203.0.113.7"));
        let r = parse_rule("ufw limit in on eth0 log 22/tcp", &a).unwrap();
        assert_eq!((r.interface.as_deref(), r.port.as_deref()), (Some("eth0"), Some("22")));
        let r = parse_rule("ufw route allow in on wg0 out on eth0", &a).unwrap();
        assert!(r.route);
        assert!(parse_rule("Added user rules (see 'ufw status' for running firewall):", &a).is_none());
        assert!(parse_rule("(None)", &a).is_none());
    }

    #[test]
    fn reads_state_when_off_and_on() {
        let off = "ufw\nStatus: inactive\n@@PORTWAY@@\nAdded user rules (see 'ufw status' for running firewall):\nufw allow 22/tcp\n@@PORTWAY@@\n@@PORTWAY@@\nDEFAULT_INPUT_POLICY=\"DROP\"\nDEFAULT_OUTPUT_POLICY=\"ACCEPT\"\n@@PORTWAY@@\n";
        let FirewallState::Ufw { active, incoming, outgoing, rules } = parse_state(off) else { panic!() };
        assert!(!active);
        assert_eq!((incoming.as_str(), outgoing.as_str(), rules.len()), ("deny", "allow", 1));
        let on = "ufw\nStatus: active\nDefault: reject (incoming), allow (outgoing), deny (routed)\n@@PORTWAY@@\n(None)\n@@PORTWAY@@\n@@PORTWAY@@\n@@PORTWAY@@\n";
        let FirewallState::Ufw { active, incoming, .. } = parse_state(on) else { panic!() };
        assert!(active && incoming == "reject");
        assert!(matches!(parse_state("noufw\n@@PORTWAY@@\n@@PORTWAY@@\n@@PORTWAY@@\n@@PORTWAY@@\nfirewalld\n"), FirewallState::NoUfw { firewalld: true }));
        assert!(matches!(parse_state("ufw\nERROR: You need to be root to run this script\n@@PORTWAY@@\n"), FirewallState::NeedsRoot));
    }

    #[test]
    fn builds_and_checks_new_rules() {
        let r = |action: &str, port: &str, proto: &str, from: Option<&str>, comment: Option<&str>| RuleInput {
            action: action.into(),
            port: port.into(),
            proto: proto.into(),
            from: from.map(Into::into),
            comment: comment.map(Into::into),
        };
        assert_eq!(ufw_line(&add_args(&r("allow", "8080", "tcp", None, Some("Web app"))).unwrap()), "ufw allow 8080/tcp comment 'Web app'");
        assert_eq!(
            ufw_line(&add_args(&r("limit", "22", "tcp", Some("10.0.0.0/8"), None)).unwrap()),
            "ufw limit from 10.0.0.0/8 to any port 22 proto tcp"
        );
        assert_eq!(ufw_line(&add_args(&r("allow", "53", "any", None, None)).unwrap()), "ufw allow 53");
        assert_eq!(add_args(&r("allow", "6000:6010", "any", None, None)).unwrap_err().code, "range_needs_proto");
        assert_eq!(add_args(&r("allow", "70000", "tcp", None, None)).unwrap_err().code, "invalid_port");
        assert_eq!(add_args(&r("allow", "22", "tcp", Some("1.2.3.4; rm -rf /"), None)).unwrap_err().code, "invalid_source");
        assert_eq!(ufw_line(&add_args(&r("allow", "22", "tcp", None, Some("it's"))).unwrap()), "ufw allow 22/tcp comment 'it'\\''s'");
        assert_eq!(delete_line(&["allow".into(), "Nginx Full".into()]), "ufw delete allow 'Nginx Full'");
    }
}
