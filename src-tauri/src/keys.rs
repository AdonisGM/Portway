use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

use russh::keys::{HashAlg, PublicKey};
use serde::Serialize;
use tauri::State;

use crate::db::Db;
use crate::error::{Error, Result};
use crate::ssh::expand_home;

/// One private key found in `~/.ssh`.
///
/// Everything here is read from the *public* half or from the filesystem entry.
/// The private key is never opened: it may be encrypted, and the Keys screen
/// promises that private keys do not leave the machine — reading their material
/// to fill a column would be a strange way to honour that.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyFile {
    pub name: String,
    /// In `~/` form, matching what the form's field shows and what the backend
    /// expands on connect.
    pub path: String,
    /// `ed25519`, `rsa 4096`, … or `None` when there is no readable `.pub`.
    pub kind: Option<String>,
    /// `SHA256:…`, or `None` for the same reason.
    pub fingerprint: Option<String>,
    /// The key is offered by a running ssh-agent.
    pub in_agent: bool,
    /// An algorithm or size that should not be used for new work. Orthogonal to
    /// `in_agent`: a key can be both weak and loaded, or neither.
    pub weak: bool,
    /// Saved hosts whose `key_path` resolves to this file.
    pub used_by: usize,
    /// File mtime, epoch ms — formatted in the UI, like every other date here.
    pub added_at: Option<i64>,
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

/// What the companion `<name>.pub` says about the key.
///
/// One parse yields all three facts the screen needs. An OpenSSH-format private
/// key names no algorithm in its own header and a fingerprint cannot be derived
/// without the key material, so a key with no `.pub` beside it is listed with
/// both columns empty rather than guessed at.
struct PubFacts {
    kind: String,
    fingerprint: String,
    weak: bool,
}

fn read_pub(path: &Path) -> Option<PubFacts> {
    let text = fs::read_to_string(path.with_extension("pub")).ok()?;
    let key = PublicKey::from_openssh(&text).ok()?;
    let data = key.key_data();

    // The design's Type column reads `ed25519` / `rsa 4096`, so size is only
    // spelled out where it varies.
    let (kind, weak) = if let Some(rsa) = data.rsa() {
        // The russh fork of ssh-key predates `key_size()`, so the modulus is
        // measured directly. `as_positive_bytes` drops the sign byte, and an
        // RSA modulus always has its top bit set, so the byte count is exact.
        let bits = rsa.n.as_positive_bytes().map_or(0, |b| b.len() * 8);
        // NIST has considered 2048-bit RSA end-of-life since 2030 planning
        // began, and OpenSSH treats sha1-signed RSA as legacy. 3072 is the
        // first size that is not on someone's deprecation list.
        (format!("rsa {bits}"), bits < 3072)
    } else if data.ed25519().is_some() {
        ("ed25519".to_string(), false)
    } else if let Some(ec) = data.ecdsa() {
        (format!("ecdsa {}", ec.curve()), false)
    } else {
        // DSA and anything else this build does not name: all long deprecated.
        (key.algorithm().as_str().to_string(), true)
    };

    Some(PubFacts {
        kind,
        fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
        weak,
    })
}

/// Whatever the platform's ssh-agent is holding.
///
/// The two systems do not agree on what an agent even is. Unix publishes a
/// Unix-domain socket in `SSH_AUTH_SOCK`; Windows OpenSSH publishes a named
/// pipe and sets no such variable. russh reflects that split in its types —
/// `connect_env` exists only under `#[cfg(unix)]` — so calling it
/// unconditionally does not degrade on Windows, it fails to compile.
///
/// No agent at all is an ordinary state, not an error: the variable is unset on
/// a fresh login shell and the Windows service is off by default. Every key then
/// reads as "not loaded", which is true.
async fn agent_identities() -> Vec<russh::keys::PublicKey> {
    use russh::keys::agent::client::AgentClient;

    #[cfg(unix)]
    {
        let Ok(mut agent) = AgentClient::connect_env().await else {
            return Vec::new();
        };
        agent.request_identities().await.unwrap_or_default()
    }

    #[cfg(windows)]
    {
        // The path Windows OpenSSH always uses. Pageant speaks the same
        // protocol over a different transport and would be a separate branch.
        let Ok(mut agent) =
            AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await
        else {
            return Vec::new();
        };
        agent.request_identities().await.unwrap_or_default()
    }
}

async fn agent_fingerprints() -> HashSet<String> {
    agent_identities()
        .await
        .iter()
        .map(|k| k.fingerprint(HashAlg::Sha256).to_string())
        .collect()
}

/// Every saved host's key path, expanded, so `~/.ssh/id_ed25519` and
/// `/Users/you/.ssh/id_ed25519` count as the same key — both are things a user
/// can end up with, since the picker writes tilde form and the field accepts
/// anything typed.
fn key_paths_in_use(db: &Db) -> Vec<std::path::PathBuf> {
    let Ok(conn) = db.0.lock() else { return Vec::new() };
    let Ok(mut stmt) = conn.prepare("SELECT key_path FROM hosts WHERE key_path IS NOT NULL") else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) else {
        return Vec::new();
    };
    rows.flatten().map(|p| expand_home(&p)).collect()
}

/// Every private key in `~/.ssh`, with what the Keys screen shows about it.
///
/// Also feeds the server form's "From SSH Keys" picker, which uses `name`,
/// `path` and `kind` — one scan serves both so the two can never disagree about
/// what is on the machine.
#[tauri::command]
pub async fn list_ssh_keys(db: State<'_, Db>) -> Result<Vec<KeyFile>> {
    let Some(dir) = dirs::home_dir().map(|h| h.join(".ssh")) else {
        return Ok(Vec::new());
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };

    let in_agent = agent_fingerprints().await;
    let in_use = key_paths_in_use(&db);

    let mut keys: Vec<KeyFile> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter(|e| is_private_key(&e.path()))
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let facts = read_pub(&e.path());
            let added_at = e
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64);

            let full = e.path();
            Some(KeyFile {
                path: format!("~/.ssh/{name}"),
                used_by: in_use.iter().filter(|p| **p == full).count(),
                in_agent: facts
                    .as_ref()
                    .is_some_and(|f| in_agent.contains(&f.fingerprint)),
                weak: facts.as_ref().is_some_and(|f| f.weak),
                kind: facts.as_ref().map(|f| f.kind.clone()),
                fingerprint: facts.map(|f| f.fingerprint),
                added_at,
                name,
            })
        })
        .collect();

    keys.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(keys)
}

/// The public half of one key, for "Copy pub".
///
/// Only ever the `.pub` file — the path is rebuilt from the scan's own naming
/// rather than trusted from the caller, so this cannot be pointed at an
/// arbitrary file, and it can never return private key material.
#[tauri::command]
pub fn read_public_key(name: String) -> Result<String> {
    let Some(dir) = dirs::home_dir().map(|h| h.join(".ssh")) else {
        return Err(Error::Invalid("no home directory".into()));
    };
    // A name is a single filename inside ~/.ssh, never a path.
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(Error::Invalid(format!("not a key name: {name}")));
    }
    let path = dir.join(&name).with_extension("pub");
    fs::read_to_string(&path)
        .map(|s| s.trim().to_string())
        .map_err(|e| Error::Invalid(format!("could not read {}: {e}", path.display())))
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

    /// A real ed25519 public key: type, fingerprint and strength all come from
    /// this one parse.
    #[test]
    fn reads_type_and_fingerprint_from_the_public_half() {
        let dir = std::env::temp_dir().join("portway-keys-pub");
        fs::create_dir_all(&dir).unwrap();
        let key = write(&dir, "id_ed25519", "-----BEGIN OPENSSH PRIVATE KEY-----\n");
        write(
            &dir,
            "id_ed25519.pub",
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIzOEZbrfnNMDCVWQ2/PtP1D3AoDGfL5vsPTGvbRQZDL portway\n",
        );
        let facts = read_pub(&key).expect("parses");
        assert_eq!(facts.kind, "ed25519");
        assert!(facts.fingerprint.starts_with("SHA256:"));
        assert!(!facts.weak);

        // No `.pub` beside it: listed, but with both columns unknown rather
        // than filled in from the private key.
        let bare = write(&dir, "id_bare", "-----BEGIN OPENSSH PRIVATE KEY-----\n");
        assert!(read_pub(&bare).is_none());
        fs::remove_dir_all(&dir).ok();
    }

    /// A `.pub` that is present but corrupt must degrade the same way a missing
    /// one does, not take the whole listing down.
    #[test]
    fn survives_an_unparseable_public_half() {
        let dir = std::env::temp_dir().join("portway-keys-bad");
        fs::create_dir_all(&dir).unwrap();
        let key = write(&dir, "id_broken", "-----BEGIN OPENSSH PRIVATE KEY-----\n");
        write(&dir, "id_broken.pub", "not a key at all\n");
        assert!(read_pub(&key).is_none());
        fs::remove_dir_all(&dir).ok();
    }
}
