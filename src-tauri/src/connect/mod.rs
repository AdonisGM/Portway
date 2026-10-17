//! Portway Connect: two Portways on one LAN find each other over mDNS, pair
//! once by comparing a six-digit code, and then keep an encrypted link between
//! them. Off until the user turns it on: while it is off nothing listens and
//! nothing is announced.

mod machine;
mod net;
mod runtime;
mod store;
mod sys_clip;
mod wire;

pub use runtime::Connect;
use runtime::View;
use tauri::State;

use crate::error::AppResult;

#[tauri::command]
pub fn connect_state(connect: State<'_, Connect>) -> View {
    connect.view()
}

#[tauri::command]
pub async fn connect_set_enabled(connect: State<'_, Connect>, enabled: bool) -> AppResult<View> {
    let connect = connect.inner().clone();
    connect.set_enabled(enabled).await?;
    Ok(connect.view())
}

/// Ask a machine to pair: by id (found over mDNS) or at an address typed in.
#[tauri::command]
pub fn connect_pair(connect: State<'_, Connect>, id: Option<String>, addr: Option<String>) -> AppResult<()> {
    connect.pair(id, addr)
}

/// The user's answer to "do both screens show this code?".
#[tauri::command]
pub fn connect_pair_decide(connect: State<'_, Connect>, ok: bool) -> AppResult<()> {
    connect.pair_decide(ok)
}

#[tauri::command]
pub fn connect_pair_close(connect: State<'_, Connect>) {
    connect.pair_close()
}

#[tauri::command]
pub fn connect_unpair(connect: State<'_, Connect>, id: String) -> AppResult<()> {
    connect.unpair(&id)
}

#[tauri::command]
pub fn connect_link(connect: State<'_, Connect>, id: String) -> AppResult<()> {
    connect.link(&id)
}

#[tauri::command]
pub fn connect_unlink(connect: State<'_, Connect>) {
    connect.unlink()
}

#[tauri::command]
pub fn connect_dismiss_link_error(connect: State<'_, Connect>) {
    connect.dismiss_link_error()
}

#[tauri::command]
pub fn connect_add_address(connect: State<'_, Connect>, id: String, addr: String) -> AppResult<()> {
    connect.add_address(&id, &addr)
}

#[tauri::command]
pub fn connect_remove_address(connect: State<'_, Connect>, id: String, addr: String) -> AppResult<()> {
    connect.remove_address(&id, &addr)
}

/// Send magic packets to a paired machine and wait for it to come up.
#[tauri::command]
pub fn connect_wake(connect: State<'_, Connect>, id: String) -> AppResult<()> {
    connect.wake(&id)
}

#[tauri::command]
pub fn connect_dismiss_wake(connect: State<'_, Connect>) {
    connect.dismiss_wake()
}

/// Offer files (by path) to a paired machine.
#[tauri::command]
pub fn connect_send(connect: State<'_, Connect>, id: String, paths: Vec<String>) -> AppResult<()> {
    connect.send_files(&id, paths)
}

/// The user's answer to a machine that wants to send files.
#[tauri::command]
pub fn connect_transfer_decide(connect: State<'_, Connect>, id: String, accept: bool) -> AppResult<()> {
    connect.transfer_decide(&id, accept)
}

#[tauri::command]
pub fn connect_transfer_cancel(connect: State<'_, Connect>, id: String) {
    connect.transfer_cancel(&id)
}

#[tauri::command]
pub fn connect_transfers_clear(connect: State<'_, Connect>) {
    connect.transfers_clear()
}

/// Per machine: write its copied text here, and send ours to it as soon as it is copied.
#[tauri::command]
pub fn connect_set_clip(connect: State<'_, Connect>, id: String, receive: bool, send: bool) -> AppResult<()> {
    connect.set_clip(&id, receive, send)
}

/// Send the text on the clipboard now to the machine linked with.
#[tauri::command]
pub fn connect_clip_send(connect: State<'_, Connect>, id: String) -> AppResult<()> {
    connect.clip_send_now(&id)
}

/// Measure how fast bytes go to this machine and back.
#[tauri::command]
pub fn connect_speed_test(connect: State<'_, Connect>, id: String) -> AppResult<()> {
    connect.speed_test(&id)
}

/// Tell the machine linked with that the files on the clipboard were copied here.
#[tauri::command]
pub fn connect_clip_files_send(connect: State<'_, Connect>, id: String) -> AppResult<()> {
    connect.clip_files_send_now(&id)
}

/// Fetch what the linked machine copied into the downloads folder.
#[tauri::command]
pub fn connect_clip_files_save(connect: State<'_, Connect>, id: String) -> AppResult<()> {
    connect.clip_files_save(&id)
}
