//! Saved server connections, persisted as JSON in the app data directory.
//! Nothing here touches the servers themselves; it is only the local list.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{AppError, AppResult};
use crate::keys::list_keys;
use crate::paths::{contract_tilde, expand_tilde};
use crate::ssh_config::{self, ConfigHost};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Auth {
    /// Private key file, stored as written by the user (usually `~/.ssh/...`).
    Key { path: String },
    /// Password kept in the OS keychain (asked on first connect).
    Password,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub user: String,
    pub auth: Auth,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub note: String,
    /// The first account is the default one.
    pub accounts: Vec<Account>,
    /// Detected on connect, e.g. "Ubuntu 24.04"; None until then.
    #[serde(default)]
    pub os: Option<String>,
    #[serde(default)]
    pub pinned: bool,
    pub created_at: u64,
    pub updated_at: u64,
}

/// What the add/edit form sends. `id` is None when adding.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInput {
    pub id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub note: String,
    pub accounts: Vec<Account>,
    #[serde(default)]
    pub pinned: Option<bool>,
}

#[derive(Serialize, Deserialize, Default)]
struct StoreFile {
    version: u32,
    servers: Vec<Server>,
}

pub struct ServerStore {
    path: PathBuf,
    servers: Mutex<Vec<Server>>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl ServerStore {
    pub fn load(path: PathBuf) -> AppResult<Self> {
        let servers = match fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str::<StoreFile>(&text)?.servers,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
        Ok(Self { path, servers: Mutex::new(servers) })
    }

    /// Write to a temp file and rename, so a crash never leaves a half-written list.
    fn persist(&self, servers: &[Server]) -> AppResult<()> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        let file = StoreFile { version: 1, servers: servers.to_vec() };
        fs::write(&tmp, serde_json::to_vec_pretty(&file)?)?;
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }

    pub fn list(&self) -> Vec<Server> {
        self.servers.lock().unwrap().clone()
    }

    pub fn save(&self, input: ServerInput) -> AppResult<Server> {
        let mut servers = self.servers.lock().unwrap();
        let input = normalize(input);
        validate(&input, &servers)?;
        let now = now_ms();
        let saved = match &input.id {
            Some(id) => {
                let existing = servers.iter_mut().find(|s| &s.id == id).ok_or_else(|| AppError::new("not_found"))?;
                existing.name = input.name;
                existing.host = input.host;
                existing.port = input.port;
                existing.group = input.group;
                existing.tags = input.tags;
                existing.note = input.note;
                existing.accounts = input.accounts;
                if let Some(p) = input.pinned {
                    existing.pinned = p;
                }
                existing.updated_at = now;
                existing.clone()
            }
            None => {
                let server = Server {
                    id: uuid::Uuid::new_v4().to_string(),
                    name: input.name,
                    host: input.host,
                    port: input.port,
                    group: input.group,
                    tags: input.tags,
                    note: input.note,
                    accounts: input.accounts,
                    os: None,
                    pinned: input.pinned.unwrap_or(false),
                    created_at: now,
                    updated_at: now,
                };
                servers.push(server.clone());
                server
            }
        };
        self.persist(&servers)?;
        Ok(saved)
    }

    /// Record the OS detected on connect; only writes when it changed.
    pub fn set_os(&self, id: &str, os: &str) -> AppResult<()> {
        let mut servers = self.servers.lock().unwrap();
        let Some(server) = servers.iter_mut().find(|s| s.id == id) else { return Ok(()) };
        if server.os.as_deref() == Some(os) {
            return Ok(());
        }
        server.os = Some(os.to_string());
        self.persist(&servers)
    }

    /// Pin or unpin a server.
    pub fn set_pinned(&self, id: &str, pinned: bool) -> AppResult<Server> {
        let mut servers = self.servers.lock().unwrap();
        let server = servers.iter_mut().find(|s| s.id == id).ok_or_else(|| AppError::new("not_found"))?;
        server.pinned = pinned;
        let saved = server.clone();
        self.persist(&servers)?;
        Ok(saved)
    }

    pub fn delete(&self, id: &str) -> AppResult<()> {
        let mut servers = self.servers.lock().unwrap();
        let before = servers.len();
        servers.retain(|s| s.id != id);
        if servers.len() == before {
            return Err(AppError::new("not_found"));
        }
        self.persist(&servers)
    }

    /// Add hosts that are not in the list yet. A host counts as present when a
    /// server has the same name, or the same host, port and a matching user.
    pub fn import(&self, hosts: Vec<ConfigHost>) -> AppResult<ImportReport> {
        let mut servers = self.servers.lock().unwrap();
        let found = hosts.len();
        let default_key = default_key_path();
        let fallback_user = std::env::var("USER").unwrap_or_else(|_| "root".into());
        let (mut added, mut skipped) = (Vec::new(), Vec::new());
        let now = now_ms();

        for h in hosts {
            let user = h.user.clone().unwrap_or_else(|| fallback_user.clone());
            let present = servers.iter().any(|s| {
                s.name.eq_ignore_ascii_case(&h.alias)
                    || (s.host.eq_ignore_ascii_case(&h.host_name) && s.port == h.port && s.accounts.iter().any(|a| a.user == user))
            });
            if present {
                skipped.push(h.alias);
                continue;
            }
            let auth = match h.identity_file.as_deref().or(default_key.as_deref()) {
                Some(path) => Auth::Key { path: contract_tilde(&expand_tilde(path)) },
                None => Auth::Password,
            };
            let server = Server {
                id: uuid::Uuid::new_v4().to_string(),
                name: h.alias,
                host: h.host_name,
                port: h.port,
                group: String::new(),
                tags: Vec::new(),
                note: String::new(),
                accounts: vec![Account { user, auth }],
                os: None,
                pinned: false,
                created_at: now,
                updated_at: now,
            };
            servers.push(server.clone());
            added.push(server);
        }
        if !added.is_empty() {
            self.persist(&servers)?;
        }
        Ok(ImportReport { found, added, skipped })
    }
}

/// Without an IdentityFile, ssh tries the default keys; pick the first that exists.
fn default_key_path() -> Option<String> {
    let keys = list_keys();
    ["id_ed25519", "id_ecdsa", "id_rsa"]
        .iter()
        .find_map(|name| keys.iter().find(|k| k.name == *name))
        .or(keys.first())
        .map(|k| k.path.clone())
}

fn normalize(mut input: ServerInput) -> ServerInput {
    input.name = input.name.trim().to_string();
    input.host = input.host.trim().to_string();
    input.group = input.group.trim().to_string();
    input.note = input.note.trim().to_string();
    let mut tags: Vec<String> = Vec::new();
    for t in input.tags.iter().map(|t| t.trim()).filter(|t| !t.is_empty()) {
        if !tags.iter().any(|x| x.eq_ignore_ascii_case(t)) {
            tags.push(t.to_string());
        }
    }
    input.tags = tags;
    for a in &mut input.accounts {
        a.user = a.user.trim().to_string();
    }
    input.accounts.retain(|a| !a.user.is_empty());
    input
}

fn validate(input: &ServerInput, servers: &[Server]) -> AppResult<()> {
    if input.name.is_empty() {
        return Err(AppError::field("required", "name"));
    }
    let taken = servers.iter().any(|s| Some(&s.id) != input.id.as_ref() && s.name.eq_ignore_ascii_case(&input.name));
    if taken {
        return Err(AppError::field("name_taken", "name"));
    }
    if input.host.is_empty() {
        return Err(AppError::field("required", "host"));
    }
    if input.host.contains(char::is_whitespace) {
        return Err(AppError::field("invalid_host", "host"));
    }
    if input.port == 0 {
        return Err(AppError::field("invalid_port", "port"));
    }
    if input.accounts.is_empty() {
        return Err(AppError::field("no_account", "accounts"));
    }
    for (i, a) in input.accounts.iter().enumerate() {
        if input.accounts[..i].iter().any(|b| b.user == a.user) {
            return Err(AppError { code: "duplicate_user", field: Some("accounts"), detail: Some(a.user.clone()) });
        }
        if let Auth::Key { path } = &a.auth {
            if path.trim().is_empty() {
                return Err(AppError::field("no_key", "accounts"));
            }
        }
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    /// Hosts found in the config (wildcards excluded).
    pub found: usize,
    pub added: Vec<Server>,
    /// Aliases already in Portway.
    pub skipped: Vec<String>,
}

#[tauri::command]
pub fn servers_list(store: tauri::State<ServerStore>) -> Vec<Server> {
    store.list()
}

#[tauri::command]
pub fn server_save(store: tauri::State<ServerStore>, input: ServerInput) -> AppResult<Server> {
    store.save(input)
}

#[tauri::command]
pub fn server_set_pinned(store: tauri::State<ServerStore>, id: String, pinned: bool) -> AppResult<Server> {
    store.set_pinned(&id, pinned)
}

#[tauri::command]
pub fn server_delete(store: tauri::State<ServerStore>, id: String) -> AppResult<()> {
    store.delete(&id)
}

#[tauri::command]
pub fn servers_import_ssh_config(store: tauri::State<ServerStore>) -> AppResult<ImportReport> {
    let hosts = ssh_config::read_default().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound { AppError::new("no_ssh_config") } else { e.into() }
    })?;
    store.import(hosts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store(name: &str) -> ServerStore {
        let path = std::env::temp_dir().join(format!("portway-test-{}-{}.json", name, std::process::id()));
        let _ = fs::remove_file(&path);
        ServerStore::load(path).unwrap()
    }

    fn input(name: &str, host: &str) -> ServerInput {
        ServerInput {
            id: None,
            name: name.into(),
            host: host.into(),
            port: 22,
            group: String::new(),
            tags: vec![" docker ".into(), "Docker".into(), "".into()],
            note: String::new(),
            accounts: vec![Account { user: " root ".into(), auth: Auth::Key { path: "~/.ssh/id_ed25519".into() } }],
            pinned: None,
        }
    }

    #[test]
    fn save_normalizes_and_persists() {
        let store = temp_store("save");
        let s = store.save(input(" web-01 ", "10.0.0.1")).unwrap();
        assert_eq!(s.name, "web-01");
        assert_eq!(s.tags, ["docker"]);
        assert_eq!(s.accounts[0].user, "root");

        let reloaded = ServerStore::load(store.path.clone()).unwrap();
        assert_eq!(reloaded.list().len(), 1);
        fs::remove_file(&store.path).ok();
    }

    #[test]
    fn rejects_duplicate_names_and_bad_input() {
        let store = temp_store("validate");
        store.save(input("web-01", "10.0.0.1")).unwrap();
        assert_eq!(store.save(input("WEB-01", "10.0.0.2")).unwrap_err().code, "name_taken");
        assert_eq!(store.save(input("", "10.0.0.2")).unwrap_err().code, "required");
        assert_eq!(store.save(input("x", "bad host")).unwrap_err().code, "invalid_host");
        let mut no_user = input("y", "10.0.0.3");
        no_user.accounts[0].user = "  ".into();
        assert_eq!(store.save(no_user).unwrap_err().code, "no_account");
        fs::remove_file(&store.path).ok();
    }

    #[test]
    fn import_skips_existing() {
        let store = temp_store("import");
        store.save(input("web-01", "10.0.0.1")).unwrap();
        let host = |alias: &str, name: &str| ConfigHost {
            alias: alias.into(),
            host_name: name.into(),
            port: 22,
            user: Some("root".into()),
            identity_file: Some("~/.ssh/id_ed25519".into()),
        };
        let report = store
            .import(vec![host("web-01", "1.1.1.1"), host("web-alias", "10.0.0.1"), host("new", "10.0.0.9")])
            .unwrap();
        assert_eq!(report.found, 3);
        assert_eq!(report.skipped, ["web-01", "web-alias"]);
        assert_eq!(report.added.len(), 1);
        assert_eq!(store.list().len(), 2);
        fs::remove_file(&store.path).ok();
    }
}
