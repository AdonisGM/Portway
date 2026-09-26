//! Log of what Portway did on servers on the user's behalf (connect, trust a
//! host key, sudo, open a terminal…). Commands typed in a terminal are not in it.
//! Stored as JSON lines in the app data directory.

use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const KEEP: usize = 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: String,
    /// ms since epoch
    pub at: u64,
    pub server_id: String,
    pub user: String,
    /// Stable code: connect, reconnect, disconnect, trustHostKey, openTerminal, sudoOn, sudoOff.
    pub action: String,
    /// The command or change, as the user would read it.
    pub command: String,
    pub ok: bool,
    /// Error text, or extra facts about the result.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Cheap to clone; clones share the same log.
#[derive(Clone)]
pub struct AuditLog {
    path: Arc<PathBuf>,
    entries: Arc<Mutex<Vec<AuditEntry>>>,
}

impl AuditLog {
    pub fn load(path: PathBuf) -> Self {
        let mut entries: Vec<AuditEntry> = fs::read_to_string(&path)
            .map(|t| t.lines().filter_map(|l| serde_json::from_str(l).ok()).collect())
            .unwrap_or_default();
        if entries.len() > KEEP {
            entries.drain(..entries.len() - KEEP);
            let text: String = entries.iter().filter_map(|e| serde_json::to_string(e).ok()).map(|l| l + "\n").collect();
            let _ = fs::write(&path, text);
        }
        Self { path: Arc::new(path), entries: Arc::new(Mutex::new(entries)) }
    }

    pub fn record(&self, server_id: &str, user: &str, action: &str, command: impl Into<String>, ok: bool, detail: Option<String>) {
        let entry = AuditEntry {
            id: uuid::Uuid::new_v4().to_string(),
            at: SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0),
            server_id: server_id.to_string(),
            user: user.to_string(),
            action: action.to_string(),
            command: command.into(),
            ok,
            detail,
        };
        if let Some(dir) = self.path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let (Ok(mut f), Ok(line)) = (OpenOptions::new().create(true).append(true).open(self.path.as_ref()), serde_json::to_string(&entry)) {
            let _ = writeln!(f, "{line}");
        }
        let mut entries = self.entries.lock().unwrap();
        entries.push(entry);
        if entries.len() > KEEP * 2 {
            let cut = entries.len() - KEEP;
            entries.drain(..cut);
        }
    }

    pub fn list(&self, server_id: Option<&str>, limit: usize) -> Vec<AuditEntry> {
        self.entries
            .lock()
            .unwrap()
            .iter()
            .rev()
            .filter(|e| server_id.is_none_or(|s| e.server_id == s))
            .take(limit)
            .cloned()
            .collect()
    }
}

#[tauri::command]
pub fn audit_list(log: tauri::State<AuditLog>, server_id: Option<String>, limit: Option<usize>) -> Vec<AuditEntry> {
    log.list(server_id.as_deref(), limit.unwrap_or(50))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_newest_first_and_survives_reload() {
        let path = std::env::temp_dir().join(format!("portway-audit-{}.jsonl", std::process::id()));
        let _ = fs::remove_file(&path);
        let log = AuditLog::load(path.clone());
        log.record("a", "root", "connect", "ssh root@a", true, None);
        log.record("b", "root", "connect", "ssh root@b", false, Some("refused".into()));
        log.record("a", "root", "disconnect", "exit", true, None);
        let a: Vec<_> = log.list(Some("a"), 10).into_iter().map(|e| e.action).collect();
        assert_eq!(a, ["disconnect", "connect"]);
        let reloaded = AuditLog::load(path.clone());
        assert_eq!(reloaded.list(None, 10).len(), 3);
        assert_eq!(reloaded.list(Some("b"), 10)[0].detail.as_deref(), Some("refused"));
        fs::remove_file(path).ok();
    }
}
