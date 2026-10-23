//! What was copied here and is too big for the live link (a frame holds 64 KB):
//! a picture (a screenshot, "Copy Image"), or text together with its HTML (a web
//! page, a Word selection) so the other machine keeps the formatting. Both follow
//! the switches of copied text: sent as soon as they are copied when auto-send is
//! on, or by the button, and taken only where "receive" is on.
//!
//! The bytes are kept as a file of our own and fetched by the other machine the
//! way copied files are, on a connection of its own, for the lease still on the
//! clipboard. A picture is a PNG; rich text is a small JSON file with both forms.

use super::*;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use serde::Deserialize;
use tauri_plugin_clipboard_manager::ClipboardExt;

/// The most a picture or a piece of rich text may weigh, on either side.
pub const MAX_BLOB: u64 = 25 * 1024 * 1024;
/// Decoded, a picture is width x height x 4 bytes: a small file can still ask
/// for gigabytes, so the size it declares is judged before it is decoded.
const MAX_PIXELS: u64 = 40_000_000;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Blob {
    Image,
    Rich,
}

/// Text and the HTML it was copied with.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Rich {
    text: String,
    html: String,
}

fn hash_bytes(bytes: &[u8]) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

/// Width and height from the PNG header, without decoding the picture.
fn png_size(png: &[u8]) -> Option<(u32, u32)> {
    let reader = png::Decoder::new(std::io::Cursor::new(png)).read_info().ok()?;
    let info = reader.info();
    Some((info.width, info.height))
}

/// Why this PNG should not go or be written: nothing there, not a PNG, or too big.
pub fn check_png(png: &[u8]) -> Result<(), &'static str> {
    if png.is_empty() {
        return Err("clip_empty");
    }
    if png.len() as u64 > MAX_BLOB {
        return Err("clip_image_too_large");
    }
    let (w, h) = png_size(png).ok_or("clip_image_invalid")?;
    if u64::from(w) * u64::from(h) > MAX_PIXELS {
        return Err("clip_image_too_large");
    }
    Ok(())
}

fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, width, height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header().ok()?.write_image_data(rgba).ok()?;
    }
    Some(out)
}

/// Identifies the same text and HTML on the clipboard again.
pub(super) fn hash_rich(text: &str, html: &str) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut h);
    html.hash(&mut h);
    h.finish()
}

impl Connect {
    /// The picture on the clipboard as PNG bytes: as the system has it where it
    /// keeps PNG, else read as pixels and encoded.
    fn read_clip_png(&self) -> Option<Vec<u8>> {
        if let Some(png) = sys_clip::image_png() {
            return Some(png);
        }
        let img = self.inner.app.clipboard().read_image().ok()?;
        encode_png(img.width(), img.height(), img.rgba())
    }

    fn blob_dir(&self, name: &str) -> Option<PathBuf> {
        self.inner.app.path().app_cache_dir().ok().map(|d| d.join(name))
    }

    fn peer_can(&self, peer_id: &str, feature: &str) -> bool {
        self.lock().store.peer(peer_id).and_then(|p| p.info.as_ref()).is_some_and(|i| i.has(feature))
    }

    /// Note what happened to something sent, so the panel can say so.
    fn note_blob_out(&self, peer_id: &str, kind: Blob, chars: usize, bytes: u64, status: &str) {
        self.lock().clip.note = Some(ClipNote {
            peer_id: peer_id.to_string(),
            direction: "out",
            chars,
            files: 0,
            image: kind == Blob::Image,
            rich: kind == Blob::Rich,
            bytes,
            at: now_ms(),
            status: status.into(),
        });
        self.publish();
    }

    /// Keep `bytes` as a file, offer it to the peer as a lease and tell it.
    fn announce_blob(&self, peer_id: &str, outbox: &mpsc::UnboundedSender<Msg>, kind: Blob, bytes: &[u8], hash: u64, chars: usize, upgrade: bool) -> Result<(), &'static str> {
        let size = bytes.len() as u64;
        let name = self.lock().store.peer(peer_id).map(|p| p.name.clone()).unwrap_or_default();
        // What was announced before is no longer what the clipboard holds.
        self.revoke_clip_files();
        let lease = uuid::Uuid::new_v4().simple().to_string();
        let dir = self.blob_dir("clipblob").ok_or("io")?;
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).map_err(|_| "io")?;
        let path = dir.join(&lease);
        std::fs::write(&path, bytes).map_err(|_| "io")?;
        {
            let mut s = self.lock();
            s.clip_out = Some(OutLease { id: lease.clone(), paths: vec![path], peers: std::iter::once(peer_id.to_string()).collect(), blob: true });
            s.clip.last = Some(hash);
        }
        self.note_blob_out(peer_id, kind, chars, size, "sent");
        let _ = outbox.send(match kind {
            Blob::Image => Msg::ClipImage { lease, size },
            Blob::Rich => Msg::ClipRich { lease, size, upgrade },
        });
        self.audit(if kind == Blob::Image { "clipImageSend" } else { "clipRichSend" }, &name, true, Some(format!("{size} bytes")));
        Ok(())
    }

    /// Still the announcement written last, and the clipboard has not changed
    /// since it was handled: what arrived late must not overwrite something newer.
    fn blob_is_current(&self, lease: &str) -> bool {
        let s = self.lock();
        s.clip.blob_guard.as_ref().is_some_and(|(l, count)| l == lease && *count == sys_clip::change_count())
    }

    /// Nothing copied stays on disk from an earlier run.
    pub(super) fn purge_blobs(&self) {
        for name in ["clipblob", "clipblob-in"] {
            if let Some(dir) = self.blob_dir(name) {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }

    // -- sending ----------------------------------------------------------------

    /// Send the picture on the clipboard to the machine linked with. `manual`
    /// (the button) sends it even if it is the one sent last; the watcher does not.
    pub(super) fn send_clip_image(&self, peer_id: &str, outbox: &mpsc::UnboundedSender<Msg>, manual: bool) -> Result<(), &'static str> {
        let Some(png) = self.read_clip_png() else { return Err("clip_empty") };
        let hash = hash_bytes(&png);
        if !manual && self.lock().clip.last == Some(hash) {
            return Ok(());
        }
        let size = png.len() as u64;
        if !self.peer_can(peer_id, machine::FEATURE_CLIPIMAGE) {
            if !manual {
                self.lock().clip.last = Some(hash);
                self.note_blob_out(peer_id, Blob::Image, 0, size, "unsupported");
            }
            return Err("clipimage_unsupported");
        }
        if let Err(code) = check_png(&png) {
            self.lock().clip.last = Some(hash);
            self.note_blob_out(peer_id, Blob::Image, 0, size, if code == "clip_image_too_large" { "too_large" } else { "failed" });
            return Err(code);
        }
        self.announce_blob(peer_id, outbox, Blob::Image, &png, hash, 0, false)
    }

    /// Send text that was copied with HTML, so it keeps its formatting. `upgrade`
    /// says the plain text was just sent too. Gives back false when this cannot
    /// be done (the other machine is older, or it is too big).
    pub(super) fn send_clip_rich(&self, peer_id: &str, outbox: &mpsc::UnboundedSender<Msg>, text: &str, html: &str, upgrade: bool) -> bool {
        if !self.peer_can(peer_id, machine::FEATURE_CLIPRICH) {
            return false;
        }
        let Ok(bytes) = serde_json::to_vec(&Rich { text: text.to_string(), html: html.to_string() }) else { return false };
        if bytes.len() as u64 > MAX_BLOB {
            return false;
        }
        self.announce_blob(peer_id, outbox, Blob::Rich, &bytes, hash_rich(text, html), text.chars().count(), upgrade).is_ok()
    }

    // -- receiving --------------------------------------------------------------

    /// The linked machine copied a picture. Gives back why it will not be
    /// written here, or "" when it is on its way: the answer to the sender
    /// follows when the picture has arrived.
    pub(super) fn on_clip_image(&self, peer_id: &str, lease: String, size: u64) -> &'static str {
        self.receive_blob(peer_id, lease, size, Blob::Image, false)
    }

    /// The linked machine copied text with its HTML; as `on_clip_image`.
    pub(super) fn on_clip_rich(&self, peer_id: &str, lease: String, size: u64, upgrade: bool) -> &'static str {
        self.receive_blob(peer_id, lease, size, Blob::Rich, upgrade)
    }

    /// `upgrade`: the plain text of this copy is already here, so when this fails
    /// the sender is not told, and nothing is overwritten.
    fn receive_blob(&self, peer_id: &str, lease: String, size: u64, kind: Blob, upgrade: bool) -> &'static str {
        let (allowed, peer, targets) = {
            let s = self.lock();
            let Some(p) = s.store.peer(peer_id) else { return "off" };
            (p.clip_receive, p.clone(), targets_for(&s, peer_id, p))
        };
        if !allowed {
            return "off";
        }
        if size == 0 || size > MAX_BLOB {
            return "too_large";
        }
        let Some(me) = self.me() else { return "failed" };
        if targets.is_empty() {
            return "failed";
        }
        let Some(dir) = self.blob_dir("clipblob-in").map(|d| d.join(&lease)) else { return "failed" };
        // Only the latest announcement is written, and only if nothing was copied here meanwhile.
        self.lock().clip.blob_guard = Some((lease.clone(), sys_clip::change_count()));
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            let _ = std::fs::remove_dir_all(&dir);
            let fetched = this.fetch_item(&me, &peer, &targets, &lease, 0, &dir, None, Arc::new(Notify::new()), Some(MAX_BLOB)).await;
            let reason = match fetched {
                Ok(Some(_)) if !this.blob_is_current(&lease) => "",
                Ok(Some(path)) => {
                    let path = PathBuf::from(path);
                    match kind {
                        Blob::Image => this.write_received_image(&peer, &path),
                        Blob::Rich => this.write_received_rich(&peer, &path),
                    }
                }
                Ok(None) => "failed",
                Err(code) if code == "too_large" => "too_large",
                Err(_) => "failed",
            };
            let _ = std::fs::remove_dir_all(&dir);
            // A failed upgrade changes nothing for the sender: the plain text was taken.
            if upgrade && !reason.is_empty() {
                return;
            }
            if let Some(outbox) = this.link_outbox(&peer.id) {
                let _ = outbox.send(Msg::ClipAck { ok: reason.is_empty(), reason: reason.into() });
            }
        });
        ""
    }

    /// Put a fetched PNG on this machine's clipboard. Gives back why not, or "".
    fn write_received_image(&self, peer: &Peer, path: &std::path::Path) -> &'static str {
        let Ok(bytes) = std::fs::read(path) else { return "failed" };
        if let Err(code) = check_png(&bytes) {
            self.audit("clipImageReceive", &peer.name, false, Some(code.into()));
            return if code == "clip_image_too_large" { "too_large" } else { "failed" };
        }
        let Ok(image) = tauri::image::Image::from_bytes(&bytes) else { return "failed" };
        if self.inner.app.clipboard().write_image(&image).is_err() {
            return "failed";
        }
        self.wrote(peer, Blob::Image, 0, bytes.len() as u64, hash_bytes(&bytes));
        ""
    }

    /// Put fetched text and HTML on this machine's clipboard. Gives back why not, or "".
    fn write_received_rich(&self, peer: &Peer, path: &std::path::Path) -> &'static str {
        let Ok(bytes) = std::fs::read(path) else { return "failed" };
        let Ok(rich) = serde_json::from_slice::<Rich>(&bytes) else {
            self.audit("clipRichReceive", &peer.name, false, Some("invalid".into()));
            return "failed";
        };
        if self.inner.app.clipboard().write_html(rich.html.clone(), Some(rich.text.clone())).is_err() {
            return "failed";
        }
        self.wrote(peer, Blob::Rich, rich.text.chars().count(), bytes.len() as u64, hash_rich(&rich.text, &rich.html));
        ""
    }

    /// Something from the other machine is on this clipboard now.
    fn wrote(&self, peer: &Peer, kind: Blob, chars: usize, bytes: u64, hash: u64) {
        {
            let mut s = self.lock();
            // What was just written is not something the user copied: not to be sent back.
            s.clip.own_change = sys_clip::change_count();
            s.clip.last = Some(hash);
            s.clip.note = Some(ClipNote {
                peer_id: peer.id.clone(),
                direction: "in",
                chars,
                files: 0,
                image: kind == Blob::Image,
                rich: kind == Blob::Rich,
                bytes,
                at: now_ms(),
                status: "delivered".into(),
            });
        }
        self.audit(if kind == Blob::Image { "clipImageReceive" } else { "clipRichReceive" }, &peer.name, true, Some(format!("{bytes} bytes")));
        self.publish();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pixels(w: u32, h: u32) -> Vec<u8> {
        (0..w * h * 4).map(|i| (i % 251) as u8).collect()
    }

    #[test]
    fn a_png_is_judged_by_its_header_before_it_is_decoded() {
        let ok = encode_png(40, 30, &pixels(40, 30)).unwrap();
        assert_eq!(png_size(&ok), Some((40, 30)));
        assert_eq!(check_png(&ok), Ok(()));
        assert_eq!(check_png(&[]), Err("clip_empty"));
        assert_eq!(check_png(b"not a picture"), Err("clip_image_invalid"));
        // 8000 x 6000 = 48 MP: a small PNG (1 bit per pixel, all white) can claim more than this
        // machine should decode, so it is refused on the header alone.
        let mut huge = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut huge, 8000, 6000);
            enc.set_color(png::ColorType::Grayscale);
            enc.set_depth(png::BitDepth::One);
            enc.write_header().unwrap().write_image_data(&vec![0u8; 8000 / 8 * 6000]).unwrap();
        }
        assert!((huge.len() as u64) < MAX_BLOB, "small on the wire: {}", huge.len());
        assert_eq!(check_png(&huge), Err("clip_image_too_large"));
    }

    #[test]
    fn too_many_bytes_are_refused_whatever_they_hold() {
        let big = vec![0u8; MAX_BLOB as usize + 1];
        assert_eq!(check_png(&big), Err("clip_image_too_large"));
    }

    #[test]
    fn the_same_picture_hashes_the_same() {
        let a = encode_png(8, 8, &pixels(8, 8)).unwrap();
        assert_eq!(hash_bytes(&a), hash_bytes(&a.clone()));
        assert_ne!(hash_bytes(&a), hash_bytes(&encode_png(8, 9, &pixels(8, 9)).unwrap()));
    }

    #[test]
    fn text_and_its_html_travel_together_and_hash_apart_from_plain_text() {
        let rich = Rich { text: "Hello caf\u{e9}".into(), html: "<p>Hello <b>caf\u{e9}</b> 😀</p>".into() };
        let bytes = serde_json::to_vec(&rich).unwrap();
        assert_eq!(serde_json::from_slice::<Rich>(&bytes).unwrap(), rich);
        assert!(serde_json::from_slice::<Rich>(b"{\"text\":\"only\"}").is_err());
        assert_eq!(hash_rich("a", "<p>a</p>"), hash_rich("a", "<p>a</p>"));
        assert_ne!(hash_rich("a", "<p>a</p>"), hash_rich("a", "<b>a</b>"));
        assert_ne!(hash_rich("a", "<p>a</p>"), super::super::clip::hash_of("a"));
    }

    #[test]
    fn the_new_messages_round_trip_and_an_older_reader_ignores_them() {
        #[derive(Debug, PartialEq, serde::Deserialize)]
        #[serde(tag = "t")]
        enum Older {
            Ping { seq: u64 },
            #[serde(other)]
            Unknown,
        }
        for m in [Msg::ClipImage { lease: "abc".into(), size: 1234 }, Msg::ClipRich { lease: "def".into(), size: 99, upgrade: true }] {
            let json = serde_json::to_string(&m).unwrap();
            assert_eq!(serde_json::from_str::<Msg>(&json).unwrap(), m);
            // The same tagging the wire uses, read by a build that does not know the message.
            assert_eq!(serde_json::from_str::<Older>(&json).unwrap(), Older::Unknown, "{json}");
        }
        // A sender that does not know `upgrade` (it is false there) is still understood.
        let plain: Msg = serde_json::from_str(r#"{"t":"clipRich","lease":"x","size":5}"#).unwrap();
        assert_eq!(plain, Msg::ClipRich { lease: "x".into(), size: 5, upgrade: false });
    }
}
