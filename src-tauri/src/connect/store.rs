//! What Connect remembers between runs: whether it is on, this machine's
//! identity, and the machines it is paired with. The public parts live in
//! `connect.json`; the private key lives in the OS secret store.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use super::wire::{self, hex, unhex, MacInfo};
use crate::error::AppResult;
use crate::secrets;

const KEY_ACCOUNT: &str = "connect-private-key";

/// A machine this one is paired with.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub id: String,
    pub name: String,
    pub os: String,
    /// Its static public key, hex. A machine claiming this id with another key is refused.
    pub public_key: String,
    /// ms since epoch
    pub paired_at: u64,
    /// Addresses ("ip:port") the user added by hand, for when mDNS does not find it.
    #[serde(default)]
    pub manual_addrs: Vec<String>,
    /// Cards it can be woken through, as it last told us.
    #[serde(default)]
    pub macs: Vec<MacInfo>,
    /// Write text it sends into this machine's clipboard. Off until the user turns it on.
    #[serde(default)]
    pub clip_receive: bool,
    /// Send this machine's copied text to it as soon as it is copied (while linked).
    #[serde(default)]
    pub clip_send: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Stored {
    pub enabled: bool,
    /// Random id other machines see; empty until Connect is first turned on.
    pub id: String,
    pub public_key: String,
    pub peers: Vec<Peer>,
}

pub struct Store {
    path: PathBuf,
    pub data: Stored,
    /// Private key; loaded when the identity is, never written to `connect.json`.
    pub private_key: Option<Vec<u8>>,
}

impl Store {
    /// A missing or unreadable file gives the defaults: Connect off, nobody paired.
    pub fn load(path: PathBuf) -> Self {
        let data: Stored = fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        Self { path, data, private_key: None }
    }

    /// Make sure this machine has an identity: read the key from the secret
    /// store, or create one. Done on first use, so a machine that never turns
    /// Connect on never touches the Keychain for it. A lost private key means a
    /// new identity, and the old pairings cannot be trusted any more.
    pub fn ensure_identity(&mut self) -> AppResult<()> {
        if self.private_key.is_some() {
            return Ok(());
        }
        // A refused read is an error, not "no key": treating it as one would
        // replace the identity and forget every pairing.
        let stored = secrets::get_checked(KEY_ACCOUNT)?.and_then(|h| unhex(&h)).filter(|k| k.len() == 32);
        match stored {
            Some(key) if !self.data.id.is_empty() && !self.data.public_key.is_empty() => self.private_key = Some(key),
            _ => {
                let kp = wire::generate_keypair();
                secrets::set(KEY_ACCOUNT, &hex(&kp.private))?;
                self.data.id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
                self.data.public_key = hex(&kp.public);
                self.data.peers.clear();
                self.private_key = Some(kp.private);
                self.save()?;
            }
        }
        Ok(())
    }

    pub fn save(&self) -> AppResult<()> {
        write_atomic(&self.path, &serde_json::to_vec_pretty(&self.data)?)
    }

    pub fn peer(&self, id: &str) -> Option<&Peer> {
        self.data.peers.iter().find(|p| p.id == id)
    }

    /// Add a peer, or replace the one with the same id (pairing again).
    pub fn upsert(&mut self, peer: Peer) -> AppResult<()> {
        match self.data.peers.iter_mut().find(|p| p.id == peer.id) {
            Some(old) => {
                let manual_addrs = std::mem::take(&mut old.manual_addrs);
                // Pairing again may come without cards; keep the ones we had.
                let macs = if peer.macs.is_empty() { std::mem::take(&mut old.macs) } else { peer.macs.clone() };
                let (clip_receive, clip_send) = (old.clip_receive, old.clip_send);
                *old = Peer { manual_addrs, macs, clip_receive, clip_send, ..peer };
            }
            None => self.data.peers.push(peer),
        }
        self.save()
    }

    pub fn remove(&mut self, id: &str) -> AppResult<bool> {
        let before = self.data.peers.len();
        self.data.peers.retain(|p| p.id != id);
        let removed = self.data.peers.len() != before;
        if removed {
            self.save()?;
        }
        Ok(removed)
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer(id: &str, key: &str) -> Peer {
        Peer { id: id.into(), name: format!("name-{id}"), os: "macos".into(), public_key: key.into(), paired_at: 1, manual_addrs: vec![], macs: vec![], clip_receive: false, clip_send: false }
    }

    fn temp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("portway-connect-{name}-{}.json", std::process::id()));
        let _ = fs::remove_file(&p);
        p
    }

    #[test]
    fn missing_file_means_off_and_nobody_paired() {
        let s = Store::load(temp("missing"));
        assert!(!s.data.enabled);
        assert!(s.data.peers.is_empty());
        assert!(s.data.id.is_empty());
    }

    #[test]
    fn peers_round_trip_and_repairing_keeps_manual_addresses() {
        let path = temp("peers");
        let mut s = Store::load(path.clone());
        s.upsert(peer("a", "aa")).unwrap();
        s.data.peers[0].manual_addrs.push("10.0.0.2:47615".into());
        s.upsert(peer("b", "bb")).unwrap();
        s.upsert(Peer { name: "renamed".into(), ..peer("a", "a2") }).unwrap();
        let back = Store::load(path.clone());
        assert_eq!(back.data.peers.len(), 2);
        let a = back.peer("a").unwrap();
        assert_eq!((a.name.as_str(), a.public_key.as_str(), a.manual_addrs.len()), ("renamed", "a2", 1));
        assert_eq!(back.peer("b").map(|p| p.public_key.as_str()), Some("bb"));
        assert!(back.peer("c").is_none());
        fs::remove_file(path).ok();
    }

    #[test]
    fn unpairing_forgets_the_machine() {
        let path = temp("unpair");
        let mut s = Store::load(path.clone());
        s.upsert(peer("a", "aa")).unwrap();
        assert!(s.remove("a").unwrap());
        assert!(!s.remove("a").unwrap());
        assert!(Store::load(path.clone()).data.peers.is_empty());
        fs::remove_file(path).ok();
    }

    #[test]
    fn unknown_fields_and_garbage_fall_back_to_defaults() {
        let path = temp("garbage");
        fs::write(&path, r#"{"enabled":true,"extra":1}"#).unwrap();
        assert!(Store::load(path.clone()).data.enabled);
        fs::write(&path, "not json").unwrap();
        assert!(!Store::load(path.clone()).data.enabled);
        fs::remove_file(path).ok();
    }
}
