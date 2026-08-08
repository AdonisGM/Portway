use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection, Row};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;

use crate::audit::{self, Kind, Origin};
use crate::db::{now_ms, Db};
use crate::error::{Error, Result};
use crate::hosts;
use crate::logging::{self, Level, Span};
use crate::models::{Tunnel, TunnelInput};
use crate::ssh;

/// Port forwarding: the three things `ssh -L`, `ssh -R` and `ssh -D` do.
///
/// A tunnel opens its **own** SSH connection rather than borrowing an open
/// session's. That is what `ssh -L … -N` does, and it is the difference between
/// a forward that works and one that dies because somebody closed a terminal
/// tab it never had anything to do with. It also makes "start at launch"
/// meaningful, which it would not be if a tunnel needed a session first.

/// How long Test waits before calling silence an answer.
const CHECK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

const COLUMNS: &str = "t.id, t.label, t.host_id, h.name, t.kind, t.bind_address, t.bind_port, \
                       t.target_host, t.target_port, t.autostart, t.created_at, t.updated_at";

fn row_to_tunnel(row: &Row) -> rusqlite::Result<Tunnel> {
    Ok(Tunnel {
        id: row.get(0)?,
        label: row.get(1)?,
        host_id: row.get(2)?,
        via: row.get(3)?,
        kind: row.get(4)?,
        bind_address: row.get(5)?,
        bind_port: row.get(6)?,
        target_host: row.get(7)?,
        target_port: row.get(8)?,
        autostart: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn map_conflict(error: rusqlite::Error, label: &str) -> Error {
    if let rusqlite::Error::SqliteFailure(err, _) = &error {
        if err.code == rusqlite::ErrorCode::ConstraintViolation {
            return Error::Invalid(format!("A tunnel called '{label}' already exists"));
        }
    }
    Error::Sqlite(error)
}

fn fetch(conn: &Connection, id: i64) -> Result<Tunnel> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM tunnels t JOIN hosts h ON h.id = t.host_id WHERE t.id = ?1"),
        params![id],
        row_to_tunnel,
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Error::NotFound(id),
        other => Error::Sqlite(other),
    })
}

/* ---------------------------------------------------------------------------
   What is running
--------------------------------------------------------------------------- */

/// One tunnel's live state, as the table draws it.
///
/// Wider than the design's `active | idle`, because a forward has two states
/// those two words cannot tell apart: still connecting, and stopped *because
/// something went wrong*. A tunnel that silently reads `idle` after failing to
/// bind its port is a tunnel the user will try to start again and again.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TunnelState {
    pub id: i64,
    /// `idle` | `starting` | `active` | `error`
    pub state: String,
    pub error: Option<String>,
    /// What happened on the **far leg** — the hop from the server to the
    /// destination for a local forward, or from this machine to it for a remote
    /// one. `None` means nothing has tried it yet since this tunnel came up.
    ///
    /// Deliberately not measured on a timer or probed at startup. A forward set
    /// to `autostart: launch` would then dial somebody's production database at
    /// boot to decide the colour of a line, and a probe that succeeded half an
    /// hour ago would still be drawn as true now. This is only ever what the
    /// last real connection through the forward did — plus whatever the Test
    /// button did, which is the user asking.
    pub reachable: Option<bool>,
    /// Bytes carried each way since this forward came up, and how many
    /// connections it is holding now against how many it has served.
    ///
    /// Filled in by `tunnel_states` from the live counters rather than carried
    /// on the published event: these move constantly, and a state event per
    /// kilobyte would be a re-render per kilobyte. The screen that wants them
    /// asks for them.
    pub up: u64,
    pub down: u64,
    pub open: u64,
    pub served: u64,
}

/// What has crossed one forward since it came up.
///
/// The numbers were already being computed and thrown away:
/// `copy_bidirectional` returns the bytes it moved each way, and both call
/// sites discarded them with `let _ =`. Keeping them is the difference between
/// a row that says a tunnel is `active` and a row that says it is *doing
/// something* — which is the question somebody actually has, because a forward
/// that is listening and carrying nothing looks exactly like one that works.
///
/// Atomics rather than a lock: every connection updates these, they are read by
/// a poll on another thread, and none of it is worth serialising.
#[derive(Default)]
pub struct Traffic {
    /// Bytes from this machine towards the server.
    up: AtomicU64,
    /// And back.
    down: AtomicU64,
    /// Connections open right now.
    open: AtomicU64,
    /// Connections carried since this forward started.
    served: AtomicU64,
}

impl TunnelState {
    /// The counters at zero, for the three places that publish a lifecycle
    /// change and have no traffic to report — `tunnel_states` fills them in
    /// from the live figures when somebody asks.
    fn empty(id: i64) -> Self {
        Self {
            id,
            state: String::new(),
            error: None,
            reachable: None,
            up: 0,
            down: 0,
            open: 0,
            served: 0,
        }
    }
}

pub struct Running {
    /// Dropping this is what closes the listener. Aborting the accept task is
    /// not enough on its own to be sure the socket is released, and a leaked
    /// listener means the next start fails with "address already in use" and no
    /// way to see why.
    cancel: CancellationToken,
    /// The connection this forward rides, kept so Test can open a channel over
    /// it rather than dialling the host a second time. `None` for a remote
    /// forward, whose far leg starts on this machine and needs no channel.
    handle: Option<Arc<russh::client::Handle<ssh::ClientHandler>>>,
    /// Where that far leg goes. `None` for a dynamic forward, which is told by
    /// each client and so has no one destination to test.
    target: Option<(String, u16)>,
    /// Shared with every connection this forward carries.
    traffic: Arc<Traffic>,
}

#[derive(Default)]
pub struct Tunnels(pub Mutex<HashMap<i64, Running>>);

/// The last reported state of every tunnel that is not plain idle.
#[derive(Default)]
pub struct TunnelStates(pub Mutex<HashMap<i64, TunnelState>>);

fn publish(app: &AppHandle, state: TunnelState) {
    app.state::<TunnelStates>()
        .0
        .lock()
        .unwrap()
        .insert(state.id, state.clone());
    let _ = app.emit("tunnel://state", state);
}

/// The far leg worked.
///
/// Emitted only on a *change*, so the ordinary case — connection after
/// connection succeeding — is silent. It also drops a failure that has stopped
/// being true: without that, the first refusal would be the last word, and the
/// row would keep explaining a problem that is over. That is how a diagnostic
/// becomes a lie.
fn report_reachable(app: &AppHandle, id: i64) {
    let stale = {
        let states = app.state::<TunnelStates>();
        let map = states.0.lock().unwrap();
        map.get(&id)
            .is_some_and(|s| s.error.is_some() || s.reachable != Some(true))
    };
    if !stale {
        return;
    }
    publish(
        app,
        TunnelState {
            id,
            state: "active".into(),
            error: None,
            reachable: Some(true),
            ..TunnelState::empty(id)
        },
    );
    logging::info("tunnel", "the far leg is carrying traffic", Some(&format!("tunnel={id}")));
}

/// The far leg did not.
///
/// Logged only when the reason *changes*. A browser pointed at a proxy the
/// far end refuses will fail once per request, and a hundred identical lines
/// a second would bury the connection that finally succeeded.
fn report_unreachable(app: &AppHandle, id: i64, reason: String) {
    let repeat = {
        let states = app.state::<TunnelStates>();
        let map = states.0.lock().unwrap();
        map.get(&id).and_then(|s| s.error.clone()) == Some(reason.clone())
    };
    publish(
        app,
        TunnelState {
            id,
            // Still `active`: the listener is up and the SSH connection is
            // fine. It is the hop beyond the server that is broken, which is a
            // different fact and drawn as a different line.
            state: "active".into(),
            error: Some(reason.clone()),
            reachable: Some(false),
            ..TunnelState::empty(id)
        },
    );
    if !repeat {
        logging::warn(
            "tunnel",
            "the far leg refused a connection",
            Some(&format!("tunnel={id} · {reason}")),
        );
    }
}

/// A lifecycle change: starting, up, stopped, failed to start.
///
/// Always resets what is known about the far leg, because none of those
/// transitions leave the previous answer true — a tunnel that has just come up
/// has not tried its far leg yet, whatever the one before it managed.
fn set_state(app: &AppHandle, id: i64, state: &str, error: Option<String>) {
    publish(
        app,
        TunnelState {
            id,
            state: state.into(),
            error,
            reachable: None,
            ..TunnelState::empty(id)
        },
    );
}

/// How many forwards are up, for the debug panel's summary.
pub fn active_count(app: &AppHandle) -> usize {
    app.state::<TunnelStates>()
        .0
        .lock()
        .map(|map| map.values().filter(|s| s.state == "active").count())
        .unwrap_or(0)
}

/* ---------------------------------------------------------------------------
   Storage
--------------------------------------------------------------------------- */

#[tauri::command]
pub fn list_tunnels(db: State<'_, Db>) -> Result<Vec<Tunnel>> {
    let conn = db.0.lock().unwrap();
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM tunnels t JOIN hosts h ON h.id = t.host_id ORDER BY t.id"
    ))?;
    let rows = stmt.query_map([], row_to_tunnel)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Every tunnel's state, for a screen that has just opened and missed the
/// events. Anything absent from the map has never run and is idle.
#[tauri::command]
pub fn tunnel_states(app: AppHandle) -> Vec<TunnelState> {
    // The live counters are read here rather than pushed with every state
    // event: they move with every byte, and a re-render per kilobyte is not a
    // status display, it is a load. The screen showing them polls; nothing else
    // pays for them.
    let running = app.state::<Tunnels>();
    let live = running.0.lock().unwrap();

    app.state::<TunnelStates>()
        .0
        .lock()
        .unwrap()
        .values()
        .cloned()
        .map(|mut state| {
            if let Some(carrying) = live.get(&state.id) {
                let count = |n: &std::sync::atomic::AtomicU64| n.load(Ordering::Relaxed);
                state.up = count(&carrying.traffic.up);
                state.down = count(&carrying.traffic.down);
                state.open = count(&carrying.traffic.open);
                state.served = count(&carrying.traffic.served);
            }
            state
        })
        .collect()
}

#[tauri::command]
pub fn create_tunnel(db: State<'_, Db>, input: TunnelInput) -> Result<Tunnel> {
    let input = input.normalized();
    input.validate()?;

    let conn = db.0.lock().unwrap();
    let at = now_ms();
    conn.execute(
        "INSERT INTO tunnels (label, host_id, kind, bind_address, bind_port, target_host, \
         target_port, autostart, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        params![
            input.label,
            input.host_id,
            input.kind,
            input.bind_address,
            input.bind_port,
            input.target_host,
            input.target_port,
            input.autostart,
            at,
        ],
    )
    .map_err(|e| map_conflict(e, &input.label))?;

    let tunnel = fetch(&conn, conn.last_insert_rowid())?;
    logging::info(
        "tunnel",
        &format!("created {}", tunnel.label),
        Some(&format!(
            "tunnel={} kind={} {}:{} autostart={}",
            tunnel.id, tunnel.kind, tunnel.bind_address, tunnel.bind_port, tunnel.autostart
        )),
    );
    Ok(tunnel)
}

/// Editing a running tunnel does not move the running one. The change lands in
/// the database and takes effect the next time it starts — restarting it under
/// the user would drop whatever is connected through it right now.
#[tauri::command]
pub fn update_tunnel(db: State<'_, Db>, id: i64, input: TunnelInput) -> Result<Tunnel> {
    let input = input.normalized();
    input.validate()?;

    let conn = db.0.lock().unwrap();
    let changed = conn
        .execute(
            "UPDATE tunnels SET label = ?1, host_id = ?2, kind = ?3, bind_address = ?4, \
             bind_port = ?5, target_host = ?6, target_port = ?7, autostart = ?8, updated_at = ?9 \
             WHERE id = ?10",
            params![
                input.label,
                input.host_id,
                input.kind,
                input.bind_address,
                input.bind_port,
                input.target_host,
                input.target_port,
                input.autostart,
                now_ms(),
                id,
            ],
        )
        .map_err(|e| map_conflict(e, &input.label))?;
    if changed == 0 {
        return Err(Error::NotFound(id));
    }
    logging::info("tunnel", &format!("edited {}", input.label), Some(&format!("tunnel={id}")));
    fetch(&conn, id)
}

#[tauri::command]
pub async fn delete_tunnel(app: AppHandle, id: i64) -> Result<()> {
    // Stop first. Deleting the row and leaving the listener bound is how a port
    // stays occupied by something with no way left to reach it.
    stop(&app, id);

    let db = app.state::<Db>();
    let conn = db.0.lock().unwrap();
    let removed = conn.execute("DELETE FROM tunnels WHERE id = ?1", params![id])?;
    if removed == 0 {
        return Err(Error::NotFound(id));
    }
    app.state::<TunnelStates>().0.lock().unwrap().remove(&id);
    logging::info("tunnel", "deleted", Some(&format!("tunnel={id}")));
    Ok(())
}

/// Every tunnel belonging to a host, used when that host is deleted. The row
/// goes by `ON DELETE CASCADE`; the listener has to be closed by hand.
pub fn ids_for_host(conn: &Connection, host_id: i64) -> Vec<i64> {
    let Ok(mut stmt) = conn.prepare("SELECT id FROM tunnels WHERE host_id = ?1") else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map(params![host_id], |row| row.get::<_, i64>(0)) else {
        return Vec::new();
    };
    rows.filter_map(std::result::Result::ok).collect()
}

/* ---------------------------------------------------------------------------
   Running
--------------------------------------------------------------------------- */

#[tauri::command]
pub async fn start_tunnel(app: AppHandle, id: i64) -> Result<()> {
    start(&app, id).await
}

#[tauri::command]
pub fn stop_tunnel(app: AppHandle, id: i64) {
    stop(&app, id);
}

/// Tests the far leg, because the user asked.
///
/// A button rather than something the app does on its own. The check opens a
/// real connection to the destination, and a forward set to `autostart: launch`
/// would otherwise dial somebody's production database at boot to decide the
/// colour of a line on a diagram. Asked for, it is a useful answer; unasked, it
/// is the app connecting to things nobody told it to.
///
/// Runs over the connection the tunnel is already holding rather than dialling
/// the host again, so what it tests is the leg that is actually in use.
#[tauri::command]
pub async fn check_tunnel(app: AppHandle, id: i64) -> Result<bool> {
    let (handle, target) = {
        let running = app.state::<Tunnels>();
        let map = running.0.lock().unwrap();
        let Some(running) = map.get(&id) else {
            return Err(Error::Invalid("Start the tunnel before testing it".into()));
        };
        (running.handle.clone(), running.target.clone())
    };

    let Some((host, port)) = target else {
        return Err(Error::Invalid(
            "A dynamic forward is told where to go by each client that connects — there is no one destination to test".into(),
        ));
    };

    let span = Span::start("tunnel", format!("test the far leg to {host}:{port}"));
    let probe = async {
        match handle {
        // Local: the hop is made by the server, so the test has to be too.
        Some(handle) => handle
            .channel_open_direct_tcpip(host.clone(), port as u32, "127.0.0.1", 0)
            .await
            .map(|channel| {
                // Opened and immediately dropped. Nothing is sent — the
                // question was whether the far end would accept a connection,
                // and it has already been answered.
                drop(channel);
            })
            .map_err(|e| format!("the server could not reach {host}:{port} — {e}")),
        // Remote: the far leg starts here, so this is an ordinary connect.
        None => TcpStream::connect((host.as_str(), port))
            .await
            .map(drop)
            .map_err(|e| format!("could not reach {host}:{port} from this machine — {e}")),
        }
    };

    // An address that is routed nowhere does not refuse — it says nothing, and
    // the connect sits there for over a minute waiting for a SYN-ACK that is
    // not coming. Left unbounded the button reads "Testing…" for that whole
    // time, which is indistinguishable from the app having hung. Not answering
    // is itself the answer, and eight seconds is long enough to be sure of it.
    let outcome = match tokio::time::timeout(CHECK_TIMEOUT, probe).await {
        Ok(outcome) => outcome,
        Err(_) => Err(format!(
            "{host}:{port} did not answer within {}s — nothing refused the connection, it simply never arrived",
            CHECK_TIMEOUT.as_secs()
        )),
    };

    match outcome {
        Ok(()) => {
            span.done(Level::Info, Some(&format!("tunnel={id} · reachable")));
            report_reachable(&app, id);
            Ok(true)
        }
        Err(reason) => {
            span.failed(&reason);
            report_unreachable(&app, id, reason);
            Ok(false)
        }
    }
}

pub fn stop(app: &AppHandle, id: i64) {
    let running = app.state::<Tunnels>().0.lock().unwrap().remove(&id);
    if let Some(running) = running {
        running.cancel.cancel();
        set_state(app, id, "idle", None);
        logging::info("tunnel", "stopped", Some(&format!("tunnel={id}")));
        // The trail should close what it opened. A forward that appears in it
        // with no matching close reads as one that is still up.
        let db = app.state::<Db>();
        let conn = db.0.lock().unwrap();
        if let Ok(tunnel) = fetch(&conn, id) {
            audit::record(
                &conn,
                tunnel.host_id,
                None,
                Origin::User,
                Kind::Tunnel,
                &describe(&tunnel),
                Some("stopped"),
                None,
            );
        }
    }
}

/// One forward, in the words `ssh` would use for it.
///
/// Written the way the flags read rather than as a sentence, so a row in the
/// trail can be checked against what somebody meant to set up: `-L`, `-R` and
/// `-D` are the three things this does, and they are what a reader already
/// knows.
fn describe(tunnel: &Tunnel) -> String {
    let flag = match tunnel.kind.as_str() {
        "remote" => "-R",
        "dynamic" => "-D",
        _ => "-L",
    };
    let bind = format!("{}:{}", tunnel.bind_address, tunnel.bind_port);
    match (tunnel.kind.as_str(), &tunnel.target_host, tunnel.target_port) {
        // A dynamic forward is told its destination by each client that
        // connects, so there is none to name here.
        ("dynamic", _, _) => format!("tunnel {flag} {bind}"),
        (_, Some(host), Some(port)) => format!("tunnel {flag} {bind}:{host}:{port}"),
        _ => format!("tunnel {flag} {bind}"),
    }
}

/// One row about a forward, against the host it goes through.
///
/// `session_id` is `None` and that is not an omission: a tunnel opens its own
/// SSH connection rather than borrowing a session's, which is the whole reason
/// it survives the terminal being closed.
fn audited(app: &AppHandle, tunnel: &Tunnel, origin: Origin, command: &str, detail: Option<&str>) {
    let db = app.state::<Db>();
    let conn = db.0.lock().unwrap();
    audit::record(&conn, tunnel.host_id, None, origin, Kind::Tunnel, command, detail, None);
}

pub async fn start(app: &AppHandle, id: i64) -> Result<()> {
    if app.state::<Tunnels>().0.lock().unwrap().contains_key(&id) {
        return Ok(());
    }

    let db = app.state::<Db>();
    let tunnel = {
        let conn = db.0.lock().unwrap();
        fetch(&conn, id)?
    };
    let host = hosts::get(&db, tunnel.host_id)?;

    set_state(app, id, "starting", None);

    // Started, rather than starting: the span covers the SSH connection, the
    // authentication and the bind, and how long those took together is the
    // difference between a slow server and a port that was never free.
    let span = Span::start("tunnel", format!("start {} ({})", tunnel.label, tunnel.kind));

    // Failures are reported through the state as well as returned. The button
    // that started this gets the error; so does a start nobody clicked, which
    // is the whole point of the `error` state.
    // Written before the attempt, as every other operation that reaches a host
    // is: a forward that failed to open is still something that was tried
    // against this server, and the outcome goes in the detail below.
    audited(
        app,
        &tunnel,
        Origin::User,
        &describe(&tunnel),
        Some("starting"),
    );

    match open(app, &tunnel, &host).await {
        Ok(running) => {
            app.state::<Tunnels>().0.lock().unwrap().insert(id, running);
            set_state(app, id, "active", None);
            audited(app, &tunnel, Origin::System, &describe(&tunnel), Some("active"));
            span.done(
                Level::Info,
                Some(&format!(
                    "tunnel={id} via={} {}:{}",
                    host.name, tunnel.bind_address, tunnel.bind_port
                )),
            );
            Ok(())
        }
        Err(e) => {
            set_state(app, id, "error", Some(e.to_string()));
            span.failed(&e.to_string());
            audited(app, &tunnel, Origin::System, &describe(&tunnel), Some(&e.to_string()));
            Err(e)
        }
    }
}

/// Brings one tunnel up, and returns what it takes to run and stop it.
///
/// Everything that can fail happens before this returns — connecting,
/// authenticating, binding the port, asking the server to listen — so a tunnel
/// reported `active` is one whose *near* leg is genuinely up. Whether the hop
/// beyond the server works is a separate question, answered by the first thing
/// that uses it or by the Test button, never by dialling on its own.
async fn open(
    app: &AppHandle,
    tunnel: &Tunnel,
    host: &crate::models::Host,
) -> Result<Running> {
    let cancel = CancellationToken::new();
    let destination = match tunnel.kind.as_str() {
        "dynamic" => None,
        _ => Some((
            tunnel.target_host.clone().unwrap_or_default(),
            tunnel.target_port.unwrap_or(0),
        )),
    };

    // A remote forward has to know its destination before the connection is
    // made: the server opens those channels against the handler.
    let forward_to = if tunnel.kind == "remote" {
        Some((
            tunnel.target_host.clone().unwrap_or_default(),
            tunnel.target_port.unwrap_or(0),
        ))
    } else {
        None
    };

    let (mut handle, _) = ssh::dial(app, host, None, forward_to).await?;

    match tunnel.kind.as_str() {
        // The server listens; we only have to stay connected and let the
        // handler place what arrives.
        "remote" => {
            // The reply carries the port actually bound, which only differs
            // from the request when 0 was asked for — not something the form
            // allows, but the value is the server's answer either way.
            handle
                .tcpip_forward(tunnel.bind_address.clone(), tunnel.bind_port as u32)
                .await
                .map_err(|e| {
                    Error::Ssh(format!(
                        "the server would not listen on {}:{} — {e}",
                        tunnel.bind_address, tunnel.bind_port
                    ))
                })?;

            let cancelled = cancel.clone();
            let address = tunnel.bind_address.clone();
            let bind_port = tunnel.bind_port as u32;
            tokio::spawn(async move {
                cancelled.cancelled().await;
                let _ = handle.cancel_tcpip_forward(address, bind_port).await;
                let _ = handle
                    .disconnect(russh::Disconnect::ByApplication, "tunnel closed", "")
                    .await;
            });

            // No handle kept: a remote forward's far leg starts here, so
            // testing it is an ordinary local connect and needs no channel.
            // A remote forward has no accept loop on this side — the server
            // listens and the handler places what arrives — so nothing here
            // counts its bytes. The counters stay at zero rather than lying.
            return Ok(Running {
                cancel,
                handle: None,
                target: destination,
                traffic: Arc::new(Traffic::default()),
            });
        }

        // We listen; every connection becomes a channel to the far end.
        kind => {
            // Shared from here on: each accepted connection opens its own
            // channel on the one connection, and russh's handle is not `Clone`.
            let handle = Arc::new(handle);
            let kept = Arc::clone(&handle);
            let dynamic = kind == "dynamic";
            let listener = TcpListener::bind((tunnel.bind_address.as_str(), tunnel.bind_port))
                .await
                .map_err(|e| {
                    Error::Invalid(format!(
                        "could not listen on {}:{} — {e}",
                        tunnel.bind_address, tunnel.bind_port
                    ))
                })?;

            let target = (
                tunnel.target_host.clone().unwrap_or_default(),
                tunnel.target_port.unwrap_or(0),
            );
            let cancelled = cancel.clone();
            let reporter = app.clone();
            let id = tunnel.id;
            let traffic = Arc::new(Traffic::default());
            let counting = Arc::clone(&traffic);
            tokio::spawn(async move {
                loop {
                    let accepted = tokio::select! {
                        _ = cancelled.cancelled() => break,
                        accepted = listener.accept() => accepted,
                    };
                    let Ok((stream, peer)) = accepted else { continue };

                    let handle = Arc::clone(&handle);
                    let target = target.clone();
                    let reporter = reporter.clone();
                    let counting = Arc::clone(&counting);
                    tokio::spawn(async move {
                        let outcome = if dynamic {
                            socks5(handle, stream, peer, counting).await
                        } else {
                            forward(handle, stream, peer, &target.0, target.1, counting).await
                        };
                        // The tunnel stays up — this is one connection, and the
                        // next may well work. But a forward that is listening
                        // and refusing everything looks identical to one that
                        // is working until somebody says why, and the commonest
                        // reason by far is `AllowTcpForwarding no` on the far
                        // end, which no amount of retrying will fix.
                        match outcome {
                            Err(e) => report_unreachable(&reporter, id, e.to_string()),
                            Ok(()) => report_reachable(&reporter, id),
                        }
                    });
                }
                // Dropping the listener here is what frees the port; the
                // connections already open are left to finish.
                drop(listener);
            });

            return Ok(Running {
                cancel,
                handle: Some(kept),
                target: destination,
                traffic,
            });
        }
    }
}

/// Joins one accepted connection to a channel through the server.
async fn forward(
    handle: Arc<russh::client::Handle<ssh::ClientHandler>>,
    mut stream: TcpStream,
    peer: std::net::SocketAddr,
    host: &str,
    port: u16,
    traffic: Arc<Traffic>,
) -> Result<()> {
    // Every connection that crosses the server is written down — here, in the
    // app log, and not in the audit trail. A forward carrying a browser makes
    // hundreds of these a minute, and a database row apiece would bury the
    // trail's own subject: what a person did to this host. `debug` for the same
    // reason, so the ordinary narrative stays readable and the detail is one
    // setting away when somebody needs to know where a tunnel has been.
    logging::debug(
        "tunnel",
        &format!("forwarding {peer} to {host}:{port}"),
        Some("local"),
    );
    let channel = handle
        .channel_open_direct_tcpip(host, port as u32, peer.ip().to_string(), peer.port() as u32)
        .await
        .map_err(|e| Error::Ssh(format!("the server refused a channel to {host}:{port} — {e}")))?;

    let mut remote = channel.into_stream();
    relay(&mut stream, &mut remote, &traffic, peer, host, port).await;
    Ok(())
}

/// Moves the bytes, counts them, and says what it moved when it is over.
///
/// `copy_bidirectional` has always returned this pair and both callers threw it
/// away. It is the only measurement of a tunnel there is — everything inside is
/// TLS this app holds no key for — and it answers the question that matters:
/// not "is the port open" but "is anything going through it, and to where".
///
/// The line lands when the connection *closes*, because that is when the total
/// is known. It names the destination, which for a dynamic forward is the only
/// record of where the tunnel has actually been.
async fn relay(
    stream: &mut TcpStream,
    remote: &mut (impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin),
    traffic: &Traffic,
    peer: std::net::SocketAddr,
    host: &str,
    port: u16,
) {
    traffic.open.fetch_add(1, Ordering::Relaxed);
    traffic.served.fetch_add(1, Ordering::Relaxed);
    let started = std::time::Instant::now();

    let moved = tokio::io::copy_bidirectional(stream, remote).await;

    traffic.open.fetch_sub(1, Ordering::Relaxed);
    let seconds = started.elapsed().as_secs_f64();
    match moved {
        Ok((up, down)) => {
            traffic.up.fetch_add(up, Ordering::Relaxed);
            traffic.down.fetch_add(down, Ordering::Relaxed);
            logging::debug(
                "tunnel",
                &format!("carried {peer} to {host}:{port}"),
                Some(&format!("up={up}B down={down}B in {seconds:.1}s")),
            );
        }
        // A connection cut mid-flight is ordinary — a browser tab closing does
        // it — so this is not a warning. What was moved before the cut is lost
        // to the counters, which `copy_bidirectional` gives no way to recover.
        Err(e) => logging::debug(
            "tunnel",
            &format!("cut {peer} to {host}:{port}"),
            Some(&format!("after {seconds:.1}s · {e}")),
        ),
    }
}

/* ---------------------------------------------------------------------------
   SOCKS5, for a dynamic forward
--------------------------------------------------------------------------- */

const SOCKS5: u8 = 0x05;
const NO_AUTH: u8 = 0x00;
const CMD_CONNECT: u8 = 0x01;
const ATYP_IPV4: u8 = 0x01;
const ATYP_DOMAIN: u8 = 0x03;
const ATYP_IPV6: u8 = 0x04;

const REPLY_OK: u8 = 0x00;
const REPLY_FAILED: u8 = 0x01;
const REPLY_CMD_UNSUPPORTED: u8 = 0x07;
const REPLY_ATYP_UNSUPPORTED: u8 = 0x08;

/// The client half of a dynamic forward: enough SOCKS5 to be told where to go.
///
/// Only CONNECT is implemented — BIND and UDP ASSOCIATE are not things an SSH
/// dynamic forward can offer — but they are *refused* with a proper reply
/// rather than by dropping the socket, so a client says "command not supported"
/// instead of "connection reset".
///
/// Domain names are forwarded as names, never resolved here. That is the point
/// of routing a browser through one of these: the far end does the lookup, on
/// the network where the name means something.
async fn socks5(
    handle: Arc<russh::client::Handle<ssh::ClientHandler>>,
    mut stream: TcpStream,
    peer: std::net::SocketAddr,
    traffic: Arc<Traffic>,
) -> Result<()> {
    // Greeting: version, how many methods follow, then that many bytes.
    let mut head = [0u8; 2];
    stream.read_exact(&mut head).await?;
    if head[0] != SOCKS5 {
        return Ok(());
    }
    let mut methods = vec![0u8; head[1] as usize];
    stream.read_exact(&mut methods).await?;
    // No authentication: the proxy is bound to loopback and the SSH connection
    // behind it is already authenticated.
    stream.write_all(&[SOCKS5, NO_AUTH]).await?;

    // Request: version, command, reserved, address type.
    let mut request = [0u8; 4];
    stream.read_exact(&mut request).await?;
    if request[1] != CMD_CONNECT {
        reply(&mut stream, REPLY_CMD_UNSUPPORTED).await?;
        return Ok(());
    }

    let host = match request[3] {
        ATYP_IPV4 => {
            let mut octets = [0u8; 4];
            stream.read_exact(&mut octets).await?;
            std::net::Ipv4Addr::from(octets).to_string()
        }
        ATYP_DOMAIN => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await?;
            let mut name = vec![0u8; len[0] as usize];
            stream.read_exact(&mut name).await?;
            String::from_utf8_lossy(&name).into_owned()
        }
        ATYP_IPV6 => {
            let mut octets = [0u8; 16];
            stream.read_exact(&mut octets).await?;
            std::net::Ipv6Addr::from(octets).to_string()
        }
        _ => {
            reply(&mut stream, REPLY_ATYP_UNSUPPORTED).await?;
            return Ok(());
        }
    };

    let mut port = [0u8; 2];
    stream.read_exact(&mut port).await?;
    let port = u16::from_be_bytes(port);

    // Worth a line even more than the local case: a dynamic forward is told
    // where to go by each client, so this is the only place that records where
    // the tunnel has actually been.
    logging::debug(
        "tunnel",
        &format!("forwarding {peer} to {host}:{port}"),
        Some("dynamic"),
    );
    let channel = match handle
        .channel_open_direct_tcpip(
            host.clone(),
            port as u32,
            peer.ip().to_string(),
            peer.port() as u32,
        )
        .await
    {
        Ok(channel) => channel,
        // The client still gets a well-formed refusal — but the reason is
        // reported upward too. Swallowing it is how a dynamic forward that the
        // server refuses to forward *anything* through looked identical to one
        // that was working.
        Err(e) => {
            reply(&mut stream, REPLY_FAILED).await?;
            return Err(Error::Ssh(format!(
                "the server refused a channel to {host}:{port} — {e}"
            )));
        }
    };

    reply(&mut stream, REPLY_OK).await?;
    let mut remote = channel.into_stream();
    relay(&mut stream, &mut remote, &traffic, peer, &host, port).await;
    Ok(())
}

/// A SOCKS5 reply with an all-zero IPv4 bound address, which is what a proxy
/// that never binds one is expected to send.
async fn reply(stream: &mut TcpStream, code: u8) -> std::io::Result<()> {
    stream
        .write_all(&[SOCKS5, code, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0])
        .await
}

/* ---------------------------------------------------------------------------
   Autostart
--------------------------------------------------------------------------- */

/// Starts every tunnel that asked to come up on its own.
///
/// `trigger` is `launch` at startup, or `session` when a session to `host_id`
/// opens. Failures are left in the state map rather than raised: nobody clicked
/// anything, and a dialog for a tunnel the user has not thought about since
/// they created it would be an interruption, not news.
pub fn autostart(app: &AppHandle, trigger: &str, host_id: Option<i64>) {
    let wanted: Vec<i64> = {
        let db = app.state::<Db>();
        let Ok(conn) = db.0.lock() else { return };
        let sql = match host_id {
            Some(_) => "SELECT id FROM tunnels WHERE autostart = ?1 AND host_id = ?2",
            None => "SELECT id FROM tunnels WHERE autostart = ?1",
        };
        let Ok(mut stmt) = conn.prepare(sql) else { return };
        let read = |row: &rusqlite::Row| row.get::<_, i64>(0);
        // Collected inside each arm: the two `query_map` calls borrow different
        // parameter slices, so their iterators cannot meet as one value.
        match host_id {
            Some(id) => match stmt.query_map(params![trigger, id], read) {
                Ok(rows) => rows.filter_map(std::result::Result::ok).collect(),
                Err(_) => return,
            },
            None => match stmt.query_map(params![trigger], read) {
                Ok(rows) => rows.filter_map(std::result::Result::ok).collect(),
                Err(_) => return,
            },
        }
    };

    if !wanted.is_empty() {
        logging::info(
            "tunnel",
            "starting the forwards that asked to come up",
            Some(&format!("trigger={trigger} count={}", wanted.len())),
        );
    }

    for id in wanted {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = start(&app, id).await;
        });
    }
}


