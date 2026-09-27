//! Local paths: the home folder, `~`, and on Windows the "/c/Users/x" form
//! the file panes use, so the UI handles one kind of path (slash-separated,
//! rooted at "/") on every system. On Windows "/" itself is the list of drives.

use std::path::{Path, PathBuf};

pub fn home_dir() -> PathBuf {
    // Git Bash sets HOME to "/c/Users/x"; USERPROFILE is the real one.
    #[cfg(windows)]
    let var = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    #[cfg(not(windows))]
    let var = std::env::var_os("HOME");
    var.filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "C:\\" } else { "/" }))
}

pub fn ssh_dir() -> PathBuf {
    home_dir().join(".ssh")
}

/// A local path from the UI or a setting: `~`, `~/x`, a native path, or on
/// Windows the pane form "/c/Users/x".
pub fn expand_tilde(path: &str) -> PathBuf {
    if path == "~" {
        return home_dir();
    }
    if let Some(rest) = path.strip_prefix("~/").or_else(|| if cfg!(windows) { path.strip_prefix("~\\") } else { None }) {
        return home_dir().join(rest);
    }
    #[cfg(windows)]
    if let Some(native) = pane_to_native(path) {
        return PathBuf::from(native);
    }
    PathBuf::from(path)
}

/// A local path as the file panes show it: "/c/Users/x" on Windows, as is elsewhere.
#[cfg(windows)]
pub fn ui_path(path: &Path) -> String {
    native_to_pane(&path.to_string_lossy())
}

#[cfg(not(windows))]
pub fn ui_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Show a path under the home directory as `~/...`, the way users write it.
pub fn contract_tilde(path: &Path) -> String {
    match path.strip_prefix(home_dir()) {
        Ok(rest) if rest.as_os_str().is_empty() => "~".into(),
        Ok(rest) => format!("~/{}", slashes(&rest.to_string_lossy())),
        Err(_) => path.display().to_string(),
    }
}

/// Backslashes are separators only on Windows; elsewhere they are part of a name.
fn slashes(s: &str) -> String {
    if cfg!(windows) {
        s.replace('\\', "/")
    } else {
        s.to_string()
    }
}

/// "/c/Users/x" → "C:\Users\x", "/d" → "D:\". None for anything else.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn pane_to_native(path: &str) -> Option<String> {
    let rest = path.strip_prefix('/')?;
    let mut chars = rest.chars();
    let drive = chars.next().filter(|c| c.is_ascii_alphabetic())?;
    let tail = chars.as_str();
    if !(tail.is_empty() || tail.starts_with('/')) {
        return None;
    }
    let tail = tail.trim_start_matches('/').trim_end_matches('/');
    Some(format!("{}:\\{}", drive.to_ascii_uppercase(), tail.replace('/', "\\")))
}

/// "C:\Users\x" (or "C:/Users/x") → "/c/Users/x", "D:\" → "/d". Other paths
/// (UNC shares) only get forward slashes.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn native_to_pane(path: &str) -> String {
    let p = path.strip_prefix(r"\\?\").unwrap_or(path).replace('\\', "/");
    let b = p.as_bytes();
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b.len() == 2 || b[2] == b'/') {
        let tail = p[2..].trim_matches('/');
        let drive = (b[0] as char).to_ascii_lowercase();
        return if tail.is_empty() { format!("/{drive}") } else { format!("/{drive}/{tail}") };
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_windows_paths_both_ways() {
        assert_eq!(native_to_pane(r"C:\Users\Tung\Downloads"), "/c/Users/Tung/Downloads");
        assert_eq!(native_to_pane(r"C:\"), "/c");
        assert_eq!(native_to_pane("D:"), "/d");
        assert_eq!(native_to_pane("C:/Program Files/"), "/c/Program Files");
        assert_eq!(native_to_pane(r"\\?\C:\Users"), "/c/Users");
        assert_eq!(native_to_pane(r"\\nas\share\x"), "//nas/share/x");

        assert_eq!(pane_to_native("/c/Users/Tung/Downloads").as_deref(), Some(r"C:\Users\Tung\Downloads"));
        assert_eq!(pane_to_native("/d").as_deref(), Some(r"D:\"));
        assert_eq!(pane_to_native("/c/").as_deref(), Some(r"C:\"));
        assert_eq!(pane_to_native("/c/Program Files/x y").as_deref(), Some(r"C:\Program Files\x y"));
        // Not the pane form: a plain Unix-looking path, the drive list, a relative name.
        assert_eq!(pane_to_native("/Users/x"), None);
        assert_eq!(pane_to_native("/"), None);
        assert_eq!(pane_to_native("c/x"), None);
        assert_eq!(pane_to_native("/1/x"), None);

        for p in ["/c/Users/Tung", "/e", "/c/a b/c"] {
            assert_eq!(native_to_pane(&pane_to_native(p).unwrap()), p);
        }
    }

    #[test]
    fn tilde_round_trip() {
        let home = home_dir();
        assert_eq!(expand_tilde("~"), home);
        assert_eq!(expand_tilde("~/.ssh/id"), home.join(".ssh/id"));
        assert_eq!(contract_tilde(&home), "~");
        assert_eq!(contract_tilde(&home.join("Downloads")), "~/Downloads");
    }
}
