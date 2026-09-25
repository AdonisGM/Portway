use std::path::{Path, PathBuf};

pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

pub fn ssh_dir() -> PathBuf {
    home_dir().join(".ssh")
}

/// Expand a leading `~/` to the home directory.
pub fn expand_tilde(path: &str) -> PathBuf {
    match path.strip_prefix("~/") {
        Some(rest) => home_dir().join(rest),
        None if path == "~" => home_dir(),
        None => PathBuf::from(path),
    }
}

/// Show a path under the home directory as `~/...`, the way users write it.
pub fn contract_tilde(path: &Path) -> String {
    match path.strip_prefix(home_dir()) {
        Ok(rest) => format!("~/{}", rest.display()),
        Err(_) => path.display().to_string(),
    }
}
