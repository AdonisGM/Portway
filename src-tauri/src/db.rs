use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{params, Connection};

use crate::error::Result;

/// The open database, held in Tauri state. One connection behind a mutex is
/// plenty for a single-user desktop app and keeps writes serialised without a
/// pool.
pub struct Db(pub Mutex<Connection>);

/// Everything Portway keeps on this machine: the database, and the scratch
/// copies of files opened for editing.
pub fn app_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".portway")
}

/// `~/.portway/portway.db`, alongside the `config.toml` the design refers to.
pub fn database_path(home: PathBuf) -> PathBuf {
    home.join(".portway").join("portway.db")
}

pub fn open(path: &PathBuf) -> Result<Connection> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let conn = Connection::open(path)?;

    // WAL keeps reads from blocking the write that follows a form save, and
    // foreign_keys is off by default in SQLite.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;

    migrate(&conn)?;
    Ok(conn)
}

/// The version `migrate` brings a database up to. Bump it with each new step.
const LATEST: i64 = 5;

/// Migrations are keyed off `PRAGMA user_version`, so each step runs exactly
/// once. Add new steps by appending — never by editing one that has shipped.
fn migrate(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;

    // Schema moves are rare and consequential, and a database that quietly
    // arrived at the wrong version explains a great deal of otherwise
    // inexplicable behaviour. One line, only when something actually happens.
    if version < LATEST {
        crate::logging::info(
            "db",
            "migrating the database",
            Some(&format!("from={version} to={LATEST}")),
        );
    }

    if version < 1 {
        conn.execute_batch(
            "BEGIN;
             CREATE TABLE hosts (
               id                  INTEGER PRIMARY KEY AUTOINCREMENT,
               name                TEXT    NOT NULL,
               address             TEXT    NOT NULL,
               port                INTEGER NOT NULL DEFAULT 22,
               user                TEXT    NOT NULL,
               group_id            TEXT    NOT NULL,
               auth                TEXT    NOT NULL,
               key_path            TEXT,
               jump_host           TEXT,
               run_on_connect      TEXT,
               agent_forwarding    INTEGER NOT NULL DEFAULT 0,
               keep_alive          INTEGER NOT NULL DEFAULT 0,
               save_to_keychain    INTEGER NOT NULL DEFAULT 1,
               unlock_via_keychain INTEGER NOT NULL DEFAULT 1,
               favorite            INTEGER NOT NULL DEFAULT 0,
               last_used_at        INTEGER,
               created_at          INTEGER NOT NULL,
               updated_at          INTEGER NOT NULL
             );
             CREATE INDEX idx_hosts_group ON hosts(group_id);
             CREATE INDEX idx_hosts_last_used ON hosts(last_used_at);
             PRAGMA user_version = 1;
             COMMIT;",
        )?;
    }

    if version < 2 {
        // Labels became unique. Existing databases may already hold duplicates
        // (Duplicate used to append " copy"), and the index would refuse to
        // build over them — so rename the clashes first.
        dedupe_names(conn)?;
        conn.execute_batch(
            "BEGIN;
             CREATE UNIQUE INDEX idx_hosts_name ON hosts(name);
             PRAGMA user_version = 2;
             COMMIT;",
        )?;
    }

    if version < 3 {
        // Every command that reaches a host is recorded here, including the
        // ones the app issues itself — `origin` is what separates them.
        conn.execute_batch(
            "BEGIN;
             CREATE TABLE command_log (
               id         INTEGER PRIMARY KEY AUTOINCREMENT,
               host_id    INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
               session_id TEXT,
               -- 'user'   typed or clicked by the person at the keyboard
               -- 'system' issued by Portway itself
               origin     TEXT    NOT NULL,
               -- 'shell' a command line run in the interactive PTY
               -- 'exec'  a one-shot command on its own channel
               -- 'sftp'  an SFTP protocol operation
               -- 'auth'  connection lifecycle (connect, host key, disconnect)
               kind       TEXT    NOT NULL,
               command    TEXT    NOT NULL,
               detail     TEXT,
               exit_code  INTEGER,
               created_at INTEGER NOT NULL
             );
             CREATE INDEX idx_log_host ON command_log(host_id, created_at DESC);
             CREATE INDEX idx_log_session ON command_log(session_id);
             PRAGMA user_version = 3;
             COMMIT;",
        )?;
    }

    if version < 4 {
        // Port forwards. A tunnel belongs to a host because that is the
        // connection it rides, and goes with it — a forward through a server
        // that no longer exists has nothing to forward through.
        conn.execute_batch(
            "BEGIN;
             CREATE TABLE tunnels (
               id           INTEGER PRIMARY KEY AUTOINCREMENT,
               label        TEXT    NOT NULL,
               host_id      INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
               -- 'local'   listen here, connect from the far end   (ssh -L)
               -- 'remote'  listen there, connect from this end     (ssh -R)
               -- 'dynamic' listen here as a SOCKS5 proxy           (ssh -D)
               kind         TEXT    NOT NULL,
               -- Where the listening socket binds. Loopback unless the user
               -- deliberately widened it; the far side of a remote forward is
               -- further limited by the server's own GatewayPorts setting.
               bind_address TEXT    NOT NULL DEFAULT '127.0.0.1',
               bind_port    INTEGER NOT NULL,
               -- Where connections are delivered. NULL for dynamic, which is
               -- told by each client where it wants to go.
               target_host  TEXT,
               target_port  INTEGER,
               -- 'manual' | 'session' (a session to this host opens) | 'launch'
               autostart    TEXT    NOT NULL DEFAULT 'manual',
               created_at   INTEGER NOT NULL,
               updated_at   INTEGER NOT NULL
             );
             CREATE UNIQUE INDEX idx_tunnels_label ON tunnels(label);
             CREATE INDEX idx_tunnels_host ON tunnels(host_id);
             PRAGMA user_version = 4;
             COMMIT;",
        )?;
    }

    if version < 5 {
        // Preferences. Values are stored as the plain text a person would
        // write — `true`, `13`, `accept-new` — and not as JSON: the frontend
        // knows each key's type from its own defaults, Rust reads two of them
        // as strings, and a settings table you can read with `sqlite3` and
        // understand is worth more than a uniform encoding nobody needs.
        //
        // A key absent from this table means "the default", so a setting that
        // was never touched is not a row, and defaults can be changed later
        // without rewriting anybody's database.
        conn.execute_batch(
            "BEGIN;
             CREATE TABLE settings (
               key   TEXT PRIMARY KEY,
               value TEXT NOT NULL
             );
             PRAGMA user_version = 5;
             COMMIT;",
        )?;
    }

    Ok(())
}

/// Keeps the first host to claim a name and renumbers every later one.
fn dedupe_names(conn: &Connection) -> Result<()> {
    let rows: Vec<(i64, String)> = {
        let mut stmt = conn.prepare("SELECT id, name FROM hosts ORDER BY id")?;
        let mapped = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        mapped.collect::<rusqlite::Result<Vec<_>>>()?
    };

    let mut taken: HashSet<String> = HashSet::new();
    for (id, name) in rows {
        if taken.insert(name.clone()) {
            continue;
        }
        let unique = next_free_name(&name, &taken);
        conn.execute(
            "UPDATE hosts SET name = ?1 WHERE id = ?2",
            params![unique, id],
        )?;
        taken.insert(unique);
    }
    Ok(())
}

/// `web-01.prod` → `web-01.prod 2`, and `web-01.prod 2` → `web-01.prod 3`,
/// skipping anything already taken. Mirrors `nextCopyName` in the frontend so
/// a migration and a Duplicate click produce the same shape of name.
fn next_free_name(name: &str, taken: &HashSet<String>) -> String {
    let (base, start) = split_trailing_number(name);
    let mut n = start;
    loop {
        let candidate = format!("{base} {n}");
        if !taken.contains(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

fn split_trailing_number(name: &str) -> (String, u32) {
    let trimmed = name.trim();
    if let Some((head, tail)) = trimmed.rsplit_once(' ') {
        if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) {
            if let Ok(n) = tail.parse::<u32>() {
                return (head.trim_end().to_string(), n.saturating_add(1).max(2));
            }
        }
    }
    (trimmed.to_string(), 2)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
