//! Folders on this computer, for the "Chuyển tệp" screen: the same listing
//! shape as a server's, so both panes read alike. Paths go to the UI in the
//! pane form of paths.rs; on Windows "/" is the list of drives.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::error::{AppError, AppResult};
use crate::files::{check_name, Class, Entry, Kind, Listing};
use crate::paths::{expand_tilde, home_dir, ui_path};

fn secs(t: std::io::Result<std::time::SystemTime>) -> Option<u64> {
    t.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs())
}

fn kind_of(m: &std::fs::Metadata) -> Kind {
    let t = m.file_type();
    if t.is_symlink() {
        Kind::Link
    } else if t.is_dir() {
        Kind::Dir
    } else if t.is_file() {
        Kind::File
    } else {
        Kind::Other
    }
}

/// Owner, mode and access of one entry, the way this system has them.
struct Access {
    mode: u32,
    uid: Option<u32>,
    gid: Option<u32>,
    owner: Option<String>,
    class: Class,
    readable: bool,
    writable: bool,
}

#[cfg(unix)]
mod sys {
    use super::Access;
    use crate::files::Class;
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;
    use std::path::Path;

    /// What this process may do with a path, asked from the OS (covers ACLs).
    fn can(path: &Path, mode: libc::c_int) -> bool {
        let Ok(c) = CString::new(path.as_os_str().as_bytes()) else { return false };
        unsafe { libc::access(c.as_ptr(), mode) == 0 }
    }

    pub fn user_name() -> String {
        std::env::var("USER").unwrap_or_default()
    }

    pub fn access(path: &Path, m: &std::fs::Metadata, dir: bool, broken: bool, user: &str) -> Access {
        let me = unsafe { libc::getuid() };
        let x = if dir { libc::X_OK } else { 0 };
        Access {
            mode: m.mode() & 0o7777,
            uid: Some(m.uid()),
            gid: Some(m.gid()),
            owner: (m.uid() == me).then(|| user.to_string()),
            class: if me == 0 {
                Class::Root
            } else if m.uid() == me {
                Class::Owner
            } else {
                Class::Other
            },
            readable: !broken && can(path, libc::R_OK | x),
            writable: !broken && can(path, libc::W_OK | x),
        }
    }

    /// Protected system files stay out of the listing (never hidden on Unix).
    pub fn hidden_system(_m: &std::fs::Metadata) -> bool {
        false
    }
}

#[cfg(windows)]
mod sys {
    use super::Access;
    use crate::files::Class;
    use std::os::windows::fs::MetadataExt;
    use std::path::Path;

    const HIDDEN: u32 = 0x2;
    const SYSTEM: u32 = 0x4;

    pub fn user_name() -> String {
        std::env::var("USERNAME").unwrap_or_default()
    }

    /// Windows has no mode bits; they are made up from the read-only flag so the
    /// pane can show something familiar. Access is decided by ACLs, which only
    /// an attempt can tell: a folder that turns out unreadable is listed as
    /// `denied` when opened, and a failed write reports the error.
    pub fn access(_path: &Path, m: &std::fs::Metadata, dir: bool, broken: bool, user: &str) -> Access {
        let read_only = m.permissions().readonly();
        Access {
            mode: if dir {
                0o755
            } else if read_only {
                0o444
            } else {
                0o644
            },
            uid: None,
            gid: None,
            owner: Some(user.to_string()),
            class: Class::Owner,
            readable: !broken,
            // The read-only flag means nothing on folders.
            writable: !broken && (dir || !read_only),
        }
    }

    /// Files Explorer hides unless told otherwise (desktop.ini, $Recycle.Bin…).
    pub fn hidden_system(m: &std::fs::Metadata) -> bool {
        m.file_attributes() & (HIDDEN | SYSTEM) == HIDDEN | SYSTEM
    }

    /// The drive letters that exist, e.g. ['C', 'D'].
    pub fn drives() -> Vec<char> {
        let mask = unsafe { windows_sys::Win32::Storage::FileSystem::GetLogicalDrives() };
        (0..26u8).filter(|i| mask & (1 << i) != 0).map(|i| (b'A' + i) as char).collect()
    }
}

fn entry(path: &Path, name: String, user: &str) -> std::io::Result<Entry> {
    let m = std::fs::symlink_metadata(path)?;
    let kind = kind_of(&m);
    let target = if kind == Kind::Link { std::fs::metadata(path).ok() } else { None };
    let eff = target.as_ref().unwrap_or(&m);
    let broken = kind == Kind::Link && target.is_none();
    let a = sys::access(path, eff, eff.is_dir(), broken, user);
    Ok(Entry {
        name,
        path: ui_path(path),
        kind,
        target_kind: target.as_ref().map(kind_of),
        link_target: (kind == Kind::Link).then(|| std::fs::read_link(path).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()),
        size: m.len(),
        mtime: secs(m.modified()),
        atime: secs(m.accessed()),
        mode: a.mode,
        uid: a.uid,
        gid: a.gid,
        owner: a.owner,
        group: None,
        class: a.class,
        readable: a.readable,
        writable: a.writable,
    })
}

/// A folder entry made up for something that is not one (the drive list).
#[cfg_attr(not(windows), allow(dead_code))]
fn virtual_dir(name: &str, path: &str, user: &str, writable: bool) -> Entry {
    Entry {
        name: name.into(),
        path: path.into(),
        kind: Kind::Dir,
        target_kind: None,
        link_target: None,
        size: 0,
        mtime: None,
        atime: None,
        mode: 0o755,
        uid: None,
        gid: None,
        owner: Some(user.into()),
        group: None,
        class: Class::Owner,
        readable: true,
        writable,
    }
}

/// "/" on Windows: one folder per drive ("C:" → "/c").
#[cfg(windows)]
fn drive_list(user: String) -> Listing {
    let entries = sys::drives().into_iter().map(|d| virtual_dir(&format!("{d}:"), &format!("/{}", d.to_ascii_lowercase()), &user, true)).collect();
    Listing { path: "/".into(), dir: virtual_dir("/", "/", &user, false), entries, denied: false, user }
}

/// List a folder on this computer. An empty path or "~" is the home folder.
#[tauri::command]
pub fn local_list(path: String) -> AppResult<Listing> {
    let user = sys::user_name();
    #[cfg(windows)]
    if path.trim() == "/" {
        return Ok(drive_list(user));
    }
    let wanted = if path.trim().is_empty() { home_dir() } else { expand_tilde(path.trim()) };
    let canon: PathBuf = dunce::canonicalize(&wanted).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => AppError::detail("not_found", wanted.display()),
        std::io::ErrorKind::PermissionDenied => AppError::detail("permission_denied", wanted.display()),
        _ => AppError::detail("io", e),
    })?;
    if !canon.is_dir() {
        return Err(AppError::detail("not_a_dir", canon.display()));
    }
    let dir_name = canon.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| ui_path(&canon));
    let dir = entry(&canon, dir_name, &user)?;
    let path = ui_path(&canon);
    let read = match std::fs::read_dir(&canon) {
        Ok(r) => r,
        // macOS privacy (Desktop, Documents… until allowed), or an ACL on Windows.
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            return Ok(Listing { path, dir, entries: vec![], denied: true, user });
        }
        Err(e) => return Err(AppError::detail("io", e)),
    };
    let entries = read
        .flatten()
        .filter(|e| !e.metadata().is_ok_and(|m| sys::hidden_system(&m)))
        .filter_map(|e| entry(&e.path(), e.file_name().to_string_lossy().into_owned(), &user).ok())
        .collect();
    Ok(Listing { path, dir, entries, denied: false, user })
}

#[tauri::command]
pub fn local_mkdir(dir: String, name: String) -> AppResult<String> {
    check_name(&name)?;
    if !crate::transfers::safe_local_name(name.trim()) {
        return Err(AppError::new("invalid_name"));
    }
    let path = expand_tilde(&dir).join(name.trim());
    std::fs::create_dir(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => AppError::new("name_exists"),
        std::io::ErrorKind::PermissionDenied => AppError::detail("permission_denied", path.display()),
        _ => AppError::detail("io", e),
    })?;
    Ok(ui_path(&path))
}

/// Open a terminal in a folder on this computer: Terminal.app on macOS,
/// Windows Terminal (or PowerShell in a console window) on Windows.
#[tauri::command]
pub fn local_terminal(path: String) -> AppResult<()> {
    let dir = expand_tilde(&path);
    if !dir.is_dir() {
        return Err(AppError::detail("not_a_dir", &path));
    }
    open_terminal_in(&dir)
}

#[cfg(target_os = "macos")]
fn open_terminal_in(dir: &Path) -> AppResult<()> {
    let status = std::process::Command::new("open").arg("-a").arg("Terminal").arg(dir).status()?;
    if !status.success() {
        return Err(AppError::detail("io", format!("open exited with {status}")));
    }
    Ok(())
}

#[cfg(windows)]
fn open_terminal_in(dir: &Path) -> AppResult<()> {
    crate::winterm::open(dir)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn open_terminal_in(_dir: &Path) -> AppResult<()> {
    Err(AppError::detail("terminal", "no terminal on this system"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_a_folder() {
        let dir = std::env::temp_dir().join(format!("portway-local-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.txt"), "hello").unwrap();
        let l = local_list(ui_path(&dir)).unwrap();
        assert!(!l.denied);
        let a = l.entries.iter().find(|e| e.name == "a.txt").unwrap();
        assert_eq!((a.kind, a.size, a.readable, a.writable), (Kind::File, 5, true, true));
        assert_eq!(l.entries.iter().find(|e| e.name == "sub").unwrap().kind, Kind::Dir);
        assert!(l.dir.writable);
        assert!(l.path.starts_with('/'), "pane form: {}", l.path);
        assert_eq!(local_mkdir(l.path.clone(), "sub".into()).unwrap_err().code, "name_exists");
        std::fs::remove_dir_all(dir).ok();
    }
}
