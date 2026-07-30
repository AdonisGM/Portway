use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

use serde::Serialize;

use crate::error::Result;

/// One private key found in `~/.ssh`.
///
/// Deliberately not `models::SshKey`-shaped: the mock the Keys screen renders
/// carries a fingerprint, a "used by" count and an added date, none of which a
/// directory scan can produce without parsing key material. This carries only
/// what the form needs to fill its field, plus the type when it is free.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyFile {
    pub name: String,
    /// Written back in `~/` form, which is what the field displays and what
    /// `ssh::expand_home` reads.
    pub path: String,
    /// `ed25519`, `rsa`, … or `None` when there is no readable `.pub` beside it.
    pub kind: Option<String>,
}

/// Private keys have no extension and no fixed name, so the only honest test is
/// the file's own header. Reading a fixed prefix keeps this cheap and means a
/// stray binary in `~/.ssh` is rejected rather than sniffed in full.
const HEADER_BYTES: usize = 64;

fn is_private_key(path: &Path) -> bool {
    let Ok(mut file) = File::open(path) else { return false };
    let mut head = [0u8; HEADER_BYTES];
    let Ok(n) = file.read(&mut head) else { return false };

    let head = String::from_utf8_lossy(&head[..n]);
    // Covers OPENSSH, RSA, EC, DSA and PKCS#8 — every form `load_secret_key`
    // accepts writes "PRIVATE KEY" into the first line.
    head.starts_with("-----BEGIN") && head.contains("PRIVATE KEY")
}

/// The algorithm, taken from the companion `<name>.pub` rather than the private
/// key: an OpenSSH-format private key names no algorithm in its header, and the
/// public half states it in the clear as its first field.
fn kind_from_pub(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path.with_extension("pub")).ok()?;
    let algo = text.split_whitespace().next()?;
    Some(match algo {
        "ssh-ed25519" => "ed25519".into(),
        "ssh-rsa" => "rsa".into(),
        "ssh-dss" => "dsa".into(),
        other if other.starts_with("ecdsa-") => "ecdsa".into(),
        other if other.starts_with("sk-") => "hardware".into(),
        other => other.to_string(),
    })
}

/// Every private key in `~/.ssh`, for the form's "From SSH Keys" picker.
///
/// Never returns key material — name, display path and algorithm only. An
/// unreadable entry is skipped rather than failing the whole listing, and a
/// missing `~/.ssh` is an empty list, not an error: neither is something the
/// user can act on from a picker.
#[tauri::command]
pub fn list_ssh_keys() -> Result<Vec<KeyFile>> {
    let Some(dir) = dirs::home_dir().map(|h| h.join(".ssh")) else {
        return Ok(Vec::new());
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };

    let mut keys: Vec<KeyFile> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter(|e| is_private_key(&e.path()))
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            Some(KeyFile {
                path: format!("~/.ssh/{name}"),
                kind: kind_from_pub(&e.path()),
                name,
            })
        })
        .collect();

    keys.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(keys)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(dir: &Path, name: &str, body: &str) -> std::path::PathBuf {
        let path = dir.join(name);
        File::create(&path).unwrap().write_all(body.as_bytes()).unwrap();
        path
    }

    #[test]
    fn accepts_every_private_key_header_russh_can_load() {
        let dir = std::env::temp_dir().join("portway-keys-accept");
        fs::create_dir_all(&dir).unwrap();
        for (name, header) in [
            ("openssh", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n"),
            ("rsa", "-----BEGIN RSA PRIVATE KEY-----\nabc\n"),
            ("ec", "-----BEGIN EC PRIVATE KEY-----\nabc\n"),
            ("pkcs8", "-----BEGIN PRIVATE KEY-----\nabc\n"),
        ] {
            assert!(is_private_key(&write(&dir, name, header)), "{name}");
        }
        fs::remove_dir_all(&dir).ok();
    }

    /// The files that sit beside the keys are the whole reason this sniffs
    /// content instead of filtering names.
    #[test]
    fn rejects_the_rest_of_the_ssh_directory() {
        let dir = std::env::temp_dir().join("portway-keys-reject");
        fs::create_dir_all(&dir).unwrap();
        for (name, body) in [
            ("config", "Host *\n  AddKeysToAgent yes\n"),
            ("known_hosts", "github.com ssh-ed25519 AAAAC3Nz\n"),
            ("id_ed25519.pub", "ssh-ed25519 AAAAC3Nz user@host\n"),
            ("authorized_keys", "ssh-rsa AAAAB3Nz user@host\n"),
        ] {
            assert!(!is_private_key(&write(&dir, name, body)), "{name}");
        }
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reads_the_algorithm_from_the_public_half() {
        let dir = std::env::temp_dir().join("portway-keys-kind");
        fs::create_dir_all(&dir).unwrap();
        let key = write(&dir, "id_ed25519", "-----BEGIN OPENSSH PRIVATE KEY-----\n");
        write(&dir, "id_ed25519.pub", "ssh-ed25519 AAAAC3Nz user@host\n");
        assert_eq!(kind_from_pub(&key).as_deref(), Some("ed25519"));

        // A key with no .pub beside it is listed, just without a type.
        let bare = write(&dir, "id_bare", "-----BEGIN OPENSSH PRIVATE KEY-----\n");
        assert_eq!(kind_from_pub(&bare), None);
        fs::remove_dir_all(&dir).ok();
    }
}
