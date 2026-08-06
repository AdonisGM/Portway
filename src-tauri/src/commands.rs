use tauri::{AppHandle, Manager, State};

use crate::audit::{self, LogEntry, Origin};
use crate::db::Db;
use crate::error::{Error, Result};
use crate::logging;
use crate::sftp::{self, Listing};
use crate::ssh::{self, SessionInfo};
use crate::sudo;
use crate::hosts;

/// Writes a failed command to the application log, and passes it on unchanged.
///
/// The rule: **a command either times itself or is wrapped in this.** The long
/// operations — connect, upload a folder, delete a tree, start a tunnel — open
/// a span of their own, and that span already reports its own failure with the
/// time it took to get there. Everything else is one round trip, and this is
/// where its failure is recorded.
///
/// Without it, the commonest kind of failure there is — a listing refused, a
/// rename onto a name that exists — reaches the user as a message in the pane
/// and leaves no trace anywhere. The pane is dismissed; the log is what is
/// still there afterwards.
fn logged<T>(operation: &str, outcome: Result<T>) -> Result<T> {
    logging::call(operation, None, outcome)
}

/// The same, for anything aimed at a session — which is to say at a server.
///
/// The host goes in the detail because the failure line is where it matters
/// most: "could not read /etc — permission denied" is half an answer until you
/// know which of the four open machines said it.
fn on<T>(app: &AppHandle, session_id: &str, operation: &str, outcome: Result<T>) -> Result<T> {
    logging::call(operation, Some(&ssh::label_of(app, session_id)), outcome)
}

/// Opens a connection and an interactive shell. `sessionId` is chosen by the
/// UI so the tab it just created can subscribe to events before this returns.
#[tauri::command]
/// `window` is the webview that invoked this, which is how a session knows
/// where to send its output. Taking it as a parameter rather than looking it up
/// is what makes a session opened in its own window work without a
/// session-to-window map: whichever window connects, owns it.
pub async fn ssh_connect(
    app: AppHandle,
    window: tauri::Window,
    host_id: i64,
    session_id: String,
) -> Result<SessionInfo> {
    let host = {
        let db = app.state::<Db>();
        hosts::get(&db, host_id)?
    };
    let named = format!("connect {} ({}@{}:{})", host.name, host.user, host.address, host.port);
    let info = logging::call(
        &named,
        None,
        ssh::connect(app.clone(), host, session_id, window.label().to_string()).await,
    )?;

    // "Autostart: on session" means exactly this moment. Tunnels hold their own
    // connections, so this only decides *when* one comes up, not what it rides.
    crate::tunnels::autostart(&app, "session", Some(host_id));

    Ok(info)
}

/// Sends keystrokes. The bytes are base64 so control characters survive JSON.
#[tauri::command]
pub fn ssh_write(app: AppHandle, session_id: String, data: String) -> Result<()> {
    let session = ssh::session(&app, &session_id)?;
    let _ = session.input.send(ssh::decode_base64(&data));
    Ok(())
}

#[tauri::command]
pub fn ssh_resize(app: AppHandle, session_id: String, cols: u32, rows: u32) -> Result<()> {
    let session = ssh::session(&app, &session_id)?;
    let _ = session.resize.send((cols, rows));
    Ok(())
}

#[tauri::command]
pub async fn ssh_disconnect(app: AppHandle, session_id: String) -> Result<()> {
    let named = format!("disconnect {}", ssh::label_of(&app, &session_id));
    logging::call(&named, None, ssh::disconnect(&app, &session_id).await)
}

/// Types `cd <path>` at the session's shell — the SFTP pane taking the terminal
/// where it is looking.
///
/// Goes through the same queue as a keystroke, so `command_log` records it the
/// way it records anything else typed there. It is typing at the user's shell,
/// and the trail should say so rather than hide it.
#[tauri::command]
pub fn ssh_cd(app: AppHandle, session_id: String, path: String) -> Result<()> {
    on(&app, &session_id, &format!("cd {path}"), ssh::cd(&app, &session_id, &path))
}

/// The last directory this session's shell announced, or `None`.
///
/// Asked by the SFTP pane when it mounts, because a tab switch destroys and
/// rebuilds it and the announcements it missed are not repeated — a shell says
/// the same directory before every prompt, and only a change is emitted.
#[tauri::command]
pub fn ssh_cwd(app: AppHandle, session_id: String) -> Option<String> {
    let found = ssh::cwd(&app, &session_id);
    logging::debug(
        "cmd",
        "read the shell's directory",
        Some(&format!(
            "{} · {}",
            ssh::label_of(&app, &session_id),
            found.as_deref().unwrap_or("not announced")
        )),
    );
    found
}

/// The first listing after a pane opens is Portway's doing, not the user's —
/// hence the `system` flag the UI passes on that one call.
#[tauri::command]
pub async fn sftp_list(
    app: AppHandle,
    session_id: String,
    path: String,
    system: Option<bool>,
) -> Result<Listing> {
    let origin = if system.unwrap_or(false) { Origin::System } else { Origin::User };
    on(&app, &session_id, &format!("list {path}"), sftp::list(&app, &session_id, &path, origin).await)
}

/// The accounts and groups the Owner dialog offers. Read once per session by
/// the pane, not per dialog — it is two small files over an open connection,
/// but it is still a round trip.
#[tauri::command]
pub async fn sftp_principals(app: AppHandle, session_id: String) -> Result<sftp::Principals> {
    on(&app, &session_id, "read accounts", sftp::principals(&app, &session_id).await)
}

#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    session_id: String,
    remote: String,
    local: String,
) -> Result<u64> {
    on(&app, &session_id, &format!("download {remote}"), sftp::download(&app, &session_id, &remote, &local).await)
}

#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    session_id: String,
    local: String,
    remote: String,
) -> Result<u64> {
    on(&app, &session_id, &format!("upload {remote}"), sftp::upload(&app, &session_id, &local, &remote).await)
}

/// A dropped path — one file, or a directory and everything under it — into the
/// folder the pane is showing.
#[tauri::command]
pub async fn sftp_upload_path(
    app: AppHandle,
    session_id: String,
    local: String,
    remote_dir: String,
) -> Result<u64> {
    logging::call(
        &format!("upload {local} into {remote_dir}"),
        Some(&ssh::label_of(&app, &session_id)),
        sftp::upload_path(&app, &session_id, &local, &remote_dir).await,
    )
}

/// Rename, which on a remote filesystem is also move.
#[tauri::command]
pub async fn sftp_rename(
    app: AppHandle,
    session_id: String,
    from: String,
    to: String,
) -> Result<()> {
    on(&app, &session_id, &format!("rename {from} to {to}"), sftp::rename(&app, &session_id, &from, &to).await)
}

#[tauri::command]
pub async fn sftp_chmod(
    app: AppHandle,
    session_id: String,
    path: String,
    mode: u32,
) -> Result<()> {
    on(&app, &session_id, &format!("chmod {mode:o} {path}"), sftp::chmod(&app, &session_id, &path, mode).await)
}

/// Returns how many entries were changed, which is the only way the UI can say
/// what a recursive run actually did.
#[tauri::command]
pub async fn sftp_chown(
    app: AppHandle,
    session_id: String,
    path: String,
    uid: u32,
    gid: u32,
    recursive: bool,
) -> Result<u64> {
    on(&app, &session_id, &format!("chown {uid}:{gid} {path}"), sftp::chown(&app, &session_id, &path, uid, gid, recursive).await)
}

/// Downloads a file to a scratch copy, opens it in a local application and
/// watches it: saving there writes back to the server.
///
/// `opener` is a chosen application, or `None` for whatever the OS has
/// registered. `confirmed_large` is the user having seen the size warning.
/// `sudo` sends every write-back through root, and is decided here rather than
/// when a save fails — see `sftp::edit`.
#[tauri::command]
pub async fn sftp_edit(
    app: AppHandle,
    session_id: String,
    remote: String,
    opener: Option<String>,
    confirmed_large: bool,
    sudo: bool,
) -> Result<String> {
    on(
        &app,
        &session_id,
        &format!("edit {remote}"),
        sftp::edit(&app, &session_id, &remote, opener, confirmed_large, sudo).await,
    )
}

/// Re-sends the scratch copy of a file already open for editing, as root, and
/// keeps every save after it going the same way.
///
/// What the pane offers when a write-back was refused: the editor has already
/// written the file, and asking for it to be saved again is asking for
/// something that has already happened.
#[tauri::command]
pub async fn sftp_elevate(app: AppHandle, session_id: String, remote: String) -> Result<u64> {
    on(&app, &session_id, &format!("save {remote} as root"), sftp::elevate(&app, &session_id, &remote).await)
}

/// What `sudo` would do on this session, asked without doing anything and
/// without asking the user for anything.
///
/// A NOPASSWD host answers `ready` here, and never sees a password box.
#[tauri::command]
pub async fn sudo_check(app: AppHandle, session_id: String) -> Result<sudo::Check> {
    on(&app, &session_id, "check sudo", sudo::check(&app, &session_id).await)
}

/// Takes the account password, checks it against the host, and keeps it in
/// memory for the rest of the session. It is never written anywhere.
#[tauri::command]
pub async fn sudo_unlock(app: AppHandle, session_id: String, password: String) -> Result<()> {
    // Deliberately not `logged`: its message would be the operation and the
    // error, and the error here is about a password. `sudo::unlock` writes its
    // own line, with nothing in it that came from the box.
    //
    // There is no command to forget one on purpose, and that is not an
    // oversight: it is dropped when the host refuses it and when the session
    // closes, which are the two moments it stops being the right password. A
    // button for it would be a control over something the user cannot see.
    logging::call(
        &format!("unlock sudo on {}", ssh::label_of(&app, &session_id)),
        None,
        sudo::unlock(&app, &session_id, password).await,
    )
}

/// Deletes a file, or a directory and everything under it. Returns how many
/// entries went, which is the only way the UI can report what a recursive
/// delete actually did.
#[tauri::command]
pub async fn sftp_remove(
    app: AppHandle,
    session_id: String,
    path: String,
    is_dir: bool,
) -> Result<u64> {
    logging::call(
        &format!("delete {path}"),
        Some(&ssh::label_of(&app, &session_id)),
        sftp::remove(&app, &session_id, &path, is_dir).await,
    )
}

/// Hands a link to the browser.
///
/// Restricted to `https`, and deliberately. This is a process launcher exposed
/// to the webview: on macOS `open` will just as happily take a local path, a
/// `file://` URL or an application, so anything that could ever put a string
/// into this call could put one of those in instead. The app has exactly one
/// link and it is a web address.
///
/// No shell is involved — the URL is an argument, not a command line — so
/// quoting is not the concern here; what it points at is.
#[tauri::command]
pub fn open_url(url: String) -> Result<()> {
    if !url.starts_with("https://") {
        logging::warn("app", "refused to open a link", Some(&url));
        return Err(Error::Invalid(format!("refusing to open {url}")));
    }

    let mut command = if cfg!(target_os = "macos") {
        let mut c = std::process::Command::new("open");
        c.arg(&url);
        c
    } else if cfg!(target_os = "windows") {
        // The empty argument is `start`'s window title; without it `start`
        // reads the first quoted argument as the title and opens nothing.
        let mut c = std::process::Command::new("cmd");
        c.arg("/C").arg("start").arg("").arg(&url);
        c
    } else {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&url);
        c
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|e| Error::Invalid(format!("could not open {url}: {e}")))
}

/// The audit trail for one host, newest first.
#[tauri::command]
pub fn host_log(db: State<'_, Db>, host_id: i64, limit: Option<i64>) -> Result<Vec<LogEntry>> {
    let conn = db.0.lock().unwrap();
    audit::recent(&conn, host_id, limit.unwrap_or(50))
}

/// A second window, wearing the same chrome as the first.
///
/// Every option has to be repeated for each one. `tauri.macos.conf.json`
/// applies to `app.windows[0]` and nothing else, so a runtime window inherits
/// none of the traffic-light treatment and would otherwise open with a stock
/// frame in the middle of an app that has none. Said once here rather than at
/// each call site, because two copies of it would drift and the difference
/// would only show up as one window with a system titlebar.
///
/// Anything opened this way must also be named in `capabilities/default.json`.
/// A window that list does not name gets no `core:event` at all — it renders
/// perfectly and never receives a single thing the backend emits.
fn open_window(
    app: &AppHandle,
    label: &str,
    query: &str,
    title: &str,
    size: (f64, f64),
    minimum: (f64, f64),
) -> Result<()> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    let url = WebviewUrl::App(format!("index.html?{query}").into());
    let builder = WebviewWindowBuilder::new(app, label, url)
        .title(title)
        .inner_size(size.0, size.1)
        .min_inner_size(minimum.0, minimum.1)
        .background_color(tauri::window::Color(0x1b, 0x1e, 0x22, 0xff))
        .theme(Some(tauri::Theme::Dark))
        .center();

    #[cfg(target_os = "macos")]
    let builder = builder
        .decorations(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(14.0, 18.0));

    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false);

    builder
        .build()
        .map_err(|e| Error::Invalid(format!("could not open a window: {e}")))?;
    Ok(())
}

/// Raises a window that already exists. `true` when there was one.
fn raise(app: &AppHandle, label: &str) -> bool {
    match app.get_webview_window(label) {
        Some(window) => {
            let _ = window.unminimize();
            let _ = window.set_focus();
            true
        }
        None => false,
    }
}

/// Opens a session in a window of its own.
///
/// The window is created *empty* and connects for itself once it has booted:
/// `ssh_connect` records whichever window invoked it, so letting the new window
/// do the connecting is what makes its output arrive there rather than in the
/// window that asked for it.
#[tauri::command]
pub async fn open_session_window(app: AppHandle, host_id: i64, title: String) -> Result<()> {
    // One window per host: asking twice should raise the window that is already
    // showing that server rather than opening a second one onto the same box.
    let label = format!("session-{host_id}");
    if raise(&app, &label) {
        logging::debug("app", "raised an existing session window", Some(&label));
        return Ok(());
    }
    logging::info("app", "opening a session window", Some(&label));

    open_window(
        &app,
        &label,
        &format!("host={host_id}"),
        &title,
        (1320.0, 836.0),
        (820.0, 520.0),
    )
}

/// Opens the debug console, in a window of its own.
///
/// A window rather than a panel over the app, because the two things you want
/// it for both need it beside what it is describing: watching a connection go
/// through while you are looking at the terminal it is for, and putting it on a
/// second screen while something runs. An overlay hides the very thing you
/// opened it to explain.
///
/// One console for the whole app, not one per window — there is a single log,
/// and two views of it side by side would only be two copies of the same
/// stream. Asking again from anywhere raises the one that exists.
#[tauri::command]
pub async fn open_debug_window(app: AppHandle) -> Result<()> {
    if raise(&app, "debug") {
        return Ok(());
    }
    logging::info("app", "opening the debug console", None);

    open_window(
        &app,
        "debug",
        "debug=1",
        // The name it goes by in the Window menu, in Mission Control and on the
        // taskbar. The bar inside the window says it again with the log file
        // under it — the one place where "which log am I looking at" is
        // answerable at a glance.
        "Portway — Debug & logs",
        (1180.0, 760.0),
        (720.0, 420.0),
    )
}
