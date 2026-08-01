use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection, Row};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;

use crate::db::{now_ms, Db};
use crate::error::{Error, Result};
use crate::hosts;
use crate::models::{Tunnel, TunnelInput};
use crate::ssh;

/// Port forwarding: the three things `ssh -L`, `ssh -R` and `ssh -D` do.
///
/// A tunnel opens its **own** SSH connection rather than borrowing an open
/// session's. That is what `ssh -L … -N` does, and it is the difference between
/// a forward that works and one that dies because somebody closed a terminal
/// tab it never had anything to do with. It also makes "start at launch"
/// meaningful, which it would not be if a tunnel needed a session first.

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
}

pub struct Running {
    /// Dropping this is what closes the listener. Aborting the accept task is
    /// not enough on its own to be sure the socket is released, and a leaked
    /// listener means the next start fails with "address already in use" and no
    /// way to see why.
    cancel: CancellationToken,
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

fn set_state(app: &AppHandle, id: i64, state: &str, error: Option<String>) {
    publish(
        app,
        TunnelState {
            id,
            state: state.into(),
            error,
        },
    );
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
    app.state::<TunnelStates>()
        .0
        .lock()
        .unwrap()
        .values()
        .cloned()
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

    fetch(&conn, conn.last_insert_rowid())
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

pub fn stop(app: &AppHandle, id: i64) {
    let running = app.state::<Tunnels>().0.lock().unwrap().remove(&id);
    if let Some(running) = running {
        running.cancel.cancel();
        set_state(app, id, "idle", None);
    }
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

    // Failures are reported through the state as well as returned. The button
    // that started this gets the error; so does a start nobody clicked, which
    // is the whole point of the `error` state.
    match open(app, &tunnel, &host).await {
        Ok(cancel) => {
            app.state::<Tunnels>()
                .0
                .lock()
                .unwrap()
                .insert(id, Running { cancel });
            set_state(app, id, "active", None);
            Ok(())
        }
        Err(e) => {
            set_state(app, id, "error", Some(e.to_string()));
            Err(e)
        }
    }
}

/// Brings one tunnel up, and returns the token that takes it down again.
///
/// Everything that can fail happens before this returns — connecting,
/// authenticating, binding the port, asking the server to listen — so a tunnel
/// reported `active` is one that is genuinely carrying traffic, not one that
/// has been asked to try.
async fn open(
    app: &AppHandle,
    tunnel: &Tunnel,
    host: &crate::models::Host,
) -> Result<CancellationToken> {
    let cancel = CancellationToken::new();

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
        }

        // We listen; every connection becomes a channel to the far end.
        kind => {
            // Shared from here on: each accepted connection opens its own
            // channel on the one connection, and russh's handle is not `Clone`.
            let handle = Arc::new(handle);
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
                    tokio::spawn(async move {
                        let outcome = if dynamic {
                            socks5(handle, stream, peer).await
                        } else {
                            forward(handle, stream, peer, &target.0, target.1).await
                        };
                        // The tunnel stays up — this is one connection, and the
                        // next may well work. But a forward that is listening
                        // and refusing everything looks identical to one that
                        // is working until somebody says why, and the commonest
                        // reason by far is `AllowTcpForwarding no` on the far
                        // end, which no amount of retrying will fix.
                        if let Err(e) = outcome {
                            set_state(&reporter, id, "active", Some(e.to_string()));
                        }
                    });
                }
                // Dropping the listener here is what frees the port; the
                // connections already open are left to finish.
                drop(listener);
            });
        }
    }

    Ok(cancel)
}

/// Joins one accepted connection to a channel through the server.
async fn forward(
    handle: Arc<russh::client::Handle<ssh::ClientHandler>>,
    mut stream: TcpStream,
    peer: std::net::SocketAddr,
    host: &str,
    port: u16,
) -> Result<()> {
    let channel = handle
        .channel_open_direct_tcpip(host, port as u32, peer.ip().to_string(), peer.port() as u32)
        .await
        .map_err(|e| Error::Ssh(format!("the server refused a channel to {host}:{port} — {e}")))?;

    let mut remote = channel.into_stream();
    let _ = tokio::io::copy_bidirectional(&mut stream, &mut remote).await;
    Ok(())
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
        Err(_) => {
            reply(&mut stream, REPLY_FAILED).await?;
            return Ok(());
        }
    };

    reply(&mut stream, REPLY_OK).await?;
    let mut remote = channel.into_stream();
    let _ = tokio::io::copy_bidirectional(&mut stream, &mut remote).await;
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

    for id in wanted {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = start(&app, id).await;
        });
    }
}


