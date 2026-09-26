//! "HTTP (curl)": a Postman-like request builder that runs curl on the
//! server itself, so services listening on localhost, in containers or on a
//! private network answer as they do for the server.
//!
//! Headers, credentials and the body never go on curl's command line (other
//! users could read them in `ps`): they travel on stdin into a curl config
//! file and a body file in a private temporary directory, removed on exit.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::error::{AppError, AppResult};
use crate::i18n::tr;
use crate::ssh::{exec_input, Sessions, MARK};
use crate::trace;

/// Response bodies are shown up to this size; the full size is reported.
const BODY_LIMIT: usize = 2 * 1024 * 1024;
const HISTORY: usize = 50;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pair {
    pub name: String,
    pub value: String,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Body {
    None,
    Json { text: String },
    /// application/x-www-form-urlencoded
    Form { fields: Vec<Pair> },
    Text { text: String, content_type: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Auth {
    None,
    Bearer { token: String },
    Basic { user: String, password: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Options {
    pub follow_redirects: bool,
    /// Skip TLS verification (self-signed, IP instead of the name).
    pub insecure: bool,
    pub timeout_secs: u32,
    /// Send to this address instead of what the URL's host resolves to (curl --resolve).
    pub connect_to: String,
    pub compressed: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self { follow_redirects: true, insecure: false, timeout_secs: 30, connect_to: String::new(), compressed: true }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<Pair>,
    pub body: Body,
    pub auth: Auth,
    #[serde(default)]
    pub options: Options,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Timings {
    pub dns: f64,
    pub connect: f64,
    pub tls: f64,
    pub first_byte: f64,
    pub total: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    /// 0 when curl got no answer (see `error`).
    pub status: u16,
    pub reason: String,
    pub http_version: String,
    /// Headers of the final response (after redirects).
    pub headers: Vec<(String, String)>,
    /// UTF-8 text of the body, when it is text.
    pub text: Option<String>,
    /// The body as base64 when it is not text.
    pub binary: Option<String>,
    pub size: u64,
    pub truncated: bool,
    pub content_type: String,
    pub timings: Timings,
    pub remote: String,
    pub final_url: String,
    pub redirects: u32,
    /// curl's own error (no route, TLS failure, timeout…).
    pub error: Option<String>,
    /// The request as a curl command line, to copy.
    pub command: String,
}

// ------------------------------------------------------------ building

/// A value in double quotes for a curl config file.
fn cfg(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn percent(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            b' ' => "+".into(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn valid_method(m: &str) -> bool {
    !m.is_empty() && m.len() <= 16 && m.bytes().all(|b| b.is_ascii_uppercase())
}

/// The URL with a scheme; "localhost:3000/x" becomes "http://localhost:3000/x".
pub(crate) fn full_url(url: &str) -> AppResult<String> {
    let u = url.trim();
    if u.is_empty() || u.contains(char::is_whitespace) {
        return Err(AppError::detail("invalid_url", url));
    }
    Ok(if u.contains("://") {
        if !(u.starts_with("http://") || u.starts_with("https://")) {
            return Err(AppError::detail("invalid_url", url));
        }
        u.to_string()
    } else {
        format!("http://{u}")
    })
}

/// Host and port of a URL, for --resolve.
fn host_port(url: &str) -> Option<(String, u16)> {
    let (scheme, rest) = url.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit('@').next()?;
    let default = if scheme == "https" { 443 } else { 80 };
    if let Some(v6) = authority.strip_prefix('[') {
        let (h, p) = v6.split_once(']')?;
        return Some((format!("[{h}]"), p.strip_prefix(':').and_then(|p| p.parse().ok()).unwrap_or(default)));
    }
    match authority.rsplit_once(':') {
        Some((h, p)) => Some((h.to_string(), p.parse().ok()?)),
        None => Some((authority.to_string(), default)),
    }
}

fn has_header(r: &Request, name: &str) -> bool {
    r.headers.iter().any(|h| h.enabled && h.name.trim().eq_ignore_ascii_case(name))
}

/// The body bytes to send and the Content-Type it implies.
fn body_of(r: &Request) -> (Option<Vec<u8>>, Option<String>) {
    match &r.body {
        Body::None => (None, None),
        Body::Json { text } => (Some(text.as_bytes().to_vec()), Some("application/json".into())),
        Body::Text { text, content_type } => (Some(text.as_bytes().to_vec()), Some(content_type.clone()).filter(|c| !c.trim().is_empty())),
        Body::Form { fields } => {
            let s = fields.iter().filter(|f| f.enabled && !f.name.is_empty()).map(|f| format!("{}={}", percent(&f.name), percent(&f.value))).collect::<Vec<_>>().join("&");
            (Some(s.into_bytes()), Some("application/x-www-form-urlencoded".into()))
        }
    }
}

/// What curl reads from its config file (everything but output paths).
pub(crate) fn config_of(r: &Request) -> AppResult<String> {
    let method = r.method.trim().to_ascii_uppercase();
    if !valid_method(&method) {
        return Err(AppError::detail("invalid_method", &r.method));
    }
    let url = full_url(&r.url)?;
    let mut c = vec![format!("url = {}", cfg(&url)), "silent".into(), "show-error".into()];
    if method == "HEAD" {
        c.push("head".into());
    } else if method != "GET" || !matches!(r.body, Body::None) {
        c.push(format!("request = {}", cfg(&method)));
    }
    for h in r.headers.iter().filter(|h| h.enabled && !h.name.trim().is_empty()) {
        if h.name.contains(['\n', '\r', ':']) || h.value.contains(['\n', '\r']) {
            return Err(AppError::detail("invalid_header", &h.name));
        }
        c.push(format!("header = {}", cfg(&format!("{}: {}", h.name.trim(), h.value))));
    }
    let (body, ctype) = body_of(r);
    if body.is_some() && !has_header(r, "content-type") {
        if let Some(t) = ctype {
            c.push(format!("header = {}", cfg(&format!("Content-Type: {t}"))));
        }
    }
    match &r.auth {
        Auth::None => {}
        Auth::Bearer { token } if !token.is_empty() => c.push(format!("header = {}", cfg(&format!("Authorization: Bearer {token}")))),
        Auth::Bearer { .. } => {}
        Auth::Basic { user, password } => c.push(format!("user = {}", cfg(&format!("{user}:{password}")))),
    }
    let o = &r.options;
    if o.follow_redirects {
        c.push("location".into());
        c.push("max-redirs = 10".into());
    }
    if o.insecure {
        c.push("insecure".into());
    }
    if o.compressed {
        c.push("compressed".into());
    }
    c.push(format!("max-time = {}", o.timeout_secs.clamp(1, 600)));
    let to = o.connect_to.trim();
    if !to.is_empty() {
        if to.contains(char::is_whitespace) || to.contains(['"', '\\']) {
            return Err(AppError::detail("invalid_connect_to", to));
        }
        let (host, port) = host_port(&url).ok_or_else(|| AppError::detail("invalid_url", &url))?;
        c.push(format!("resolve = {}", cfg(&format!("{}:{port}:{to}", host.trim_matches(|ch| ch == '[' || ch == ']')))));
    }
    c.push(format!(
        "write-out = {}",
        cfg("%{http_code}\n%{http_version}\n%{time_namelookup}\n%{time_connect}\n%{time_appconnect}\n%{time_starttransfer}\n%{time_total}\n%{size_download}\n%{remote_ip}\n%{remote_port}\n%{url_effective}\n%{num_redirects}\n%{content_type}\n")
    ));
    Ok(c.join("\n") + "\n")
}

/// A shell-quoted curl command doing the same, for the user to copy.
pub(crate) fn command_of(r: &Request) -> String {
    use crate::ssh::shell_quote as q;
    let method = r.method.trim().to_ascii_uppercase();
    let url = full_url(&r.url).unwrap_or_else(|_| r.url.clone());
    let mut p = vec!["curl".to_string()];
    if method == "HEAD" {
        p.push("-I".into());
    } else if method != "GET" || !matches!(r.body, Body::None) {
        p.push(format!("-X {method}"));
    }
    if r.options.follow_redirects {
        p.push("-L".into());
    }
    if r.options.insecure {
        p.push("-k".into());
    }
    if r.options.compressed {
        p.push("--compressed".into());
    }
    if let (false, Some((host, port))) = (r.options.connect_to.trim().is_empty(), host_port(&url)) {
        p.push(format!("--resolve {}", q(&format!("{}:{port}:{}", host.trim_matches(|c| c == '[' || c == ']'), r.options.connect_to.trim()))));
    }
    for h in r.headers.iter().filter(|h| h.enabled && !h.name.trim().is_empty()) {
        p.push(format!("-H {}", q(&format!("{}: {}", h.name.trim(), h.value))));
    }
    let (body, ctype) = body_of(r);
    if body.is_some() && !has_header(r, "content-type") {
        if let Some(t) = ctype {
            p.push(format!("-H {}", q(&format!("Content-Type: {t}"))));
        }
    }
    match &r.auth {
        Auth::Bearer { token } if !token.is_empty() => p.push(format!("-H {}", q(&format!("Authorization: Bearer {token}")))),
        Auth::Basic { user, password } => p.push(format!("-u {}", q(&format!("{user}:{password}")))),
        _ => {}
    }
    if let Some(b) = body {
        p.push(format!("--data-binary {}", q(&String::from_utf8_lossy(&b))));
    }
    p.push(q(&url));
    p.join(" ")
}

// ------------------------------------------------------------ running

fn script(has_body: bool) -> String {
    let data = if has_body { r#"--data-binary "@$d/body""# } else { "" };
    format!(
        r#"command -v curl >/dev/null 2>&1 || {{ echo NOCURL; exit 0; }}
d=$(mktemp -d) || exit 1
trap 'rm -rf "$d"' EXIT
IFS= read -r b64
printf '%s' "$b64" | base64 -d > "$d/body"
cat > "$d/cfg"
curl -K "$d/cfg" {data} -o "$d/out" -D "$d/hdr" 2>"$d/err"; code=$?
echo {MARK}; cat "$d/hdr" 2>/dev/null
echo {MARK}; head -c {BODY_LIMIT} "$d/out" 2>/dev/null | base64
echo {MARK}; wc -c < "$d/out" 2>/dev/null || echo 0
echo {MARK}; echo $code
echo {MARK}; cat "$d/err"
"#
    )
}

/// The last response's status line and headers from a `-D` dump that may hold
/// several (redirects, 100 Continue).
fn last_headers(dump: &str) -> (String, Vec<(String, String)>) {
    let mut blocks: Vec<(String, Vec<(String, String)>)> = Vec::new();
    for line in dump.lines() {
        let l = line.trim_end_matches('\r');
        if l.starts_with("HTTP/") {
            blocks.push((l.to_string(), Vec::new()));
        } else if let (Some((_, hs)), Some((k, v))) = (blocks.last_mut(), l.split_once(':')) {
            hs.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    // A final "HTTP/1.1 100 Continue" without headers is not the answer.
    while blocks.len() > 1 && blocks.last().is_some_and(|b| b.0.split_whitespace().nth(1) == Some("100")) {
        blocks.pop();
    }
    blocks.pop().unwrap_or_default()
}

fn secs_to_ms(s: &str) -> f64 {
    s.trim().parse::<f64>().map(|v| (v * 1000.0 * 10.0).round() / 10.0).unwrap_or(0.0)
}

fn parse_output(out: &str, command: String) -> AppResult<Response> {
    if out.trim() == "NOCURL" {
        return Err(AppError::new("no_curl"));
    }
    let parts: Vec<&str> = out.split(MARK).collect();
    let w: Vec<&str> = parts.first().unwrap_or(&"").lines().collect();
    let get = |i: usize| w.get(i).copied().unwrap_or("").trim().to_string();
    let (status_line, headers) = last_headers(parts.get(1).unwrap_or(&""));
    let b64: String = parts.get(2).unwrap_or(&"").split_whitespace().collect();
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).unwrap_or_default();
    let size: u64 = parts.get(3).and_then(|s| s.trim().parse().ok()).unwrap_or(bytes.len() as u64);
    let code: i32 = parts.get(4).and_then(|s| s.trim().parse().ok()).unwrap_or(-1);
    let stderr = parts.get(5).unwrap_or(&"").trim().to_string();
    let status: u16 = get(0).parse().unwrap_or(0);
    let reason = status_line.splitn(3, ' ').nth(2).unwrap_or("").trim().to_string();
    let (text, binary) = match String::from_utf8(bytes) {
        Ok(t) if !t.contains('\0') => (Some(t), None),
        Ok(t) => (None, Some(base64::engine::general_purpose::STANDARD.encode(t.as_bytes()))),
        Err(e) => (None, Some(base64::engine::general_purpose::STANDARD.encode(e.as_bytes()))),
    };
    let t = |i| secs_to_ms(&get(i));
    let (dns, connect, tls, first, total) = (t(2), t(3), t(4), t(5), t(6));
    Ok(Response {
        status,
        reason,
        http_version: get(1),
        headers,
        text,
        binary,
        size,
        truncated: size as usize > BODY_LIMIT,
        content_type: get(12),
        timings: Timings {
            dns,
            connect: (connect - dns).max(0.0),
            tls: if tls > 0.0 { (tls - connect).max(0.0) } else { 0.0 },
            first_byte: (first - if tls > 0.0 { tls } else { connect }).max(0.0),
            total,
        },
        remote: if get(8).is_empty() { String::new() } else { format!("{}:{}", get(8), get(9)) },
        final_url: get(10),
        redirects: get(11).parse().unwrap_or(0),
        error: (code != 0).then(|| if stderr.is_empty() { format!("curl exit {code}") } else { stderr }),
        command,
    })
}

// ------------------------------------------------------------ saved requests

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub id: String,
    /// None: offered on every server.
    pub server_id: Option<String>,
    pub name: String,
    pub request: Request,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub id: String,
    pub at: u64,
    pub request: Request,
    pub status: u16,
    pub ms: f64,
    pub error: bool,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoreFile {
    #[serde(default)]
    saved: Vec<Saved>,
    #[serde(default)]
    history: HashMap<String, Vec<HistoryItem>>,
}

pub struct HttpStore {
    path: PathBuf,
    data: Mutex<StoreFile>,
}

impl HttpStore {
    pub fn load(path: PathBuf) -> Self {
        let data = fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        Self { path, data: Mutex::new(data) }
    }

    fn persist(&self, data: &StoreFile) -> AppResult<()> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(data)?)?;
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[tauri::command]
pub async fn http_send(
    sessions: tauri::State<'_, Sessions>,
    store: tauri::State<'_, HttpStore>,
    server_id: String,
    user: String,
    request: Request,
) -> AppResult<Response> {
    let config = config_of(&request)?;
    let command = command_of(&request);
    let (body, _) = body_of(&request);
    let has_body = body.is_some();
    let input = format!("{}\n{config}", base64::engine::general_purpose::STANDARD.encode(body.unwrap_or_default()));
    let timeout = Duration::from_secs(request.options.timeout_secs.clamp(1, 600) as u64 + 15);
    let run = async {
        let session = sessions.get(&server_id, &user)?;
        let out = exec_input(&session, &script(has_body), &input, false, timeout).await?;
        parse_output(&out.stdout, command)
    };
    let r: AppResult<Response> = trace::labelled(tr("HTTP · gửi request", "HTTP · send request"), run).await;
    let resp = r?;
    let mut data = store.data.lock().unwrap();
    let list = data.history.entry(server_id).or_default();
    list.insert(0, HistoryItem { id: uuid::Uuid::new_v4().to_string(), at: now_ms(), request, status: resp.status, ms: resp.timings.total, error: resp.error.is_some() });
    list.truncate(HISTORY);
    let _ = store.persist(&data);
    Ok(resp)
}

#[tauri::command]
pub fn http_saved(store: tauri::State<'_, HttpStore>, server_id: String) -> Vec<Saved> {
    store.data.lock().unwrap().saved.iter().filter(|s| s.server_id.as_deref().is_none_or(|id| id == server_id)).cloned().collect()
}

#[tauri::command]
pub fn http_history(store: tauri::State<'_, HttpStore>, server_id: String) -> Vec<HistoryItem> {
    store.data.lock().unwrap().history.get(&server_id).cloned().unwrap_or_default()
}

#[tauri::command]
pub fn http_history_clear(store: tauri::State<'_, HttpStore>, server_id: String) -> AppResult<()> {
    let mut data = store.data.lock().unwrap();
    data.history.remove(&server_id);
    store.persist(&data)
}

/// Add or replace a saved request (an empty id adds).
#[tauri::command]
pub fn http_save(store: tauri::State<'_, HttpStore>, saved: Saved) -> AppResult<Saved> {
    if saved.name.trim().is_empty() {
        return Err(AppError::field("required", "name"));
    }
    let mut data = store.data.lock().unwrap();
    let mut item = saved;
    item.name = item.name.trim().to_string();
    match data.saved.iter_mut().find(|s| s.id == item.id && !item.id.is_empty()) {
        Some(s) => *s = item.clone(),
        None => {
            item.id = uuid::Uuid::new_v4().to_string();
            data.saved.push(item.clone());
        }
    }
    store.persist(&data)?;
    Ok(item)
}

#[tauri::command]
pub fn http_delete(store: tauri::State<'_, HttpStore>, id: String) -> AppResult<()> {
    let mut data = store.data.lock().unwrap();
    data.saved.retain(|s| s.id != id);
    store.persist(&data)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> Request {
        Request {
            method: "post".into(),
            url: "localhost:3000/api/items?x=1".into(),
            headers: vec![
                Pair { name: "X-Trace".into(), value: "a \"b\" \\ c".into(), enabled: true },
                Pair { name: "X-Off".into(), value: "no".into(), enabled: false },
            ],
            body: Body::Json { text: "{\"name\":\"x\"}".into() },
            auth: Auth::Bearer { token: "tok".into() },
            options: Options { connect_to: "127.0.0.1".into(), ..Default::default() },
        }
    }

    #[test]
    fn builds_config_and_command() {
        let c = config_of(&req()).unwrap();
        assert!(c.contains(r#"url = "http://localhost:3000/api/items?x=1""#));
        assert!(c.contains(r#"request = "POST""#));
        assert!(c.contains(r#"header = "X-Trace: a \"b\" \\ c""#));
        assert!(!c.contains("X-Off"));
        assert!(c.contains(r#"header = "Content-Type: application/json""#));
        assert!(c.contains(r#"header = "Authorization: Bearer tok""#));
        assert!(c.contains(r#"resolve = "localhost:3000:127.0.0.1""#));
        assert!(c.contains("location") && c.contains("max-time = 30"));
        let cmd = command_of(&req());
        assert!(cmd.starts_with("curl -X POST -L --compressed --resolve localhost:3000:127.0.0.1 -H 'X-Trace: a \"b\" \\ c'"), "{cmd}");
        assert!(cmd.ends_with("--data-binary '{\"name\":\"x\"}' 'http://localhost:3000/api/items?x=1'"), "{cmd}");
    }

    #[test]
    fn refuses_bad_input() {
        let mut r = req();
        r.headers[0].value = "a\nb".into();
        assert_eq!(config_of(&r).unwrap_err().code, "invalid_header");
        r = req();
        r.method = "GE T".into();
        assert_eq!(config_of(&r).unwrap_err().code, "invalid_method");
        assert_eq!(full_url("ftp://x").unwrap_err().code, "invalid_url");
        assert_eq!(host_port("https://[::1]/x"), Some(("[::1]".into(), 443)));
        assert_eq!(host_port("http://u:p@h:8080/x"), Some(("h".into(), 8080)));
        let form = Request { body: Body::Form { fields: vec![Pair { name: "a b".into(), value: "x&y=é".into(), enabled: true }] }, ..req() };
        assert_eq!(body_of(&form).0.unwrap(), b"a+b=x%26y%3D%C3%A9");
    }

    #[test]
    fn reads_curl_output() {
        let out = format!(
            "200\n1.1\n0.001\n0.002\n0\n0.010\n0.020\n0\n127.0.0.1\n80\nhttp://x/\n0\ntext/html\n{MARK}\nHTTP/1.1 301 Moved\r\nLocation: /b\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-A: 1\r\n\r\n{MARK}\neyJvayI6dHJ1ZX0=\n{MARK}\n11\n{MARK}\n0\n{MARK}\n"
        );
        let r = parse_output(&out, "curl x".into()).unwrap();
        assert_eq!((r.status, r.reason.as_str(), r.text.as_deref()), (200, "OK", Some("{\"ok\":true}")));
        assert_eq!(r.headers, [("Content-Type".to_string(), "application/json".to_string()), ("X-A".into(), "1".into())]);
        assert_eq!((r.timings.dns, r.timings.connect, r.timings.first_byte, r.timings.total), (1.0, 1.0, 8.0, 20.0));
        assert!(r.error.is_none());
        let failed = format!("000\n0\n0\n0\n0\n0\n0.5\n0\n\n0\nhttp://x/\n0\n\n{MARK}\n{MARK}\n{MARK}\n0\n{MARK}\n7\n{MARK}\ncurl: (7) Failed to connect\n");
        let f = parse_output(&failed, String::new()).unwrap();
        assert_eq!(f.status, 0);
        assert_eq!(f.error.as_deref(), Some("curl: (7) Failed to connect"));
        assert_eq!(parse_output("NOCURL\n", String::new()).unwrap_err().code, "no_curl");
    }
}
