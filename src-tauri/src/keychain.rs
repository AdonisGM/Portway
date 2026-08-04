use keyring::{Entry, Error as KeyringError};

use crate::error::{Error, Result};

/// The secret half of a host, kept where the form promises it is kept.
///
/// The database holds the auth *method*, the key path and the two keychain
/// toggles; the secrets themselves live here, in the OS credential store —
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

/// Which secret of a host this is about.
///
/// A host uses at most one of them — its auth method decides which — but they
/// are two entries rather than one "the secret" entry, so that switching a
/// host from Password to Private key cannot hand the old password to the new
/// method, and so that clearing one leaves the other alone.
#[derive(Debug, Clone, Copy)]
pub enum Slot {
    /// Unlocks an encrypted private key, for `auth == "key"`.
    Passphrase,
    /// The account password sent to the server, for `auth == "password"`.
    Password,
}

impl Slot {
    fn account(self, host_id: i64) -> String {
        match self {
            // Spelled exactly as it was when this was the only slot, so
            // passphrases stored by an earlier build stay findable.
            Slot::Passphrase => format!("host:{host_id}:passphrase"),
            Slot::Password => format!("host:{host_id}:password"),
        }
    }
}

fn entry(slot: Slot, host_id: i64) -> Result<Entry> {
    Entry::new(SERVICE, &slot.account(host_id)).map_err(|e| Error::Keychain(e.to_string()))
}

pub fn set(slot: Slot, host_id: i64, value: &str) -> Result<()> {
    entry(slot, host_id)?
        .set_password(value)
        .map_err(|e| Error::Keychain(e.to_string()))
}

/// `None` when nothing is stored, which is an ordinary state — a key with no
/// passphrase, or a host whose secret was never saved — not an error.
pub fn get(slot: Slot, host_id: i64) -> Result<Option<String>> {
    match entry(slot, host_id)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(Error::Keychain(e.to_string())),
    }
}

/// Deleting what is not there succeeds: this runs on every save where the
/// matching toggle is off, which is most saves, and the common case is that
/// there was never an entry to begin with.
pub fn forget(slot: Slot, host_id: i64) -> Result<()> {
    match entry(slot, host_id)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(Error::Keychain(e.to_string())),
    }
}
