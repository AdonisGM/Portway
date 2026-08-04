use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use russh::client::{self, AuthResult, Handle, KeyboardInteractiveAuthResponse, Prompt};
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh::{ChannelMsg, Disconnect, MethodKind, MethodSet};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;

use crate::audit::{self, Kind, LineReader, Origin};
use crate::db::Db;
use crate::error::{Error, Result};
use crate::keychain;
use crate::hosts;
use crate::logging::{self, Level, Span};
use crate::models::Host;

/// A live SSH connection plus its interactive shell.
///
/// `Handle` is the multiplexed connection: the shell rides one channel and
/// SFTP opens another on the same connection, which is why both appear under
/// one session and one audit trail.
pub struct Session {
    pub id: String,
    pub host_id: i64,
    /// The window that opened this session. Output is emitted only there:
    /// `app.emit` broadcasts to every webview, so with a session in its own
    /// window each byte would cross the IPC boundary once per window and be
    /// discarded by all but one.
    pub window: String,
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
    /// Where to send channels the *server* opens, which is how a remote forward
    /// delivers its traffic: `tcpip_forward` only asks the server to listen, and
    /// every connection it then accepts arrives here rather than on the handle.
    /// `None` for every other kind of connection, which opens its own channels
    /// and is never called back.
    pub forward_to: Option<(String, u16)>,
}

/// What to do about a server key, and which server it is about.
///
/// A changed key is always refused. What Settings decides is the *other*
/// half: whether a host nobody has met before is recorded and trusted, or
/// stopped. Those are OpenSSH's `accept-new` and `yes`, and they are named
/// after it here for the same reason the Known hosts screen shows real
/// fingerprints — this is a file and a protocol somebody may already know.
pub struct KnownHostsPolicy {
    pub host: String,
    pub port: u16,
    /// `false` is `accept-new`: a first sight is trusted and written down, the
    /// way `ssh` does. `true` is `yes`: nothing gets in that is not already in
    /// the file, and a new server has to be added deliberately.
    pub strict: bool,
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
            // First sight, and Settings says only what is already in the file
            // may in. Nothing is written: recording the key here would defeat
            // the setting by making every host known the moment it is met.
            Ok(false) if self.known_hosts.strict => {
                *verdict = "REFUSED — host key not in known_hosts (strict host keys)".into();
                Ok(false)
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

    /// A connection the *server* made on our behalf, on a port a remote forward
    /// asked it to listen on. Ours to join to something local.
    ///
    /// Dropping the channel is the right answer when there is nowhere to send
    /// it: that is a connection to a port this client never asked to forward.
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<russh::client::Msg>,
        _connected_address: &str,
        _connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut russh::client::Session,
    ) -> std::result::Result<(), Self::Error> {
        let Some((host, port)) = self.forward_to.clone() else { return Ok(()) };

        tokio::spawn(async move {
            let Ok(mut local) = tokio::net::TcpStream::connect((host.as_str(), port)).await else {
                // The far end is already connected and waiting; closing our half
                // is what tells it there is nothing here.
                return;
            };
            let mut remote = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut local, &mut remote).await;
        });

        Ok(())
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

/// Reaches a host and authenticates, and stops there.
///
/// Split out of `connect` because a shell is not the only reason to hold a
/// connection: a tunnel wants one with no channel on it at all. Everything up
/// to and including authentication is identical either way — the same host-key
/// policy, the same auth methods, the same audit entries — and the two would
/// drift apart the moment they were written twice.
///
/// Returns the handle and the key algorithm the handshake settled on.
///
/// `forward_to` is where inbound forwarded channels should be connected, and is
/// `None` for everything but a remote forward: the server opens those channels
/// against the *handler*, so the destination has to be decided here, before the
/// connection exists.
pub async fn dial(
    app: &AppHandle,
    host: &Host,
    session_id: Option<&str>,
    forward_to: Option<(String, u16)>,
) -> Result<(Handle<ClientHandler>, String)> {
    let db = app.state::<Db>();
    let addr = format!("{}:{}", host.address, host.port);

    {
        let conn = db.0.lock().unwrap();
        audit::record(
            &conn,
            host.id,
            session_id,
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

    // Read here rather than inside the handler: `check_server_key` runs in the
    // middle of a handshake with no access to the database, and reaching for a
    // mutex from there would tie a network callback to whatever else is
    // holding it.
    let strict = {
        let conn = db.0.lock().unwrap();
        crate::settings::text(&conn, "hostKeys").as_deref() == Some("strict")
    };

    let server_key = Arc::new(Mutex::new(String::new()));
    let verdict = Arc::new(Mutex::new(String::new()));
    let handler = ClientHandler {
        server_key: server_key.clone(),
        verdict: verdict.clone(),
        known_hosts: KnownHostsPolicy {
            host: host.address.clone(),
            port: host.port,
            strict,
        },
        forward_to,
    };

    let handshake = Span::start("ssh", format!("handshake with {addr}"));
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
                session_id,
                Origin::System,
                Kind::Auth,
                "verify host key",
                Some(&decision),
            );
            let level = if decision.starts_with("REFUSED") { Level::Error } else { Level::Debug };
            logging::record(level, "ssh", "host key", Some(&decision));
        }
    }

    let mut handle = match connected {
        Ok(handle) => {
            handshake.done(Level::Info, Some(&format!("key={}", server_key.lock().unwrap())));
            handle
        }
        Err(e) => {
            let decision = verdict.lock().unwrap().clone();
            // Two refusals with two different fixes. Telling somebody to
            // remove an entry that is not there is worse than saying nothing.
            let error = if decision.contains("strict host keys") {
                Error::Ssh(format!(
                    "{decision}. Either add this server's key to ~/.ssh/known_hosts, \
                     or set Settings › Security › Host keys back to accept-new."
                ))
            } else if decision.starts_with("REFUSED") {
                Error::Ssh(format!(
                    "{decision}. Check it in Known hosts, and remove the old entry there \
                     if this is expected."
                ))
            } else {
                Error::Ssh(format!("could not reach {addr}: {e}"))
            };
            handshake.failed(&error.to_string());
            return Err(error);
        }
    };

    let auth = Span::start("ssh", format!("authenticate {}@{addr}", host.user));
    match authenticate(&mut handle, host).await {
        Ok(()) => auth.done(Level::Info, Some(&format!("method={}", host.auth))),
        Err(e) => {
            auth.failed(&e.to_string());
            return Err(e);
        }
    }

    let negotiated = server_key.lock().unwrap().clone();
    Ok((handle, negotiated))
}

/// Opens the connection, authenticates, and starts an interactive shell.
///
/// Every step that touches the host is written to the audit trail as it
/// happens, so a failed connection leaves a record too.
pub async fn connect(
    app: AppHandle,
    host: Host,
    session_id: String,
    window: String,
) -> Result<SessionInfo> {
    let db = app.state::<Db>();

    // The whole thing, end to end. `dial` times the handshake and the
    // authentication inside it, so a slow connection can be read down to which
    // step ate the time.
    let opening = Span::start("ssh", format!("open a session to {}", host.name));
    logging::info(
        "ssh",
        "connecting",
        Some(&format!(
            "host={} address={}@{}:{} auth={} session={session_id} window={window}",
            host.name, host.user, host.address, host.port, host.auth
        )),
    );

    let (handle, negotiated) = match dial(&app, &host, Some(&session_id), None).await {
        Ok(dialled) => dialled,
        Err(e) => {
            opening.failed(&e.to_string());
            return Err(e);
        }
    };

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
    let pump_window = window.clone();
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
                            let _ = pump_app.emit_to(&pump_window, "ssh://data", DataEvent {
                                session_id: pump_session.clone(),
                                data: base64(&data),
                            });
                        }
                        Some(ChannelMsg::ExtendedData { data, .. }) => {
                            let _ = pump_app.emit_to(&pump_window, "ssh://data", DataEvent {
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
        logging::info(
            "ssh",
            "the shell ended",
            Some(&format!("session={pump_session} host={host_id}")),
        );
        let _ = pump_app.emit_to(
            &pump_window,
            "ssh://closed",
            ClosedEvent { session_id: pump_session.clone(), reason: "the shell ended".into() },
        );
        let sessions = pump_app.state::<Sessions>();
        sessions.0.lock().unwrap().remove(&pump_session);
    });

    let session = Arc::new(Session {
        id: session_id.clone(),
        host_id: host.id,
        window: window.clone(),
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

    opening.done(
        Level::Info,
        Some(&format!("session={session_id} hostkey={negotiated}")),
    );

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

            // Said before the read rather than after it, because the read is
            // where it goes quiet: macOS draws its consent dialog outside the
            // app, so from in here a gated key looks like a server that has
            // stopped answering. The span below then puts a number on it.
            if logging::is_gated_path(&path) {
                logging::warn(
                    "ssh",
                    "this key is in a folder macOS keeps behind a permission prompt",
                    Some(&format!(
                        "{} — the first read blocks until that dialog is answered, and an \
                         ad-hoc signed build is asked again after every rebuild. ~/.ssh is \
                         not gated.",
                        path.display()
                    )),
                );
            }

            // Reading the credential store can put a system prompt on screen and
            // block for as long as the user looks at it, so it does not run on a
            // runtime worker.
            let passphrase = if host.unlock_via_keychain {
                stored_secret(keychain::Slot::Passphrase, host.id).await?
            } else {
                None
            };

            let read = Span::start("ssh", "read the private key");
            let key = match load_secret_key(&path, passphrase.as_deref()) {
                Ok(key) => {
                    read.done(Level::Debug, Some(&path.display().to_string()));
                    key
                }
                Err(e) => {
                    let error = Error::Ssh(format!(
                        "could not read {} — {e}. If the key is encrypted, put its \
                         passphrase in the host's form with \"Unlock via keychain\" on.",
                        path.display()
                    ));
                    read.failed(&error.to_string());
                    return Err(error);
                }
            };
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
        "password" => {
            let Some(password) = stored_secret(keychain::Slot::Password, host.id).await? else {
                return Err(Error::Ssh(format!(
                    "no password is stored for '{}'. Open the host, type it into the Password \
                     box with \"Save to system keychain\" on, and save — the app sends what is \
                     in the keychain, and there is nothing there for this host.",
                    host.name
                )));
            };
            password_auth(handle, host, &password).await
        }
        "agent" => Err(Error::Ssh(
            "ssh-agent auth is not wired up yet — use a private key for now".into(),
        )),
        other => Err(Error::Ssh(format!("unknown auth method '{other}'"))),
    }
}

/// Reads one secret for a host, off the runtime's workers.
///
/// The credential store can put a system prompt on screen and block for as long
/// as the user looks at it, so this never runs on a worker thread.
async fn stored_secret(slot: keychain::Slot, host_id: i64) -> Result<Option<String>> {
    let span = Span::start("ssh", "keychain lookup");
    let found = tokio::task::spawn_blocking(move || keychain::get(slot, host_id))
        .await
        .map_err(|e| Error::Ssh(format!("keychain lookup did not finish: {e}")))??;
    // Whether there was one, never what it was.
    span.done(
        Level::Debug,
        Some(if found.is_some() { "a secret was stored" } else { "nothing stored" }),
    );
    Ok(found)
}

/// Password auth, in both of the shapes servers offer it.
///
/// `password` is the method's own name; `keyboard-interactive` is the one PAM
/// answers on. Plenty of hosts that offer what an admin would call "password
/// login" accept only the second — `KbdInteractiveAuthentication yes` with
/// `PasswordAuthentication no` is an ordinary sshd configuration, and it is the
/// default on several distributions. Sending only the first would fail there
/// with nothing to suggest the password was right all along.
///
/// The server is asked what it will accept before anything is sent, the way
/// `ssh` does. A method the server never listed is an attempt spent for
/// nothing, and `MaxAuthTries` counts it.
async fn password_auth(
    handle: &mut Handle<ClientHandler>,
    host: &Host,
    password: &str,
) -> Result<()> {
    let mut offered = match handle.authenticate_none(&host.user).await {
        // A server that admits anyone with no credentials at all. Rare, and
        // never what the form intended, but it has just said the connection is
        // authenticated and there is nothing left to send.
        Ok(AuthResult::Success) => return Ok(()),
        Ok(AuthResult::Failure { remaining_methods, .. }) => remaining_methods,
        Err(e) => {
            return Err(Error::Ssh(format!("could not start authentication: {e}")));
        }
    };
    logging::debug("ssh", "the server accepts", Some(&method_names(&offered)));

    // An empty list is a server that named nothing rather than a server that
    // accepts nothing: try both instead of refusing on its silence.
    let silent = offered.is_empty();
    let mut tried = false;

    if silent || offered.contains(&MethodKind::Password) {
        tried = true;
        let span = Span::start("ssh", "password auth");
        match handle.authenticate_password(&host.user, password).await {
            Ok(AuthResult::Success) => {
                span.done(Level::Debug, Some("accepted"));
                return Ok(());
            }
            Ok(AuthResult::Failure { partial_success: true, .. }) => {
                span.failed("accepted, but the server wants another factor");
                return Err(second_factor(host));
            }
            Ok(AuthResult::Failure { remaining_methods, .. }) => {
                span.failed("the server did not accept it");
                // What it will still take *after* this attempt, which is not
                // always what it listed before one.
                offered = remaining_methods;
            }
            Err(e) => return Err(Error::Ssh(format!("password auth failed: {e}"))),
        }
    }

    if silent || offered.contains(&MethodKind::KeyboardInteractive) {
        return keyboard_interactive(handle, host, password).await;
    }

    Err(if tried {
        rejected(host)
    } else {
        Error::Ssh(format!(
            "this server does not offer password login for user '{}' — it accepts {}. \
             Switch the host to Private key, or enable password auth on the server.",
            host.user,
            method_names(&offered)
        ))
    })
}

/// The `keyboard-interactive` exchange, answered with the stored password.
///
/// The server drives it: any number of rounds, each carrying a set of prompts.
/// A PAM stack commonly spends the first round on a banner with no prompts at
/// all, so rounds are not what is counted — what is tracked is whether the
/// password has already been given. The thing a server asks for right after
/// accepting it is a second factor, and nothing stored here could answer that;
/// guessing would send the password into a prompt asking for a one-time code.
async fn keyboard_interactive(
    handle: &mut Handle<ClientHandler>,
    host: &Host,
    password: &str,
) -> Result<()> {
    let span = Span::start("ssh", "keyboard-interactive auth");
    let mut response = handle
        .authenticate_keyboard_interactive_start(&host.user, None::<String>)
        .await
        .map_err(|e| Error::Ssh(format!("keyboard-interactive auth failed: {e}")))?;
    let mut sent_password = false;

    // Bounded because the far end decides how many rounds there are: a server
    // sending empty requests forever would otherwise keep this task here.
    for _ in 0..10 {
        let answers = match response {
            KeyboardInteractiveAuthResponse::Success => {
                span.done(Level::Debug, Some("accepted"));
                return Ok(());
            }
            KeyboardInteractiveAuthResponse::Failure { partial_success, .. } => {
                span.failed(if partial_success {
                    "accepted, but the server wants another factor"
                } else {
                    "the server did not accept it"
                });
                return Err(if partial_success { second_factor(host) } else { rejected(host) });
            }
            KeyboardInteractiveAuthResponse::InfoRequest { name, instructions, prompts } => {
                // The server's own words, and the one thing that explains a
                // refusal after the fact — "Password expired", "Account locked",
                // a 2FA prompt. Written down; the answers never are.
                logging::debug(
                    "ssh",
                    "the server asks",
                    Some(&describe(&name, &instructions, &prompts)),
                );
                match prompts.as_slice() {
                    // A banner, or an instruction with nothing to answer.
                    [] => Vec::new(),
                    [prompt] if !prompt.echo && !sent_password => {
                        sent_password = true;
                        vec![password.to_string()]
                    }
                    _ => {
                        let asked = describe(&name, &instructions, &prompts);
                        span.failed(&asked);
                        return Err(Error::Ssh(format!(
                            "the server is asking for something the app cannot answer from a \
                             stored password ({asked}). A host behind a one-time code or a \
                             second factor needs an interactive login, which Portway does not \
                             have yet — use a private key for this one."
                        )));
                    }
                }
            }
        };
        response = handle
            .authenticate_keyboard_interactive_respond(answers)
            .await
            .map_err(|e| Error::Ssh(format!("keyboard-interactive auth failed: {e}")))?;
    }

    span.failed("the server kept asking");
    Err(Error::Ssh(format!(
        "the server kept asking for more input than a stored password can answer for user '{}'",
        host.user
    )))
}

/// Named separately from a plain rejection: the password was *right*, and
/// telling somebody to check it would send them retyping a correct one.
fn second_factor(host: &Host) -> Error {
    Error::Ssh(format!(
        "the password for '{}' was accepted, but the server requires a second factor as well. \
         Portway cannot prompt for one yet — use a private key for this host.",
        host.user
    ))
}

fn rejected(host: &Host) -> Error {
    Error::Ssh(format!(
        "the server rejected the password for user '{}'. Check the password saved for this \
         host, and that the account is not locked or restricted to key auth.",
        host.user
    ))
}

/// `publickey, password` rather than the `Debug` of a set, because this reaches
/// the user in an error and those are the names sshd's own config uses.
fn method_names(methods: &MethodSet) -> String {
    if methods.is_empty() {
        return "nothing it would name".into();
    }
    methods.iter().map(<&str>::from).collect::<Vec<_>>().join(", ")
}

/// Server-supplied text, flattened to one line for a log or an error. Prompts
/// are named but never their answers, and `echo` is noted because it is the
/// difference between "type your password" and "type the code from your phone".
fn describe(name: &str, instructions: &str, prompts: &[Prompt]) -> String {
    let mut parts: Vec<String> = Vec::new();
    for text in [name, instructions] {
        let text = text.trim();
        if !text.is_empty() {
            parts.push(text.replace('\n', " "));
        }
    }
    for prompt in prompts {
        let text = prompt.prompt.trim().replace('\n', " ");
        parts.push(if prompt.echo { format!("{text} [visible]") } else { text });
    }
    if parts.is_empty() {
        "nothing at all".into()
    } else {
        parts.join(" · ")
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
        logging::info(
            "ssh",
            "disconnected",
            Some(&format!(
                "session={id} host={} up={}s",
                session.host_id,
                (crate::db::now_ms() - session.started_at) / 1000
            )),
        );
    }
    Ok(())
}

/// Every session a window owns — used when that window closes.
pub fn sessions_of_window(app: &AppHandle, label: &str) -> Vec<String> {
    let sessions = app.state::<Sessions>();
    let map = sessions.0.lock().unwrap();
    map.values()
        .filter(|s| s.window == label)
        .map(|s| s.id.clone())
        .collect()
}

/// The password exchange, against a server that actually answers.
///
/// Everything here is about one question: what a server will *say* when it
/// offers password login, and whether this client survives each shape of it.
/// The interesting one is a host with `PasswordAuthentication no` and
/// `KbdInteractiveAuthentication yes` — the configuration a user reads as
/// "password login works, and this app is the only client that cannot do it".
#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::ssh_key::rand_core::OsRng;
    use russh::keys::{Algorithm, PrivateKey};
    use russh::server::{self, Auth, Server as _};
    use std::borrow::Cow;

    const PASSWORD: &str = "correct horse battery staple";

    /// What the test server will accept, whatever it advertises.
    #[derive(Clone, Copy, PartialEq)]
    enum Accepts {
        Password,
        KeyboardInteractive,
        /// Neither — a server that offers password login and turns down the
        /// password.
        Nothing,
    }

    #[derive(Clone)]
    struct Sshd {
        accepts: Accepts,
        /// Whether this connection has been shown the password prompt yet.
        /// The exchange opens with a promptless round, the way a PAM stack
        /// sends its banner before it asks anything.
        asked: bool,
    }

    impl server::Server for Sshd {
        type Handler = Self;
        fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
            self.clone()
        }
    }

    impl server::Handler for Sshd {
        type Error = russh::Error;

        async fn auth_password(
            &mut self,
            _user: &str,
            password: &str,
        ) -> std::result::Result<Auth, Self::Error> {
            Ok(if self.accepts == Accepts::Password && password == PASSWORD {
                Auth::Accept
            } else {
                Auth::reject()
            })
        }

        async fn auth_keyboard_interactive<'a>(
            &'a mut self,
            _user: &str,
            _submethods: &str,
            response: Option<server::Response<'a>>,
        ) -> std::result::Result<Auth, Self::Error> {
            if self.accepts != Accepts::KeyboardInteractive {
                return Ok(Auth::reject());
            }
            let Some(mut answers) = response else {
                // Opening round: a banner and nothing to answer.
                return Ok(Auth::Partial {
                    name: "".into(),
                    instructions: "Portway test server".into(),
                    prompts: Cow::Owned(Vec::new()),
                });
            };
            if !self.asked {
                self.asked = true;
                return Ok(Auth::Partial {
                    name: "".into(),
                    instructions: "".into(),
                    prompts: Cow::Owned(vec![("Password: ".into(), false)]),
                });
            }
            Ok(match answers.next() {
                Some(given) if given == PASSWORD.as_bytes() => Auth::Accept,
                _ => Auth::reject(),
            })
        }
    }

    /// `check_server_key` writes down a host it has not met, and every test
    /// here meets one. Point HOME at a scratch directory so that lands in a
    /// temporary file, and refuse to run at all if the redirect did not take —
    /// the alternative is appending to the known_hosts of whoever ran `cargo
    /// test`.
    fn scratch_home() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            let dir = std::env::temp_dir().join("portway-ssh-tests");
            std::fs::create_dir_all(dir.join(".ssh")).unwrap();
            // Entries are keyed by host *and port*, and the port is a new one
            // every run, so the file would only ever grow.
            let _ = std::fs::remove_file(dir.join(".ssh").join("known_hosts"));
            std::env::set_var("HOME", &dir);
        });
        assert!(
            known_hosts_path().starts_with(std::env::temp_dir()),
            "the tests must not be able to touch a real known_hosts"
        );
    }

    fn host() -> Host {
        Host {
            id: 1,
            name: "test".into(),
            address: "127.0.0.1".into(),
            port: 0,
            user: "portway".into(),
            group: "dev".into(),
            auth: "password".into(),
            key_path: None,
            jump_host: None,
            run_on_connect: None,
            agent_forwarding: false,
            keep_alive: false,
            save_to_keychain: true,
            unlock_via_keychain: false,
            favorite: false,
            last_used_at: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    /// Runs the server on a loopback port and connects to it exactly as `dial`
    /// does — same handler, same host-key policy — stopping short of auth.
    async fn connected(accepts: Accepts, advertises: &[MethodKind]) -> Handle<ClientHandler> {
        scratch_home();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();

        let config = Arc::new(server::Config {
            methods: advertises.into(),
            keys: vec![PrivateKey::random(&mut OsRng, Algorithm::Ed25519).unwrap()],
            // A rejection this server makes is not a security event worth
            // slowing a test suite down for.
            auth_rejection_time: std::time::Duration::ZERO,
            auth_rejection_time_initial: Some(std::time::Duration::ZERO),
            ..Default::default()
        });
        let mut sshd = Sshd { accepts, asked: false };
        tokio::spawn(async move { sshd.run_on_socket(config, &listener).await });

        let handler = ClientHandler {
            server_key: Arc::new(Mutex::new(String::new())),
            verdict: Arc::new(Mutex::new(String::new())),
            known_hosts: KnownHostsPolicy { host: "127.0.0.1".into(), port, strict: false },
            forward_to: None,
        };
        client::connect(Arc::new(client::Config::default()), ("127.0.0.1", port), handler)
            .await
            .expect("the test server completes a handshake")
    }

    #[tokio::test]
    async fn logs_in_with_the_password_method() {
        let mut handle = connected(Accepts::Password, &[MethodKind::Password]).await;
        password_auth(&mut handle, &host(), PASSWORD).await.expect("logs in");
    }

    /// The configuration this was written for: the server lists `password`,
    /// turns one down anyway, and means `keyboard-interactive`.
    #[tokio::test]
    async fn falls_back_to_keyboard_interactive() {
        let mut handle = connected(
            Accepts::KeyboardInteractive,
            &[MethodKind::Password, MethodKind::KeyboardInteractive],
        )
        .await;
        password_auth(&mut handle, &host(), PASSWORD).await.expect("logs in");
    }

    /// And the same server with `PasswordAuthentication no`, which does not
    /// list `password` at all — nothing to fall back *from*.
    #[tokio::test]
    async fn logs_in_where_only_keyboard_interactive_is_offered() {
        let mut handle =
            connected(Accepts::KeyboardInteractive, &[MethodKind::KeyboardInteractive]).await;
        password_auth(&mut handle, &host(), PASSWORD).await.expect("logs in");
    }

    /// A wrong password has to read as a wrong password. This is the case that
    /// sends somebody to the server's logs if the message is vague.
    #[tokio::test]
    async fn says_so_when_the_password_is_wrong() {
        let mut handle = connected(Accepts::Nothing, &[MethodKind::Password]).await;
        let error = password_auth(&mut handle, &host(), "wrong").await.unwrap_err().to_string();
        assert!(error.contains("rejected the password"), "{error}");
    }

    /// A server that will not take a password at all is not the same failure,
    /// and pointing at the password would be the wrong advice.
    #[tokio::test]
    async fn distinguishes_a_server_that_offers_no_password_login() {
        let mut handle = connected(Accepts::Nothing, &[MethodKind::PublicKey]).await;
        let error = password_auth(&mut handle, &host(), PASSWORD).await.unwrap_err().to_string();
        assert!(error.contains("does not offer password login"), "{error}");
        assert!(error.contains("publickey"), "{error}");
    }
}
