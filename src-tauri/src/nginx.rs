//! Nginx sites, read from `nginx -T` (the configuration nginx actually loads)
//! plus the files in sites-available that are not enabled. Certificates are
//! read from what nginx serves (openssl s_client with SNI), and proxy targets
//! on the server are checked with a TCP connect.
//!
//! Changes are small and reversible: enable or disable a site (a symlink in
//! sites-enabled), test the configuration, reload. A change that makes
//! `nginx -t` fail is undone before reloading.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::audit::AuditLog;
use crate::error::{AppError, AppResult};
use crate::i18n::tr;
use crate::ssh::{exec, exec_priv, shell_quote, Session, Sessions, MARK};
use crate::trace;

const AVAILABLE: &str = "/etc/nginx/sites-available";
const ENABLED: &str = "/etc/nginx/sites-enabled";

// ---------------------------------------------------------------- parsing

#[derive(Debug, Clone, PartialEq)]
struct Directive {
    name: String,
    args: Vec<String>,
    block: Option<Vec<Directive>>,
}

#[derive(Debug, PartialEq)]
enum Tok {
    Word(String),
    Open,
    Close,
    End,
}

fn tokenize(text: &str) -> Vec<Tok> {
    let mut out = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(&c) = chars.peek() {
        match c {
            c if c.is_whitespace() => {
                chars.next();
            }
            '#' => {
                while let Some(c) = chars.next() {
                    if c == '\n' {
                        break;
                    }
                }
            }
            '{' => {
                chars.next();
                out.push(Tok::Open);
            }
            '}' => {
                chars.next();
                out.push(Tok::Close);
            }
            ';' => {
                chars.next();
                out.push(Tok::End);
            }
            '"' | '\'' => {
                let quote = c;
                chars.next();
                let mut w = String::new();
                while let Some(c) = chars.next() {
                    match c {
                        '\\' => {
                            if let Some(n) = chars.next() {
                                w.push(n);
                            }
                        }
                        c if c == quote => break,
                        c => w.push(c),
                    }
                }
                out.push(Tok::Word(w));
            }
            _ => {
                let mut w = String::new();
                while let Some(&c) = chars.peek() {
                    if c.is_whitespace() || matches!(c, '{' | '}' | ';') {
                        break;
                    }
                    // `${var}` keeps its braces.
                    if c == '$' {
                        w.push(c);
                        chars.next();
                        if chars.peek() == Some(&'{') {
                            for c in chars.by_ref() {
                                w.push(c);
                                if c == '}' {
                                    break;
                                }
                            }
                        }
                        continue;
                    }
                    w.push(c);
                    chars.next();
                }
                out.push(Tok::Word(w));
            }
        }
    }
    out
}

fn parse_block(toks: &[Tok], i: &mut usize) -> Vec<Directive> {
    let mut out = Vec::new();
    while *i < toks.len() {
        match &toks[*i] {
            Tok::Close => {
                *i += 1;
                return out;
            }
            Tok::Open | Tok::End => *i += 1,
            Tok::Word(name) => {
                let name = name.clone();
                let mut args = Vec::new();
                *i += 1;
                let mut block = None;
                while *i < toks.len() {
                    match &toks[*i] {
                        Tok::Word(a) => {
                            args.push(a.clone());
                            *i += 1;
                        }
                        Tok::End => {
                            *i += 1;
                            break;
                        }
                        Tok::Open => {
                            *i += 1;
                            block = Some(parse_block(toks, i));
                            break;
                        }
                        Tok::Close => break,
                    }
                }
                out.push(Directive { name, args, block });
            }
        }
    }
    out
}

fn parse_conf(text: &str) -> Vec<Directive> {
    let toks = tokenize(text);
    let mut i = 0;
    let mut all = Vec::new();
    // A stray `}` ends a block early; keep reading the rest of the file.
    while i < toks.len() {
        all.extend(parse_block(&toks, &mut i));
    }
    all
}

/// `# configuration file /path:` sections of `nginx -T`, and what came before
/// them (the test result).
fn split_dump(text: &str) -> (String, Vec<(String, String)>) {
    let mut head = String::new();
    let mut files: Vec<(String, String)> = Vec::new();
    for line in text.lines() {
        if let Some(path) = line.strip_prefix("# configuration file ").and_then(|r| r.strip_suffix(':')) {
            files.push((path.to_string(), String::new()));
        } else if let Some((_, body)) = files.last_mut() {
            body.push_str(line);
            body.push('\n');
        } else {
            head.push_str(line);
            head.push('\n');
        }
    }
    (head, files)
}

// ---------------------------------------------------------------- model

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Listen {
    /// "*" when nginx listens on every address.
    pub addr: String,
    pub port: u16,
    pub ssl: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Target {
    Proxy { url: String },
    Static { root: String },
    Redirect { code: u16, to: String },
    /// `return 200 …` and the like: nginx answers by itself.
    Fixed { code: u16 },
    Other,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Cert {
    /// Seconds since epoch.
    pub not_after: u64,
    pub days_left: i64,
    pub subject: String,
    pub issuer: String,
    pub names: Vec<String>,
    pub self_signed: bool,
    /// The certificate nginx served does not cover the site's name.
    pub name_mismatch: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Site {
    /// Stable within a read: file and first server_name.
    pub id: String,
    /// As nginx includes it (sites-enabled/x for an enabled site).
    pub file: String,
    /// The file in sites-available, when the site is managed that way.
    pub available: Option<String>,
    pub enabled: bool,
    pub names: Vec<String>,
    pub listens: Vec<Listen>,
    pub target: Target,
    pub ssl: bool,
    pub https_redirect: bool,
    pub gzip: bool,
    pub websocket: bool,
    pub ssl_certificate: Option<String>,
    pub access_log: Option<String>,
    pub error_log: Option<String>,
    pub cert: Option<Cert>,
    /// Proxy target on this server: accepting connections or not; None when not checked.
    pub upstream_up: Option<bool>,
    /// The server blocks as written, for "Xem cấu hình".
    pub source: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum NginxState {
    Absent,
    /// nginx -T needs root here (permission denied reading its files).
    NeedsRoot { detail: String },
    /// The configuration does not pass `nginx -t`.
    Broken { version: String, running: bool, output: String },
    Ok { version: String, running: bool, test: String, sites: Vec<Site>, layout: bool },
}

fn find<'a>(ds: &'a [Directive], name: &str) -> Option<&'a Directive> {
    ds.iter().find(|d| d.name == name)
}

fn all_nested<'a>(ds: &'a [Directive], out: &mut Vec<&'a Directive>) {
    for d in ds {
        out.push(d);
        if let Some(b) = &d.block {
            all_nested(b, out);
        }
    }
}

fn parse_listen(args: &[String]) -> Option<Listen> {
    let first = args.first()?;
    if first.starts_with("unix:") {
        return None;
    }
    let ssl = args.iter().skip(1).any(|a| a == "ssl" || a == "quic");
    let (addr, port) = if let Ok(p) = first.parse::<u16>() {
        ("*".to_string(), p)
    } else if let Some(i) = first.rfind(':') {
        let (a, p) = first.split_at(i);
        (a.trim_matches(|c| c == '[' || c == ']').to_string(), p[1..].parse().ok()?)
    } else {
        (first.clone(), 80)
    };
    Some(Listen { addr: if addr.is_empty() { "*".into() } else { addr }, port, ssl })
}

/// Values set in the http block that server blocks inherit.
#[derive(Default, Clone)]
struct Inherited {
    gzip: bool,
    access_log: Option<String>,
    error_log: Option<String>,
}

fn log_path(d: Option<&Directive>) -> Option<Option<String>> {
    d.and_then(|d| d.args.first()).map(|p| (p != "off" && !p.starts_with("syslog:")).then(|| p.clone()))
}

/// One server block, before blocks of the same site are merged.
struct Block {
    names: Vec<String>,
    listens: Vec<Listen>,
    target: Target,
    ssl_certificate: Option<String>,
    gzip: bool,
    websocket: bool,
    access_log: Option<String>,
    error_log: Option<String>,
    source: String,
}

fn render(d: &Directive, depth: usize, out: &mut String) {
    let pad = "    ".repeat(depth);
    let args = d.args.iter().map(|a| if a.contains(char::is_whitespace) || a.is_empty() { format!("\"{a}\"") } else { a.clone() }).collect::<Vec<_>>().join(" ");
    let head = if args.is_empty() { d.name.clone() } else { format!("{} {args}", d.name) };
    match &d.block {
        None => out.push_str(&format!("{pad}{head};\n")),
        Some(b) => {
            out.push_str(&format!("{pad}{head} {{\n"));
            for c in b {
                render(c, depth + 1, out);
            }
            out.push_str(&format!("{pad}}}\n"));
        }
    }
}

fn block_of(server: &[Directive], inh: &Inherited) -> Block {
    let names: Vec<String> = server.iter().filter(|d| d.name == "server_name").flat_map(|d| d.args.clone()).filter(|n| !n.is_empty()).collect();
    let mut listens: Vec<Listen> = server.iter().filter(|d| d.name == "listen").filter_map(|d| parse_listen(&d.args)).collect();
    if listens.is_empty() {
        listens.push(Listen { addr: "*".into(), port: 80, ssl: false });
    }
    if find(server, "ssl").is_some_and(|d| d.args.first().map(String::as_str) == Some("on")) {
        listens.iter_mut().for_each(|l| l.ssl = true);
    }
    let locations: Vec<(&str, &[Directive])> = server
        .iter()
        .filter(|d| d.name == "location")
        .filter_map(|d| Some((d.args.last().map(String::as_str).unwrap_or(""), d.block.as_deref()?)))
        .collect();
    let root_loc = locations.iter().find(|(p, _)| *p == "/").map(|(_, b)| *b);
    let proxy = root_loc
        .and_then(|b| find(b, "proxy_pass"))
        .or_else(|| locations.iter().find_map(|(_, b)| find(b, "proxy_pass")))
        .and_then(|d| d.args.first().cloned());
    let ret = find(server, "return").filter(|d| d.args.len() >= 2 && d.args[0].parse::<u16>().is_ok_and(|c| (300..400).contains(&c)));
    let root = find(server, "root").or_else(|| root_loc.and_then(|b| find(b, "root"))).and_then(|d| d.args.first().cloned());
    let fixed = find(server, "return")
        .or_else(|| root_loc.and_then(|b| find(b, "return")))
        .or_else(|| locations.iter().find_map(|(_, b)| find(b, "return")))
        .and_then(|d| d.args.first()?.parse::<u16>().ok());
    let target = if let Some(r) = ret {
        Target::Redirect { code: r.args[0].parse().unwrap_or(301), to: r.args[1].clone() }
    } else if let Some(url) = proxy {
        Target::Proxy { url }
    } else if let Some(root) = root {
        Target::Static { root }
    } else if let Some(code) = fixed {
        Target::Fixed { code }
    } else {
        Target::Other
    };
    let mut nested = Vec::new();
    all_nested(server, &mut nested);
    let gzip = match find(server, "gzip") {
        Some(d) => d.args.first().map(String::as_str) == Some("on"),
        None => inh.gzip,
    };
    let websocket = nested.iter().any(|d| d.name == "proxy_set_header" && d.args.first().is_some_and(|h| h.eq_ignore_ascii_case("upgrade")));
    let mut source = String::new();
    render(&Directive { name: "server".into(), args: vec![], block: Some(server.to_vec()) }, 0, &mut source);
    Block {
        names,
        listens,
        target,
        ssl_certificate: find(server, "ssl_certificate").and_then(|d| d.args.first().cloned()),
        gzip,
        websocket,
        access_log: log_path(find(server, "access_log")).unwrap_or_else(|| inh.access_log.clone()),
        error_log: log_path(find(server, "error_log")).unwrap_or_else(|| inh.error_log.clone()),
        source,
    }
}

/// Server blocks of one file: at the top of an included file, or inside
/// `http` of the main one (never `stream` or `mail`).
fn blocks_in(ds: &[Directive], main: bool, inh: &mut Inherited, out: &mut Vec<Block>) {
    // error_log also works at the top of nginx.conf, outside http.
    if main {
        if let Some(v) = log_path(find(ds, "error_log")) {
            inh.error_log = v;
        }
    }
    for d in ds {
        match (d.name.as_str(), &d.block) {
            ("http", Some(b)) => {
                if let Some(g) = find(b, "gzip") {
                    inh.gzip = g.args.first().map(String::as_str) == Some("on");
                }
                if let Some(v) = log_path(find(b, "access_log")) {
                    inh.access_log = v;
                }
                if let Some(v) = log_path(find(b, "error_log")) {
                    inh.error_log = v;
                }
                blocks_in(b, false, inh, out);
            }
            ("server", Some(b)) if !main => out.push(block_of(b, inh)),
            _ => {}
        }
    }
}

fn is_https_redirect(b: &Block) -> bool {
    matches!(&b.target, Target::Redirect { to, .. } if to.starts_with("https://")) && b.listens.iter().all(|l| !l.ssl)
}

/// Blocks of one file with the same names are one site (the usual :80
/// redirect next to the :443 server).
fn merge(file: &str, blocks: Vec<Block>, enabled: bool, available: Option<String>) -> Vec<Site> {
    let mut groups: Vec<(Vec<String>, Vec<Block>)> = Vec::new();
    for b in blocks {
        let mut key = b.names.clone();
        key.sort();
        match groups.iter_mut().find(|(k, _)| *k == key) {
            Some((_, g)) => g.push(b),
            None => groups.push((key, vec![b])),
        }
    }
    groups
        .into_iter()
        .map(|(_, g)| {
            let https_redirect = g.len() > 1 && g.iter().any(is_https_redirect);
            // The block that serves the site, not the one that only redirects.
            let main = g.iter().find(|b| !(https_redirect && is_https_redirect(b))).unwrap_or(&g[0]);
            let mut listens: Vec<Listen> = Vec::new();
            for l in g.iter().flat_map(|b| b.listens.iter()) {
                if !listens.contains(l) {
                    listens.push(l.clone());
                }
            }
            listens.sort_by_key(|l| (l.port, l.addr.clone()));
            let ssl = listens.iter().any(|l| l.ssl);
            Site {
                id: format!("{file}#{}", main.names.first().cloned().unwrap_or_default()),
                file: file.to_string(),
                available: available.clone(),
                enabled,
                names: main.names.clone(),
                listens,
                target: main.target.clone(),
                ssl,
                https_redirect,
                gzip: main.gzip,
                websocket: main.websocket,
                ssl_certificate: g.iter().find_map(|b| b.ssl_certificate.clone()),
                access_log: main.access_log.clone(),
                error_log: main.error_log.clone(),
                cert: None,
                upstream_up: None,
                source: g.iter().map(|b| b.source.as_str()).collect::<Vec<_>>().join("\n"),
            }
        })
        .collect()
}

// ---------------------------------------------------------------- dates

/// Days since 1970-01-01 of a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// "Oct  6 15:08:31 2026 GMT" as printed by `openssl x509 -enddate`.
fn parse_openssl_date(s: &str) -> Option<u64> {
    let p: Vec<&str> = s.split_whitespace().collect();
    let first = *p.first()?;
    let month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].iter().position(|m| *m == first)? as i64 + 1;
    let day: i64 = p.get(1)?.parse().ok()?;
    let hms: Vec<i64> = p.get(2)?.split(':').filter_map(|x| x.parse().ok()).collect();
    let year: i64 = p.get(3)?.parse().ok()?;
    if hms.len() != 3 {
        return None;
    }
    let secs = days_from_civil(year, month, day) * 86400 + hms[0] * 3600 + hms[1] * 60 + hms[2];
    u64::try_from(secs).ok()
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Whether a certificate name (maybe `*.example.com`) covers `host`.
fn covers(pattern: &str, host: &str) -> bool {
    let (p, h) = (pattern.to_ascii_lowercase(), host.to_ascii_lowercase());
    match p.strip_prefix("*.") {
        Some(rest) => h.split_once('.').is_some_and(|(_, tail)| tail == rest),
        None => p == h,
    }
}

/// Output of `openssl x509 -noout -enddate -issuer -subject -ext subjectAltName`.
fn parse_cert(text: &str, host: &str) -> Option<Cert> {
    let mut not_after = None;
    let (mut subject, mut issuer, mut names) = (String::new(), String::new(), Vec::new());
    let mut in_san = false;
    for line in text.lines() {
        let l = line.trim();
        if let Some(v) = l.strip_prefix("notAfter=") {
            not_after = parse_openssl_date(v);
        } else if let Some(v) = l.strip_prefix("issuer=") {
            issuer = v.trim().to_string();
        } else if let Some(v) = l.strip_prefix("subject=") {
            subject = v.trim().to_string();
        } else if l.starts_with("X509v3 Subject Alternative Name") {
            in_san = true;
        } else if in_san {
            names.extend(l.split(',').filter_map(|n| n.trim().strip_prefix("DNS:").map(str::to_string)));
            in_san = false;
        }
    }
    let not_after = not_after?;
    if names.is_empty() {
        if let Some(cn) = subject.split(',').find_map(|p| p.trim().strip_prefix("CN = ").or_else(|| p.trim().strip_prefix("CN="))) {
            names.push(cn.trim().to_string());
        }
    }
    let days_left = (not_after as i64 - now_secs() as i64).div_euclid(86400);
    Some(Cert {
        not_after,
        days_left,
        self_signed: !subject.is_empty() && subject == issuer,
        name_mismatch: !host.is_empty() && !names.iter().any(|n| covers(n, host)),
        subject,
        issuer,
        names,
    })
}

/// `127.0.0.1:3000` of `http://127.0.0.1:3000/path`; None for upstream names
/// and anything not on this machine.
fn local_target(url: &str) -> Option<(String, u16)> {
    let rest = url.split_once("://")?.1;
    let hostport = rest.split('/').next()?;
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) => (h, p.parse().ok()?),
        None => (hostport, if url.starts_with("https") { 443 } else { 80 }),
    };
    matches!(host, "127.0.0.1" | "localhost" | "[::1]").then(|| (host.trim_matches(|c| c == '[' || c == ']').to_string(), port))
}

// ---------------------------------------------------------------- reading

fn read_script() -> String {
    format!(
        r##"command -v nginx >/dev/null 2>&1 || {{ echo absent; exit 0; }}
nginx -v 2>&1
echo {MARK}
nginx -T 2>&1; echo "exit=$?"
echo {MARK}
if [ -d /run/systemd/system ]; then systemctl is-active nginx 2>/dev/null; else pgrep -x nginx >/dev/null 2>&1 && echo active || echo inactive; fi
echo {MARK}
if [ -d {AVAILABLE} ] && [ -d {ENABLED} ]; then
  echo layout
  for l in {ENABLED}/*; do [ -e "$l" ] && echo "link $l $(readlink -f "$l")"; done
  en=$(for l in {ENABLED}/*; do [ -e "$l" ] && readlink -f "$l"; done)
  for f in {AVAILABLE}/*; do
    [ -f "$f" ] || continue
    r=$(readlink -f "$f")
    echo "$en" | grep -qxF "$r" || {{ echo "# configuration file $f:"; cat "$f"; echo; }}
  done
fi
"##
    )
}

fn parse_state(text: &str, can_escalate: bool) -> (NginxState, HashMap<String, String>) {
    if text.trim() == "absent" {
        return (NginxState::Absent, HashMap::new());
    }
    let parts: Vec<&str> = text.split(MARK).collect();
    let version = parts.first().unwrap_or(&"").trim().trim_start_matches("nginx version: ").to_string();
    let dump = parts.get(1).copied().unwrap_or("");
    let running = parts.get(2).map(|s| s.trim() == "active").unwrap_or(false);
    let extra = parts.get(3).copied().unwrap_or("");
    let ok = dump.contains("exit=0");
    let (head, files) = split_dump(dump.trim().trim_end_matches(|c: char| c != '\n').trim_end());
    let test = head.lines().filter(|l| l.starts_with("nginx:")).collect::<Vec<_>>().join("\n");
    if !ok || files.is_empty() {
        let output = dump.lines().filter(|l| !l.starts_with("exit=")).collect::<Vec<_>>().join("\n");
        if output.contains("Permission denied") && !can_escalate {
            return (NginxState::NeedsRoot { detail: output }, HashMap::new());
        }
        return (NginxState::Broken { version, running, output }, HashMap::new());
    }
    let layout = extra.trim_start().lines().next().map(str::trim) == Some("layout");
    let links: HashMap<String, String> = extra
        .lines()
        .filter_map(|l| l.strip_prefix("link "))
        .filter_map(|l| l.split_once(' '))
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect();

    let mut sites = Vec::new();
    let mut inh = Inherited::default();
    // The main file first, so its http-level defaults apply to the includes.
    for (i, (path, body)) in files.iter().enumerate() {
        let mut blocks = Vec::new();
        blocks_in(&parse_conf(body), i == 0, &mut inh, &mut blocks);
        let available = links.get(path).filter(|t| t.starts_with(&format!("{AVAILABLE}/"))).cloned();
        sites.extend(merge(path, blocks, true, available));
    }
    let (_, disabled) = split_dump(extra);
    for (path, body) in disabled {
        let mut blocks = Vec::new();
        blocks_in(&parse_conf(&body), false, &mut inh.clone(), &mut blocks);
        sites.extend(merge(&path, blocks, false, Some(path.clone())));
    }
    (NginxState::Ok { version, running, test, sites, layout }, links)
}

/// SNI name used to fetch a site's certificate: its first real name.
fn sni_of(site: &Site) -> Option<String> {
    site.names.iter().find(|n| *n != "_" && !n.contains('*') && !n.starts_with('~') && !n.is_empty()).cloned()
}

/// Certificates as served and proxy targets as reachable, one script for all sites.
async fn probe(session: &Session, sites: &mut [Site]) {
    let mut script = String::new();
    let mut asks: Vec<(usize, &'static str)> = Vec::new();
    for (i, s) in sites.iter().enumerate() {
        if !s.enabled {
            continue;
        }
        if let Some(l) = s.listens.iter().find(|l| l.ssl) {
            let addr = if l.addr == "*" || l.addr == "::" || l.addr == "0.0.0.0" { "127.0.0.1".to_string() } else { l.addr.clone() };
            let sni = sni_of(s).unwrap_or_default();
            let sni_arg = if sni.is_empty() { String::new() } else { format!("-servername {}", shell_quote(&sni)) };
            script.push_str(&format!(
                "echo | timeout 5 openssl s_client -connect {}:{} {sni_arg} 2>/dev/null | openssl x509 -noout -enddate -issuer -subject -ext subjectAltName 2>/dev/null; echo {MARK}\n",
                shell_quote(&addr),
                l.port
            ));
            asks.push((i, "cert"));
        }
        if let Target::Proxy { url } = &s.target {
            if let Some((host, port)) = local_target(url) {
                script.push_str(&format!(
                    "if command -v bash >/dev/null 2>&1; then timeout 2 bash -c ': </dev/tcp/{host}/{port}' 2>/dev/null && echo up || echo down; else echo unknown; fi; echo {MARK}\n"
                ));
                asks.push((i, "up"));
            }
        }
    }
    if asks.is_empty() {
        return;
    }
    let Ok(out) = exec(session, &script).await else { return };
    for ((i, what), part) in asks.into_iter().zip(out.stdout.split(MARK)) {
        match what {
            "cert" => {
                let host = sni_of(&sites[i]).unwrap_or_default();
                sites[i].cert = parse_cert(part, &host);
            }
            _ => {
                sites[i].upstream_up = match part.trim() {
                    "up" => Some(true),
                    "down" => Some(false),
                    _ => None,
                }
            }
        }
    }
}

#[tauri::command]
pub async fn nginx_state(sessions: tauri::State<'_, Sessions>, server_id: String, user: String) -> AppResult<NginxState> {
    let run = async move {
        let session = sessions.get(&server_id, &user)?;
        let out = exec_priv(&session, &read_script(), Duration::from_secs(30)).await?;
        let (mut state, _) = parse_state(&out.stdout, session.is_root() || session.sudo_on());
        if let NginxState::Ok { sites, .. } = &mut state {
            probe(&session, sites).await;
        }
        Ok(state)
    };
    let r: AppResult<NginxState> = trace::labelled(tr("Nginx · đọc cấu hình", "Nginx · read config"), run).await;
    r
}

// ---------------------------------------------------------------- actions

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Action {
    Test,
    Reload,
    /// Link a file of sites-available into sites-enabled.
    Enable { file: String },
    /// Remove a site's link from sites-enabled.
    Disable { link: String },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub ok: bool,
    /// What nginx -t (and reload) printed.
    pub output: String,
    /// The change was undone because nginx -t failed.
    pub rolled_back: bool,
}

const RELOAD: &str = "if [ -d /run/systemd/system ]; then systemctl reload nginx; else nginx -s reload; fi";

fn safe_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains('/') && !name.contains('\0')
}

/// The script for an action, as run and as shown.
pub(crate) fn action_script(a: &Action) -> AppResult<String> {
    Ok(match a {
        Action::Test => "nginx -t".into(),
        Action::Reload => format!("nginx -t && {RELOAD}"),
        Action::Enable { file } => {
            let name = file.strip_prefix(&format!("{AVAILABLE}/")).filter(|n| safe_name(n)).ok_or_else(|| AppError::detail("invalid_site", file))?;
            let link = format!("{ENABLED}/{name}");
            format!(
                "ln -s {src} {dst} && if nginx -t; then {RELOAD}; else rm -f {dst}; echo @@ROLLBACK@@; exit 3; fi",
                src = shell_quote(file),
                dst = shell_quote(&link)
            )
        }
        Action::Disable { link } => {
            let name = link.strip_prefix(&format!("{ENABLED}/")).filter(|n| safe_name(n)).ok_or_else(|| AppError::detail("invalid_site", link))?;
            let dst = format!("{ENABLED}/{name}");
            // Put the same link back if nginx -t fails without it.
            format!(
                "t=$(readlink {dst}) && rm {dst} && if nginx -t; then {RELOAD}; else ln -s \"$t\" {dst}; echo @@ROLLBACK@@; exit 3; fi",
                dst = shell_quote(&dst)
            )
        }
    })
}

#[tauri::command]
pub async fn nginx_action(
    sessions: tauri::State<'_, Sessions>,
    audit: tauri::State<'_, AuditLog>,
    server_id: String,
    user: String,
    action: Action,
) -> AppResult<ActionResult> {
    let script = action_script(&action)?;
    let run = async {
        let session = sessions.get(&server_id, &user)?;
        let out = exec_priv(&session, &format!("{{ {script}; }} 2>&1"), Duration::from_secs(40)).await?;
        let rolled_back = out.stdout.contains("@@ROLLBACK@@");
        let output = out.stdout.replace("@@ROLLBACK@@\n", "").replace("@@ROLLBACK@@", "").trim().to_string();
        let ok = out.code == Some(0);
        let label = match &action {
            Action::Test => "nginxTest",
            Action::Reload => "nginxReload",
            Action::Enable { .. } => "nginxEnable",
            Action::Disable { .. } => "nginxDisable",
        };
        if !matches!(action, Action::Test) {
            audit.record(&server_id, &user, label, crate::ssh::shown_as_run(&session, &script), ok, (!ok).then(|| output.clone()));
        }
        Ok(ActionResult { ok, output, rolled_back })
    };
    let r: AppResult<ActionResult> = trace::labelled(tr("Nginx · thao tác", "Nginx · action"), run).await;
    r
}

#[tauri::command]
pub fn nginx_action_preview(action: Action) -> AppResult<String> {
    // The marker only tells Portway a rollback happened.
    Ok(action_script(&action)?.replace("echo @@ROLLBACK@@; ", ""))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAIN: &str = r#"
user www-data;
error_log /var/log/nginx/main-error.log;
events { worker_connections 768; }
http {
    gzip off;
    access_log /var/log/nginx/access.log;
    include /etc/nginx/sites-enabled/*;
    server { listen 8080; server_name inside.test; root /srv/inside; }
    server { listen 127.0.0.1:3000; location / { return 200 'ok'; } }
}
stream { server { listen 5432; proxy_pass db:5432; } }
"#;

    const SHOP: &str = r#"
# comment { not a block }
server {
    listen 80;
    server_name shop.test www.shop.test;
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl http2;
    listen [::]:443 ssl;
    server_name shop.test www.shop.test;
    ssl_certificate "/etc/ssl/shop.crt";
    gzip on;
    access_log off;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Upgrade $http_upgrade;
        add_header X-Test "a;b";
    }
}
"#;

    fn dump() -> String {
        format!(
            "nginx version: nginx/1.22.1\n{MARK}\nnginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful\n# configuration file /etc/nginx/nginx.conf:\n{MAIN}\n# configuration file /etc/nginx/sites-enabled/shop:\n{SHOP}\nexit=0\n{MARK}\nactive\n{MARK}\nlayout\nlink /etc/nginx/sites-enabled/shop /etc/nginx/sites-available/shop\n# configuration file /etc/nginx/sites-available/old:\nserver {{ listen 80; server_name old.test; return 302 https://shop.test; }}\n"
        )
    }

    #[test]
    fn tokenizes_quotes_comments_and_variables() {
        let d = parse_conf("add_header X \"a;b\"; # c { \nset $x ${y}z;");
        assert_eq!(d[0].args, ["X", "a;b"]);
        assert_eq!(d[1].args, ["$x", "${y}z"]);
    }

    #[test]
    fn reads_sites_from_dump() {
        let (state, _) = parse_state(&dump(), true);
        let NginxState::Ok { version, running, sites, layout, test } = state else { panic!("not ok") };
        assert_eq!(version, "nginx/1.22.1");
        assert!(running && layout && test.contains("syntax is ok"));
        let names: Vec<_> = sites.iter().map(|s| s.names.join(",")).collect();
        assert_eq!(names, ["inside.test", "", "shop.test,www.shop.test", "old.test"], "stream servers are left out");
        assert_eq!(sites[1].target, Target::Fixed { code: 200 });
        assert_eq!(sites[1].listens, [Listen { addr: "127.0.0.1".into(), port: 3000, ssl: false }]);

        let inside = &sites[0];
        assert_eq!(inside.target, Target::Static { root: "/srv/inside".into() });
        assert_eq!(inside.access_log.as_deref(), Some("/var/log/nginx/access.log"));
        assert!(!inside.gzip);

        let shop = &sites[2];
        assert!(shop.ssl && shop.https_redirect && shop.gzip && shop.websocket && shop.enabled);
        assert_eq!(shop.target, Target::Proxy { url: "http://127.0.0.1:3000".into() });
        assert_eq!(shop.listens.iter().map(|l| (l.addr.as_str(), l.port, l.ssl)).collect::<Vec<_>>(), [("*", 80, false), ("*", 443, true), ("::", 443, true)]);
        assert_eq!(shop.ssl_certificate.as_deref(), Some("/etc/ssl/shop.crt"));
        assert_eq!(shop.access_log, None, "access_log off");
        assert_eq!(shop.error_log.as_deref(), Some("/var/log/nginx/main-error.log"), "from the top of nginx.conf");
        assert_eq!(shop.available.as_deref(), Some("/etc/nginx/sites-available/shop"));
        assert!(shop.source.contains("proxy_pass http://127.0.0.1:3000;"));

        let old = &sites[3];
        assert!(!old.enabled);
        assert_eq!(old.target, Target::Redirect { code: 302, to: "https://shop.test".into() });
    }

    #[test]
    fn broken_config_and_needs_root() {
        let broken = format!("nginx version: nginx/1.22.1\n{MARK}\nnginx: [emerg] unknown directive \"proxy_pas\" in /etc/nginx/sites-enabled/x:9\nnginx: configuration file /etc/nginx/nginx.conf test failed\nexit=1\n{MARK}\nactive\n{MARK}\n");
        assert!(matches!(parse_state(&broken, true).0, NginxState::Broken { ref output, .. } if output.contains("proxy_pas")));
        let denied = format!("nginx version: nginx/1.22.1\n{MARK}\nnginx: [emerg] open() \"/run/nginx.pid\" failed (13: Permission denied)\nexit=1\n{MARK}\nactive\n{MARK}\n");
        assert!(matches!(parse_state(&denied, false).0, NginxState::NeedsRoot { .. }));
        assert!(matches!(parse_state("absent\n", false).0, NginxState::Absent));
    }

    #[test]
    fn reads_certificates() {
        assert_eq!(parse_openssl_date("Jan  1 00:00:00 1970 GMT"), Some(0));
        assert_eq!(parse_openssl_date("Oct  6 15:08:31 2026 GMT"), Some(1_791_299_311));
        let text = "notAfter=Oct  6 15:08:31 2026 GMT\nissuer=C = US, O = Let's Encrypt, CN = R11\nsubject=CN = shop.test\nX509v3 Subject Alternative Name: \n    DNS:shop.test, DNS:*.shop.test\n";
        let c = parse_cert(text, "www.shop.test").unwrap();
        assert_eq!(c.names, ["shop.test", "*.shop.test"]);
        assert!(!c.self_signed && !c.name_mismatch);
        let selfsigned = parse_cert("notAfter=Oct  6 15:08:31 2026 GMT\nissuer=CN = blog.test\nsubject=CN = blog.test\n", "other.test").unwrap();
        assert!(selfsigned.self_signed && selfsigned.name_mismatch);
        assert_eq!(selfsigned.names, ["blog.test"]);
        assert!(parse_cert("", "x").is_none());
    }

    #[test]
    fn local_targets_and_scripts() {
        assert_eq!(local_target("http://127.0.0.1:3000/api"), Some(("127.0.0.1".into(), 3000)));
        assert_eq!(local_target("http://localhost"), Some(("localhost".into(), 80)));
        assert_eq!(local_target("http://backend_pool"), None);
        assert_eq!(local_target("http://10.0.0.5:8080"), None);
        assert!(action_script(&Action::Enable { file: "/etc/nginx/sites-available/../x".into() }).is_err());
        assert!(action_script(&Action::Enable { file: "/etc/passwd".into() }).is_err());
        let s = action_script(&Action::Disable { link: "/etc/nginx/sites-enabled/shop".into() }).unwrap();
        assert!(s.contains("rm /etc/nginx/sites-enabled/shop") && s.contains("@@ROLLBACK@@"));
    }
}
