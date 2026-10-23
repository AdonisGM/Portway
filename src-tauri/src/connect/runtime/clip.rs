//! Copied text between two linked machines. Sending is manual (a button) or,
//! per machine and off by default, automatic as soon as text is copied; either
//! way it goes over the live link. Receiving is a per-machine switch that is
//! also off by default. The text itself is never written to the audit log.

use super::*;
use std::hash::{Hash, Hasher};
use tauri_plugin_clipboard_manager::ClipboardExt;

/// A frame holds about 64 KB, and JSON may escape some characters to six.
/// Longer text is refused with a message, never cut or dropped silently.
const MAX_BYTES: usize = 40_000;
const WATCH_EVERY: Duration = Duration::from_millis(700);

pub(super) fn hash_of(text: &str) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut h);
    h.finish()
}

/// Why this text should not go: nothing to send, or too long.
pub fn check_text(text: &str) -> Result<(), &'static str> {
    if text.trim().is_empty() {
        return Err("clip_empty");
    }
    // What the frame will carry, escaped.
    let wire = serde_json::to_vec(&Msg::Clip { text: text.to_string() }).map(|v| v.len()).unwrap_or(usize::MAX);
    if wire > MAX_BYTES {
        return Err("clip_too_large");
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipNote {
    pub peer_id: String,
    /// "in" (written here) or "out" (sent).
    pub direction: &'static str,
    pub chars: usize,
    /// How many files or folders when it is files that were copied; 0 for text.
    pub files: u32,
    /// A picture (then `bytes` is its size) rather than text or files.
    pub image: bool,
    pub bytes: u64,
    pub at: u64,
    /// For "out": "sent" until the other machine answers, then "delivered" or
    /// why it was not taken ("off", "too_large", "failed"). Machines older than
    /// the answer stay at "sent". For "in" always "delivered".
    pub status: String,
}

/// What the linked machine does with clipboard text for this one.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipPrefs {
    pub receive: bool,
    pub send: bool,
}

pub struct ClipState {
    /// Hash of the text last sent or written, so it is not sent back or written twice.
    pub(super) last: Option<u64>,
    /// The clipboard's change count right after this app put something there.
    pub own_change: Option<u64>,
    pub note: Option<ClipNote>,
}

impl ClipState {
    pub fn new() -> Self {
        Self { last: None, own_change: None, note: None }
    }
}

impl Connect {
    pub fn set_clip(&self, id: &str, receive: bool, send: bool) -> AppResult<()> {
        {
            let mut s = self.lock();
            let peer = s.store.data.peers.iter_mut().find(|p| p.id == id).ok_or_else(|| AppError::new("peer_not_found"))?;
            peer.clip_receive = receive;
            peer.clip_send = send;
            s.store.save()?;
        }
        // The other side shows these, so tell it at once if it is listening.
        if let Some(outbox) = self.link_outbox(id) {
            let _ = outbox.send(Msg::ClipPrefs { receive, send });
        }
        self.publish();
        Ok(())
    }

    /// Send what is on the clipboard now to the machine linked with.
    pub fn clip_send_now(&self, id: &str) -> AppResult<()> {
        let outbox = self.link_outbox(id).ok_or_else(|| AppError::new("not_linked"))?;
        let text = self.inner.app.clipboard().read_text().unwrap_or_default();
        // No text: a picture, if that is what was copied.
        if text.trim().is_empty() && sys_clip::has_image() {
            return self.send_clip_image(id, &outbox, true).map_err(AppError::new);
        }
        check_text(&text).map_err(AppError::new)?;
        self.send_clip(id, &outbox, text);
        Ok(())
    }

    pub(super) fn link_outbox(&self, id: &str) -> Option<mpsc::UnboundedSender<Msg>> {
        self.lock().link.as_ref().filter(|l| l.up && l.peer_id == id).map(|l| l.outbox.clone())
    }

    fn send_clip(&self, id: &str, outbox: &mpsc::UnboundedSender<Msg>, text: String) {
        let chars = text.chars().count();
        let name = self.lock().store.peer(id).map(|p| p.name.clone()).unwrap_or_default();
        {
            let mut s = self.lock();
            s.clip.last = Some(hash_of(&text));
            s.clip.note = Some(ClipNote { peer_id: id.to_string(), direction: "out", chars, files: 0, image: false, bytes: 0, at: now_ms(), status: "sent".into() });
        }
        let _ = outbox.send(Msg::Clip { text });
        self.audit("clipSend", &name, true, Some(format!("{chars} chars")));
        self.publish();
    }

    /// Text arrived from the machine linked with. Gives back why it was not
    /// written here, or "" when it was, to tell the sender.
    pub(super) fn on_clip(&self, peer_id: &str, text: String) -> &'static str {
        let (allowed, name) = {
            let s = self.lock();
            match s.store.peer(peer_id) {
                Some(p) => (p.clip_receive, p.name.clone()),
                None => (false, String::new()),
            }
        };
        if !allowed {
            return "off";
        }
        if check_text(&text).is_err() {
            return "too_large";
        }
        let h = hash_of(&text);
        if self.lock().clip.last == Some(h) {
            return "";
        }
        let chars = text.chars().count();
        if self.inner.app.clipboard().write_text(text).is_err() {
            return "failed";
        }
        {
            let mut s = self.lock();
            s.clip.last = Some(h);
            s.clip.note = Some(ClipNote { peer_id: peer_id.to_string(), direction: "in", chars, files: 0, image: false, bytes: 0, at: now_ms(), status: "delivered".into() });
        }
        self.audit("clipReceive", &name, true, Some(format!("{chars} chars")));
        self.publish();
        ""
    }

    /// What the linked machine does with clipboard text for this one.
    pub(super) fn on_clip_prefs(&self, peer_id: &str, receive: bool, send: bool) {
        self.lock().peer_clip = Some((peer_id.to_string(), ClipPrefs { receive, send }));
        self.publish();
    }

    /// What this machine does with clipboard text for that one.
    pub(super) fn my_clip_prefs(&self, peer_id: &str) -> Option<Msg> {
        self.lock().store.peer(peer_id).map(|p| Msg::ClipPrefs { receive: p.clip_receive, send: p.clip_send })
    }

    /// The other machine's answer to the text just sent.
    pub(super) fn on_clip_ack(&self, peer_id: &str, ok: bool, reason: String) {
        {
            let mut s = self.lock();
            match s.clip.note.as_mut() {
                Some(n) if n.direction == "out" && n.peer_id == peer_id => n.status = if ok { "delivered".into() } else if reason.is_empty() { "failed".into() } else { reason },
                _ => return,
            }
        }
        self.publish();
    }

    /// While the link with this machine is up and "send as soon as copied" is
    /// on for it, notice new text on the clipboard and send it. Content is read
    /// only when the clipboard changed and its owner did not mark it sensitive.
    pub(super) async fn watch_clipboard(&self, token: u64, peer_id: String) {
        let mut seen = sys_clip::change_count();
        loop {
            tokio::time::sleep(WATCH_EVERY).await;
            let (alive, enabled) = {
                let s = self.lock();
                (s.link.as_ref().is_some_and(|l| l.token == token), s.store.peer(&peer_id).is_some_and(|p| p.clip_send))
            };
            if !alive {
                return;
            }
            let now = sys_clip::change_count();
            if now.is_none() || now == seen {
                continue;
            }
            seen = now;
            // Written by this app (files offered by the other machine): not something to send back.
            if self.lock().clip.own_change == now {
                continue;
            }
            let sensitive = sys_clip::is_sensitive();
            // Files copied (and not marked sensitive): their names go, the bytes wait to be asked for.
            let files = if sensitive { Vec::new() } else { sys_clip::file_paths() };
            // Whatever was announced is not on the clipboard any more.
            if !self.clip_out_is(&files) {
                self.revoke_clip_files();
            }
            // Keep up while off, so switching it on does not send what was copied long ago.
            if !enabled || sensitive {
                continue;
            }
            if !files.is_empty() {
                if !self.clip_out_is(&files) || !self.lock().clip_out_told(&peer_id) {
                    if let Some(outbox) = self.link_outbox(&peer_id) {
                        let _ = self.announce_clip_files(&peer_id, &outbox, files);
                    }
                }
                continue;
            }
            let text = self.inner.app.clipboard().read_text().unwrap_or_default();
            if text.trim().is_empty() {
                // No text: a picture, if that is what was copied. (Word and Pages put a
                // rendering of the text on the clipboard too; then the text is what goes.)
                if sys_clip::has_image() {
                    if let Some(outbox) = self.link_outbox(&peer_id) {
                        let _ = self.send_clip_image(&peer_id, &outbox, false);
                    }
                }
                continue;
            }
            if check_text(&text).is_err() || self.lock().clip.last == Some(hash_of(&text)) {
                continue;
            }
            if let Some(outbox) = self.link_outbox(&peer_id) {
                self.send_clip(&peer_id, &outbox, text);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_and_huge_text_is_refused_with_a_reason() {
        assert_eq!(check_text(""), Err("clip_empty"));
        assert_eq!(check_text("  \n\t "), Err("clip_empty"));
        assert_eq!(check_text("hello"), Ok(()));
        assert_eq!(check_text(&"x".repeat(100_000)), Err("clip_too_large"));
        // Control characters escape to six bytes each: judged by what is sent.
        assert_eq!(check_text(&"\u{1}".repeat(10_000)), Err("clip_too_large"));
        assert_eq!(check_text(&"é".repeat(15_000)), Ok(()));
    }

    #[test]
    fn the_same_text_hashes_the_same() {
        assert_eq!(hash_of("a"), hash_of("a"));
        assert_ne!(hash_of("a"), hash_of("b"));
    }
}
