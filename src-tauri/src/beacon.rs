//! Windows only. A small service that tells other machines this PC is on while
//! nobody has signed in yet, so that after a Wake-on-LAN the other machine can
//! see it came up and say "sign in to use Connect".
//!
//! This is all it can do. Connect's key lives in the signed-in user's
//! Credential Manager, which a service cannot read, and a service has no
//! clipboard or windows; so it announces over mDNS (same id, `s=login`) and
//! listens for nothing. Once somebody has signed in it stops announcing and
//! the app takes over.
//!
//! The same exe runs as the service (`--beacon-service`) and installs or
//! removes it (`--install-beacon`, `--uninstall-beacon`, started elevated).
//! The service runs from a copy in Program Files, never from the user's own
//! install folder, which the user can write to.

use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::System::RemoteDesktop::{WTSEnumerateSessionsW, WTSFreeMemory, WTSQuerySessionInformationW, WTSUserName, WTS_CURRENT_SERVER_HANDLE, WTS_SESSION_INFOW};
use windows_service::service::{ServiceAccess, ServiceControl, ServiceControlAccept, ServiceErrorControl, ServiceExitCode, ServiceInfo, ServiceStartType, ServiceState, ServiceStatus, ServiceType};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};
use windows_service::{define_windows_service, service_dispatcher};

const SERVICE_NAME: &str = "PortwayBeacon";
const SERVICE_ARG: &str = "--beacon-service";
const INSTALL_ARG: &str = "--install-beacon";
const UNINSTALL_ARG: &str = "--uninstall-beacon";
const FIREWALL_RULE: &str = "Portway Beacon";
const SERVICE_TYPE: ServiceType = ServiceType::OWN_PROCESS;
/// How often the service looks whether somebody has signed in.
const POLL: Duration = Duration::from_secs(3);
/// Starts no window: another process the exe would otherwise open.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// What the beacon announces: written by the app (whose identity it is) where the service can read it.
#[derive(Debug, Serialize, Deserialize)]
struct Identity {
    id: String,
    version: u32,
    port: u16,
}

fn data_dir() -> PathBuf {
    PathBuf::from(std::env::var_os("ProgramData").unwrap_or_else(|| OsString::from(r"C:\ProgramData"))).join("Portway")
}

fn identity_file() -> PathBuf {
    data_dir().join("beacon.json")
}

/// Let the beacon know who to announce as. Best effort: without the file it announces nothing.
pub fn publish_identity(id: &str, version: u32, port: u16) {
    let dir = data_dir();
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    if let Ok(json) = serde_json::to_vec(&Identity { id: id.to_string(), version, port }) {
        let _ = std::fs::write(identity_file(), json);
    }
}

/// Called first thing in `run`: when this process was started as the service
/// or to (un)install it, do that and end; otherwise return and start the app.
pub fn run_if_requested() {
    match std::env::args().nth(1).as_deref() {
        Some(SERVICE_ARG) => {
            let _ = service_dispatcher::start(SERVICE_NAME, ffi_service_main);
            std::process::exit(0);
        }
        Some(INSTALL_ARG) => std::process::exit(if install().is_ok() { 0 } else { 1 }),
        Some(UNINSTALL_ARG) => std::process::exit(if uninstall().is_ok() { 0 } else { 1 }),
        _ => {}
    }
}

define_windows_service!(ffi_service_main, service_main);

fn service_main(_args: Vec<OsString>) {
    let _ = run_service();
}

fn run_service() -> windows_service::Result<()> {
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let handler = move |event| match event {
        ServiceControl::Stop | ServiceControl::Shutdown => {
            let _ = stop_tx.send(());
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        _ => ServiceControlHandlerResult::NotImplemented,
    };
    let status = service_control_handler::register(SERVICE_NAME, handler)?;
    let report = |state: ServiceState, accepted: ServiceControlAccept| ServiceStatus {
        service_type: SERVICE_TYPE,
        current_state: state,
        controls_accepted: accepted,
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::default(),
        process_id: None,
    };
    status.set_service_status(report(ServiceState::Running, ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN))?;
    announce_until_stopped(&stop_rx);
    status.set_service_status(report(ServiceState::Stopped, ServiceControlAccept::empty()))
}

/// Announce while nobody is signed in; stop the moment somebody is.
fn announce_until_stopped(stop: &mpsc::Receiver<()>) {
    let mut daemon: Option<mdns_sd::ServiceDaemon> = None;
    loop {
        let wanted = !somebody_signed_in();
        match (wanted, daemon.is_some()) {
            (true, false) => daemon = start_announcing(),
            (false, true) => {
                if let Some(d) = daemon.take() {
                    let _ = d.shutdown();
                }
            }
            _ => {}
        }
        match stop.recv_timeout(POLL) {
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            _ => break,
        }
    }
    if let Some(d) = daemon {
        let _ = d.shutdown();
    }
}

fn start_announcing() -> Option<mdns_sd::ServiceDaemon> {
    let who: Identity = serde_json::from_slice(&std::fs::read(identity_file()).ok()?).ok()?;
    let daemon = mdns_sd::ServiceDaemon::new().ok()?;
    let version = who.version.to_string();
    let props = [("id", who.id.as_str()), ("v", version.as_str()), ("s", "login")];
    let host = format!("portway-{}.local.", who.id);
    let info = mdns_sd::ServiceInfo::new("_portway._tcp.local.", &who.id, &host, "", who.port, &props[..]).ok()?.enable_addr_auto();
    daemon.register(info).ok()?;
    Some(daemon)
}

/// Some session has a user in it, at the console or over Remote Desktop.
fn somebody_signed_in() -> bool {
    // SAFETY: the list and each name are Windows-allocated buffers, read within the counts they come with and freed after.
    unsafe {
        let mut sessions: *mut WTS_SESSION_INFOW = std::ptr::null_mut();
        let mut count = 0u32;
        if WTSEnumerateSessionsW(Some(WTS_CURRENT_SERVER_HANDLE), 0, 1, &mut sessions, &mut count).is_err() {
            // Cannot tell: better to stay quiet than to announce over a running app.
            return true;
        }
        let mut found = false;
        for i in 0..count as usize {
            let id = (*sessions.add(i)).SessionId;
            let mut name = PWSTR::null();
            let mut bytes = 0u32;
            if WTSQuerySessionInformationW(Some(WTS_CURRENT_SERVER_HANDLE), id, WTSUserName, &mut name, &mut bytes).is_ok() {
                if !name.is_null() && !name.as_wide().is_empty() {
                    found = true;
                }
                WTSFreeMemory(name.0 as *mut _);
            }
            if found {
                break;
            }
        }
        WTSFreeMemory(sessions as *mut _);
        found
    }
}

// -- installing -------------------------------------------------------------

fn install_dir() -> PathBuf {
    PathBuf::from(std::env::var_os("ProgramFiles").unwrap_or_else(|| OsString::from(r"C:\Program Files"))).join("Portway Beacon")
}

fn netsh(args: &[&str]) {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("netsh").args(args).creation_flags(CREATE_NO_WINDOW).status();
}

/// Run elevated: copy the exe, register the service, open the firewall for mDNS, start it.
fn install() -> Result<(), String> {
    let source = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = install_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let target = dir.join("portway-beacon.exe");
    // An older copy may be running from there: stop it so it can be replaced.
    let _ = stop_and_delete();
    std::fs::copy(&source, &target).map_err(|e| e.to_string())?;

    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE).map_err(|e| e.to_string())?;
    let info = ServiceInfo {
        name: OsString::from(SERVICE_NAME),
        display_name: OsString::from("Portway Beacon"),
        service_type: SERVICE_TYPE,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: target.clone(),
        launch_arguments: vec![OsString::from(SERVICE_ARG)],
        dependencies: vec![],
        account_name: Some(OsString::from(r"NT AUTHORITY\LocalService")),
        account_password: None,
    };
    let service = manager.create_service(&info, ServiceAccess::CHANGE_CONFIG | ServiceAccess::START).map_err(|e| e.to_string())?;
    let _ = service.set_description("Tells other Portway machines this PC is on while nobody has signed in yet.");
    // A service cannot answer a firewall prompt: allow mDNS in for this program ahead of time.
    netsh(&["advfirewall", "firewall", "delete", "rule", &format!("name={FIREWALL_RULE}")]);
    netsh(&["advfirewall", "firewall", "add", "rule", &format!("name={FIREWALL_RULE}"), "dir=in", "action=allow", &format!("program={}", target.display()), "protocol=UDP", "localport=5353"]);
    service.start::<OsString>(&[]).map_err(|e| e.to_string())?;
    Ok(())
}

fn stop_and_delete() -> Result<(), String> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT).map_err(|e| e.to_string())?;
    let service = manager.open_service(SERVICE_NAME, ServiceAccess::STOP | ServiceAccess::DELETE | ServiceAccess::QUERY_STATUS).map_err(|e| e.to_string())?;
    if service.query_status().map(|s| s.current_state != ServiceState::Stopped).unwrap_or(false) {
        let _ = service.stop();
        for _ in 0..50 {
            if service.query_status().map(|s| s.current_state == ServiceState::Stopped).unwrap_or(true) {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    service.delete().map_err(|e| e.to_string())
}

/// Run elevated: undo `install`.
fn uninstall() -> Result<(), String> {
    let removed = stop_and_delete();
    netsh(&["advfirewall", "firewall", "delete", "rule", &format!("name={FIREWALL_RULE}")]);
    let _ = std::fs::remove_dir_all(install_dir());
    // Not being installed is as good as being removed.
    removed.or_else(|e| if installed() { Err(e) } else { Ok(()) })
}

// -- asking from the app ------------------------------------------------------

fn installed() -> bool {
    state().installed
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeaconState {
    /// Only Windows has it.
    pub supported: bool,
    pub installed: bool,
    pub running: bool,
}

pub fn state() -> BeaconState {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT);
    let service = manager.ok().and_then(|m| m.open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS).ok());
    match service {
        Some(s) => BeaconState { supported: true, installed: true, running: s.query_status().map(|st| st.current_state == ServiceState::Running).unwrap_or(false) },
        None => BeaconState { supported: true, installed: false, running: false },
    }
}

/// Install or remove the service, asking Windows for the administrator's
/// permission (the UAC prompt) by starting this exe again, elevated.
pub fn set_installed(on: bool) -> Result<BeaconState, String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE};
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let wide = |s: &str| -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() };
    let (verb, file, args) = (wide("runas"), wide(&exe.to_string_lossy()), wide(if on { INSTALL_ARG } else { UNINSTALL_ARG }));
    // SAFETY: the strings outlive the call; the process handle it returns is waited on and closed here.
    unsafe {
        let mut info = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS,
            lpVerb: PCWSTR(verb.as_ptr()),
            lpFile: PCWSTR(file.as_ptr()),
            lpParameters: PCWSTR(args.as_ptr()),
            nShow: 0,
            ..Default::default()
        };
        // Declined at the prompt (or no right to ask): an error here.
        ShellExecuteExW(&mut info).map_err(|_| "declined".to_string())?;
        let process = info.hProcess;
        WaitForSingleObject(process, INFINITE);
        let mut code = 1u32;
        let _ = GetExitCodeProcess(process, &mut code);
        let _ = CloseHandle(process);
        if code != 0 {
            return Err("failed".into());
        }
    }
    Ok(state())
}
