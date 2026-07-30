use rusqlite::{params, Connection};
use serde::Serialize;

use crate::db::now_ms;
use crate::error::Result;

/// Who caused a command to run.
///
/// The distinction the audit trail exists for: `System` covers everything
/// Portway issues on its own initiative — the `run on connect` line, the SFTP
/// listing it fetches when a pane opens, the connection handshake — and `User`
/// covers what the person at the keyboard asked for.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    User,
    System,
}

impl Origin {
    fn as_str(self) -> &'static str {
        match self {
            Origin::User => "user",
            Origin::System => "system",
        }
    }
}

/// What sort of thing reached the host.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// A command line run inside the interactive PTY.
    Shell,
    /// A one-shot command on its own channel.
    Exec,
    /// An SFTP protocol operation, written in `sftp <op> <path>` form.
    Sftp,
    /// Connection lifecycle: host key decisions, auth, disconnect.
    Auth,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Shell => "shell",
            Kind::Exec => "exec",
            Kind::Sftp => "sftp",
            Kind::Auth => "auth",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub id: i64,
    pub host_id: i64,
    pub session_id: Option<String>,
    pub origin: String,
    pub kind: String,
    pub command: String,
    pub detail: Option<String>,
    pub exit_code: Option<i32>,
    pub created_at: i64,
}

/// Appends one entry. Deliberately infallible from the caller's point of view
/// — auditing must never be the reason an operation fails — so callers use
/// `record` and ignore the result.
pub fn record(
    conn: &Connection,
    host_id: i64,
    session_id: Option<&str>,
    origin: Origin,
    kind: Kind,
    command: &str,
    detail: Option<&str>,
) {
    let _ = conn.execute(
        "INSERT INTO command_log (host_id, session_id, origin, kind, command, detail, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            host_id,
            session_id,
            origin.as_str(),
            kind.as_str(),
            command,
            detail,
            now_ms(),
        ],
    );
}

pub fn recent(conn: &Connection, host_id: i64, limit: i64) -> Result<Vec<LogEntry>> {
    let mut stmt = conn.prepare(
        "SELECT id, host_id, session_id, origin, kind, command, detail, exit_code, created_at
         FROM command_log WHERE host_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![host_id, limit], |row| {
        Ok(LogEntry {
            id: row.get(0)?,
            host_id: row.get(1)?,
            session_id: row.get(2)?,
            origin: row.get(3)?,
            kind: row.get(4)?,
            command: row.get(5)?,
            detail: row.get(6)?,
            exit_code: row.get(7)?,
            created_at: row.get(8)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Rebuilds command lines from the bytes typed into an interactive PTY.
///
/// This is the only way to see what a person ran in a shell without changing
/// the remote host: SSH carries keystrokes, not commands. It follows the line
/// the user is editing — including backspace — and emits it when Enter is
/// pressed.
///
/// Known limits, and they are inherent rather than bugs to fix later:
///   · it sees the *input*, so shell aliases and expansions are not resolved
///   · text typed inside a full-screen program (vim, less, top) is keystrokes,
///     not commands, and is deliberately dropped once such a program takes the
///     screen — we cannot tell, so those lines are recorded as typed
///   · a command produced by a script running on the host was never typed and
///     so cannot appear here at all
///
/// Anything Portway itself sends is logged where it is issued, not here, which
/// is why `origin` is trustworthy even though this reconstruction is not exact.
#[derive(Default)]
pub struct LineReader {
    /// Bytes, not chars: a keystroke can arrive as a partial UTF-8 sequence
    /// split across two writes, and filtering to ASCII would silently drop
    /// every accented character from the recorded command.
    buffer: Vec<u8>,
    /// Set while an ANSI escape sequence is being consumed.
    in_escape: bool,
}

impl LineReader {
    /// Feeds raw input bytes, returning any completed command lines.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut out = Vec::new();

        for &byte in bytes {
            if self.in_escape {
                // Escape sequences end at the first alphabetic byte (or `~`).
                if byte.is_ascii_alphabetic() || byte == b'~' {
                    self.in_escape = false;
                }
                continue;
            }

            match byte {
                0x1b => self.in_escape = true, // ESC
                b'\r' | b'\n' => {
                    let line = String::from_utf8_lossy(&self.buffer).trim().to_string();
                    self.buffer.clear();
                    if !line.is_empty() {
                        out.push(line);
                    }
                }
                0x7f | 0x08 => self.backspace(),
                // Ctrl-C / Ctrl-U abandon the line rather than run it.
                0x03 | 0x15 => self.buffer.clear(),
                0x09 => self.buffer.push(b' '), // Tab: completion happens remotely
                // Keep printable ASCII and every byte of a multi-byte
                // character; drop the remaining control codes.
                b if b == b' ' || b.is_ascii_graphic() || b >= 0x80 => self.buffer.push(b),
                _ => {}
            }
        }

        out
    }

    /// Removes one whole character, not one byte — otherwise erasing an
    /// accented letter would leave a stray continuation byte behind and
    /// corrupt the recorded line.
    fn backspace(&mut self) {
        while let Some(&last) = self.buffer.last() {
            self.buffer.pop();
            // Continuation bytes are 10xxxxxx; stop once a lead byte is gone.
            if last & 0b1100_0000 != 0b1000_0000 {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emits_a_line_on_enter() {
        let mut reader = LineReader::default();
        assert!(reader.push(b"ls -la").is_empty());
        assert_eq!(reader.push(b"\r"), vec!["ls -la".to_string()]);
    }

    #[test]
    fn honours_backspace() {
        let mut reader = LineReader::default();
        reader.push(b"lsx");
        reader.push(&[0x7f]);
        assert_eq!(reader.push(b" -l\r"), vec!["ls -l".to_string()]);
    }

    #[test]
    fn drops_an_abandoned_line() {
        let mut reader = LineReader::default();
        reader.push(b"rm -rf /");
        reader.push(&[0x03]); // Ctrl-C
        assert!(reader.push(b"\r").is_empty());
    }

    #[test]
    fn keeps_non_ascii_arguments() {
        let mut reader = LineReader::default();
        assert_eq!(
            reader.push("cat /etc/hótname\r".as_bytes()),
            vec!["cat /etc/hótname".to_string()]
        );
    }

    #[test]
    fn backspace_erases_a_whole_character() {
        let mut reader = LineReader::default();
        reader.push("echo ó".as_bytes());
        reader.push(&[0x7f]);
        assert_eq!(reader.push(b"x\r"), vec!["echo x".to_string()]);
    }

    #[test]
    fn survives_a_split_utf8_sequence() {
        // "ó" is 0xC3 0xB3 — arriving in two separate writes.
        let mut reader = LineReader::default();
        reader.push(b"echo ");
        reader.push(&[0xC3]);
        reader.push(&[0xB3]);
        assert_eq!(reader.push(b"\r"), vec!["echo ó".to_string()]);
    }

    #[test]
    fn ignores_arrow_keys() {
        let mut reader = LineReader::default();
        reader.push(b"echo hi");
        reader.push(&[0x1b, b'[', b'D']); // left arrow
        assert_eq!(reader.push(b"\r"), vec!["echo hi".to_string()]);
    }
}
