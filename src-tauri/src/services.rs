//! systemd services: the units on the server, the state of the ones the user
//! watches, their journal, and start/stop/restart/enable/disable. Reads run as
//! the session's user; changes need root or sudo (systemctl asks polkit
//! otherwise, which has no one to answer over SSH).

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::time::Duration;

use crate::audit::AuditLog;
use crate::error::{AppError, AppResult};
use crate::i18n::tr;
use crate::ssh::{exec_priv, shell_quote, shown_as_run, Sessions, MARK};
use crate::trace;

const READ_TIMEOUT: Duration = Duration::from_secs(30);

/// Unit names as systemd allows them; anything else is refused before it
/// reaches a shell.
fn valid_unit(u: &str) -> bool {
    !u.is_empty() && u.len() <= 256 && !u.starts_with('-') && u.chars().all(|c| c.is_ascii_alphanumeric() || "@._:-".contains(c))
}

fn check_units(units: &[String]) -> AppResult<()> {
    match units.iter().find(|u| !valid_unit(u)) {
        Some(bad) => Err(AppError::detail("invalid_unit", bad)),
        None => Ok(()),
    }
}

// ------------------------------------------------------------- all the units

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UnitBrief {
    pub name: String,
    pub description: String,
    /// active, inactive, failed, activating…; "" for unit files never loaded.
    pub active: String,
    /// enabled, disabled, static, masked…
    pub file_state: Option<String>,
}

const ALL_SCRIPT: &str = "systemctl list-units --type=service --all --no-legend --plain --no-pager 2>/dev/null; echo @@PORTWAY@@; systemctl list-unit-files --type=service --no-legend --no-pager 2>/dev/null";

pub(crate) fn parse_all(out: &str) -> Vec<UnitBrief> {
    let (loaded, files) = out.split_once(MARK).unwrap_or((out, ""));
    let mut units: HashMap<String, UnitBrief> = HashMap::new();
    for l in loaded.lines() {
        let f: Vec<&str> = l.split_whitespace().collect();
        // Referenced by another unit but not installed: nothing to watch.
        if f.len() < 4 || !f[0].ends_with(".service") || f[1] == "not-found" {
            continue;
        }
        units.insert(
            f[0].to_string(),
            UnitBrief { name: f[0].into(), description: f[4..].join(" "), active: f[2].into(), file_state: None },
        );
    }
    for l in files.lines() {
        let f: Vec<&str> = l.split_whitespace().collect();
        if f.len() < 2 || !f[0].ends_with(".service") {
            continue;
        }
        // Templates (foo@.service) cannot be watched as such, and an alias
        // (sshd.service → ssh.service) would show its unit twice.
        if f[0].ends_with("@.service") || f[1] == "alias" {
            continue;
        }
        units
            .entry(f[0].to_string())
            .or_insert_with(|| UnitBrief { name: f[0].into(), description: String::new(), active: String::new(), file_state: None })
            .file_state = Some(f[1].to_string());
    }
    let mut list: Vec<UnitBrief> = units.into_values().collect();
    list.sort_by(|a, b| a.name.cmp(&b.name));
    list
}

#[tauri::command]
pub async fn services_all(sessions: tauri::State<'_, Sessions>, server_id: String, user: String) -> AppResult<Vec<UnitBrief>> {
    let session = sessions.get(&server_id, &user)?;
    let out = trace::labelled(tr("Dịch vụ · danh sách unit", "Services · list units"), exec_priv(&session, ALL_SCRIPT, READ_TIMEOUT)).await?;
    Ok(parse_all(&out.stdout))
}

// ---------------------------------------------------------- watched units

#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Unit {
    pub name: String,
    /// Other names of the unit (aliases like sshd.service), from Names=.
    pub aliases: Vec<String>,
    pub description: String,
    /// loaded, not-found, masked…
    pub load_state: String,
    /// active, inactive, failed, activating, deactivating, reloading
    pub active_state: String,
    /// running, exited, dead, auto-restart…
    pub sub_state: String,
    /// enabled, disabled, static, masked…
    pub file_state: String,
    pub main_pid: Option<u32>,
    pub memory: Option<u64>,
    pub restarts: u64,
    /// ms since epoch, when it last became active / inactive.
    pub active_since: Option<u64>,
    pub inactive_since: Option<u64>,
    /// Exit status of the main process and how it ended (exited, killed…).
    pub exit_status: Option<i64>,
    pub exit_code: Option<String>,
    /// success, exit-code, signal, start-limit-hit…
    pub result: String,
    pub fragment_path: String,
    pub run_as: Option<String>,
}

const PROPS: &str = "Id,Names,Description,LoadState,ActiveState,SubState,UnitFileState,MainPID,MemoryCurrent,NRestarts,ActiveEnterTimestamp,InactiveEnterTimestamp,ExecMainStatus,ExecMainCode,FragmentPath,User,Result";

/// "@1727326801" from --timestamp=unix, in ms; empty or 0 when it never happened.
fn unix_ms(v: &str) -> Option<u64> {
    v.strip_prefix('@').and_then(|s| s.parse::<u64>().ok()).filter(|s| *s > 0).map(|s| s * 1000)
}

pub(crate) fn parse_show(out: &str) -> Vec<Unit> {
    out.split("\n\n")
        .filter_map(|block| {
            let props: HashMap<&str, &str> = block.lines().filter_map(|l| l.split_once('=')).collect();
            let get = |k: &str| props.get(k).copied().unwrap_or("").to_string();
            let name = get("Id");
            if name.is_empty() {
                return None;
            }
            let pid: u32 = get("MainPID").parse().unwrap_or(0);
            let aliases = get("Names").split_whitespace().filter(|n| *n != name).map(str::to_string).collect();
            Some(Unit {
                aliases,
                name,
                description: get("Description"),
                load_state: get("LoadState"),
                active_state: get("ActiveState"),
                sub_state: get("SubState"),
                file_state: get("UnitFileState"),
                main_pid: (pid > 0).then_some(pid),
                // "[not set]" or u64::MAX when there is no memory accounting.
                memory: get("MemoryCurrent").parse().ok().filter(|m| *m < u64::MAX),
                restarts: get("NRestarts").parse().unwrap_or(0),
                active_since: unix_ms(&get("ActiveEnterTimestamp")),
                inactive_since: unix_ms(&get("InactiveEnterTimestamp")),
                exit_status: get("ExecMainStatus").parse().ok(),
                exit_code: Some(get("ExecMainCode")).filter(|c| !c.is_empty() && c != "0"),
                result: get("Result"),
                fragment_path: get("FragmentPath"),
                run_as: Some(get("User")).filter(|u| !u.is_empty()),
            })
        })
        .collect()
}

#[tauri::command]
pub async fn services_status(sessions: tauri::State<'_, Sessions>, server_id: String, user: String, units: Vec<String>) -> AppResult<Vec<Unit>> {
    if units.is_empty() {
        return Ok(vec![]);
    }
    check_units(&units)?;
    let session = sessions.get(&server_id, &user)?;
    let list = units.join(" ");
    let cmd = format!("systemctl show --no-pager --timestamp=unix -p {PROPS} -- {list}");
    let out = trace::labelled(tr("Dịch vụ · trạng thái unit", "Services · unit status"), exec_priv(&session, &cmd, READ_TIMEOUT)).await?;
    if out.code != Some(0) && out.stdout.trim().is_empty() {
        return Err(AppError::detail("systemctl", out.stderr.trim()));
    }
    // An alias shows as its real unit (Id); keep one row per unit.
    let mut seen = std::collections::HashSet::new();
    Ok(parse_show(&out.stdout).into_iter().filter(|u| seen.insert(u.name.clone())).collect())
}

// -------------------------------------------------------------------- journal

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct JournalLine {
    /// ms since epoch.
    pub at: u64,
    /// syslog priority: 0 emerg … 3 err, 4 warning, 6 info, 7 debug.
    pub priority: Option<u8>,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalPage {
    pub lines: Vec<JournalLine>,
    /// Where to continue from when following.
    pub cursor: Option<String>,
    /// journalctl said this user cannot see every message.
    pub limited: bool,
}

/// MESSAGE is a string, or an array of bytes when it is not valid UTF-8.
fn message(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(bytes) => String::from_utf8_lossy(&bytes.iter().filter_map(|b| b.as_u64().map(|b| b as u8)).collect::<Vec<u8>>()).into_owned(),
        _ => String::new(),
    }
}

pub(crate) fn parse_journal(stdout: &str, stderr: &str) -> JournalPage {
    let mut lines = Vec::new();
    let mut cursor = None;
    for l in stdout.lines() {
        let Ok(v) = serde_json::from_str::<Value>(l) else { continue };
        cursor = v["__CURSOR"].as_str().map(str::to_string).or(cursor);
        lines.push(JournalLine {
            at: v["__REALTIME_TIMESTAMP"].as_str().and_then(|t| t.parse::<u64>().ok()).map(|us| us / 1000).unwrap_or(0),
            priority: v["PRIORITY"].as_str().and_then(|p| p.parse().ok()),
            message: message(&v["MESSAGE"]),
        });
    }
    let limited = stderr.contains("insufficient permissions") || stderr.contains("not seeing messages");
    JournalPage { lines, cursor, limited }
}

/// `id -u` then `id -Gn`: root, or in a group that may read the system journal.
fn can_read_journal(who: &str) -> bool {
    let mut lines = who.lines().map(str::trim).filter(|l| !l.is_empty());
    let uid = lines.next().unwrap_or("");
    let groups = lines.next().unwrap_or("");
    uid == "0" || groups.split_whitespace().any(|g| matches!(g, "systemd-journal" | "adm" | "wheel"))
}

/// The unit's last `tail` journal lines, or those after `cursor` when following.
#[tauri::command]
pub async fn services_journal(
    sessions: tauri::State<'_, Sessions>,
    server_id: String,
    user: String,
    unit: String,
    tail: u32,
    cursor: Option<String>,
) -> AppResult<JournalPage> {
    check_units(std::slice::from_ref(&unit))?;
    let session = sessions.get(&server_id, &user)?;
    let mut cmd = format!("journalctl -u {unit} -o json --no-pager -n {}", tail.clamp(1, 2000));
    if let Some(c) = &cursor {
        cmd.push_str(&format!(" --after-cursor={}", shell_quote(c)));
    }
    // Without read access to the system journal, journalctl prints nothing
    // and exits 0; say so instead of showing an empty log. Checked where the
    // command runs, so sudo counts.
    let script = format!("{cmd}; echo {MARK}; id -u; id -Gn");
    let out = trace::labelled(tr("Dịch vụ · đọc journal", "Services · read journal"), exec_priv(&session, &script, READ_TIMEOUT)).await?;
    let (body, who) = out.stdout.split_once(MARK).unwrap_or((&out.stdout, ""));
    let mut page = parse_journal(body, &out.stderr);
    page.limited |= !can_read_journal(who);
    if page.cursor.is_none() {
        page.cursor = cursor;
    }
    Ok(page)
}

/// `systemctl cat`: the unit file with its drop-ins, as systemd reads it.
#[tauri::command]
pub async fn services_unit_file(sessions: tauri::State<'_, Sessions>, server_id: String, user: String, unit: String) -> AppResult<String> {
    check_units(std::slice::from_ref(&unit))?;
    let session = sessions.get(&server_id, &user)?;
    let out = trace::labelled(tr("Dịch vụ · đọc file unit", "Services · read unit file"), exec_priv(&session, &format!("systemctl cat --no-pager -- {unit}"), READ_TIMEOUT)).await?;
    if out.code != Some(0) {
        return Err(AppError::detail("systemctl", out.stderr.trim()));
    }
    Ok(out.stdout)
}

// -------------------------------------------------------------------- actions

/// The systemctl line for an action, exactly as it runs (without sudo).
pub fn action_command(unit: &str, action: &str) -> Option<String> {
    let verb = match action {
        "start" | "stop" | "restart" | "enable" | "disable" => action,
        "resetFailed" => "reset-failed",
        _ => return None,
    };
    Some(format!("systemctl {verb} {unit}"))
}

#[tauri::command]
pub async fn services_action(
    sessions: tauri::State<'_, Sessions>,
    audit: tauri::State<'_, AuditLog>,
    server_id: String,
    user: String,
    unit: String,
    action: String,
) -> AppResult<()> {
    check_units(std::slice::from_ref(&unit))?;
    let cmd = action_command(&unit, &action).ok_or_else(|| AppError::new("unknown_action"))?;
    let session = sessions.get(&server_id, &user)?;
    if !session.is_root() && !session.sudo_on() {
        return Err(AppError::new("needs_root"));
    }
    let log = format!("service{}{}", action[..1].to_uppercase(), &action[1..]);
    let shown = shown_as_run(&session, &cmd);
    let out = trace::labelled(tr("Dịch vụ · thao tác", "Services · action"), exec_priv(&session, &format!("{cmd} 2>&1"), Duration::from_secs(120))).await;
    let out = match out {
        Ok(o) => o,
        Err(e) => {
            audit.record(&server_id, &user, &log, &shown, false, e.detail.clone().or(Some(e.code.to_string())));
            return Err(e);
        }
    };
    let text = format!("{}{}", out.stdout, out.stderr).trim().to_string();
    let ok = out.code == Some(0);
    audit.record(&server_id, &user, &log, &shown, ok, (!ok).then(|| text.clone()));
    if ok {
        Ok(())
    } else {
        Err(AppError::detail("systemctl", if text.is_empty() { "exit status != 0".into() } else { text }))
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_loaded_units_and_unit_files() {
        let out = "nginx.service loaded active running A high performance web server\nauditd.service not-found inactive dead auditd.service\nworker-queue.service loaded failed failed Background worker\n@@PORTWAY@@\nnginx.service enabled enabled\nreport-mailer.service disabled enabled\ngetty@.service enabled enabled\nsshd.service alias -\n";
        let all = parse_all(out);
        let names: Vec<&str> = all.iter().map(|u| u.name.as_str()).collect();
        assert_eq!(names, vec!["nginx.service", "report-mailer.service", "worker-queue.service"]);
        assert_eq!(all[0].file_state.as_deref(), Some("enabled"));
        assert_eq!(all[0].description, "A high performance web server");
        assert_eq!(all[1].active, "", "never loaded");
        assert_eq!(all[2].active, "failed");
    }

    #[test]
    fn parses_systemctl_show() {
        let out = "Id=worker-queue.service\nDescription=Background worker\nLoadState=loaded\nActiveState=failed\nSubState=failed\nUnitFileState=enabled\nMainPID=0\nMemoryCurrent=[not set]\nNRestarts=4\nActiveEnterTimestamp=\nInactiveEnterTimestamp=@1727326801\nExecMainStatus=3\nExecMainCode=1\nFragmentPath=/etc/systemd/system/worker-queue.service\nUser=deploy\nResult=exit-code\n\nId=nginx.service\nActiveState=active\nMainPID=412\nMemoryCurrent=5242880\nActiveEnterTimestamp=@1727326700\n";
        let u = parse_show(out);
        assert_eq!(u.len(), 2);
        assert_eq!((u[0].restarts, u[0].main_pid, u[0].memory), (4, None, None));
        assert_eq!(u[0].inactive_since, Some(1_727_326_801_000));
        assert_eq!(u[0].exit_status, Some(3));
        assert_eq!(u[0].run_as.as_deref(), Some("deploy"));
        assert_eq!((u[1].main_pid, u[1].memory), (Some(412), Some(5_242_880)));
    }

    #[test]
    fn reads_journal_json() {
        let out = "{\"__CURSOR\":\"s=1\",\"__REALTIME_TIMESTAMP\":\"1727326801000000\",\"PRIORITY\":\"3\",\"MESSAGE\":\"ERROR: refused\"}\n{\"__CURSOR\":\"s=2\",\"__REALTIME_TIMESTAMP\":\"1727326802000000\",\"PRIORITY\":\"6\",\"MESSAGE\":[104,105]}\n";
        let p = parse_journal(out, "Hint: You are currently not seeing messages from other users and the system.");
        assert_eq!(p.lines.len(), 2);
        assert_eq!(p.lines[0].priority, Some(3));
        assert_eq!(p.lines[1].message, "hi");
        assert_eq!(p.cursor.as_deref(), Some("s=2"));
        assert!(p.limited);
    }

    #[test]
    fn knows_who_reads_the_journal() {
        assert!(can_read_journal("\n0\nroot\n"));
        assert!(can_read_journal("1000\ndeploy adm sudo\n"));
        assert!(!can_read_journal("1000\ndeploy sudo\n"));
    }

    #[test]
    fn refuses_odd_unit_names() {
        assert!(valid_unit("php8.2-fpm.service"));
        assert!(valid_unit("getty@tty1.service"));
        assert!(!valid_unit("nginx; rm -rf /"));
        assert!(!valid_unit("--now"));
        assert_eq!(action_command("nginx.service", "resetFailed").unwrap(), "systemctl reset-failed nginx.service");
        assert!(action_command("nginx.service", "mask").is_none());
    }
}
