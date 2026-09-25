use serde::Serialize;
use std::fs;

use crate::paths::{contract_tilde, ssh_dir};

/// A private key in ~/.ssh, recognised by having a matching `.pub` next to it.
/// Portway never reads the private key itself.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SshKey {
    pub name: String,
    /// `~/.ssh/<name>`, the form stored on server accounts.
    pub path: String,
    /// ED25519, RSA, ECDSA… from the public key; None if it could not be read.
    pub kind: Option<String>,
    pub comment: Option<String>,
}

pub fn list_keys() -> Vec<SshKey> {
    let dir = ssh_dir();
    let Ok(entries) = fs::read_dir(&dir) else { return Vec::new() };
    let mut keys: Vec<SshKey> = entries
        .flatten()
        .filter_map(|entry| {
            let pub_path = entry.path();
            let name = pub_path.file_name()?.to_str()?.strip_suffix(".pub")?.to_string();
            let private = dir.join(&name);
            if !private.is_file() {
                return None;
            }
            let (kind, comment) = fs::read_to_string(&pub_path)
                .map(|text| parse_public_key(&text))
                .unwrap_or((None, None));
            Some(SshKey { name, path: contract_tilde(&private), kind, comment })
        })
        .collect();
    keys.sort_by(|a, b| a.name.cmp(&b.name));
    keys
}

/// Key type and comment from an OpenSSH public key line: `<type> <base64> [comment]`.
fn parse_public_key(text: &str) -> (Option<String>, Option<String>) {
    let mut parts = text.split_whitespace();
    let kind = parts.next().map(|t| {
        match t {
            "ssh-ed25519" => "ED25519",
            "ssh-rsa" => "RSA",
            "ssh-dss" => "DSA",
            "sk-ssh-ed25519@openssh.com" => "ED25519-SK",
            "sk-ecdsa-sha2-nistp256@openssh.com" => "ECDSA-SK",
            t if t.starts_with("ecdsa-sha2-") => "ECDSA",
            other => other,
        }
        .to_string()
    });
    let _blob = parts.next();
    let comment: Vec<&str> = parts.collect();
    let comment = (!comment.is_empty()).then(|| comment.join(" "));
    (kind, comment)
}

#[tauri::command]
pub fn ssh_keys_list() -> Vec<SshKey> {
    list_keys()
}

#[cfg(test)]
mod tests {
    use super::parse_public_key;

    #[test]
    fn reads_type_and_comment() {
        let (kind, comment) = parse_public_key("ssh-ed25519 AAAAC3Nz me@laptop\n");
        assert_eq!(kind.as_deref(), Some("ED25519"));
        assert_eq!(comment.as_deref(), Some("me@laptop"));

        let (kind, comment) = parse_public_key("ecdsa-sha2-nistp256 AAAA");
        assert_eq!(kind.as_deref(), Some("ECDSA"));
        assert_eq!(comment, None);
    }
}
