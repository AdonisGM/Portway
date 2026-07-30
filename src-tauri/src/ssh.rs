use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use russh::client::{self, Handle};
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh::{ChannelMsg, Disconnect};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;

use crate::audit::{self, Kind, LineReader, Origin};
use crate::db::Db;
use crate::error::{Error, Result};
use crate::keychain;
use crate::hosts;
use crate::models::Host;

/// A live SSH connection plus its interactive shell.
///
/// `Handle` is the multiplexed connection: the shell rides one channel and
/// SFTP opens another on the same connection, which is why both appear under
/// one session and one audit trail.
pub struct Session {
    pub id: String,
    pub host_id: i64,
    pub handle: Handle<ClientHandler>,
    /// Keystrokes go here; a task forwards them to the shell channel.
    pub input: mpsc::UnboundedSender<Vec<u8>>,
    /// Window resize requests, same idea.
    pub resize: mpsc::UnboundedSender<(u32, u32)>,
    pub started_at: i64,
    pub server_key: String,
}

#[derive(Default)]
pub struct Sessions(pub Mutex<HashMap<String, Arc<Session>>>);

/// What the UI needs to render a session's header and status bar.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub host_id: i64,
    pub host_name: String,
    pub user: String,
    /// The key algorithm actually negotiated, e.g. `ssh-ed25519`.
    pub server_key: String,
    pub started_at: i64,
}

/// Payload for the `ssh://data` event — one chunk of shell output.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DataEvent {
    session_id: String,
    /// Base64 so arbitrary bytes survive the JSON hop intact.
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClosedEvent {
    session_id: String,
    reason: String,
}

pub struct ClientHandler {
    /// Filled in during the handshake so the session can report what it saw.
    pub server_key: Arc<Mutex<String>>,
    /// What the host-key check decided, for the audit trail. `check_server_key`
    /// has no database access, so the verdict is parked here and written once
    /// the connection is established.
    pub verdict: Arc<Mutex<String>>,
    pub known_hosts: KnownHostsPolicy,
}

/// Trust-on-first-use, refuse on change.
///
/// The design has a Known hosts screen and a "host key changed" confirmation
/// that was never drawn, so there is no UI to ask the user. Refusing a changed
/// key is the safe half of that missing dialog: a first sight is recorded, a
/// mismatch stops the connection rather than asking a question we cannot draw.
pub struct KnownHostsPolicy {
    pub host: String,
    pub port: u16,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &russh::keys::ssh_key::PublicKey,
    ) -> std::result::Result<bool, Self::Error> {
        *self.server_key.lock().unwrap() = key.algorithm().to_string();

        let path = known_hosts_path();
        let mut verdict = self.verdict.lock().unwrap();

        // The three outcomes are easy to get backwards, so spelled out:
        //   Ok(true)  — recorded and the key matches
        //   Ok(false) — no entry for this host at all
        //   Err(KeyChanged) — recorded, and the key is DIFFERENT
        match russh::keys::check_known_hosts_path(
            &self.known_hosts.host,
            self.known_hosts.port,
            key,
            &path,
        ) {
            Ok(true) => {
                *verdict = "known host key".into();
                Ok(true)
            }
            // First sight: trust it and write it down, the way `ssh` does on a
            // first connection.
            Ok(false) => {
                let learned = russh::keys::known_hosts::learn_known_hosts_path(
                    &self.known_hosts.host,
                    self.known_hosts.port,
                    key,
                    &path,
                );
                *verdict = match learned {
                    Ok(()) => "new host key recorded".into(),
                    Err(e) => format!("new host key, but known_hosts could not be written: {e}"),
                };
                Ok(true)
            }
            // The host is known and the key does not match. The design leaves
            // the "host key changed" confirmation undrawn, so there is no way
            // to ask — refusing is the safe half of that missing dialog.
            Err(e) => {
                *verdict = format!("REFUSED — host key changed ({e})");
                Ok(false)
            }
        }
    }
}

fn known_hosts_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".ssh")
        .join("known_hosts")
}

pub fn expand_home(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        return dirs::home_dir().unwrap_or_default().join(rest);
    }
    PathBuf::from(path)
}

/// Opens the connection, authenticates, and starts an interactive shell.
///
/// Every step that touches the host is written to the audit trail as it
/// happens, so a failed connection leaves a record too.
pub async fn connect(app: AppHandle, host: Host, session_id: String) -> Result<SessionInfo> {
    let db = app.state::<Db>();
    let addr = format!("{}:{}", host.address, host.port);

    {
        let conn = db.0.lock().unwrap();
        audit::record(
            &conn,
            host.id,
            Some(&session_id),
            Origin::System,
            Kind::Auth,
            &format!("connect {}@{}", host.user, addr),
            Some(&format!("auth={}", host.auth)),
        );
    }

    let config = Arc::new(client::Config {
        inactivity_timeout: Some(std::time::Duration::from_secs(3600)),
        ..Default::default()
    });

    let server_key = Arc::new(Mutex::new(String::new()));
    let verdict = Arc::new(Mutex::new(String::new()));
    let handler = ClientHandler {
        server_key: server_key.clone(),
        verdict: verdict.clone(),
        known_hosts: KnownHostsPolicy {
            host: host.address.clone(),
            port: host.port,
        },
    };

    let connected = client::connect(config, (host.address.as_str(), host.port), handler).await;

    // Whatever happened, the host-key decision is worth recording — a refusal
    // is exactly the event an audit trail exists for.
    {
        let decision = verdict.lock().unwrap().clone();
        if !decision.is_empty() {
            let conn = db.0.lock().unwrap();
            audit::record(
                &conn,
                host.id,
                Some(&session_id),
                Origin::System,
                Kind::Auth,
                "verify host key",
                Some(&decision),
            );
        }
    }

    let mut handle = connected.map_err(|e| {
        let decision = verdict.lock().unwrap().clone();
        if decision.starts_with("REFUSED") {
            Error::Ssh(format!(
                "{decision}. Remove the old entry from ~/.ssh/known_hosts if this is expected."
            ))
        } else {
            Error::Ssh(format!("could not reach {addr}: {e}"))
        }
    })?;

    authenticate(&mut handle, &host).await?;

    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| Error::Ssh(format!("could not open a channel: {e}")))?;

    // 80x24 is the design's status bar default; the UI corrects it as soon as
    // xterm.js has measured the pane.
    channel
        .request_pty(false, "xterm-256color", 80, 24, 0, 0, &[])
        .await
        .map_err(|e| Error::Ssh(format!("the server refused a terminal: {e}")))?;
    channel
        .request_shell(true)
        .await
        .map_err(|e| Error::Ssh(format!("the server refused a shell: {e}")))?;

    let (input_tx, mut input_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (resize_tx, mut resize_rx) = mpsc::unbounded_channel::<(u32, u32)>();

    let negotiated = server_key.lock().unwrap().clone();
    let started_at = crate::db::now_ms();

    {
        let conn = db.0.lock().unwrap();
        audit::record(
            &conn,
            host.id,
            Some(&session_id),
            Origin::System,
            Kind::Auth,
            "open shell",
            Some(&format!("pty=xterm-256color hostkey={negotiated}")),
        );
    }

    // One task owns the channel: it pumps output to the webview and drains the
    // input and resize queues. Sharing a russh channel across tasks is not
    // possible, so everything funnels through here.
    let pump_app = app.clone();
    let pump_session = session_id.clone();
    let host_id = host.id;
    let run_on_connect = host.run_on_connect.clone();

    tauri::async_runtime::spawn(async move {
        let mut reader = LineReader::default();

        // `Run on connect` is Portway acting on its own, so it is logged as
        // system before the user has typed anything.
        if let Some(command) = run_on_connect.as_deref().filter(|c| !c.trim().is_empty()) {
            let db = pump_app.state::<Db>();
            {
                let conn = db.0.lock().unwrap();
                audit::record(
                    &conn,
                    host_id,
                    Some(&pump_session),
                    Origin::System,
                    Kind::Shell,
                    command,
                    Some("run on connect"),
                );
            }
            let _ = channel.data(format!("{command}\n").as_bytes()).await;
        }

        loop {
            tokio::select! {
                Some(bytes) = input_rx.recv() => {
                    // Reconstruct what the person is typing before it goes out.
                    for line in reader.push(&bytes) {
                        let db = pump_app.state::<Db>();
                        let conn = db.0.lock().unwrap();
                        audit::record(
                            &conn, host_id, Some(&pump_session),
                            Origin::User, Kind::Shell, &line, None,
                        );
                    }
                    if channel.data(bytes.as_slice()).await.is_err() {
                        break;
                    }
                }
                Some((cols, rows)) = resize_rx.recv() => {
                    let _ = channel.window_change(cols, rows, 0, 0).await;
                }
                message = channel.wait() => {
                    match message {
                        Some(ChannelMsg::Data { data }) => {
                            let _ = pump_app.emit("ssh://data", DataEvent {
                                session_id: pump_session.clone(),
                                data: base64(&data),
                            });
                        }
                        Some(ChannelMsg::ExtendedData { data, .. }) => {
                            let _ = pump_app.emit("ssh://data", DataEvent {
                                session_id: pump_session.clone(),
                                data: base64(&data),
                            });
                        }
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                        _ => {}
                    }
                }
            }
        }

        {
            let db = pump_app.state::<Db>();
            let conn = db.0.lock().unwrap();
            audit::record(
                &conn, host_id, Some(&pump_session),
                Origin::System, Kind::Auth, "shell closed", None,
            );
        }
        let _ = pump_app.emit(
            "ssh://closed",
            ClosedEvent { session_id: pump_session.clone(), reason: "the shell ended".into() },
        );
        let sessions = pump_app.state::<Sessions>();
        sessions.0.lock().unwrap().remove(&pump_session);
    });

    let session = Arc::new(Session {
        id: session_id.clone(),
        host_id: host.id,
        handle,
        input: input_tx,
        resize: resize_tx,
        started_at,
        server_key: negotiated.clone(),
    });

    app.state::<Sessions>()
        .0
        .lock()
        .unwrap()
        .insert(session_id.clone(), session);

    // Connecting counts as using the host.
    let _ = hosts::touch(&db, host.id);

    Ok(SessionInfo {
        id: session_id,
        host_id: host.id,
        host_name: host.name,
        user: host.user,
        server_key: negotiated,
        started_at,
    })
}

async fn authenticate(handle: &mut Handle<ClientHandler>, host: &Host) -> Result<()> {
    match host.auth.as_str() {
        "key" => {
            let path = expand_home(host.key_path.as_deref().unwrap_or("~/.ssh/id_ed25519"));

            // Reading the credential store can put a system prompt on screen and
            // block for as long as the user looks at it, so it does not run on a
            // runtime worker.
            let passphrase = if host.unlock_via_keychain {
                let id = host.id;
                tokio::task::spawn_blocking(move || keychain::passphrase(id))
                    .await
                    .map_err(|e| Error::Ssh(format!("keychain lookup did not finish: {e}")))??
            } else {
                None
            };

            let key = load_secret_key(&path, passphrase.as_deref()).map_err(|e| {
                Error::Ssh(format!(
                    "could not read {} — {e}. If the key is encrypted, put its \
                     passphrase in the host's form with \"Unlock via keychain\" on.",
                    path.display()
                ))
            })?;
            // Which signature algorithm to sign with, asked of the server rather
            // than assumed. It matters only for RSA keys, and there it is the
            // difference between connecting and not: `None` means `ssh-rsa`,
            // which is RSA over SHA-1, and OpenSSH has refused that by default
            // since 8.8. An RSA key that works everywhere else would be rejected
            // here with nothing to suggest the key was fine all along.
            //
            // The server answers through the `server-sig-algs` extension. A
            // server too old to send one flattens to `None`, which is also the
            // right answer for it. Non-RSA keys ignore this entirely.
            let hash_alg = handle
                .best_supported_rsa_hash()
                .await
                .map_err(|e| {
                    Error::Ssh(format!("could not read the server's signature algorithms: {e}"))
                })?
                .flatten();

            let auth = handle
                .authenticate_publickey(
                    &host.user,
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
                )
                .await
                .map_err(|e| Error::Ssh(format!("key auth failed: {e}")))?;
            if !auth.success() {
                // Name the algorithm: "the server rejected the key" alone sends
                // people looking for a wrong key, which is the one thing it is
                // usually not.
                return Err(Error::Ssh(format!(
                    "the server rejected the key for user '{}' (offered {}). \
                     Check that the public half is in ~/.ssh/authorized_keys on the host.",
                    host.user,
                    match hash_alg {
                        Some(alg) => format!("rsa-{alg:?}").to_lowercase(),
                        None => "the key's default algorithm".into(),
                    }
                )));
            }
            Ok(())
        }
        "agent" => Err(Error::Ssh(
            "ssh-agent auth is not wired up yet — use a private key for now".into(),
        )),
        // The keychain exists now — `keychain.rs` holds key passphrases — but
        // nothing writes or reads a *password* through it yet, so this stays a
        // refusal rather than a guess.
        _ => Err(Error::Ssh(
            "password auth is not wired up yet — use a private key for now".into(),
        )),
    }
}

/// Base64 without pulling in a crate for it.
fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);

    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

pub fn decode_base64(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut buffer = 0u32;
    let mut bits = 0u32;

    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => continue,
        } as u32;
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    out
}

pub fn session(app: &AppHandle, id: &str) -> Result<Arc<Session>> {
    app.state::<Sessions>()
        .0
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .ok_or_else(|| Error::Ssh(format!("session {id} is not connected")))
}

pub async fn disconnect(app: &AppHandle, id: &str) -> Result<()> {
    let session = app.state::<Sessions>().0.lock().unwrap().remove(id);
    if let Some(session) = session {
        {
            let db = app.state::<Db>();
            let conn = db.0.lock().unwrap();
            audit::record(
                &conn,
                session.host_id,
                Some(id),
                Origin::User,
                Kind::Auth,
                "disconnect",
                None,
            );
        }
        let _ = session
            .handle
            .disconnect(Disconnect::ByApplication, "", "en")
            .await;
    }
    Ok(())
}
