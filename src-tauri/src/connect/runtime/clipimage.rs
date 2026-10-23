//! A picture copied on one machine (a screenshot, "Copy Image") written into
//! the clipboard of the other. It follows the same switches as copied text:
//! sent as soon as it is copied when auto-send is on, or by the button, and
//! taken only where "receive" is on.
//!
//! The picture goes as a PNG. It is too big for the live link (a frame holds
//! 64 KB), so it is kept as a file of our own and fetched the way copied files
//! are, on a connection of its own, for the lease still on the clipboard.

use super::*;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use tauri_plugin_clipboard_manager::ClipboardExt;

/// The most a picture may weigh as PNG, on either side.
pub const MAX_IMAGE: u64 = 25 * 1024 * 1024;
/// Decoded, a picture is width x height x 4 bytes: a small file can still ask
/// for gigabytes, so the size it declares is judged before it is decoded.
const MAX_PIXELS: u64 = 40_000_000;

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
    if png.len() as u64 > MAX_IMAGE {
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

    fn clip_image_dir(&self, name: &str) -> Option<PathBuf> {
        self.inner.app.path().app_cache_dir().ok().map(|d| d.join(name))
    }

    /// Note why a picture did not go, so the panel can say so.
    fn note_image_out(&self, peer_id: &str, bytes: u64, status: &str) {
        self.lock().clip.note = Some(ClipNote { peer_id: peer_id.to_string(), direction: "out", chars: 0, files: 0, image: true, bytes, at: now_ms(), status: status.into() });
        self.publish();
    }

    /// Send the picture on the clipboard to the machine linked with. `manual`
    /// (the button) sends it even if it is the one sent last; the watcher does not.
    pub(super) fn send_clip_image(&self, peer_id: &str, outbox: &mpsc::UnboundedSender<Msg>, manual: bool) -> Result<(), &'static str> {
        let Some(png) = self.read_clip_png() else { return Err("clip_empty") };
        let hash = hash_bytes(&png);
        if !manual && self.lock().clip.last == Some(hash) {
            return Ok(());
        }
        let size = png.len() as u64;
        let (name, supported) = {
            let s = self.lock();
            let peer = s.store.peer(peer_id);
            (peer.map(|p| p.name.clone()).unwrap_or_default(), peer.and_then(|p| p.info.as_ref()).is_some_and(|i| i.has(machine::FEATURE_CLIPIMAGE)))
        };
        if !supported {
            if !manual {
                self.lock().clip.last = Some(hash);
                self.note_image_out(peer_id, size, "unsupported");
            }
            return Err("clipimage_unsupported");
        }
        if let Err(code) = check_png(&png) {
            self.lock().clip.last = Some(hash);
            self.note_image_out(peer_id, size, if code == "clip_image_too_large" { "too_large" } else { "failed" });
            return Err(code);
        }
        // What was announced before is no longer what the clipboard holds.
        self.revoke_clip_files();
        let lease = uuid::Uuid::new_v4().simple().to_string();
        let dir = self.clip_image_dir("clipimage").ok_or("io")?;
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).map_err(|_| "io")?;
        let path = dir.join(format!("{lease}.png"));
        std::fs::write(&path, &png).map_err(|_| "io")?;
        {
            let mut s = self.lock();
            s.clip_out = Some(OutLease { id: lease.clone(), paths: vec![path], peers: std::iter::once(peer_id.to_string()).collect(), image: true });
            s.clip.last = Some(hash);
            s.clip.note = Some(ClipNote { peer_id: peer_id.to_string(), direction: "out", chars: 0, files: 0, image: true, bytes: size, at: now_ms(), status: "sent".into() });
        }
        let _ = outbox.send(Msg::ClipImage { lease, size });
        self.audit("clipImageSend", &name, true, Some(format!("{size} bytes")));
        self.publish();
        Ok(())
    }

    /// The linked machine copied a picture. Gives back why it will not be
    /// written here, or "" when it is on its way: the answer to the sender
    /// follows when the picture has arrived.
    pub(super) fn on_clip_image(&self, peer_id: &str, lease: String, size: u64) -> &'static str {
        let (allowed, peer, targets) = {
            let s = self.lock();
            let Some(p) = s.store.peer(peer_id) else { return "off" };
            (p.clip_receive, p.clone(), targets_for(&s, peer_id, p))
        };
        if !allowed {
            return "off";
        }
        if size == 0 || size > MAX_IMAGE {
            return "too_large";
        }
        let Some(me) = self.me() else { return "failed" };
        if targets.is_empty() {
            return "failed";
        }
        let Some(dir) = self.clip_image_dir("clipimage-in").map(|d| d.join(&lease)) else { return "failed" };
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            let _ = std::fs::remove_dir_all(&dir);
            let fetched = this.fetch_item(&me, &peer, &targets, &lease, 0, &dir, None, Arc::new(Notify::new()), Some(MAX_IMAGE)).await;
            let reason = match fetched {
                Ok(Some(path)) => this.write_received_image(&peer, &PathBuf::from(path)),
                Ok(None) => "failed",
                Err(code) if code == "too_large" => "too_large",
                Err(_) => "failed",
            };
            let _ = std::fs::remove_dir_all(&dir);
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
        let size = bytes.len() as u64;
        {
            let mut s = self.lock();
            // What was just written is not something the user copied: not to be sent back.
            s.clip.own_change = sys_clip::change_count();
            s.clip.last = Some(hash_bytes(&bytes));
            s.clip.note = Some(ClipNote { peer_id: peer.id.clone(), direction: "in", chars: 0, files: 0, image: true, bytes: size, at: now_ms(), status: "delivered".into() });
        }
        self.audit("clipImageReceive", &peer.name, true, Some(format!("{size} bytes")));
        self.publish();
        ""
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
        assert!((huge.len() as u64) < MAX_IMAGE, "small on the wire: {}", huge.len());
        assert_eq!(check_png(&huge), Err("clip_image_too_large"));
    }

    #[test]
    fn too_many_bytes_are_refused_whatever_they_hold() {
        let big = vec![0u8; MAX_IMAGE as usize + 1];
        assert_eq!(check_png(&big), Err("clip_image_too_large"));
    }

    #[test]
    fn the_same_picture_hashes_the_same() {
        let a = encode_png(8, 8, &pixels(8, 8)).unwrap();
        assert_eq!(hash_bytes(&a), hash_bytes(&a.clone()));
        assert_ne!(hash_bytes(&a), hash_bytes(&encode_png(8, 9, &pixels(8, 9)).unwrap()));
    }

    #[test]
    fn a_clip_image_message_round_trips_and_an_older_reader_ignores_it() {
        let m = Msg::ClipImage { lease: "abc".into(), size: 1234 };
        let json = serde_json::to_string(&m).unwrap();
        assert_eq!(serde_json::from_str::<Msg>(&json).unwrap(), m);
        #[derive(Debug, PartialEq, serde::Deserialize)]
        #[serde(tag = "t")]
        enum Older {
            Ping { seq: u64 },
            #[serde(other)]
            Unknown,
        }
        // The same tagging the wire uses, read by a build that does not know ClipImage.
        let tag = serde_json::to_value(&m).unwrap()["t"].clone();
        assert!(tag.is_string(), "{json}");
        assert_eq!(serde_json::from_str::<Older>(&json).unwrap(), Older::Unknown);
    }
}
