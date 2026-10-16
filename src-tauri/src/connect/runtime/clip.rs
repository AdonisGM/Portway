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

fn hash_of(text: &str) -> u64 {
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
    pub at: u64,
}

pub struct ClipState {
    /// Hash of the text last sent or written, so it is not sent back or written twice.
    last: Option<u64>,
    pub note: Option<ClipNote>,
}

impl ClipState {
    pub fn new() -> Self {
        Self { last: None, note: None }
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
        self.publish();
        Ok(())
    }

    /// Send what is on the clipboard now to the machine linked with.
    pub fn clip_send_now(&self, id: &str) -> AppResult<()> {
        let outbox = self.link_outbox(id).ok_or_else(|| AppError::new("not_linked"))?;
        let text = self.inner.app.clipboard().read_text().map_err(|_| AppError::new("clip_empty"))?;
        check_text(&text).map_err(AppError::new)?;
        self.send_clip(id, &outbox, text);
        Ok(())
    }

    fn link_outbox(&self, id: &str) -> Option<mpsc::UnboundedSender<Msg>> {
        self.lock().link.as_ref().filter(|l| l.up && l.peer_id == id).map(|l| l.outbox.clone())
    }

    fn send_clip(&self, id: &str, outbox: &mpsc::UnboundedSender<Msg>, text: String) {
        let chars = text.chars().count();
        let name = self.lock().store.peer(id).map(|p| p.name.clone()).unwrap_or_default();
        {
            let mut s = self.lock();
            s.clip.last = Some(hash_of(&text));
            s.clip.note = Some(ClipNote { peer_id: id.to_string(), direction: "out", chars, at: now_ms() });
        }
        let _ = outbox.send(Msg::Clip { text });
        self.audit("clipSend", &name, true, Some(format!("{chars} chars")));
        self.publish();
    }

    /// Text arrived from the machine linked with.
    pub(super) fn on_clip(&self, peer_id: &str, text: String) {
        let (allowed, name) = {
            let s = self.lock();
            match s.store.peer(peer_id) {
                Some(p) => (p.clip_receive, p.name.clone()),
                None => (false, String::new()),
            }
        };
        if !allowed || check_text(&text).is_err() {
            return;
        }
        let h = hash_of(&text);
        if self.lock().clip.last == Some(h) {
            return;
        }
        let chars = text.chars().count();
        if self.inner.app.clipboard().write_text(text).is_err() {
            return;
        }
        {
            let mut s = self.lock();
            s.clip.last = Some(h);
            s.clip.note = Some(ClipNote { peer_id: peer_id.to_string(), direction: "in", chars, at: now_ms() });
        }
        self.audit("clipReceive", &name, true, Some(format!("{chars} chars")));
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
            if !enabled || now.is_none() || now == seen {
                // Keep up while off, so switching it on does not send what was copied long ago.
                seen = now;
                continue;
            }
            seen = now;
            if sys_clip::is_sensitive() {
                continue;
            }
            let Ok(text) = self.inner.app.clipboard().read_text() else { continue };
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
