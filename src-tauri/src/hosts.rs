use rusqlite::{params, Connection, Row};
use tauri::State;

use crate::db::{now_ms, Db};
use crate::error::{Error, Result};
use crate::models::{Host, HostInput};

const COLUMNS: &str = "id, name, address, port, user, group_id, auth, key_path, jump_host, \
                       run_on_connect, agent_forwarding, keep_alive, save_to_keychain, \
                       unlock_via_keychain, favorite, last_used_at, created_at, updated_at";

fn row_to_host(row: &Row) -> rusqlite::Result<Host> {
    Ok(Host {
        id: row.get(0)?,
        name: row.get(1)?,
        address: row.get(2)?,
        port: row.get(3)?,
        user: row.get(4)?,
        group: row.get(5)?,
        auth: row.get(6)?,
        key_path: row.get(7)?,
        jump_host: row.get(8)?,
        run_on_connect: row.get(9)?,
        agent_forwarding: row.get(10)?,
        keep_alive: row.get(11)?,
        save_to_keychain: row.get(12)?,
        unlock_via_keychain: row.get(13)?,
        favorite: row.get(14)?,
        last_used_at: row.get(15)?,
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
    })
}

/// The unique index on `name` is the real guarantee that labels don't collide;
/// the form checks first, but a race or a hand-edited database still lands
/// here. Turn the SQLite constraint error into something worth reading.
fn map_conflict(error: rusqlite::Error, name: &str) -> Error {
    if let rusqlite::Error::SqliteFailure(err, _) = &error {
        if err.code == rusqlite::ErrorCode::ConstraintViolation {
            return Error::Invalid(format!("A server called '{name}' already exists"));
        }
    }
    Error::Sqlite(error)
}

fn fetch(conn: &Connection, id: i64) -> Result<Host> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM hosts WHERE id = ?1"),
        params![id],
        row_to_host,
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Error::NotFound(id),
        other => Error::Sqlite(other),
    })
}

/// Ordered by creation so the list is stable across edits — sorting is the
/// frontend's job, and a row must not jump because it was renamed.
#[tauri::command]
pub fn list_hosts(db: State<'_, Db>) -> Result<Vec<Host>> {
    let conn = db.0.lock().unwrap();
    let mut stmt = conn.prepare(&format!("SELECT {COLUMNS} FROM hosts ORDER BY id"))?;
    let rows = stmt.query_map([], row_to_host)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

#[tauri::command]
pub fn create_host(db: State<'_, Db>, input: HostInput) -> Result<Host> {
    let input = input.normalized();
    input.validate()?;

    let conn = db.0.lock().unwrap();
    let now = now_ms();
    conn.execute(
        "INSERT INTO hosts (name, address, port, user, group_id, auth, key_path, jump_host,
                            run_on_connect, agent_forwarding, keep_alive, save_to_keychain,
                            unlock_via_keychain, favorite, last_used_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, NULL, ?15, ?15)",
        params![
            input.name,
            input.address,
            input.port,
            input.user,
            input.group,
            input.auth,
            input.key_path,
            input.jump_host,
            input.run_on_connect,
            input.agent_forwarding,
            input.keep_alive,
            input.save_to_keychain,
            input.unlock_via_keychain,
            input.favorite,
            now,
        ],
    )
    .map_err(|e| map_conflict(e, &input.name))?;

    fetch(&conn, conn.last_insert_rowid())
}

#[tauri::command]
pub fn update_host(db: State<'_, Db>, id: i64, input: HostInput) -> Result<Host> {
    let input = input.normalized();
    input.validate()?;

    let conn = db.0.lock().unwrap();
    let changed = conn.execute(
        "UPDATE hosts SET name = ?1, address = ?2, port = ?3, user = ?4, group_id = ?5,
                          auth = ?6, key_path = ?7, jump_host = ?8, run_on_connect = ?9,
                          agent_forwarding = ?10, keep_alive = ?11, save_to_keychain = ?12,
                          unlock_via_keychain = ?13, favorite = ?14, updated_at = ?15
         WHERE id = ?16",
        params![
            input.name,
            input.address,
            input.port,
            input.user,
            input.group,
            input.auth,
            input.key_path,
            input.jump_host,
            input.run_on_connect,
            input.agent_forwarding,
            input.keep_alive,
            input.save_to_keychain,
            input.unlock_via_keychain,
            input.favorite,
            now_ms(),
            id,
        ],
    )
    .map_err(|e| map_conflict(e, &input.name))?;

    if changed == 0 {
        return Err(Error::NotFound(id));
    }
    fetch(&conn, id)
}

#[tauri::command]
pub fn delete_host(db: State<'_, Db>, id: i64) -> Result<()> {
    let conn = db.0.lock().unwrap();
    let changed = conn.execute("DELETE FROM hosts WHERE id = ?1", params![id])?;
    if changed == 0 {
        return Err(Error::NotFound(id));
    }
    Ok(())
}

/// Stamps `last_used_at`, which is what makes the "Recent" filter and the
/// "Last used" column mean something. Called when a session is opened.
#[tauri::command]
pub fn touch_host(db: State<'_, Db>, id: i64) -> Result<Host> {
    touch(&db, id)
}

/// The same thing, callable from Rust — the SSH layer stamps a host when a
/// connection actually succeeds, not merely when a tab is opened.
pub fn touch(db: &Db, id: i64) -> Result<Host> {
    let conn = db.0.lock().unwrap();
    let changed = conn.execute(
        "UPDATE hosts SET last_used_at = ?1 WHERE id = ?2",
        params![now_ms(), id],
    )?;
    if changed == 0 {
        return Err(Error::NotFound(id));
    }
    fetch(&conn, id)
}

/// Reads one host for the SSH layer, which works from an id.
pub fn get(db: &Db, id: i64) -> Result<Host> {
    let conn = db.0.lock().unwrap();
    fetch(&conn, id)
}

/// The design has a Favorites filter but never draws a control that sets the
/// flag, so this stays available to the frontend without a UI attached to it.
#[tauri::command]
pub fn set_host_favorite(db: State<'_, Db>, id: i64, favorite: bool) -> Result<Host> {
    let conn = db.0.lock().unwrap();
    let changed = conn.execute(
        "UPDATE hosts SET favorite = ?1, updated_at = ?2 WHERE id = ?3",
        params![favorite, now_ms(), id],
    )?;
    if changed == 0 {
        return Err(Error::NotFound(id));
    }
    fetch(&conn, id)
}
