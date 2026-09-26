//! Firewall, whichever tool the server uses. Portway reads UFW, firewalld and
//! iptables in one go, picks the tool that manages the firewall (the active
//! one; by distribution when none is), and shows its rules in one shape. Each
//! change is planned by that tool's adapter (UFW here, firewalld in
//! firewalld.rs) and run the same way:
//!
//! 1. apply the change;
//! 2. when it could lock the session out (removing an allow rule, a deny rule,
//!    turning the firewall on), open a brand-new SSH connection. Established
//!    connections survive rule changes, so only a new one tells;
//! 3. it connects: keep the change (firewalld: now write it to the permanent
//!    config); it does not: undo through the still-open session.
//!
//! Everything needs root: the tools refuse otherwise.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::IpAddr;
use std::time::Duration;

use crate::audit::AuditLog;
use crate::error::{AppError, AppResult};
use crate::firewalld;
use crate::servers::ServerStore;
use crate::ssh::{exec_priv, open_for_tunnel, shell_quote, Session, Sessions, MARK};
use crate::trace;

const READ_TIMEOUT: Duration = Duration::from_secs(30);
const WRITE_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Backend {
    Ufw,
    Firewalld,
}

/// A rule in the shape every adapter fills.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    /// What identifies the rule for its tool. UFW: the words of `ufw show
    /// added` without "ufw" and the comment. firewalld: [zone, kind, value]
    /// with kind port | service | rich-rule.
    pub spec: Vec<String>,
    /// allow, deny, reject, limit
    pub action: String,
    /// in or out
    pub direction: String,
    /// Forwarded traffic, not traffic to this server.
    pub route: bool,
    pub interface: Option<String>,
    /// Destination ports: "22", "80,443", "6000:6010"; None for every port.
    pub port: Option<String>,
    /// tcp, udp…; None for both.
    pub proto: Option<String>,
    /// UFW app profile or firewalld service ("ssh") and its ports, as
    /// "80,443/tcp" or several "port/proto" joined by "|".
    pub app: Option<String>,
    pub app_ports: Option<String>,
    /// Source: "any" or an address / network.
    pub from: String,
    /// Destination address when not "any".
    pub to: String,
    pub comment: Option<String>,
    /// firewalld zone the rule belongs to.
    #[serde(default)]
    pub zone: Option<String>,
    /// Portway can edit it through the common form.
    #[serde(default)]
    pub editable: bool,
    /// The rule in its tool's own syntax.
    #[serde(default)]
    pub native: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum FirewallState {
    /// Neither UFW nor firewalld. `iptables` counts rules added straight
    /// with iptables; `family` picks the tool to suggest.
    None { family: String, iptables: u32 },
    /// This session is not root and has no sudo.
    NeedsRoot { backend: Backend },
    Error { backend: Backend, detail: String },
    Managed {
        backend: Backend,
        /// The firewall is on (UFW active, firewalld running).
        enabled: bool,
        /// Default for incoming / outgoing: allow, deny, reject.
        incoming: String,
        outgoing: String,
        /// firewalld: the zone new rules go to; zones shown.
        zone: Option<String>,
        zones: Vec<String>,
        /// UFW rules apply top to bottom; firewalld's have no order.
        ordered: bool,
        rules: Vec<Rule>,
        /// Another firewall tool is on too: they fight over the same tables.
        also_active: Vec<Backend>,
        family: String,
    },
}

pub(crate) const STATE_SCRIPT: &str = r#"
echo "family=$( . /etc/os-release 2>/dev/null; echo "$ID $ID_LIKE")"
echo @@PORTWAY@@
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
if command -v firewall-cmd >/dev/null 2>&1; then
  st=$(firewall-cmd --state 2>&1)
  echo "state=$st"
  if [ "$st" = running ]; then
    d=$(firewall-cmd --get-default-zone 2>&1); echo "default=$d"
    echo @@FW@@; firewall-cmd --get-active-zones 2>&1
    echo @@FW@@
    for z in $( { echo "$d"; firewall-cmd --get-active-zones 2>/dev/null | grep -v '^[[:space:]]'; } | sort -u); do
      firewall-cmd --zone="$z" --list-all 2>&1; echo
    done
  else
    d=$(firewall-offline-cmd --get-default-zone 2>&1); echo "default=$d"
    echo @@FW@@
    echo @@FW@@; firewall-offline-cmd --zone="$d" --list-all 2>&1
  fi
  echo @@FW@@
  grep -H '<port ' /usr/lib/firewalld/services/*.xml /etc/firewalld/services/*.xml 2>/dev/null || true
else
  echo nofirewalld
fi
echo @@PORTWAY@@
if command -v iptables >/dev/null 2>&1; then iptables -S 2>/dev/null | grep -c '^-A' || true; fi
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
pub(crate) fn parse_ufw_rule(line: &str, apps: &HashMap<String, String>) -> Option<Rule> {
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
        zone: None,
        editable: false,
        native: String::new(),
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
    rule.editable = !rule.route && rule.direction == "in" && rule.interface.is_none() && rule.to == "any" && rule.port.is_some();
    rule.native = line.trim().to_string();
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



enum UfwRead {
    Missing,
    NeedsRoot,
    Error(String),
    Ok { active: bool, incoming: String, outgoing: String, rules: Vec<Rule> },
}

fn read_ufw(parts: &[&str]) -> UfwRead {
    let get = |i: usize| parts.get(i).copied().unwrap_or("");
    let first = get(0);
    if first.starts_with("noufw") {
        return UfwRead::Missing;
    }
    let status = first.strip_prefix("ufw").unwrap_or(first).trim();
    if status.contains("You need to be root") || get(1).contains("You need to be root") {
        return UfwRead::NeedsRoot;
    }
    if status.starts_with("ERROR") {
        return UfwRead::Error(status.lines().next().unwrap_or(status).to_string());
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
    let rules = get(1).lines().filter_map(|l| parse_ufw_rule(l, &apps)).collect();
    UfwRead::Ok { active, incoming, outgoing, rules }
}

/// "rhel", "debian" or "other", from /etc/os-release ID and ID_LIKE.
fn family_of(line: &str) -> String {
    let ids = line.trim().strip_prefix("family=").unwrap_or("").to_ascii_lowercase();
    let has = |w: &str| ids.split_whitespace().any(|x| x == w);
    if ["rhel", "fedora", "centos", "ol", "rocky", "almalinux"].iter().any(|w| has(w)) {
        "rhel"
    } else if ["debian", "ubuntu"].iter().any(|w| has(w)) {
        "debian"
    } else {
        "other"
    }
    .to_string()
}

pub(crate) fn parse_state(out: &str) -> FirewallState {
    let parts: Vec<&str> = out.split(MARK).map(str::trim).collect();
    let family = family_of(parts.first().copied().unwrap_or(""));
    let ufw = read_ufw(parts.get(1..5).unwrap_or(&[]));
    let fwd = firewalld::read(parts.get(5).copied().unwrap_or(""));
    let iptables: u32 = parts.get(6).and_then(|s| s.trim().parse().ok()).unwrap_or(0);

    let ufw_on = matches!(ufw, UfwRead::Ok { active: true, .. });
    let fwd_on = matches!(fwd, firewalld::Read::Ok { running: true, .. });
    let ufw_there = !matches!(ufw, UfwRead::Missing);
    let fwd_there = !matches!(fwd, firewalld::Read::Missing);
    // The one that is on; when both or neither are, the usual one for the distribution.
    let prefer_fwd = family == "rhel";
    let backend = match (ufw_on, fwd_on) {
        (true, false) => Some(Backend::Ufw),
        (false, true) => Some(Backend::Firewalld),
        _ => match (ufw_there, fwd_there) {
            (true, true) => Some(if prefer_fwd { Backend::Firewalld } else { Backend::Ufw }),
            (true, false) => Some(Backend::Ufw),
            (false, true) => Some(Backend::Firewalld),
            (false, false) => None,
        },
    };
    let also_active = match backend {
        Some(Backend::Ufw) if fwd_on => vec![Backend::Firewalld],
        Some(Backend::Firewalld) if ufw_on => vec![Backend::Ufw],
        _ => vec![],
    };
    match backend {
        None => FirewallState::None { family, iptables },
        Some(Backend::Ufw) => match ufw {
            UfwRead::NeedsRoot => FirewallState::NeedsRoot { backend: Backend::Ufw },
            UfwRead::Error(detail) => FirewallState::Error { backend: Backend::Ufw, detail },
            UfwRead::Ok { active, incoming, outgoing, rules } => FirewallState::Managed {
                backend: Backend::Ufw,
                enabled: active,
                incoming,
                outgoing,
                zone: None,
                zones: vec![],
                ordered: true,
                rules,
                also_active,
                family,
            },
            UfwRead::Missing => unreachable!("ufw picked only when present"),
        },
        Some(Backend::Firewalld) => match fwd {
            firewalld::Read::NeedsRoot => FirewallState::NeedsRoot { backend: Backend::Firewalld },
            firewalld::Read::Error(detail) => FirewallState::Error { backend: Backend::Firewalld, detail },
            firewalld::Read::Ok { running, target_zone, zones, incoming, rules } => FirewallState::Managed {
                backend: Backend::Firewalld,
                enabled: running,
                incoming,
                outgoing: "allow".into(),
                zone: Some(target_zone),
                zones,
                ordered: false,
                rules,
                also_active,
                family,
            },
            firewalld::Read::Missing => unreachable!("firewalld picked only when present"),
        },
    }
}

async fn read_state(session: &Session) -> AppResult<FirewallState> {
    let out = exec_priv(session, STATE_SCRIPT, READ_TIMEOUT).await?;
    Ok(parse_state(&out.stdout))
}

#[tauri::command]
pub async fn firewall_state(sessions: tauri::State<'_, Sessions>, server_id: String, user: String) -> AppResult<FirewallState> {
    let session = sessions.get(&server_id, &user)?;
    trace::labelled("Firewall · đọc rule", read_state(&session)).await
}

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

pub(crate) fn valid_ports(p: &str) -> bool {
    !p.is_empty()
        && p.split(',').all(|part| {
            let (a, b) = part.split_once(':').unwrap_or((part, part));
            match (a.parse::<u32>(), b.parse::<u32>()) {
                (Ok(a), Ok(b)) => (1..=65535).contains(&a) && (1..=65535).contains(&b) && a <= b,
                _ => false,
            }
        })
}

pub(crate) fn valid_source(s: &str) -> bool {
    let (addr, prefix) = s.split_once('/').unwrap_or((s, ""));
    let Ok(ip) = addr.parse::<IpAddr>() else { return false };
    prefix.is_empty() || prefix.parse::<u8>().is_ok_and(|n| n <= if ip.is_ipv4() { 32 } else { 128 })
}

/// The ufw arguments for a rule, checked; the same line the UI previews.
pub fn ufw_add_args(r: &RuleInput) -> AppResult<Vec<String>> {
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


pub(crate) fn delete_line(spec: &[String]) -> String {
    let mut args = vec!["delete".to_string()];
    args.extend(spec.iter().cloned());
    ufw_line(&args)
}

// ---------------------------------------------------------------- plans

/// A change as commands. `apply` runs first; with `check`, a new SSH
/// connection must succeed, then `commit` runs, else `rollback` does.
#[derive(Debug, Default, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub apply: Vec<String>,
    pub check: bool,
    pub commit: Vec<String>,
    pub rollback: Vec<String>,
}

impl Plan {
    /// What the confirm dialog shows: the exact lines, with sudo when the
    /// session goes through sudo.
    pub fn preview(&self, sudo: bool) -> String {
        let s = |c: &String| if sudo { format!("sudo {c}") } else { c.clone() };
        let mut out: Vec<String> = self.apply.iter().map(s).collect();
        if self.check {
            if self.commit.is_empty() {
                out.push("# Portway mở một kết nối SSH mới để kiểm tra. Không kết nối được thì hoàn tác:".into());
            } else {
                out.push("# Portway mở một kết nối SSH mới để kiểm tra. Được thì lưu vĩnh viễn:".into());
                out.extend(self.commit.iter().map(s));
                out.push("# Không kết nối được thì hoàn tác:".into());
            }
            out.extend(self.rollback.iter().map(|c| format!("#   {}", s(c))));
        } else {
            out.extend(self.commit.iter().map(s));
        }
        out.join("\n")
    }
}

/// What the UI did its preview against; the change is refused if the server
/// has moved on since (another tool turned on, the zone changed…).
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Ctx {
    pub backend: Backend,
    pub zone: Option<String>,
    pub enabled: bool,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Op {
    Add { rule: RuleInput },
    Delete { rule: Rule },
    /// UFW and firewalld have no in-place edit: remove, then add.
    Replace { rule: Rule, with: RuleInput },
    Enable { ssh_ports: Vec<u16> },
    Disable,
}

const OPENS: [&str; 2] = ["allow", "limit"];

fn ufw_plan(ctx: &Ctx, op: &Op) -> AppResult<Plan> {
    let readd = |r: &Rule| {
        let mut args = r.spec.clone();
        if let Some(c) = &r.comment {
            args.extend(["comment".into(), c.clone()]);
        }
        ufw_line(&args)
    };
    let without_comment = |args: &[String]| {
        let cut = args.iter().position(|a| a == "comment").unwrap_or(args.len());
        args[..cut].to_vec()
    };
    Ok(match op {
        Op::Add { rule } => {
            let args = ufw_add_args(rule)?;
            Plan {
                apply: vec![ufw_line(&args)],
                check: ctx.enabled && !OPENS.contains(&rule.action.as_str()),
                commit: vec![],
                rollback: vec![delete_line(&without_comment(&args))],
            }
        }
        Op::Delete { rule } => Plan {
            apply: vec![delete_line(&rule.spec)],
            check: ctx.enabled && OPENS.contains(&rule.action.as_str()),
            commit: vec![],
            rollback: vec![readd(rule)],
        },
        Op::Replace { rule, with } => {
            let args = ufw_add_args(with)?;
            Plan {
                apply: vec![delete_line(&rule.spec), ufw_line(&args)],
                check: ctx.enabled,
                commit: vec![],
                rollback: vec![delete_line(&without_comment(&args)), readd(rule)],
            }
        }
        Op::Enable { ssh_ports } => {
            let mut apply: Vec<String> = ssh_ports
                .iter()
                .filter(|p| **p > 0)
                .map(|p| ufw_line(&["allow".into(), format!("{p}/tcp"), "comment".into(), "SSH (Portway)".into()]))
                .collect();
            apply.push("ufw --force enable".into());
            Plan { apply, check: true, commit: vec![], rollback: vec!["ufw disable".into()] }
        }
        Op::Disable => Plan { apply: vec!["ufw disable".into()], ..Default::default() },
    })
}

pub fn plan(ctx: &Ctx, op: &Op) -> AppResult<Plan> {
    match ctx.backend {
        Backend::Ufw => ufw_plan(ctx, op),
        Backend::Firewalld => firewalld::plan(ctx, op),
    }
}

/// Preview only, from what the UI shows; nothing is run.
#[tauri::command]
pub fn firewall_plan(ctx: Ctx, op: Op, sudo: bool) -> AppResult<String> {
    Ok(plan(&ctx, &op)?.preview(sudo))
}

// ------------------------------------------------------------- execution

async fn run_step(session: &Session, cmd: &str) -> Result<(), String> {
    let out = exec_priv(session, &format!("{{ {cmd}; }} 2>&1"), WRITE_TIMEOUT).await.map_err(|e| e.detail.unwrap_or_else(|| e.code.to_string()))?;
    let text = out.stdout.trim().to_string();
    // ufw reports some refusals with exit status 0.
    if out.code == Some(0) && !text.lines().any(|l| l.starts_with("ERROR")) {
        Ok(())
    } else {
        Err(if text.is_empty() { format!("{cmd}: exit status != 0") } else { text })
    }
}

async fn run_all(session: &Session, cmds: &[String]) -> Result<(), String> {
    for c in cmds {
        run_step(session, c).await?;
    }
    Ok(())
}

/// A fresh SSH connection with the session's credential. Only network
/// failures count as "locked out"; anything else cannot be checked here.
async fn can_still_connect(store: &ServerStore, sessions: &Sessions, server_id: &str, user: &str) -> Result<(), String> {
    match open_for_tunnel(store, sessions, server_id, user, None).await {
        Ok(h) => {
            let _ = h.disconnect(russh::Disconnect::ByApplication, "", "en").await;
            Ok(())
        }
        Err(e) if matches!(e.code, "refused" | "timeout" | "network" | "ssh" | "connection_lost") => Err(e.detail.unwrap_or_else(|| e.code.to_string())),
        Err(_) => Ok(()),
    }
}

fn op_action(op: &Op) -> &'static str {
    match op {
        Op::Add { .. } => "fwAdd",
        Op::Delete { .. } => "fwDelete",
        Op::Replace { .. } => "fwReplace",
        Op::Enable { .. } => "fwEnable",
        Op::Disable => "fwDisable",
    }
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn firewall_apply(
    store: tauri::State<'_, ServerStore>,
    sessions: tauri::State<'_, Sessions>,
    audit: tauri::State<'_, AuditLog>,
    server_id: String,
    user: String,
    ctx: Ctx,
    op: Op,
) -> AppResult<()> {
    let session = sessions.get(&server_id, &user)?;
    if !session.is_root() && !session.sudo_on() {
        return Err(AppError::new("needs_root"));
    }
    let run = async {
        // The server as it is now must still match what was previewed.
        match read_state(&session).await? {
            FirewallState::Managed { backend, zone, enabled, rules, .. } => {
                if backend != ctx.backend || zone != ctx.zone || enabled != ctx.enabled {
                    return Err(AppError::new("firewall_changed"));
                }
                if let Op::Delete { rule } | Op::Replace { rule, .. } = &op {
                    if !rules.iter().any(|r| r.spec == rule.spec) {
                        return Err(AppError::new("rule_gone"));
                    }
                }
            }
            FirewallState::NeedsRoot { .. } => return Err(AppError::new("needs_root")),
            _ => return Err(AppError::new("firewall_changed")),
        }
        let p = plan(&ctx, &op)?;
        let sudo = !session.is_root();
        let shown = p.preview(sudo);
        let action = op_action(&op);
        let fail = |detail: String| {
            audit.record(&server_id, &user, action, &shown, false, Some(detail.clone()));
            AppError::detail("firewall", detail)
        };
        if let Err(e) = run_all(&session, &p.apply).await {
            // A half-applied chain: put back what already ran.
            let _ = run_all(&session, &p.rollback).await;
            return Err(fail(e));
        }
        if p.check {
            let span = trace::start(&server_id, &user, trace::Kind::Connect, Some("Firewall · kiểm tra kết nối SSH mới".into()), "ssh (kết nối thử)", false);
            if let Err(e) = can_still_connect(&store, &sessions, &server_id, &user).await {
                span.fail(&e, |_| {});
                let undone = run_all(&session, &p.rollback).await;
                let detail = match undone {
                    Ok(()) => format!("Sau thay đổi, không mở được kết nối SSH mới ({e}). Portway đã hoàn tác."),
                    Err(u) => format!("Sau thay đổi, không mở được kết nối SSH mới ({e}). Hoàn tác cũng lỗi: {u}. Giữ phiên này mở và sửa ngay."),
                };
                audit.record(&server_id, &user, action, &shown, false, Some(detail.clone()));
                return Err(AppError::detail("lockout_prevented", detail));
            }
            span.ok(|_| {});
        }
        if let Err(e) = run_all(&session, &p.commit).await {
            return Err(fail(format!("Đã áp dụng nhưng chưa lưu vĩnh viễn: {e}")));
        }
        audit.record(&server_id, &user, action, &shown, true, None);
        Ok(())
    };
    trace::labelled("Firewall · thay đổi", run).await
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
        let r = parse_ufw_rule("ufw allow 22/tcp", &a).unwrap();
        assert_eq!((r.port.as_deref(), r.proto.as_deref(), r.from.as_str(), r.editable), (Some("22"), Some("tcp"), "any", true));
        let r = parse_ufw_rule("ufw allow from 113.161.0.0/16 to any port 3001 proto tcp", &a).unwrap();
        assert_eq!((r.port.as_deref(), r.proto.as_deref(), r.from.as_str()), (Some("3001"), Some("tcp"), "113.161.0.0/16"));
        let r = parse_ufw_rule("ufw allow 8443/tcp comment 'Admin panel'", &a).unwrap();
        assert_eq!(r.comment.as_deref(), Some("Admin panel"));
        assert_eq!(r.spec, vec!["allow", "8443/tcp"]);
        let r = parse_ufw_rule("ufw allow 'Nginx Full'", &a).unwrap();
        assert_eq!((r.app.as_deref(), r.app_ports.as_deref(), r.editable), (Some("Nginx Full"), Some("80,443/tcp"), false));
        let r = parse_ufw_rule("ufw deny from 203.0.113.7", &a).unwrap();
        assert_eq!((r.action.as_str(), r.port, r.from.as_str()), ("deny", None, "203.0.113.7"));
        let r = parse_ufw_rule("ufw limit in on eth0 log 22/tcp", &a).unwrap();
        assert_eq!((r.interface.as_deref(), r.port.as_deref(), r.editable), (Some("eth0"), Some("22"), false));
        assert!(parse_ufw_rule("ufw route allow in on wg0 out on eth0", &a).unwrap().route);
        assert!(parse_ufw_rule("(None)", &a).is_none());
    }

    const M: &str = "@@PORTWAY@@";

    #[test]
    fn picks_the_tool_in_use() {
        let ufw_off = format!("family=ubuntu debian\n{M}\nufw\nStatus: inactive\n{M}\nufw allow 22/tcp\n{M}\n{M}\nDEFAULT_INPUT_POLICY=\"DROP\"\n{M}\nnofirewalld\n{M}\n0\n");
        let FirewallState::Managed { backend, enabled, incoming, rules, ordered, .. } = parse_state(&ufw_off) else { panic!() };
        assert_eq!((backend, enabled, incoming.as_str(), rules.len(), ordered), (Backend::Ufw, false, "deny", 1, true));

        let fwd = format!("family=ol rhel fedora\n{M}\nnoufw\n{M}\n{M}\n{M}\n{M}\nstate=running\ndefault=public\n@@FW@@\n@@FW@@\npublic (default)\n  target: default\n  services: ssh\n  ports: 8443/tcp\n@@FW@@\n{M}\n0\n");
        let FirewallState::Managed { backend, enabled, zone, ordered, rules, .. } = parse_state(&fwd) else { panic!("{fwd}") };
        assert_eq!((backend, enabled, zone.as_deref(), ordered, rules.len()), (Backend::Firewalld, true, Some("public"), false, 2));

        let none = format!("family=ubuntu debian\n{M}\nnoufw\n{M}\n{M}\n{M}\n{M}\nnofirewalld\n{M}\n7\n");
        assert!(matches!(parse_state(&none), FirewallState::None { iptables: 7, .. }));
    }

    #[test]
    fn plans_ufw_changes_with_undo() {
        let ctx = Ctx { backend: Backend::Ufw, zone: None, enabled: true };
        let rule = |action: &str, port: &str, proto: &str, from: Option<&str>, comment: Option<&str>| RuleInput {
            action: action.into(),
            port: port.into(),
            proto: proto.into(),
            from: from.map(Into::into),
            comment: comment.map(Into::into),
        };
        let p = plan(&ctx, &Op::Add { rule: rule("allow", "8080", "tcp", None, Some("Web app")) }).unwrap();
        assert_eq!(p.apply, vec!["ufw allow 8080/tcp comment 'Web app'"]);
        assert!(!p.check);
        let p = plan(&ctx, &Op::Add { rule: rule("deny", "22", "tcp", Some("10.0.0.0/8"), None) }).unwrap();
        assert!(p.check);
        assert_eq!(p.rollback, vec!["ufw delete deny from 10.0.0.0/8 to any port 22 proto tcp"]);
        let ssh = parse_ufw_rule("ufw allow 22/tcp comment 'SSH'", &HashMap::new()).unwrap();
        let p = plan(&ctx, &Op::Delete { rule: ssh }).unwrap();
        assert_eq!((p.apply[0].as_str(), p.rollback[0].as_str(), p.check), ("ufw delete allow 22/tcp", "ufw allow 22/tcp comment SSH", true));
        assert!(p.preview(true).contains("sudo ufw delete allow 22/tcp"));
        assert_eq!(ufw_add_args(&rule("allow", "6000:6010", "any", None, None)).unwrap_err().code, "range_needs_proto");
        assert_eq!(ufw_add_args(&rule("allow", "22", "tcp", Some("1.2.3.4; rm -rf /"), None)).unwrap_err().code, "invalid_source");
        assert_eq!(delete_line(&["allow".into(), "Nginx Full".into()]), "ufw delete allow 'Nginx Full'");
    }
}
