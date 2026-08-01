use std::collections::HashMap;

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::db::Db;
use crate::error::Result;
use crate::logging;

/// Preferences, in the database beside everything else Portway keeps.
///
/// The design's Settings screen says `config.toml`, and there is no such file.
/// Rather than add one and a format to parse it with, these live in the
/// database that is already open, already migrated and already backed up with
/// the rest of the app's state — and the screen now says where they are.
///
/// A key that has never been set has no row. Absent means "the default", which
/// is what lets a default be reconsidered later without going back over
/// everybody's saved copy of the old one.

/// What the frontend needs to know a change happened somewhere else.
///
/// Every window runs its own copy of the frontend and its own store, so a
/// setting changed in the main window reaches a session window only because
/// this goes out. Without it a terminal in another window would keep the font
/// it was opened with until it was closed and opened again.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Changed {
    key: String,
    value: String,
}

/// One setting, as text, or `None` when it has never been set.
///
/// Takes a `Connection` rather than the `Db` state because the callers that
/// need it — `ssh.rs`, during a handshake — are already holding the lock.
pub fn text(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

#[tauri::command]
pub fn get_settings(db: State<'_, Db>) -> Result<HashMap<String, String>> {
    let conn = db.0.lock().unwrap();
    let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
    let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    Ok(rows.flatten().collect())
}

/// Writes one setting and tells every window.
#[tauri::command]
pub fn set_setting(app: AppHandle, db: State<'_, Db>, key: String, value: String) -> Result<()> {
    {
        let conn = db.0.lock().unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
    }

    // Debug rather than info: this fires on every click of a toggle, and a log
    // that fills with somebody deciding about a cursor is a log nobody reads.
    logging::debug("app", "setting changed", Some(&format!("{key}={value}")));

    let _ = app.emit("settings://changed", Changed { key, value });
    Ok(())
}
