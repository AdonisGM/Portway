//! Folders on this Mac, for the "Chuyển tệp" screen: the same listing shape
//! as a server's, so both panes read alike.

use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::error::{AppError, AppResult};
use crate::files::{check_name, Class, Entry, Kind, Listing};
use crate::paths::{expand_tilde, home_dir};

/// What this process may do with a path, asked from the OS (covers ACLs).
fn can(path: &Path, mode: libc::c_int) -> bool {
    let Ok(c) = CString::new(path.as_os_str().as_bytes()) else { return false };
    unsafe { libc::access(c.as_ptr(), mode) == 0 }
}

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

fn entry(path: &Path, name: String, me: u32, user: &str) -> std::io::Result<Entry> {
    let m = std::fs::symlink_metadata(path)?;
    let kind = kind_of(&m);
    let target = if kind == Kind::Link { std::fs::metadata(path).ok() } else { None };
    let eff = target.as_ref().unwrap_or(&m);
    let dir = eff.is_dir();
    let x = if dir { libc::X_OK } else { 0 };
    let broken = kind == Kind::Link && target.is_none();
    Ok(Entry {
        name,
        path: path.to_string_lossy().into_owned(),
        kind,
        target_kind: target.as_ref().map(kind_of),
        link_target: (kind == Kind::Link).then(|| std::fs::read_link(path).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()),
        size: m.len(),
        mtime: secs(m.modified()),
        atime: secs(m.accessed()),
        mode: m.mode() & 0o7777,
        uid: Some(m.uid()),
        gid: Some(m.gid()),
        owner: (m.uid() == me).then(|| user.to_string()),
        group: None,
        class: if me == 0 {
            Class::Root
        } else if m.uid() == me {
            Class::Owner
        } else {
            Class::Other
        },
        readable: !broken && can(path, libc::R_OK | x),
        writable: !broken && can(path, libc::W_OK | x),
    })
}

fn user_name() -> String {
    std::env::var("USER").unwrap_or_default()
}

/// List a folder on this Mac. An empty path or "~" is the home folder.
#[tauri::command]
pub fn local_list(path: String) -> AppResult<Listing> {
    let wanted = if path.trim().is_empty() { home_dir() } else { expand_tilde(path.trim()) };
    let canon: PathBuf = std::fs::canonicalize(&wanted).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => AppError::detail("not_found", wanted.display()),
        std::io::ErrorKind::PermissionDenied => AppError::detail("permission_denied", wanted.display()),
        _ => AppError::detail("io", e),
    })?;
    if !canon.is_dir() {
        return Err(AppError::detail("not_a_dir", canon.display()));
    }
    let me = unsafe { libc::getuid() };
    let user = user_name();
    let dir_name = canon.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "/".into());
    let dir = entry(&canon, dir_name, me, &user)?;
    let path = canon.to_string_lossy().into_owned();
    let read = match std::fs::read_dir(&canon) {
        Ok(r) => r,
        // macOS privacy: Desktop, Documents… until the user allows it.
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            return Ok(Listing { path, dir, entries: vec![], denied: true, user });
        }
        Err(e) => return Err(AppError::detail("io", e)),
    };
    let entries = read
        .flatten()
        .filter_map(|e| entry(&e.path(), e.file_name().to_string_lossy().into_owned(), me, &user).ok())
        .collect();
    Ok(Listing { path, dir, entries, denied: false, user })
}

#[tauri::command]
pub fn local_mkdir(dir: String, name: String) -> AppResult<String> {
    check_name(&name)?;
    let path = expand_tilde(&dir).join(name.trim());
    std::fs::create_dir(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => AppError::new("name_exists"),
        std::io::ErrorKind::PermissionDenied => AppError::detail("permission_denied", path.display()),
        _ => AppError::detail("io", e),
    })?;
    Ok(path.to_string_lossy().into_owned())
}

/// Open Terminal.app in a folder on this Mac.
#[tauri::command]
pub fn local_terminal(path: String) -> AppResult<()> {
    let dir = expand_tilde(&path);
    if !dir.is_dir() {
        return Err(AppError::detail("not_a_dir", &path));
    }
    let status = std::process::Command::new("open").arg("-a").arg("Terminal").arg(&dir).status()?;
    if !status.success() {
        return Err(AppError::detail("io", format!("open exited with {status}")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_a_folder() {
        let dir = std::env::temp_dir().join(format!("portway-local-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.txt"), "hello").unwrap();
        let l = local_list(dir.to_string_lossy().into_owned()).unwrap();
        assert!(!l.denied);
        let a = l.entries.iter().find(|e| e.name == "a.txt").unwrap();
        assert_eq!((a.kind, a.size, a.readable, a.writable), (Kind::File, 5, true, true));
        assert_eq!(l.entries.iter().find(|e| e.name == "sub").unwrap().kind, Kind::Dir);
        assert!(l.dir.writable);
        assert_eq!(local_mkdir(l.path.clone(), "sub".into()).unwrap_err().code, "name_exists");
        std::fs::remove_dir_all(dir).ok();
    }
}
