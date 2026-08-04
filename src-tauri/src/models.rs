use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// A saved host.
///
/// Note what is *not* here: no password, no passphrase. The UI promises that
/// "credentials always live in the OS keychain; the app stores only
/// references", so the database keeps the auth *method* and the key path, and
/// nothing that would be a secret in plaintext. `keychain.rs` is where the
/// secret half attaches.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub id: i64,
    pub name: String,
    pub address: String,
    pub port: u16,
    pub user: String,
    pub group: String,
    pub auth: String,
    /// Only meaningful when `auth == "key"`.
    pub key_path: Option<String>,
    /// Name of another host to proxy through, or `None` for a direct connection.
    pub jump_host: Option<String>,
    pub run_on_connect: Option<String>,
    pub agent_forwarding: bool,
    pub keep_alive: bool,
    pub save_to_keychain: bool,
    pub unlock_via_keychain: bool,
    pub favorite: bool,
    /// Epoch ms, or `None` when the host has never been opened.
    pub last_used_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A value that must not reach a log, a `Debug` print or the database.
///
/// `HostInput` derives `Debug`, so a plain `String` passphrase would be one
/// `{:?}` away from appearing in a panic message or a future trace line. The
/// only way out of this type is `expose`, which is deliberately awkward to
/// read past in review.
#[derive(Clone, Deserialize)]
#[serde(transparent)]
pub struct Secret(String);

impl Secret {
    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(redacted)")
    }
}

/// What the form sends. `id` is absent — create assigns it, update takes it
/// separately — so the same shape serves both.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInput {
    pub name: String,
    pub address: String,
    pub port: u16,
    pub user: String,
    pub group: String,
    pub auth: String,
    pub key_path: Option<String>,
    pub jump_host: Option<String>,
    pub run_on_connect: Option<String>,
    pub agent_forwarding: bool,
    pub keep_alive: bool,
    pub save_to_keychain: bool,
    pub unlock_via_keychain: bool,
    #[serde(default)]
    pub favorite: bool,
    /// The key's passphrase, on its way to the OS keychain and nowhere else.
    ///
    /// Asymmetric on purpose: it arrives on the way in and never appears on
    /// `Host` on the way out, because nothing reads a secret back into the UI.
    /// `None` or empty means "leave whatever is stored alone" — the form cannot
    /// populate this field when editing, so an empty box is not a request to
    /// clear anything. Clearing is what `unlock_via_keychain: false` does.
    #[serde(default)]
    pub passphrase: Option<Secret>,
    /// The account password, travelling the same way and under the same rules,
    /// with `save_to_keychain` as its toggle instead.
    #[serde(default)]
    pub password: Option<Secret>,
}

const GROUPS: [&str; 4] = ["prod", "staging", "dev", "home"];
const AUTH_METHODS: [&str; 3] = ["password", "key", "agent"];

impl HostInput {
    /// Messages here surface directly in the form, so they name the field and
    /// say what is wrong rather than quoting a constraint.
    pub fn validate(&self) -> Result<()> {
        if self.name.trim().is_empty() {
            return Err(Error::Invalid("Label cannot be empty".into()));
        }
        if self.address.trim().is_empty() {
            return Err(Error::Invalid("Host cannot be empty".into()));
        }
        if self.user.trim().is_empty() {
            return Err(Error::Invalid("Username cannot be empty".into()));
        }
        if self.port == 0 {
            return Err(Error::Invalid("Port must be between 1 and 65535".into()));
        }
        if !GROUPS.contains(&self.group.as_str()) {
            return Err(Error::Invalid(format!("Unknown group '{}'", self.group)));
        }
        if !AUTH_METHODS.contains(&self.auth.as_str()) {
            return Err(Error::Invalid(format!(
                "Unknown auth method '{}'",
                self.auth
            )));
        }
        Ok(())
    }

    /// Trims the free-text fields and drops blanks to NULL, so the database
    /// never holds `""` where the rest of the app tests for absence.
    ///
    /// The two secrets are left exactly as typed. A password may legitimately
    /// begin or end with a space, and trimming one here would surface as the
    /// server rejecting a password the user is certain is right.
    pub fn normalized(mut self) -> Self {
        self.name = self.name.trim().to_string();
        self.address = self.address.trim().to_string();
        self.user = self.user.trim().to_string();
        self.key_path = blank_to_none(self.key_path);
        self.jump_host = blank_to_none(self.jump_host);
        self.run_on_connect = blank_to_none(self.run_on_connect);
        // A key path is only meaningful for key auth.
        if self.auth != "key" {
            self.key_path = None;
        }
        self
    }
}

fn blank_to_none(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty() && v != "—")
}

/// A saved port forward.
///
/// `via` is the host's label, joined in rather than looked up by the screen:
/// the Tunnels table can render before the host list has loaded, and a row that
/// says which server it goes through only sometimes is worse than one that
/// always does.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tunnel {
    pub id: i64,
    pub label: String,
    pub host_id: i64,
    pub via: String,
    pub kind: String,
    pub bind_address: String,
    pub bind_port: u16,
    /// `None` for a dynamic forward, which learns its destination per
    /// connection instead of being told one up front.
    pub target_host: Option<String>,
    pub target_port: Option<u16>,
    pub autostart: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelInput {
    pub label: String,
    pub host_id: i64,
    pub kind: String,
    pub bind_address: String,
    pub bind_port: u16,
    pub target_host: Option<String>,
    pub target_port: Option<u16>,
    pub autostart: String,
}

const TUNNEL_KINDS: [&str; 3] = ["local", "remote", "dynamic"];
const AUTOSTARTS: [&str; 3] = ["manual", "session", "launch"];

impl TunnelInput {
    pub fn validate(&self) -> Result<()> {
        if self.label.trim().is_empty() {
            return Err(Error::Invalid("Label cannot be empty".into()));
        }
        if !TUNNEL_KINDS.contains(&self.kind.as_str()) {
            return Err(Error::Invalid(format!("Unknown tunnel type '{}'", self.kind)));
        }
        if !AUTOSTARTS.contains(&self.autostart.as_str()) {
            return Err(Error::Invalid(format!(
                "Unknown autostart '{}'",
                self.autostart
            )));
        }
        if self.bind_address.trim().is_empty() {
            return Err(Error::Invalid("Bind address cannot be empty".into()));
        }
        if self.bind_port == 0 {
            return Err(Error::Invalid("Listen port must be between 1 and 65535".into()));
        }
        // A dynamic forward is told where to go by each client that connects,
        // so a destination here would be a field with nothing to do.
        if self.kind == "dynamic" {
            return Ok(());
        }
        match (self.target_host.as_deref().map(str::trim), self.target_port) {
            (Some(host), Some(port)) if !host.is_empty() && port != 0 => Ok(()),
            _ => Err(Error::Invalid(
                "A local or remote forward needs a destination host and port".into(),
            )),
        }
    }

    pub fn normalized(mut self) -> Self {
        self.label = self.label.trim().to_string();
        self.bind_address = self.bind_address.trim().to_string();
        self.target_host = blank_to_none(self.target_host);
        if self.kind == "dynamic" {
            self.target_host = None;
            self.target_port = None;
        }
        self
    }
}
