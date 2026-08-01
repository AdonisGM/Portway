use std::fs;
use std::path::PathBuf;

use russh::keys::PublicKey;
use serde::Serialize;
use tauri::State;

use crate::db::Db;
use crate::error::{Error, Result};
use crate::keys;
use crate::logging;

/// `~/.ssh/known_hosts` — read, and on request, one line removed.
///
/// One file, not the set OpenSSH consults. `ssh` also reads `known_hosts2` and
/// the system-wide `/etc/ssh/ssh_known_hosts`; Portway's own host-key check
/// (`ssh.rs::check_server_key`) is pointed at this single path, so listing any
/// other file here would show entries that have no bearing on what this app
/// does — and offer to remove entries that would change nothing.
fn path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".ssh")
        .join("known_hosts")
}

/// One line of the file.
///
/// A row is a **line**, not a host. `web-01,10.20.4.11 ssh-ed25519 AAAA…` is a
/// single key that two names answer to, and there is no way to remove one of
/// those names without rewriting the line — so the row shows both and removing
/// it removes both, which is at least what it says it does.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHost {
    /// Which line, counting from zero. A removal names this *and* the
    /// fingerprint, and the two are checked against each other before anything
    /// is written — `ssh` appends to this file whenever it meets a new server,
    /// so an index read a minute ago may no longer point where it did.
    pub line: usize,
    /// Every name on the line. Empty when the entry is hashed.
    pub patterns: Vec<String>,
    /// `HashKnownHosts yes` stores an HMAC of the name instead of the name.
    /// The hostname cannot be read back out, which is the point of it.
    pub hashed: bool,
    /// `@cert-authority` or `@revoked`, when the line carries one.
    pub marker: Option<String>,
    /// `ed25519`, `rsa 4096`, … or null when the line will not parse.
    pub kind: Option<String>,
    pub fingerprint: Option<String>,
    /// An algorithm or size not to be trusting new work to.
    pub weak: bool,
    /// The trailing comment, which is usually nothing on a host key.
    pub comment: Option<String>,
    /// Saved servers whose address this line answers for.
    pub used_by: usize,
    /// A saved server matching this line was last **refused**: the key it
    /// offers now is not the key written here. This is the one fact on the
    /// screen that does not come from the file — the file cannot know it —
    /// and it is what makes `Remove` the fix rather than a tidy-up.
    pub changed: bool,
}

/// A saved server, reduced to what matching needs.
struct Saved {
    address: String,
    port: u16,
    /// The last host-key verdict recorded for it was a refusal.
    refused: bool,
}

/// Every saved host, with the outcome of the last host-key check against it.
///
/// The verdict lives in the audit trail, written by `ssh.rs::dial` on every
/// connection attempt, so this is a reading of what actually happened rather
/// than a flag some screen set.
fn saved(db: &Db) -> Vec<Saved> {
    let Ok(conn) = db.0.lock() else { return Vec::new() };
    let sql = "SELECT h.address, h.port,
                      (SELECT l.detail FROM command_log l
                        WHERE l.host_id = h.id AND l.command = 'verify host key'
                        ORDER BY l.created_at DESC, l.id DESC
                        LIMIT 1)
               FROM hosts h";
    let Ok(mut stmt) = conn.prepare(sql) else { return Vec::new() };
    let rows = stmt.query_map([], |row| {
        Ok(Saved {
            address: row.get(0)?,
            port: row.get::<_, i64>(1)? as u16,
            refused: row
                .get::<_, Option<String>>(2)?
                .is_some_and(|d| d.starts_with("REFUSED")),
        })
    });
    match rows {
        Ok(rows) => rows.flatten().collect(),
        Err(_) => Vec::new(),
    }
}

/// `*` matches any run of characters, `?` exactly one — OpenSSH's own pattern
/// syntax, which is glob and not a regular expression.
///
/// Iterative with a single backtrack point rather than recursion: a pattern is
/// read from a file this app does not control, and `*` `*` `*` against a long
/// name is a well-known way to make a recursive matcher take exponential time.
fn glob(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    // Where to resume from if the current `*` turns out to have matched too
    // little: the star itself, and the character after the one it had reached.
    let (mut star, mut resume) = (None, 0usize);

    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            resume = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            resume += 1;
            ti = resume;
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|c| *c == '*')
}

/// Does one pattern from the file answer for this address and port?
///
/// `known_hosts` writes a non-default port as `[host]:port` and a port 22 host
/// as the bare name, so the bracket form is not decoration — it is the only
/// thing that distinguishes two servers behind one address.
fn matches(pattern: &str, address: &str, port: u16) -> bool {
    // A negated pattern excludes rather than includes. Nothing here needs to
    // act on that beyond not counting it as a match.
    if pattern.starts_with('!') {
        return false;
    }
    if let Some(rest) = pattern.strip_prefix('[') {
        let Some((host, tail)) = rest.split_once(']') else { return false };
        let Some(p) = tail.strip_prefix(':').and_then(|n| n.parse::<u16>().ok()) else {
            return false;
        };
        return p == port && glob(host, address);
    }
    port == 22 && glob(pattern, address)
}

/// One line, or `None` for a blank line or a comment.
///
/// The shape is `[marker] patterns keytype base64 [comment]`. The key is put
/// back together and handed to the same parser the Keys screen uses, so an
/// algorithm is never named twice by two different pieces of code.
fn parse(line: &str, number: usize) -> Option<KnownHost> {
    let text = line.trim_end_matches(['\r', '\n']).trim();
    if text.is_empty() || text.starts_with('#') {
        return None;
    }

    let mut fields = text.split_whitespace();
    let mut head = fields.next()?;

    let marker = if head.starts_with('@') {
        let m = head.to_string();
        head = fields.next()?;
        Some(m)
    } else {
        None
    };

    let hashed = head.starts_with("|1|");
    let patterns: Vec<String> = if hashed {
        Vec::new()
    } else {
        head.split(',').filter(|p| !p.is_empty()).map(str::to_string).collect()
    };

    let algorithm = fields.next()?;
    let blob = fields.next()?;
    let comment = {
        let rest = fields.collect::<Vec<_>>().join(" ");
        (!rest.is_empty()).then_some(rest)
    };

    // A line that will not parse is still shown — with its type and fingerprint
    // blank, the way a key with no readable `.pub` is on the Keys screen. It is
    // in the file, it is being consulted, and hiding it would make the screen
    // disagree with what `ssh` sees.
    let facts = PublicKey::from_openssh(&format!("{algorithm} {blob}"))
        .ok()
        .map(|key| keys::facts(&key));

    Some(KnownHost {
        line: number,
        patterns,
        hashed,
        marker,
        kind: facts.as_ref().map(|f| f.kind.clone()),
        weak: facts.as_ref().is_some_and(|f| f.weak),
        fingerprint: facts.map(|f| f.fingerprint),
        comment,
        used_by: 0,
        changed: false,
    })
}

/// The file, parsed, with each line's line number preserved.
///
/// Reading the file as text and splitting *inclusively* keeps every byte of
/// every line the caller did not ask about — line endings included — so a
/// removal rewrites one line and leaves a CRLF file, or a file with no final
/// newline, exactly as it found it.
fn read() -> Result<(Vec<String>, Vec<KnownHost>)> {
    let file = path();
    let text = match fs::read_to_string(&file) {
        Ok(text) => text,
        // No file at all is the ordinary state of a machine that has not
        // connected to anything yet, not an error to put on screen.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((Vec::new(), Vec::new())),
        Err(e) => {
            return Err(Error::Invalid(format!(
                "could not read {}: {e}",
                file.display()
            )))
        }
    };

    let raw: Vec<String> = text.split_inclusive('\n').map(str::to_string).collect();
    let entries = raw
        .iter()
        .enumerate()
        .filter_map(|(i, line)| parse(line, i))
        .collect();
    Ok((raw, entries))
}

/// Fills in the two columns that come from the database rather than the file.
fn annotate(entries: &mut [KnownHost], db: &Db) {
    let hosts = saved(db);
    for entry in entries {
        let matching = hosts
            .iter()
            .filter(|h| {
                entry
                    .patterns
                    .iter()
                    .any(|p| matches(p, &h.address, h.port))
            })
            .collect::<Vec<_>>();
        entry.used_by = matching.len();
        entry.changed = matching.iter().any(|h| h.refused);
    }
}

#[tauri::command]
pub fn list_known_hosts(db: State<'_, Db>) -> Result<Vec<KnownHost>> {
    let (_, mut entries) = read()?;
    annotate(&mut entries, &db);
    Ok(entries)
}

/// Removes one line, and returns what is left.
///
/// The line is named by number and by fingerprint, and both have to agree
/// before the file is touched: `ssh` and Portway both append to this file
/// whenever they meet a server for the first time, so between the list this
/// index came from and this call, every line below an insertion has moved.
/// Deleting the wrong host key is silent — it looks exactly like success, and
/// is only discovered on the next connection.
///
/// The file is written in place rather than replaced. A fresh file created by
/// a temp-and-rename would carry the process's default mode, and `ssh` is
/// entitled to expect this one to stay as private as it made it.
#[tauri::command]
pub fn remove_known_host(
    db: State<'_, Db>,
    line: usize,
    fingerprint: Option<String>,
) -> Result<Vec<KnownHost>> {
    let (raw, entries) = read()?;

    let stale = Error::Invalid(
        "that entry has moved since the list was read — the file changed underneath it. \
         Nothing was removed; the list has been refreshed."
            .into(),
    );
    let target = entries.iter().find(|e| e.line == line).ok_or(stale)?;
    if target.fingerprint != fingerprint {
        return Err(Error::Invalid(
            "that line no longer holds the key it did — the file changed underneath it. \
             Nothing was removed; the list has been refreshed."
                .into(),
        ));
    }

    let described = if target.hashed {
        "hashed entry".to_string()
    } else {
        target.patterns.join(",")
    };

    let kept: String = raw
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != line)
        .map(|(_, text)| text.as_str())
        .collect();

    let file = path();
    fs::write(&file, kept)
        .map_err(|e| Error::Invalid(format!("could not write {}: {e}", file.display())))?;

    logging::info(
        "ssh",
        "removed a known host key",
        Some(&format!(
            "{described} {}",
            target.fingerprint.as_deref().unwrap_or("(unparsed)")
        )),
    );

    let (_, mut entries) = read()?;
    annotate(&mut entries, &db);
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ED25519: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIzOEZbrfnNMDCVWQ2/PtP1D3AoDGfL5vsPTGvbRQZDL";

    #[test]
    fn reads_the_shapes_a_real_file_holds() {
        let plain = parse(&format!("10.20.4.11 {ED25519}\n"), 0).expect("plain");
        assert_eq!(plain.patterns, ["10.20.4.11"]);
        assert_eq!(plain.kind.as_deref(), Some("ed25519"));
        assert!(plain.fingerprint.unwrap().starts_with("SHA256:"));
        assert!(!plain.hashed);

        // Two names, one key — one row, both names shown.
        let multi = parse(&format!("web-01,10.20.4.11 {ED25519}"), 3).expect("multi");
        assert_eq!(multi.patterns, ["web-01", "10.20.4.11"]);
        assert_eq!(multi.line, 3);

        let marked = parse(&format!("@revoked 10.20.4.11 {ED25519}"), 0).expect("marked");
        assert_eq!(marked.marker.as_deref(), Some("@revoked"));
        assert_eq!(marked.patterns, ["10.20.4.11"]);

        let hashed = parse(
            &format!("|1|F1E2D3C4B5A6978877665544332211AABBCCDD=|abcdef0123456789= {ED25519}"),
            0,
        )
        .expect("hashed");
        assert!(hashed.hashed);
        assert!(hashed.patterns.is_empty());

        // Present, consulted by ssh, unparseable — listed with nothing claimed
        // about it rather than dropped.
        let broken = parse("10.20.4.11 ssh-ed25519 not-base64", 0).expect("broken");
        assert!(broken.kind.is_none() && broken.fingerprint.is_none());

        assert!(parse("", 0).is_none());
        assert!(parse("# a comment", 0).is_none());
        assert!(parse("   \n", 0).is_none());
    }

    #[test]
    fn a_port_is_part_of_the_name() {
        assert!(matches("10.20.4.11", "10.20.4.11", 22));
        // The bare form means port 22 and nothing else.
        assert!(!matches("10.20.4.11", "10.20.4.11", 2222));
        assert!(matches("[10.20.4.11]:2222", "10.20.4.11", 2222));
        assert!(!matches("[10.20.4.11]:2222", "10.20.4.11", 22));
        assert!(!matches("[10.20.4.11]:2222", "10.20.4.11", 2223));
    }

    #[test]
    fn wildcards_are_globs_and_stay_cheap() {
        assert!(matches("*.example.com", "web-01.example.com", 22));
        assert!(!matches("*.example.com", "web-01.example.org", 22));
        assert!(matches("10.20.4.?", "10.20.4.1", 22));
        assert!(!matches("10.20.4.?", "10.20.4.11", 22));
        // A negation is never a match, whatever it names.
        assert!(!matches("!10.20.4.11", "10.20.4.11", 22));
        // The shape that makes a backtracking matcher hang, answered at once.
        assert!(!glob("*a*a*a*a*a*a*b", &"a".repeat(64)));
    }

    /// Everything not being removed has to survive byte for byte — this file
    /// belongs to `ssh` as much as to Portway.
    #[test]
    fn removing_a_line_leaves_the_rest_alone() {
        let text = format!("# kept\r\nfirst {ED25519}\r\nsecond {ED25519}\r\n");
        let raw: Vec<&str> = text.split_inclusive('\n').collect();
        let kept: String = raw
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != 1)
            .map(|(_, l)| *l)
            .collect();
        assert_eq!(kept, format!("# kept\r\nsecond {ED25519}\r\n"));

        // A file with no final newline keeps not having one.
        let text = format!("first {ED25519}\nsecond {ED25519}");
        let raw: Vec<&str> = text.split_inclusive('\n').collect();
        let kept: String = raw
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != 0)
            .map(|(_, l)| *l)
            .collect();
        assert_eq!(kept, format!("second {ED25519}"));
    }
}
