//! Follow a log file on a server (`tail -F`) and stream its lines to the UI as
//! `logtail` events, in batches. Each follow holds one SSH channel until it is
//! stopped or the session drops.

use russh::ChannelMsg;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

use crate::audit::AuditLog;
use crate::error::{AppError, AppResult};
use crate::ssh::{shell_quote, wrap_command, Sessions};
use crate::trace;

/// Lines sent per batch at most; a flood beyond that is counted, not sent.
const BATCH_LINES: usize = 2000;
const BATCH_EVERY: Duration = Duration::from_millis(150);
/// A line longer than this is cut (minified JSON on one line…).
const LINE_MAX: usize = 4000;
/// Follows open at once per session, leaving channels for everything else.
const PER_SESSION: usize = 3;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub id: String,
    pub lines: Vec<String>,
    /// Lines left out of this batch because too many came at once.
    pub dropped: usize,
    /// What tail said on stderr: truncated, replaced, cannot open…
    pub notes: Vec<String>,
    /// The follow ended (stopped, file gone for good, session lost).
    pub ended: bool,
    pub error: Option<String>,
}

struct Follow {
    server_id: String,
    user: String,
    stop: watch::Sender<bool>,
}

#[derive(Default)]
pub struct LogTails {
    map: Mutex<HashMap<String, Follow>>,
}

/// Split `buf` into complete lines, keeping a trailing partial line in it.
fn take_lines(buf: &mut Vec<u8>) -> Vec<String> {
    let Some(end) = buf.iter().rposition(|b| *b == b'\n') else { return Vec::new() };
    let rest = buf.split_off(end + 1);
    let text = String::from_utf8_lossy(buf).into_owned();
    *buf = rest;
    text.lines()
        .map(|l| {
            let l = l.strip_suffix('\r').unwrap_or(l);
            if l.len() > LINE_MAX {
                let mut cut = LINE_MAX;
                while !l.is_char_boundary(cut) {
                    cut -= 1;
                }
                format!("{} … (+{} ký tự)", &l[..cut], l[cut..].chars().count())
            } else {
                l.to_string()
            }
        })
        .collect()
}

/// Start following `path`: the last `lines` lines, then everything appended.
/// With `sudo`, runs through sudo when the session has it on.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn log_tail_start(
    app: AppHandle,
    sessions: tauri::State<'_, Sessions>,
    tails: tauri::State<'_, Arc<LogTails>>,
    audit: tauri::State<'_, AuditLog>,
    server_id: String,
    user: String,
    path: String,
    lines: u32,
    sudo: bool,
) -> AppResult<String> {
    let session = sessions.get(&server_id, &user)?;
    {
        let map = tails.map.lock().unwrap();
        if map.values().filter(|f| f.server_id == server_id && f.user == user).count() >= PER_SESSION {
            return Err(AppError::detail("too_many_tails", PER_SESSION));
        }
    }
    let command = format!("tail -n {} -F -- {}", lines.min(5000), shell_quote(&path));
    let (line, stdin, shown) = wrap_command(&session, &command, sudo);
    let mut channel = session.handle.channel_open_session().await.map_err(|e| AppError::detail("ssh", e))?;
    channel.exec(true, line).await.map_err(|e| AppError::detail("ssh", e))?;
    if let Some(input) = stdin {
        channel.data(input.as_bytes()).await.map_err(|e| AppError::detail("ssh", e))?;
    }

    let id = uuid::Uuid::new_v4().to_string();
    let (stop_tx, mut stop_rx) = watch::channel(false);
    tails.map.lock().unwrap().insert(id.clone(), Follow { server_id: server_id.clone(), user: user.clone(), stop: stop_tx });
    audit.record(&server_id, &user, "logTail", &shown, true, None);
    let span = trace::start(&server_id, &user, trace::Kind::Exec, Some(format!("Theo dõi {path}")), &shown, false);
    span.running();

    let tails = tails.inner().clone();
    let tail_id = id.clone();
    tauri::async_runtime::spawn(async move {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let (mut pending, mut notes, mut dropped) = (Vec::<String>::new(), Vec::<String>::new(), 0usize);
        let mut tick = tokio::time::interval(BATCH_EVERY);
        let mut code = None;
        let emit = |lines: Vec<String>, dropped: usize, notes: Vec<String>, ended: bool, error: Option<String>| {
            let _ = app.emit("logtail", Batch { id: tail_id.clone(), lines, dropped, notes, ended, error });
        };
        loop {
            tokio::select! {
                _ = stop_rx.changed() => break,
                _ = tick.tick() => {
                    if !pending.is_empty() || !notes.is_empty() || dropped > 0 {
                        emit(std::mem::take(&mut pending), std::mem::take(&mut dropped), std::mem::take(&mut notes), false, None);
                    }
                }
                msg = channel.wait() => match msg {
                    Some(ChannelMsg::Data { data }) => {
                        out.extend_from_slice(&data);
                        for l in take_lines(&mut out) {
                            if pending.len() < BATCH_LINES { pending.push(l) } else { dropped += 1 }
                        }
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        err.extend_from_slice(&data);
                        notes.extend(take_lines(&mut err));
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => code = Some(exit_status),
                    Some(_) => {}
                    None => break,
                },
            }
        }
        let _ = channel.close().await;
        let stopped = *stop_rx.borrow();
        let error = if stopped {
            None
        } else if session.handle.is_closed() {
            Some("Mất kết nối SSH".to_string())
        } else {
            Some(format!("tail kết thúc (exit {})", code.map(|c| c.to_string()).unwrap_or_else(|| "?".into())))
        };
        notes.extend(take_lines(&mut err.iter().copied().chain([b'\n']).collect()));
        emit(pending, dropped, notes, true, error.clone());
        match error {
            None => span.ok(|_| {}),
            Some(e) => span.fail(e, |_| {}),
        }
        tails.map.lock().unwrap().remove(&tail_id);
    });
    Ok(id)
}

#[tauri::command]
pub fn log_tail_stop(tails: tauri::State<'_, Arc<LogTails>>, id: String) {
    if let Some(f) = tails.map.lock().unwrap().get(&id) {
        let _ = f.stop.send(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_partial_lines_and_cuts_long_ones() {
        let mut buf = b"a\r\nb\npart".to_vec();
        assert_eq!(take_lines(&mut buf), ["a", "b"]);
        assert_eq!(buf, b"part");
        buf.extend_from_slice(b"ial\n");
        assert_eq!(take_lines(&mut buf), ["partial"]);
        let mut long = format!("{}\n", "é".repeat(3000)).into_bytes();
        let got = take_lines(&mut long);
        assert!(got[0].ends_with("(+1000 ký tự)"), "{}", &got[0][got[0].len() - 30..]);
    }
}
