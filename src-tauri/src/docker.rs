//! Docker: containers, compose projects, images and volumes, read and changed
//! through the docker CLI on the server. Everything runs as the session's user,
//! or through sudo when the session has it turned on (like the other
//! privileged reads), so users outside the docker group can still get in.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::time::Duration;

use crate::audit::AuditLog;
use crate::error::{AppError, AppResult};
use crate::trace;
use crate::ssh::{exec_priv, shell_quote, shown_as_run, Session, Sessions, MARK};

const READ_TIMEOUT: Duration = Duration::from_secs(30);

// ---------------------------------------------------------------- containers

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Port {
    pub host_ip: String,
    pub host_port: u16,
    pub container_port: u16,
    pub proto: String,
    /// Bound on every address (0.0.0.0 / ::), so reachable from outside the
    /// server; Docker writes its own iptables rules, so UFW does not stop it.
    pub public: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Mount {
    /// "volume", "bind", "tmpfs"…
    pub kind: String,
    /// Volume name, for named volumes.
    pub name: Option<String>,
    pub source: String,
    pub destination: String,
    pub rw: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EnvVar {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Container {
    pub id: String,
    pub name: String,
    /// As written when it was created, e.g. "postgres:16-alpine".
    pub image: String,
    pub image_id: String,
    /// created, running, paused, restarting, removing, exited, dead
    pub state: String,
    pub exit_code: i64,
    /// healthy, unhealthy, starting; None without a health check.
    pub health: Option<String>,
    /// Consecutive failed health checks.
    pub health_failures: u64,
    pub restarts: u64,
    /// no, always, unless-stopped, on-failure
    pub policy: String,
    /// RFC 3339 times as Docker reports them.
    pub created: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub command: String,
    pub ports: Vec<Port>,
    pub mounts: Vec<Mount>,
    pub env: Vec<EnvVar>,
    pub networks: Vec<String>,
    /// Compose labels, when the container belongs to a compose project.
    pub project: Option<String>,
    pub service: Option<String>,
    pub config_files: Vec<String>,
    /// Every compose file is still on the server, so compose commands can run.
    pub config_found: bool,
    pub working_dir: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DockerState {
    NotInstalled,
    /// Not root, not in the docker group, no sudo.
    NoAccess { detail: String },
    DaemonDown { detail: String, systemd: bool },
    Ok { version: String, compose: Option<String>, containers: Vec<Container> },
}

pub(crate) const OVERVIEW_SCRIPT: &str = r#"
if ! command -v docker >/dev/null 2>&1; then echo notinstalled; exit 0; fi
v=$(docker version --format '{{.Server.Version}}' 2>&1); echo "rc=$?"; echo "$v"
echo @@PORTWAY@@
docker compose version --short 2>/dev/null
echo @@PORTWAY@@
ids=$(docker ps -aq --no-trunc 2>/dev/null)
if [ -n "$ids" ]; then docker inspect $ids 2>/dev/null; else echo '[]'; fi
echo @@PORTWAY@@
if [ -d /run/systemd/system ]; then echo systemd; fi
"#;

/// Docker prints "0001-01-01T00:00:00Z" for times that never happened.
fn when(v: &Value) -> Option<String> {
    v.as_str().filter(|s| !s.starts_with("0001-")).map(str::to_string)
}

fn s(v: &Value) -> String {
    v.as_str().unwrap_or("").to_string()
}

fn is_public(ip: &str) -> bool {
    matches!(ip, "" | "0.0.0.0" | "::" | "[::]")
}

fn parse_ports(v: &Value) -> Vec<Port> {
    let mut out = Vec::new();
    let Some(map) = v.as_object() else { return out };
    for (key, binds) in map {
        let (cport, proto) = key.split_once('/').unwrap_or((key, "tcp"));
        let Ok(container_port) = cport.parse() else { continue };
        for b in binds.as_array().into_iter().flatten() {
            let host_ip = s(&b["HostIp"]);
            let Ok(host_port) = s(&b["HostPort"]).parse() else { continue };
            out.push(Port { public: is_public(&host_ip), host_ip, host_port, container_port, proto: proto.to_string() });
        }
    }
    // The same port published on 0.0.0.0 and :: shows once, as IPv4.
    out.sort_by(|a, b| (a.host_port, a.container_port, a.host_ip.contains(':')).cmp(&(b.host_port, b.container_port, b.host_ip.contains(':'))));
    out.dedup_by(|a, b| a.host_port == b.host_port && a.container_port == b.container_port && a.proto == b.proto && a.public == b.public);
    out
}

fn parse_container(c: &Value) -> Container {
    let st = &c["State"];
    let labels = &c["Config"]["Labels"];
    let label = |k: &str| labels[k].as_str().filter(|s| !s.is_empty()).map(str::to_string);
    let mut networks: Vec<String> = c["NetworkSettings"]["Networks"].as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default();
    networks.sort();
    let health = st["Health"]["Status"].as_str().map(str::to_string);
    let command = {
        let mut parts: Vec<String> = c["Config"]["Entrypoint"].as_array().into_iter().flatten().map(s).collect();
        parts.extend(c["Config"]["Cmd"].as_array().into_iter().flatten().map(s));
        parts.join(" ")
    };
    Container {
        id: s(&c["Id"]),
        name: s(&c["Name"]).trim_start_matches('/').to_string(),
        image: s(&c["Config"]["Image"]),
        image_id: s(&c["Image"]),
        state: s(&st["Status"]),
        exit_code: st["ExitCode"].as_i64().unwrap_or(0),
        health_failures: st["Health"]["FailingStreak"].as_u64().unwrap_or(0),
        health,
        restarts: c["RestartCount"].as_u64().unwrap_or(0),
        policy: c["HostConfig"]["RestartPolicy"]["Name"].as_str().filter(|s| !s.is_empty()).unwrap_or("no").to_string(),
        created: s(&c["Created"]),
        started_at: when(&st["StartedAt"]),
        finished_at: when(&st["FinishedAt"]),
        command,
        // A stopped container has no live bindings; show the configured ones.
        ports: match parse_ports(&c["NetworkSettings"]["Ports"]) {
            live if !live.is_empty() => live,
            _ => parse_ports(&c["HostConfig"]["PortBindings"]),
        },
        mounts: c["Mounts"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|m| Mount {
                kind: s(&m["Type"]),
                name: m["Name"].as_str().filter(|s| !s.is_empty()).map(str::to_string),
                source: s(&m["Source"]),
                destination: s(&m["Destination"]),
                rw: m["RW"].as_bool().unwrap_or(true),
            })
            .collect(),
        env: c["Config"]["Env"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|e| e.as_str()?.split_once('=').map(|(k, v)| EnvVar { key: k.into(), value: v.into() }))
            .collect(),
        networks,
        project: label("com.docker.compose.project"),
        service: label("com.docker.compose.service"),
        config_files: label("com.docker.compose.project.config_files")
            .map(|f| f.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect())
            .unwrap_or_default(),
        config_found: false,
        working_dir: label("com.docker.compose.project.working_dir"),
    }
}

/// `rc=N` then docker's output: None when it worked, else why not.
fn daemon_error(section: &str) -> Option<(bool, String)> {
    let mut lines = section.lines();
    let first = lines.next().unwrap_or("").trim();
    if first == "rc=0" {
        return None;
    }
    let detail = lines.collect::<Vec<_>>().join("\n").trim().to_string();
    Some((detail.contains("permission denied"), detail))
}

pub(crate) fn parse_overview(out: &str) -> DockerState {
    if out.trim() == "notinstalled" {
        return DockerState::NotInstalled;
    }
    let parts: Vec<&str> = out.split(MARK).map(str::trim).collect();
    let get = |i: usize| parts.get(i).copied().unwrap_or("");
    if let Some((denied, detail)) = daemon_error(get(0)) {
        return if denied { DockerState::NoAccess { detail } } else { DockerState::DaemonDown { detail, systemd: get(3) == "systemd" } };
    }
    let version = get(0).lines().nth(1).unwrap_or("").trim().to_string();
    let compose = Some(get(1).trim().trim_start_matches('v').to_string()).filter(|s| !s.is_empty());
    let list: Value = serde_json::from_str(get(2)).unwrap_or(Value::Array(vec![]));
    let mut containers: Vec<Container> = list.as_array().into_iter().flatten().map(parse_container).collect();
    containers.sort_by(|a, b| a.name.cmp(&b.name));
    DockerState::Ok { version, compose, containers }
}

#[tauri::command]
pub async fn docker_overview(sessions: tauri::State<'_, Sessions>, server_id: String, user: String) -> AppResult<DockerState> {
    let run = async move {
        let session = sessions.get(&server_id, &user)?;
        let out = exec_priv(&session, OVERVIEW_SCRIPT, READ_TIMEOUT).await?;
        let mut state = parse_overview(&out.stdout);
        if let DockerState::Ok { containers, .. } = &mut state {
            mark_config_files(&session, containers).await?;
        }
        Ok(state)
    };
    let r: AppResult<DockerState> = trace::labelled("Docker · danh sách container", run).await;
    r
}

/// Compose labels keep the paths the project was started from, which may have
/// moved, been deleted, or live on another machine (a Docker socket shared
/// into a VM). Compose commands only make sense when the files are here.
pub(crate) async fn mark_config_files(session: &Session, containers: &mut [Container]) -> AppResult<()> {
    let mut files: Vec<&String> = containers.iter().flat_map(|c| &c.config_files).collect();
    files.sort();
    files.dedup();
    if files.is_empty() {
        return Ok(());
    }
    let script: String = files.iter().map(|f| format!("if [ -f {q} ]; then echo {q}; fi\n", q = shell_quote(f))).collect();
    let out = exec_priv(session, &script, READ_TIMEOUT).await?;
    let found: std::collections::HashSet<&str> = out.stdout.lines().map(str::trim).collect();
    for c in containers.iter_mut() {
        c.config_found = !c.config_files.is_empty() && c.config_files.iter().all(|f| found.contains(f.as_str()));
    }
    Ok(())
}

// --------------------------------------------------------------------- stats

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Stat {
    pub id: String,
    /// Share of all the server's cores, 0–100.
    pub cpu: f64,
    pub mem: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub cores: u32,
    pub rows: Vec<Stat>,
}

/// "12.5MiB", "1.2GiB", "630kB", "0B": binary and decimal units.
fn size_bytes(s: &str) -> u64 {
    let s = s.trim();
    let split = s.find(|c: char| c.is_ascii_alphabetic()).unwrap_or(s.len());
    let (n, unit) = s.split_at(split);
    let n: f64 = n.trim().parse().unwrap_or(0.0);
    let mult = match unit.trim() {
        "KiB" => 1024f64,
        "MiB" => 1024f64.powi(2),
        "GiB" => 1024f64.powi(3),
        "TiB" => 1024f64.powi(4),
        "kB" | "KB" => 1e3,
        "MB" => 1e6,
        "GB" => 1e9,
        "TB" => 1e12,
        _ => 1.0,
    };
    (n * mult).round() as u64
}

pub(crate) fn parse_stats(out: &str) -> Stats {
    let parts: Vec<&str> = out.split(MARK).map(str::trim).collect();
    let cores: u32 = parts.first().and_then(|c| c.trim().parse().ok()).unwrap_or(1).max(1);
    let rows = parts
        .get(1)
        .unwrap_or(&"")
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\t').collect();
            let cpu: f64 = f.get(1)?.trim().trim_end_matches('%').parse().ok()?;
            Some(Stat {
                id: f[0].trim().to_string(),
                // docker stats counts 100% per core.
                cpu: cpu / cores as f64,
                mem: size_bytes(f.get(2)?.split('/').next().unwrap_or("")),
            })
        })
        .collect();
    Stats { cores, rows }
}

/// CPU and memory of running containers. `docker stats` samples for about two
/// seconds, so this is read apart from the container list.
#[tauri::command]
pub async fn docker_stats(sessions: tauri::State<'_, Sessions>, server_id: String, user: String) -> AppResult<Stats> {
    let run = async move {
        let session = sessions.get(&server_id, &user)?;
        let script = "nproc 2>/dev/null || echo 1; echo @@PORTWAY@@; docker stats --no-stream --no-trunc --format '{{.ID}}\t{{.CPUPerc}}\t{{.MemUsage}}' 2>/dev/null";
        let out = exec_priv(&session, script, READ_TIMEOUT).await?;
        Ok(parse_stats(&out.stdout))
    };
    let r: AppResult<Stats> = trace::labelled("Docker · CPU/RAM container", run).await;
    r
}

// ------------------------------------------------------------------- actions

/// The command as it ran, for the action log: with sudo when it went through sudo.

fn docker_error(stderr: &str) -> AppError {
    let msg = stderr.trim();
    if msg.contains("permission denied") && msg.contains("docker") {
        AppError::detail("docker_no_access", msg)
    } else if msg.contains("Cannot connect to the Docker daemon") {
        AppError::detail("docker_daemon_down", msg)
    } else {
        AppError::detail("docker", if msg.is_empty() { "exit status != 0" } else { msg })
    }
}

/// Run a changing command, log it, and return its combined output.
async fn run_logged(
    session: &Session,
    audit: &AuditLog,
    server_id: &str,
    user: &str,
    action: &str,
    cmd: &str,
    timeout: Duration,
) -> AppResult<String> {
    let shown = shown_as_run(session, cmd);
    let out = match exec_priv(session, &format!("{cmd} 2>&1"), timeout).await {
        Ok(o) => o,
        Err(e) => {
            audit.record(server_id, user, action, &shown, false, e.detail.clone().or(Some(e.code.to_string())));
            return Err(e);
        }
    };
    let text = format!("{}{}", out.stdout, out.stderr).trim().to_string();
    let ok = out.code == Some(0);
    audit.record(server_id, user, action, &shown, ok, (!ok).then(|| text.clone()));
    if ok {
        Ok(text)
    } else {
        Err(docker_error(&text))
    }
}

#[tauri::command]
pub async fn docker_container(
    sessions: tauri::State<'_, Sessions>,
    audit: tauri::State<'_, AuditLog>,
    server_id: String,
    user: String,
    name: String,
    action: String,
) -> AppResult<()> {
    let run = async move {
        let (verb, log) = match action.as_str() {
            "start" => ("start", "dockerStart"),
            "stop" => ("stop", "dockerStop"),
            "restart" => ("restart", "dockerRestart"),
            _ => return Err(AppError::new("unknown_action")),
        };
        let session = sessions.get(&server_id, &user)?;
        let cmd = format!("docker {verb} {}", shell_quote(&name));
        run_logged(&session, &audit, &server_id, &user, log, &cmd, Duration::from_secs(120)).await.map(|_| ())
    };
    let r: AppResult<()> = trace::labelled("Docker · thao tác container", run).await;
    r
}

fn valid_project(p: &str) -> bool {
    !p.is_empty() && p.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// The compose command for a project, from the labels its containers carry.
pub fn compose_command(project: &str, files: &[String], working_dir: Option<&str>, action: &str) -> Option<String> {
    let mut base = format!("docker compose -p {project}");
    for f in files {
        base.push_str(&format!(" -f {}", shell_quote(f)));
    }
    let run = match action {
        "up" => format!("{base} up -d"),
        "pullUp" => format!("{base} pull && {base} up -d"),
        "restart" => format!("{base} restart"),
        "down" => format!("{base} down"),
        _ => return None,
    };
    Some(match working_dir {
        Some(dir) => format!("cd {} && {run}", shell_quote(dir)),
        None => run,
    })
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn docker_compose(
    sessions: tauri::State<'_, Sessions>,
    audit: tauri::State<'_, AuditLog>,
    server_id: String,
    user: String,
    project: String,
    files: Vec<String>,
    working_dir: Option<String>,
    action: String,
) -> AppResult<String> {
    let run = async move {
        if !valid_project(&project) {
            return Err(AppError::detail("invalid_project", project));
        }
        let log = match action.as_str() {
            "up" => "composeUp",
            "pullUp" => "composePullUp",
            "restart" => "composeRestart",
            "down" => "composeDown",
            _ => return Err(AppError::new("unknown_action")),
        };
        let cmd = compose_command(&project, &files, working_dir.as_deref(), &action).ok_or_else(|| AppError::new("unknown_action"))?;
        let session = sessions.get(&server_id, &user)?;
        run_logged(&session, &audit, &server_id, &user, log, &cmd, Duration::from_secs(600)).await
    };
    let r: AppResult<String> = trace::labelled("Docker · compose", run).await;
    r
}

/// Start the Docker daemon through systemd (needs root or sudo).
#[tauri::command]
pub async fn docker_start_daemon(sessions: tauri::State<'_, Sessions>, audit: tauri::State<'_, AuditLog>, server_id: String, user: String) -> AppResult<()> {
    let run = async move {
        let session = sessions.get(&server_id, &user)?;
        if !session.is_root() && !session.sudo_on() {
            return Err(AppError::new("needs_root"));
        }
        run_logged(&session, &audit, &server_id, &user, "dockerDaemonStart", "systemctl start docker", Duration::from_secs(90)).await.map(|_| ())
    };
    let r: AppResult<()> = trace::labelled("Docker · khởi động daemon", run).await;
    r
}

// ---------------------------------------------------------------------- logs

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    /// RFC 3339 with nanoseconds, from `docker logs --timestamps`.
    pub ts: String,
    pub text: String,
    /// The container wrote it to stderr.
    pub err: bool,
}

pub(crate) fn parse_log_lines(text: &str, err: bool) -> Vec<LogLine> {
    text.lines()
        .filter_map(|l| {
            let (ts, rest) = l.split_once(' ').unwrap_or((l, ""));
            ts.contains('T').then(|| LogLine { ts: ts.to_string(), text: rest.to_string(), err })
        })
        .collect()
}

/// Last `tail` lines, or the lines after `since` (a timestamp from an earlier
/// read) when following. stdout and stderr are merged by timestamp.
#[tauri::command]
pub async fn docker_logs(
    sessions: tauri::State<'_, Sessions>,
    server_id: String,
    user: String,
    id: String,
    tail: u32,
    since: Option<String>,
) -> AppResult<Vec<LogLine>> {
    let run = async move {
        let session = sessions.get(&server_id, &user)?;
        let mut cmd = format!("docker logs --timestamps --tail {}", tail.clamp(1, 2000));
        if let Some(ts) = since.as_deref() {
            // Timestamps come from Docker itself; still keep them to their characters.
            if !ts.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | ':' | '.' | '+')) {
                return Err(AppError::detail("invalid_since", ts));
            }
            cmd.push_str(&format!(" --since {ts}"));
        }
        cmd.push_str(&format!(" {}", shell_quote(&id)));
        let out = exec_priv(&session, &cmd, READ_TIMEOUT).await?;
        if out.code != Some(0) {
            return Err(docker_error(&out.stderr));
        }
        let mut lines = parse_log_lines(&out.stdout, false);
        lines.extend(parse_log_lines(&out.stderr, true));
        lines.sort_by(|a, b| a.ts.cmp(&b.ts));
        if let Some(ts) = since {
            lines.retain(|l| l.ts > ts);
        }
        Ok(lines)
    };
    let r: AppResult<Vec<LogLine>> = trace::labelled("Docker · đọc log", run).await;
    r
}

// -------------------------------------------------------------------- images

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Image {
    pub id: String,
    /// "<none>" for dangling images.
    pub repo: String,
    pub tag: String,
    pub created: String,
    pub size: u64,
    /// Containers (running or not) made from this image.
    pub used_by: Vec<String>,
}

pub(crate) const IMAGES_SCRIPT: &str = r#"
out=$(docker image ls --no-trunc --format '{{.ID}}	{{.Repository}}	{{.Tag}}	{{.CreatedAt}}' 2>&1); echo "rc=$?"; echo "$out"
echo @@PORTWAY@@
ids=$(docker image ls -q --no-trunc 2>/dev/null | sort -u)
if [ -n "$ids" ]; then docker image inspect --format '{{.Id}} {{.Size}}' $ids 2>/dev/null; fi
echo @@PORTWAY@@
cs=$(docker ps -aq --no-trunc 2>/dev/null)
if [ -n "$cs" ]; then docker inspect --format '{{.Image}} {{.Name}}' $cs 2>/dev/null; fi
"#;

pub(crate) fn parse_images(out: &str) -> AppResult<Vec<Image>> {
    let parts: Vec<&str> = out.split(MARK).map(str::trim).collect();
    let get = |i: usize| parts.get(i).copied().unwrap_or("");
    if let Some((_, detail)) = daemon_error(get(0)) {
        return Err(docker_error(&detail));
    }
    let sizes: HashMap<&str, u64> = get(1)
        .lines()
        .filter_map(|l| {
            let (id, size) = l.trim().split_once(' ')?;
            Some((id, size.trim().parse().ok()?))
        })
        .collect();
    let mut users: HashMap<&str, Vec<String>> = HashMap::new();
    for l in get(2).lines() {
        if let Some((img, name)) = l.trim().split_once(' ') {
            users.entry(img).or_default().push(name.trim_start_matches('/').to_string());
        }
    }
    let mut images: Vec<Image> = get(0)
        .lines()
        .skip(1)
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\t').collect();
            let id = f.first()?.trim();
            Some(Image {
                id: id.to_string(),
                repo: f.get(1)?.to_string(),
                tag: f.get(2)?.to_string(),
                created: f.get(3).unwrap_or(&"").to_string(),
                size: sizes.get(id).copied().unwrap_or(0),
                used_by: users.get(id).cloned().unwrap_or_default(),
            })
        })
        .collect();
    images.sort_by(|a, b| (a.repo == "<none>", &a.repo, &a.tag).cmp(&(b.repo == "<none>", &b.repo, &b.tag)));
    Ok(images)
}

#[tauri::command]
pub async fn docker_images(sessions: tauri::State<'_, Sessions>, server_id: String, user: String) -> AppResult<Vec<Image>> {
    let run = async move {
        let session = sessions.get(&server_id, &user)?;
        let out = exec_priv(&session, IMAGES_SCRIPT, READ_TIMEOUT).await?;
        parse_images(&out.stdout)
    };
    let r: AppResult<Vec<Image>> = trace::labelled("Docker · images", run).await;
    r
}

/// "Total reclaimed space: 1.2GB" from `docker image prune`.
fn reclaimed(out: &str) -> String {
    out.lines().find_map(|l| l.strip_prefix("Total reclaimed space:")).map(|s| s.trim().to_string()).unwrap_or_else(|| "0B".into())
}

/// Remove dangling images, or with `all` every image no container uses.
#[tauri::command]
pub async fn docker_image_prune(
    sessions: tauri::State<'_, Sessions>,
    audit: tauri::State<'_, AuditLog>,
    server_id: String,
    user: String,
    all: bool,
) -> AppResult<String> {
    let run = async move {
        let session = sessions.get(&server_id, &user)?;
        let cmd = if all { "docker image prune -a -f" } else { "docker image prune -f" };
        let out = run_logged(&session, &audit, &server_id, &user, "imagePrune", cmd, Duration::from_secs(300)).await?;
        Ok(reclaimed(&out))
    };
    let r: AppResult<String> = trace::labelled("Docker · dọn image", run).await;
    r
}

// ------------------------------------------------------------------- volumes

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Volume {
    pub name: String,
    pub driver: String,
    pub mountpoint: String,
    pub used_by: Vec<String>,
}

pub(crate) const VOLUMES_SCRIPT: &str = r#"
out=$(docker volume ls --format '{{.Name}}	{{.Driver}}	{{.Mountpoint}}' 2>&1); echo "rc=$?"; echo "$out"
echo @@PORTWAY@@
cs=$(docker ps -aq --no-trunc 2>/dev/null)
if [ -n "$cs" ]; then docker inspect --format '{{.Name}}{{range .Mounts}}{{if eq .Type "volume"}}	{{.Name}}{{end}}{{end}}' $cs 2>/dev/null; fi
"#;

pub(crate) fn parse_volumes(out: &str) -> AppResult<Vec<Volume>> {
    let parts: Vec<&str> = out.split(MARK).map(str::trim).collect();
    let get = |i: usize| parts.get(i).copied().unwrap_or("");
    if let Some((_, detail)) = daemon_error(get(0)) {
        return Err(docker_error(&detail));
    }
    let mut users: HashMap<&str, Vec<String>> = HashMap::new();
    for l in get(1).lines() {
        let mut f = l.trim().split('\t');
        let name = f.next().unwrap_or("").trim_start_matches('/').to_string();
        for v in f {
            users.entry(v).or_default().push(name.clone());
        }
    }
    let mut vols: Vec<Volume> = get(0)
        .lines()
        .skip(1)
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\t').collect();
            let name = f.first()?.trim();
            Some(Volume {
                name: name.to_string(),
                driver: f.get(1).unwrap_or(&"").to_string(),
                mountpoint: f.get(2).unwrap_or(&"").to_string(),
                used_by: users.get(name).cloned().unwrap_or_default(),
            })
        })
        .collect();
    vols.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(vols)
}

#[tauri::command]
pub async fn docker_volumes(sessions: tauri::State<'_, Sessions>, server_id: String, user: String) -> AppResult<Vec<Volume>> {
    let run = async move {
        let session = sessions.get(&server_id, &user)?;
        let out = exec_priv(&session, VOLUMES_SCRIPT, READ_TIMEOUT).await?;
        parse_volumes(&out.stdout)
    };
    let r: AppResult<Vec<Volume>> = trace::labelled("Docker · volumes", run).await;
    r
}

/// Volume sizes from `docker system df -v`, which walks every volume and can
/// take a while on a busy server; read apart from the list.
#[tauri::command]
pub async fn docker_volume_sizes(sessions: tauri::State<'_, Sessions>, server_id: String, user: String) -> AppResult<HashMap<String, u64>> {
    let run = async move {
        let session = sessions.get(&server_id, &user)?;
        let out = exec_priv(&session, "docker system df -v --format '{{json .Volumes}}'", Duration::from_secs(180)).await?;
        if out.code != Some(0) {
            return Err(docker_error(&out.stderr));
        }
        let list: Value = serde_json::from_str(out.stdout.trim()).unwrap_or(Value::Null);
        Ok(list
            .as_array()
            .into_iter()
            .flatten()
            .map(|v| (s(&v["Name"]), crate::disks::docker_bytes(v["Size"].as_str().unwrap_or("0B"))))
            .collect())
    };
    let r: AppResult<HashMap<String, u64>> = trace::labelled("Docker · dung lượng volume", run).await;
    r
}

#[tauri::command]
pub async fn docker_volume_remove(
    sessions: tauri::State<'_, Sessions>,
    audit: tauri::State<'_, AuditLog>,
    server_id: String,
    user: String,
    name: String,
) -> AppResult<()> {
    let run = async move {
        let session = sessions.get(&server_id, &user)?;
        let cmd = format!("docker volume rm {}", shell_quote(&name));
        run_logged(&session, &audit, &server_id, &user, "volumeRemove", &cmd, Duration::from_secs(60)).await.map(|_| ())
    };
    let r: AppResult<()> = trace::labelled("Docker · xoá volume", run).await;
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_inspect_output() {
        let json = r#"[{
          "Id": "abc", "Name": "/shop-db-1", "Image": "sha256:111", "Created": "2026-09-26T05:00:00.1Z",
          "RestartCount": 2,
          "State": {"Status": "running", "ExitCode": 0, "StartedAt": "2026-09-26T05:00:01Z", "FinishedAt": "0001-01-01T00:00:00Z",
                    "Health": {"Status": "unhealthy", "FailingStreak": 3}},
          "HostConfig": {"RestartPolicy": {"Name": "unless-stopped"}},
          "Config": {"Image": "postgres:16-alpine", "Env": ["POSTGRES_USER=shop", "EMPTY="], "Cmd": ["postgres"], "Entrypoint": ["docker-entrypoint.sh"],
                     "Labels": {"com.docker.compose.project": "shop", "com.docker.compose.service": "db",
                                "com.docker.compose.project.config_files": "/srv/shop/docker-compose.yml",
                                "com.docker.compose.project.working_dir": "/srv/shop"}},
          "NetworkSettings": {"Networks": {"shop_default": {}},
                              "Ports": {"5432/tcp": [{"HostIp": "0.0.0.0", "HostPort": "5432"}, {"HostIp": "::", "HostPort": "5432"}], "6000/tcp": null}},
          "Mounts": [{"Type": "volume", "Name": "shop_db-data", "Source": "/var/lib/docker/volumes/shop_db-data/_data", "Destination": "/var/lib/postgresql/data", "RW": true}]
        }]"#;
        let out = format!("rc=0\n27.5.1\n{MARK}\n2.29.7\n{MARK}\n{json}\n{MARK}\nsystemd\n");
        let DockerState::Ok { version, compose, containers } = parse_overview(&out) else { panic!("expected Ok") };
        assert_eq!(version, "27.5.1");
        assert_eq!(compose.as_deref(), Some("2.29.7"));
        let c = &containers[0];
        assert_eq!(c.name, "shop-db-1");
        assert_eq!(c.health.as_deref(), Some("unhealthy"));
        assert_eq!(c.health_failures, 3);
        assert_eq!(c.finished_at, None);
        assert_eq!(c.ports.len(), 1, "0.0.0.0 and :: are one published port");
        assert!(c.ports[0].public);
        assert_eq!(c.env[1].value, "");
        assert_eq!(c.command, "docker-entrypoint.sh postgres");
        assert_eq!(c.config_files, vec!["/srv/shop/docker-compose.yml"]);
        assert_eq!(c.mounts[0].name.as_deref(), Some("shop_db-data"));
    }

    #[test]
    fn tells_no_access_from_daemon_down() {
        assert!(matches!(parse_overview("notinstalled\n"), DockerState::NotInstalled));
        let denied = "rc=1\npermission denied while trying to connect to the Docker daemon socket\n@@PORTWAY@@\n\n@@PORTWAY@@\n[]\n@@PORTWAY@@\n";
        assert!(matches!(parse_overview(denied), DockerState::NoAccess { .. }));
        let down = "rc=1\nCannot connect to the Docker daemon at unix:///var/run/docker.sock\n@@PORTWAY@@\n\n@@PORTWAY@@\n[]\n@@PORTWAY@@\nsystemd\n";
        assert!(matches!(parse_overview(down), DockerState::DaemonDown { systemd: true, .. }));
    }

    #[test]
    fn parses_stats_per_core() {
        let s = parse_stats("4\n@@PORTWAY@@\nabc\t50.00%\t12.5MiB / 7.66GiB\ndef\t0.10%\t1.2GiB / 7.66GiB\n");
        assert_eq!(s.cores, 4);
        assert_eq!(s.rows[0].cpu, 12.5);
        assert_eq!(s.rows[0].mem, (12.5 * 1024.0 * 1024.0) as u64);
        assert_eq!(s.rows[1].mem, (1.2 * 1024f64.powi(3)).round() as u64);
    }

    #[test]
    fn builds_compose_commands() {
        let files = vec!["/srv/shop/docker-compose.yml".to_string()];
        assert_eq!(
            compose_command("shop", &files, Some("/srv/shop"), "pullUp").unwrap(),
            "cd /srv/shop && docker compose -p shop -f /srv/shop/docker-compose.yml pull && docker compose -p shop -f /srv/shop/docker-compose.yml up -d"
        );
        assert!(compose_command("shop", &files, None, "rm").is_none());
        assert!(!valid_project("Shop; rm -rf /"));
    }

    #[test]
    fn merges_log_streams() {
        let out = parse_log_lines("2026-09-26T05:00:02.000000001Z second\n", false);
        let err = parse_log_lines("2026-09-26T05:00:01.5Z ERROR first\n", true);
        let mut all = [out, err].concat();
        all.sort_by(|a, b| a.ts.cmp(&b.ts));
        assert_eq!(all[0].text, "ERROR first");
        assert!(all[0].err);
    }

    #[test]
    fn reads_images_and_their_users() {
        let out = "rc=0\nsha256:aa\tnginx\t1.27-alpine\t2026-09-01 10:00:00 +0000 UTC\nsha256:bb\t<none>\t<none>\t2026-09-02 10:00:00 +0000 UTC\n@@PORTWAY@@\nsha256:aa 20000000\nsha256:bb 4000000\n@@PORTWAY@@\nsha256:aa /shop-web-1\n";
        let imgs = parse_images(out).unwrap();
        assert_eq!(imgs[0].repo, "nginx");
        assert_eq!(imgs[0].used_by, vec!["shop-web-1"]);
        assert_eq!(imgs[1].repo, "<none>", "dangling images sort last");
        assert_eq!(imgs[1].size, 4_000_000);
    }
}
