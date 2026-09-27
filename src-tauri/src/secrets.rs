//! Secrets in the OS store: the Keychain on macOS, Credential Manager on
//! Windows. Windows keeps at most 1280 UTF-16 units per credential, so a
//! longer value (an HTTP request's tokens) is split over several entries:
//! the main entry then holds only a marker with the number of parts.

use crate::error::{AppError, AppResult};

const SERVICE: &str = "com.portway.app";
/// Room per entry, in UTF-16 units; unlimited where the store has no limit.
const LIMIT: usize = if cfg!(windows) { 1200 } else { usize::MAX };
/// Starts the main entry of a split value; no real secret starts with U+0001.
const MARK: &str = "\u{1}portway-parts:";

fn entry(account: &str) -> Option<keyring::Entry> {
    keyring::Entry::new(SERVICE, account).ok()
}

fn part_account(account: &str, i: usize) -> String {
    format!("{account}#{i}")
}

/// Pieces of at most `limit` UTF-16 units, never splitting a character.
fn split(value: &str, limit: usize) -> Vec<String> {
    let mut parts = vec![String::new()];
    let mut used = 0;
    for c in value.chars() {
        if used + c.len_utf16() > limit {
            parts.push(String::new());
            used = 0;
        }
        parts.last_mut().unwrap().push(c);
        used += c.len_utf16();
    }
    parts
}

fn parts_of(stored: &str) -> Option<usize> {
    stored.strip_prefix(MARK)?.parse().ok()
}

pub fn get(account: &str) -> Option<String> {
    let stored = entry(account)?.get_password().ok()?;
    let Some(n) = parts_of(&stored) else { return Some(stored) };
    (1..=n).map(|i| entry(&part_account(account, i))?.get_password().ok()).collect()
}

pub fn set(account: &str, value: &str) -> AppResult<()> {
    let main = entry(account).ok_or_else(|| AppError::new("keychain"))?;
    // Parts of an earlier, longer value would be left behind otherwise.
    let old = main.get_password().ok().and_then(|s| parts_of(&s));
    let parts = split(value, LIMIT);
    let result = if parts.len() == 1 {
        main.set_password(value).map_err(|e| AppError::detail("keychain", e))
    } else {
        parts
            .iter()
            .enumerate()
            .try_for_each(|(i, p)| {
                let e = entry(&part_account(account, i + 1)).ok_or_else(|| AppError::new("keychain"))?;
                e.set_password(p).map_err(|e| AppError::detail("keychain", e))
            })
            .and_then(|_| main.set_password(&format!("{MARK}{}", parts.len())).map_err(|e| AppError::detail("keychain", e)))
    };
    let now = if parts.len() == 1 { 0 } else { parts.len() };
    for i in now + 1..=old.unwrap_or(0) {
        if let Some(e) = entry(&part_account(account, i)) {
            let _ = e.delete_credential();
        }
    }
    result
}

pub fn delete(account: &str) {
    let Some(main) = entry(account) else { return };
    if let Some(n) = main.get_password().ok().and_then(|s| parts_of(&s)) {
        for i in 1..=n {
            if let Some(e) = entry(&part_account(account, i)) {
                let _ = e.delete_credential();
            }
        }
    }
    let _ = main.delete_credential();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_on_character_boundaries() {
        assert_eq!(split("short", 1200), vec!["short"]);
        assert_eq!(split("", 3), vec![""]);
        assert_eq!(split("abcdefg", 3), vec!["abc", "def", "g"]);
        // "😀" is two UTF-16 units: it moves whole to the next part.
        assert_eq!(split("ab😀c", 3), vec!["ab", "😀c"]);
        let long = "x".repeat(3000);
        let parts = split(&long, 1200);
        assert_eq!(parts.iter().map(|p| p.len()).collect::<Vec<_>>(), vec![1200, 1200, 600]);
        assert_eq!(parts.concat(), long);
        assert_eq!(parts_of(&format!("{MARK}3")), Some(3));
        assert_eq!(parts_of("hunter2"), None);
    }
}
