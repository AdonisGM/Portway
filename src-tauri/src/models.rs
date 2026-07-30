use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// A saved host.
///
/// Note what is *not* here: no password, no passphrase. The UI promises that
/// "credentials always live in the OS keychain; the app stores only
/// references", so the database keeps the auth *method* and the key path, and
/// nothing that would be a secret in plaintext. `keychain.rs` is where the
/// secret half will attach.
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
