use keyring::{Entry, Error as KeyringError};

use crate::error::{Error, Result};

/// The secret half of a host, kept where the form promises it is kept.
///
/// The database holds the auth *method*, the key path and the two keychain
/// toggles; the passphrase itself lives here, in the OS credential store —
/// Keychain on macOS, Credential Manager on Windows. `keyring` is built with
/// `apple-native`/`windows-native` and no default features on purpose: with no
/// backend selected the crate falls back to a store that is not the OS one, and
/// writes would appear to succeed while going nowhere real.
///
/// Entries are keyed by host id, not by key path. "Unlock via keychain" is a
/// per-host toggle on a per-host form, so per-host entries keep turning it off,
/// or deleting a host, from reaching into another host that happens to use the
/// same key file.
const SERVICE: &str = "com.portway.ssh";

fn account(host_id: i64) -> String {
    format!("host:{host_id}:passphrase")
}

fn entry(host_id: i64) -> Result<Entry> {
    Entry::new(SERVICE, &account(host_id)).map_err(|e| Error::Keychain(e.to_string()))
}

pub fn set_passphrase(host_id: i64, value: &str) -> Result<()> {
    entry(host_id)?
        .set_password(value)
        .map_err(|e| Error::Keychain(e.to_string()))
}

/// `None` when nothing is stored, which is an ordinary state — a key with no
/// passphrase, or a host whose secret was never saved — not an error.
pub fn passphrase(host_id: i64) -> Result<Option<String>> {
    match entry(host_id)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(Error::Keychain(e.to_string())),
    }
}

/// Deleting what is not there succeeds: this runs on every save where the
/// toggle is off, which is most saves, and the common case is that there was
/// never an entry to begin with.
pub fn forget_passphrase(host_id: i64) -> Result<()> {
    match entry(host_id)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(Error::Keychain(e.to_string())),
    }
}
