//! Files copied on one machine, pasted on the other. Copying sends only names
//! and sizes (a "lease") over the live link; the bytes are fetched when the
//! other machine asks for them, on a connection of its own, and only for the
//! lease the sender still has on its clipboard. Nothing is stored in between.
//!
//! The asking side can save the items into its downloads folder (a button) or,
//! where the system allows files that are produced when they are pasted, let
//! the paste itself do the fetching (see `lazy_paste`).

use super::*;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use wire::{ClipItem, Frame, OfferFile};

/// Offered items at once: names and sizes must fit one message.
const MAX_ITEMS: usize = 100;
/// How long a machine that does not answer is waited for.
const FETCH_WAIT: Duration = Duration::from_secs(30);

/// What this machine copied and told others about.
pub struct OutLease {
    pub(super) id: String,
    pub(super) paths: Vec<PathBuf>,
    /// Who was told; only they may fetch.
    pub(super) peers: HashSet<String>,
    /// A copied picture, saved as a PNG of our own for the other machine to fetch
    /// (not shown as a transfer, deleted when the clipboard moves on).
    pub(super) image: bool,
}

/// What a linked machine says it copied.
#[derive(Debug, Clone)]
pub struct InLease {
    pub peer_id: String,
    pub lease: String,
    pub items: Vec<ClipItem>,
    pub at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipFilesView {
    pub items: Vec<ClipItem>,
    pub at: u64,
}

pub fn view(l: &InLease) -> ClipFilesView {
    ClipFilesView { items: l.items.clone(), at: l.at }
}

/// Names and sizes of what is on the clipboard: a file is itself, a folder is
/// everything under it. Empty folders and anything that is neither are left out.
fn describe(paths: &[PathBuf]) -> Result<Vec<ClipItem>, &'static str> {
    let mut items = Vec::new();
    let mut total_files = 0usize;
    for path in paths {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let Ok(meta) = std::fs::metadata(path) else { continue };
        if meta.is_file() {
            total_files += 1;
            items.push(ClipItem { name, size: meta.len(), files: 1, dir: false });
        } else if meta.is_dir() {
            let found = walk_dir(path).map_err(|_| "io")?;
            if found.is_empty() {
                continue;
            }
            total_files += found.len();
            items.push(ClipItem { name, size: found.iter().map(|(_, f)| f.size).sum(), files: found.len() as u32, dir: true });
        }
    }
    if items.is_empty() {
        return Err("clip_no_files");
    }
    if items.len() > MAX_ITEMS || total_files > MAX_FILES {
        return Err("too_many_files");
    }
    Ok(items)
}

impl OutLease {
    /// This peer cannot fetch any more.
    pub fn forget(&mut self, peer: &str) {
        self.peers.remove(peer);
    }
}

impl State {
    /// The current lease was announced to this peer.
    pub(super) fn clip_out_told(&self, peer: &str) -> bool {
        self.clip_out.as_ref().is_some_and(|l| l.peers.contains(peer))
    }
}

impl Connect {
    // -- announcing -----------------------------------------------------------

    /// Tell the machine linked with that these files were copied here.
    pub fn clip_files_send_now(&self, peer_id: &str) -> AppResult<()> {
        let outbox = self.link_outbox(peer_id).ok_or_else(|| AppError::new("not_linked"))?;
        if !self.lock().store.peer(peer_id).and_then(|p| p.info.as_ref()).is_some_and(|i| i.has(machine::FEATURE_CLIPFILES)) {
            return Err(AppError::new("clipfiles_unsupported"));
        }
        let paths = sys_clip::file_paths();
        if paths.is_empty() {
            return Err(AppError::new("clip_no_files"));
        }
        self.announce_clip_files(peer_id, &outbox, paths).map_err(AppError::new)
    }

    /// Announce `paths` to a peer, keeping the lease already given for the same
    /// files so everyone told can fetch.
    pub(super) fn announce_clip_files(&self, peer_id: &str, outbox: &mpsc::UnboundedSender<Msg>, paths: Vec<PathBuf>) -> Result<(), &'static str> {
        let items = describe(&paths)?;
        let (lease, name) = {
            let mut s = self.lock();
            let name = s.store.peer(peer_id).map(|p| p.name.clone()).unwrap_or_default();
            let same = s.clip_out.as_ref().is_some_and(|l| l.paths == paths);
            if !same {
                s.clip_out = Some(OutLease { id: uuid::Uuid::new_v4().simple().to_string(), paths: paths.clone(), peers: HashSet::new(), image: false });
            }
            let out = s.clip_out.as_mut().expect("just set");
            out.peers.insert(peer_id.to_string());
            let lease = out.id.clone();
            s.clip.note = Some(ClipNote { peer_id: peer_id.to_string(), direction: "out", chars: 0, files: items.len() as u32, image: false, bytes: 0, at: now_ms(), status: "sent".into() });
            (lease, name)
        };
        let count = items.len();
        let _ = outbox.send(Msg::ClipFiles { lease, items });
        self.audit("clipFilesSend", &name, true, Some(format!("{count} items")));
        self.publish();
        Ok(())
    }

    /// Whether what is on the clipboard now is what was announced.
    pub(super) fn clip_out_is(&self, paths: &[PathBuf]) -> bool {
        self.lock().clip_out.as_ref().is_some_and(|l| l.paths == paths)
    }

    /// The clipboard moved on: tell whoever was told, and stop serving.
    pub(super) fn revoke_clip_files(&self) {
        let (lease, peers) = {
            let mut s = self.lock();
            match s.clip_out.take() {
                Some(l) => {
                    if l.image {
                        for p in &l.paths {
                            let _ = std::fs::remove_file(p);
                        }
                    }
                    (l.id, l.peers)
                }
                None => return,
            }
        };
        for peer in peers {
            if let Some(outbox) = self.link_outbox(&peer) {
                let _ = outbox.send(Msg::ClipFilesGone { lease: lease.clone() });
            }
        }
    }

    // -- being told -----------------------------------------------------------

    /// The linked machine copied files. Gives back why they will not be offered
    /// here, or "" when they are.
    pub(super) fn on_clip_files(&self, peer_id: &str, lease: String, items: Vec<ClipItem>) -> &'static str {
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
        // Names and counts come from the other machine: bounded, and cleaned when the files arrive.
        if items.is_empty() || items.len() > MAX_ITEMS || items.iter().map(|i| i.files as usize).sum::<usize>() > MAX_FILES {
            return "too_large";
        }
        let count = items.len();
        {
            let mut s = self.lock();
            s.clip_in = Some(InLease { peer_id: peer_id.to_string(), lease, items, at: now_ms() });
            s.clip.note = Some(ClipNote { peer_id: peer_id.to_string(), direction: "in", chars: 0, files: count as u32, image: false, bytes: 0, at: now_ms(), status: "delivered".into() });
        }
        self.audit("clipFilesReceive", &name, true, Some(format!("{count} items")));
        self.offer_to_system();
        self.publish();
        ""
    }

    pub(super) fn on_clip_files_gone(&self, peer_id: &str, lease: &str) {
        {
            let mut s = self.lock();
            if s.clip_in.as_ref().is_some_and(|l| l.peer_id == peer_id && l.lease == lease) {
                s.clip_in = None;
            } else {
                return;
            }
        }
        self.withdraw_from_system();
        self.publish();
    }

    /// Put the offered files where the system's own paste can reach them, so
    /// Cmd+V in Finder (or Ctrl+V in Explorer) fetches them when it happens.
    /// Not possible on every system; the button is always there.
    fn offer_to_system(&self) {
        let Some(lease) = self.lock().clip_in.clone() else { return };
        let items: Vec<sys_clip::LazyItem> = lease.items.iter().map(|i| sys_clip::LazyItem { name: i.name.clone(), size: i.size, dir: i.dir }).collect();
        let this = self.clone();
        let l = lease.clone();
        let source: sys_clip::FileSource = Arc::new(move |index| this.paste_item(&l, index));
        let own = sys_clip::set_lazy_files(&items, source);
        // So the watcher does not take this for something the user copied and offer it back.
        self.lock().clip.own_change = own;
    }

    /// Take them back from there, if that is still what the clipboard holds.
    fn withdraw_from_system(&self) {
        let own = self.lock().clip.own_change.take();
        sys_clip::clear_lazy_files(own);
    }

    /// A paste asks for this item: fetch it into a folder of its own and say where
    /// it is. Blocks until it has arrived (or failed), as the system's paste waits for it.
    fn paste_item(&self, lease: &InLease, index: usize) -> Option<PathBuf> {
        let (peer, targets) = {
            let s = self.lock();
            // Still what the other machine has copied?
            if !s.clip_in.as_ref().is_some_and(|l| l.lease == lease.lease) {
                return None;
            }
            let peer = s.store.peer(&lease.peer_id)?.clone();
            let targets = targets_for(&s, &lease.peer_id, &peer);
            (peer, targets)
        };
        if targets.is_empty() {
            return None;
        }
        let me = self.me()?;
        let dir = self.inner.app.path().app_cache_dir().ok()?.join("clipfiles").join(&lease.lease).join(index.to_string());
        let _ = std::fs::remove_dir_all(&dir);
        let item = lease.items.get(index)?;
        let (tid, t) = Self::new_transfer(&lease.peer_id, &peer.name, true, vec![OfferFile { name: item.name.clone(), size: item.size }], "active");
        let cancel = t.cancel.clone();
        self.add_transfer(t);
        self.publish();
        let result = tauri::async_runtime::block_on(self.fetch_item(&me, &peer, &targets, &lease.lease, index as u32, &dir, Some(&tid), cancel, None));
        match result {
            Ok(path) => {
                self.with_transfer(&tid, |t| t.saved_to = path.clone());
                self.audit("receive", &peer.name, true, Some("pasted".into()));
                self.set_stage(&tid, "done", None);
                path.map(PathBuf::from)
            }
            Err(code) => {
                let stage = if code == "canceled" { "canceled" } else { "failed" };
                self.audit("receive", &peer.name, false, Some(code.clone()));
                self.set_stage(&tid, stage, (stage == "failed").then_some(code));
                None
            }
        }
    }

    // -- saving them ------------------------------------------------------------

    /// Fetch everything the linked machine copied into the downloads folder.
    pub fn clip_files_save(&self, peer_id: &str) -> AppResult<()> {
        let (peer, targets, lease) = {
            let s = self.lock();
            if s.run.is_none() {
                return Err(AppError::new("connect_off"));
            }
            let lease = s.clip_in.clone().filter(|l| l.peer_id == peer_id).ok_or_else(|| AppError::new("no_clip_files"))?;
            let peer = s.store.peer(peer_id).ok_or_else(|| AppError::new("peer_not_found"))?.clone();
            let targets = targets_for(&s, peer_id, &peer);
            if targets.is_empty() {
                return Err(AppError::new("peer_not_found"));
            }
            (peer, targets, lease)
        };
        let me = self.me().ok_or_else(|| AppError::new("keychain"))?;
        let files: Vec<OfferFile> = lease.items.iter().map(|i| OfferFile { name: i.name.clone(), size: i.size }).collect();
        let (tid, t) = Self::new_transfer(peer_id, &peer.name, true, files, "active");
        let cancel = t.cancel.clone();
        self.add_transfer(t);
        self.publish();
        let this = self.clone();
        let dir = self.download_dir();
        tauri::async_runtime::spawn(async move {
            let mut first: Option<String> = None;
            let mut result = Ok(());
            for index in 0..lease.items.len() {
                match this.fetch_item(&me, &peer, &targets, &lease.lease, index as u32, &dir, Some(&tid), cancel.clone(), None).await {
                    Ok(path) => first = first.or(path),
                    Err(code) => {
                        result = Err(code);
                        break;
                    }
                }
            }
            match result {
                Ok(()) => {
                    this.with_transfer(&tid, |t| t.saved_to = first);
                    this.audit("receive", &peer.name, true, Some(format!("{} items", lease.items.len())));
                    this.set_stage(&tid, "done", None);
                }
                Err(code) => {
                    let stage = if code == "canceled" { "canceled" } else { "failed" };
                    this.audit("receive", &peer.name, false, Some(code.clone()));
                    this.set_stage(&tid, stage, (stage == "failed").then_some(code));
                }
            }
        });
        Ok(())
    }

    /// Ask the machine that copied for one item and take it into `dir`. Gives
    /// back where it landed (the folder, for a folder). `tid` is the transfer
    /// to show progress on.
    pub(super) async fn fetch_item(&self, me: &Me, peer: &Peer, targets: &[SocketAddrV4], lease: &str, item: u32, dir: &Path, tid: Option<&str>, cancel: Arc<Notify>, max_bytes: Option<u64>) -> Result<Option<String>, String> {
        let (stream, _used) = tokio::select! {
            r = connect_any(targets) => r.map_err(|f| f.code().to_string())?,
            _ = cancel.notified() => return Err("canceled".into()),
        };
        let est = tokio::time::timeout(HANDSHAKE_TIMEOUT, wire::initiate(stream, &me.key)).await.map_err(|_| "no_reply".to_string())?.map_err(|_| "handshake_failed".to_string())?;
        if hex(&est.remote_static) != peer.public_key {
            return Err("key_changed".into());
        }
        let (mut tx, mut rx) = est.channel.split();
        tx.send(&Msg::Hello { id: me.id.clone(), name: me.name.clone(), os: std::env::consts::OS.into(), version: VERSION, intent: Intent::Fetch, macs: vec![] }).await.map_err(|_| "connection_lost".to_string())?;
        match tokio::time::timeout(HANDSHAKE_TIMEOUT, rx.recv()).await.map_err(|_| "no_reply".to_string())?.map_err(|_| "connection_lost".to_string())? {
            Msg::Hello { id, version, .. } if id == peer.id && version == VERSION => {}
            Msg::Refuse { code } => return Err(format!("refused_{code}")),
            _ => return Err("handshake_failed".into()),
        }
        let mut msgs = spawn_frame_reader(rx);
        tx.send(&Msg::Want { lease: lease.to_string(), item }).await.map_err(|_| "connection_lost".to_string())?;

        // What it will send: names are the other machine's to choose, never ours to trust.
        let mut offered: Vec<OfferFile> = Vec::new();
        loop {
            match tokio::time::timeout(FETCH_WAIT, msgs.recv()).await {
                Ok(Some(Frame::Msg(Msg::Offer { files, more }))) => {
                    offered.extend(files);
                    if offered.len() > MAX_FILES {
                        return Err("too_many_files".into());
                    }
                    if !more {
                        break;
                    }
                }
                Ok(Some(Frame::Msg(Msg::Refuse { code }))) => return Err(format!("refused_{code}")),
                _ => return Err("connection_lost".into()),
            }
        }
        let mut files = Vec::with_capacity(offered.len());
        for f in offered {
            let name = super::transfer::sanitize_rel(&f.name).ok_or_else(|| "protocol".to_string())?;
            if f.size >= (1u64 << 50) {
                return Err("protocol".into());
            }
            files.push(OfferFile { name, size: f.size });
        }
        if files.is_empty() {
            return Err("protocol".into());
        }
        // The size is the other machine's to claim: judged before anything is accepted.
        if max_bytes.is_some_and(|max| files.iter().map(|f| f.size).sum::<u64>() > max) {
            return Err("too_large".into());
        }
        tx.send(&Msg::Accept).await.map_err(|_| "connection_lost".to_string())?;
        let first = pull_files(&mut tx, &mut msgs, &files, dir, &cancel, |bytes, index| {
            if let Some(tid) = tid {
                self.progress(tid, bytes, index);
            }
        })
        .await?;
        let _ = tx.send(&Msg::Bye).await;
        Ok(first)
    }

    // -- serving them -----------------------------------------------------------

    /// A paired machine asks for one item of what was copied here.
    pub(super) async fn accept_fetch(&self, mut tx: Sender<Stream>, mut rx: Receiver<Stream>, peer: Peer) {
        let Ok(Ok(Msg::Want { lease, item })) = tokio::time::timeout(HANDSHAKE_TIMEOUT, rx.recv()).await else { return };
        // Only the lease still on the clipboard, only for whoever was told, only by position.
        let found = {
            let s = self.lock();
            s.clip_out.as_ref().filter(|l| l.id == lease && l.peers.contains(&peer.id)).and_then(|l| l.paths.get(item as usize).cloned().map(|p| (p, l.image)))
        };
        let Some((path, image)) = found else {
            let _ = tx.send(&Msg::Refuse { code: "gone".into() }).await;
            return;
        };
        let listed = tokio::task::spawn_blocking(move || -> std::io::Result<Vec<(PathBuf, OfferFile)>> {
            let meta = std::fs::metadata(&path)?;
            if meta.is_dir() {
                walk_dir(&path)
            } else {
                let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
                Ok(vec![(path, OfferFile { name, size: meta.len() })])
            }
        })
        .await;
        let Ok(Ok(files)) = listed else {
            let _ = tx.send(&Msg::Refuse { code: "gone".into() }).await;
            return;
        };
        if files.is_empty() || files.len() > MAX_FILES {
            let _ = tx.send(&Msg::Refuse { code: "gone".into() }).await;
            return;
        }
        let offered: Vec<OfferFile> = files.iter().map(|(_, f)| f.clone()).collect();
        let batches = offer_batches(&offered);
        let last = batches.len() - 1;
        for (i, batch) in batches.into_iter().enumerate() {
            if tx.send(&Msg::Offer { files: batch, more: i < last }).await.is_err() {
                return;
            }
        }
        let mut msgs = spawn_frame_reader(rx);
        match tokio::time::timeout(FETCH_WAIT, msgs.recv()).await {
            Ok(Some(Frame::Msg(Msg::Accept))) => {}
            _ => return,
        }
        // A copied picture is one more clipboard sync, not a transfer worth a row of its own.
        let (tid, cancel) = if image {
            (None, Arc::new(Notify::new()))
        } else {
            let (tid, t) = Self::new_transfer(&peer.id, &peer.name, false, offered, "active");
            let cancel = t.cancel.clone();
            self.add_transfer(t);
            self.publish();
            (Some(tid), cancel)
        };
        let result = push_files(&mut tx, &mut msgs, &files, &cancel, |bytes, index| {
            if let Some(tid) = &tid {
                self.progress(tid, bytes, index);
            }
        })
        .await;
        let Some(tid) = tid else { return };
        match result {
            Ok(()) => {
                self.audit("send", &peer.name, true, Some(format!("{} files", files.len())));
                self.set_stage(&tid, "done", None);
            }
            Err(code) => {
                let stage = if code == "canceled" { "canceled" } else { "failed" };
                self.audit("send", &peer.name, false, Some(code.clone()));
                self.set_stage(&tid, stage, (stage == "failed").then_some(code));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("portway-clipfiles-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_file_and_a_folder_are_described_by_name_and_size() {
        let d = temp("describe");
        std::fs::write(d.join("a.txt"), b"hello").unwrap();
        std::fs::create_dir_all(d.join("dir/sub")).unwrap();
        std::fs::write(d.join("dir/b.bin"), vec![0u8; 10]).unwrap();
        std::fs::write(d.join("dir/sub/c.bin"), vec![0u8; 20]).unwrap();
        std::fs::create_dir_all(d.join("empty")).unwrap();
        let items = describe(&[d.join("a.txt"), d.join("dir"), d.join("empty"), d.join("missing")]).unwrap();
        assert_eq!(
            items,
            vec![
                ClipItem { name: "a.txt".into(), size: 5, files: 1, dir: false },
                ClipItem { name: "dir".into(), size: 30, files: 2, dir: true },
            ]
        );
        assert_eq!(describe(&[d.join("empty")]), Err("clip_no_files"));
        assert_eq!(describe(&[]), Err("clip_no_files"));
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn too_many_items_are_refused_before_anything_is_sent() {
        let d = temp("many");
        let mut paths = Vec::new();
        for i in 0..=MAX_ITEMS {
            let p = d.join(format!("f{i}"));
            std::fs::write(&p, b"x").unwrap();
            paths.push(p);
        }
        assert_eq!(describe(&paths), Err("too_many_files"));
        std::fs::remove_dir_all(d).ok();
    }
}
