//! SSH keys in ~/.ssh. A key is a private key file with a matching `.pub` next
//! to it; everything shown (type, size, fingerprint) comes from the public key.
//! Private keys are only ever written (when generating), never read.

use serde::{Deserialize, Serialize};
use ssh_key::{public::KeyData, rand_core::OsRng, Algorithm, HashAlg, LineEnding, PrivateKey, PublicKey};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::error::{AppError, AppResult};
use crate::paths::{contract_tilde, expand_tilde, ssh_dir};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SshKey {
    pub name: String,
    /// `~/.ssh/<name>`, the form stored on server accounts.
    pub path: String,
    /// ED25519, RSA, ECDSA… None if the public key could not be parsed.
    pub kind: Option<String>,
    /// Key size for RSA and ECDSA.
    pub bits: Option<u32>,
    /// `SHA256:…`, as printed by `ssh-keygen -l`.
    pub fingerprint: Option<String>,
    pub comment: Option<String>,
    /// Creation time of the private key file (ms since epoch).
    pub created_at: Option<u64>,
}

pub fn list_keys() -> Vec<SshKey> {
    let dir = ssh_dir();
    let Ok(entries) = fs::read_dir(&dir) else { return Vec::new() };
    let mut keys: Vec<SshKey> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_str()?.strip_suffix(".pub")?.to_string();
            let private = dir.join(&name);
            private.is_file().then(|| describe(&private, &name))
        })
        .collect();
    keys.sort_by(|a, b| a.name.cmp(&b.name));
    keys
}

fn describe(private: &Path, name: &str) -> SshKey {
    let public = fs::read_to_string(pub_path(private)).ok().and_then(|t| PublicKey::from_openssh(t.trim()).ok());
    let (kind, bits) = public.as_ref().map(|k| kind_and_bits(k.key_data())).unwrap_or((None, None));
    let created_at = fs::metadata(private)
        .and_then(|m| m.created().or_else(|_| m.modified()))
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    SshKey {
        name: name.to_string(),
        path: contract_tilde(private),
        kind,
        bits,
        fingerprint: public.as_ref().map(|k| k.fingerprint(HashAlg::Sha256).to_string()),
        comment: public.as_ref().map(|k| k.comment().to_string()).filter(|c| !c.is_empty()),
        created_at,
    }
}

fn pub_path(private: &Path) -> std::path::PathBuf {
    let mut p = private.as_os_str().to_owned();
    p.push(".pub");
    p.into()
}

fn kind_and_bits(data: &KeyData) -> (Option<String>, Option<u32>) {
    match data {
        KeyData::Ed25519(_) => (Some("ED25519".into()), None),
        KeyData::Rsa(rsa) => {
            let bits = rsa.n.as_positive_bytes().map(|n| {
                let lead = n.first().map_or(8, |b| b.leading_zeros());
                n.len() as u32 * 8 - lead
            });
            (Some("RSA".into()), bits)
        }
        KeyData::Ecdsa(ec) => {
            let bits = match ec.curve() {
                ssh_key::EcdsaCurve::NistP256 => 256,
                ssh_key::EcdsaCurve::NistP384 => 384,
                ssh_key::EcdsaCurve::NistP521 => 521,
            };
            (Some("ECDSA".into()), Some(bits))
        }
        KeyData::SkEd25519(_) => (Some("ED25519-SK".into()), None),
        KeyData::SkEcdsaSha2NistP256(_) => (Some("ECDSA-SK".into()), Some(256)),
        other => (Some(other.algorithm().as_str().to_uppercase()), None),
    }
}

#[tauri::command]
pub fn ssh_keys_list() -> Vec<SshKey> {
    list_keys()
}

/// The public key line (`ssh-ed25519 AAAA… comment`) of the key at `path`.
#[tauri::command]
pub fn ssh_key_public(path: String) -> AppResult<String> {
    let text = fs::read_to_string(pub_path(&expand_tilde(&path))).map_err(|_| AppError::new("no_public_key"))?;
    Ok(text.trim().to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateInput {
    /// File name inside ~/.ssh.
    pub name: String,
    /// "ed25519" or "rsa" (RSA is 4096 bits).
    pub kind: String,
    /// Empty means `user@host`, like ssh-keygen.
    #[serde(default)]
    pub comment: String,
    /// Empty means no passphrase.
    #[serde(default)]
    pub passphrase: String,
}

/// Create a new key pair in ~/.ssh, the equivalent of
/// `ssh-keygen -t ed25519 -f ~/.ssh/<name> -C <comment>`.
#[tauri::command]
pub async fn ssh_key_generate(input: GenerateInput) -> AppResult<SshKey> {
    // RSA generation takes a moment; keep it off the main thread.
    tauri::async_runtime::spawn_blocking(move || generate(input, &ssh_dir()))
        .await
        .map_err(|e| AppError::detail("keygen_failed", e))?
}

fn generate(input: GenerateInput, dir: &Path) -> AppResult<SshKey> {
    let name = input.name.trim();
    let valid = !name.is_empty()
        && !name.starts_with('.')
        && !name.ends_with(".pub")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'));
    if !valid {
        return Err(AppError::field("invalid_key_name", "name"));
    }
    let private_path = dir.join(name);
    if private_path.exists() || pub_path(&private_path).exists() {
        return Err(AppError::field("key_exists", "name"));
    }

    let mut key = match input.kind.as_str() {
        "ed25519" => PrivateKey::random(&mut OsRng, Algorithm::Ed25519),
        "rsa" => ssh_key::private::RsaKeypair::random(&mut OsRng, 4096).map(PrivateKey::from),
        _ => return Err(AppError::field("invalid_key_kind", "kind")),
    }
    .map_err(|e| AppError::detail("keygen_failed", e))?;

    let comment = match input.comment.trim() {
        "" => default_comment(),
        c => c.to_string(),
    };
    key.set_comment(comment);
    let public = key.public_key().to_openssh().map_err(|e| AppError::detail("keygen_failed", e))?;
    if !input.passphrase.is_empty() {
        key = key.encrypt(&mut OsRng, &input.passphrase).map_err(|e| AppError::detail("keygen_failed", e))?;
    }
    let private = key.to_openssh(LineEnding::LF).map_err(|e| AppError::detail("keygen_failed", e))?;

    create_dir_private(dir)?;
    write_new(&private_path, private.as_bytes(), 0o600)?;
    if let Err(e) = write_new(&pub_path(&private_path), format!("{public}\n").as_bytes(), 0o644) {
        let _ = fs::remove_file(&private_path);
        return Err(e);
    }
    Ok(describe(&private_path, name))
}

fn default_comment() -> String {
    // Windows names them differently, and a program run from a GUI app there
    // would flash a console window, so the host name comes from the environment.
    #[cfg(windows)]
    let (user, host) = (std::env::var("USERNAME").ok(), std::env::var("COMPUTERNAME").ok());
    #[cfg(not(windows))]
    let (user, host) = (
        std::env::var("USER").ok(),
        std::process::Command::new("hostname").arg("-s").output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()),
    );
    let user = user.filter(|u| !u.is_empty()).unwrap_or_else(|| "user".into());
    let host = host.filter(|h| !h.is_empty()).unwrap_or_else(|| "localhost".into());
    format!("{user}@{host}")
}

fn create_dir_private(dir: &Path) -> AppResult<()> {
    if dir.exists() {
        return Ok(());
    }
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Create a file that must not exist yet, with the given unix permissions.
fn write_new(path: &Path, bytes: &[u8], mode: u32) -> AppResult<()> {
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    let mut file = opts.open(path)?;
    file.write_all(bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("portway-keys-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn generates_ed25519_with_passphrase() {
        let dir = temp_dir("ed");
        let key = generate(
            GenerateInput { name: "test_key".into(), kind: "ed25519".into(), comment: "me@test".into(), passphrase: "secret".into() },
            &dir,
        )
        .unwrap();
        assert_eq!(key.kind.as_deref(), Some("ED25519"));
        assert_eq!(key.comment.as_deref(), Some("me@test"));
        assert!(key.fingerprint.unwrap().starts_with("SHA256:"));

        let private = PrivateKey::from_openssh(fs::read_to_string(dir.join("test_key")).unwrap()).unwrap();
        assert!(private.is_encrypted());
        assert!(private.decrypt("secret").is_ok());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(dir.join("test_key")).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(fs::metadata(dir.join("test_key.pub")).unwrap().permissions().mode() & 0o777, 0o644);
        }

        let again = generate(GenerateInput { name: "test_key".into(), kind: "ed25519".into(), comment: String::new(), passphrase: String::new() }, &dir);
        assert_eq!(again.unwrap_err().code, "key_exists");
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn fingerprint_matches_ssh_keygen() {
        let dir = temp_dir("fp");
        let key = generate(GenerateInput { name: "fp_key".into(), kind: "ed25519".into(), comment: "c".into(), passphrase: String::new() }, &dir).unwrap();
        let Ok(out) = std::process::Command::new("ssh-keygen").arg("-lf").arg(dir.join("fp_key.pub")).output() else {
            return; // ssh-keygen not installed
        };
        let line = String::from_utf8_lossy(&out.stdout);
        assert_eq!(line.split_whitespace().nth(1), key.fingerprint.as_deref());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn rejects_bad_names() {
        let dir = temp_dir("names");
        for bad in ["", ".hidden", "a/b", "x.pub", "có dấu"] {
            let r = generate(GenerateInput { name: bad.into(), kind: "ed25519".into(), comment: String::new(), passphrase: String::new() }, &dir);
            assert_eq!(r.unwrap_err().code, "invalid_key_name", "{bad:?}");
        }
    }

    #[test]
    fn describes_rsa_bits() {
        let dir = temp_dir("rsa");
        let key = generate(GenerateInput { name: "rsa_key".into(), kind: "rsa".into(), comment: "x".into(), passphrase: String::new() }, &dir).unwrap();
        assert_eq!(key.kind.as_deref(), Some("RSA"));
        assert_eq!(key.bits, Some(4096));
        fs::remove_dir_all(dir).ok();
    }
}
