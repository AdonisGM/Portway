//! Sending files to a paired machine and receiving them. Each transfer is its
//! own encrypted connection (not the live link), opened to a machine whose key
//! is in the paired list. The receiver's user is always asked first; the bytes
//! go in order, each file closed by its BLAKE2s hash, which the receiver checks
//! before the file gets its real name.

use super::*;
use crate::settings::SettingsStore;
use blake2::{Blake2s256, Digest};
use std::path::{Path, PathBuf};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::oneshot;
use wire::{Frame, OfferFile, MAX_DATA};

/// Most transfers kept in the list, finished ones dropping off first.
const KEEP: usize = 30;
/// Offers waiting for the user at once; more are refused as busy.
const MAX_PENDING_OFFERS: usize = 3;
pub(super) const MAX_FILES: usize = 20_000;
/// A frame holds about 64 KB; an offer message stays well under that.
const OFFER_BATCH_BYTES: usize = 40_000;
const OFFER_WAIT: Duration = Duration::from_secs(120);

pub struct Transfer {
    id: String,
    peer_id: String,
    peer_name: String,
    receiving: bool,
    files: Vec<OfferFile>,
    stage: &'static str,
    done: u64,
    total: u64,
    current: usize,
    rate: f64,
    error: Option<String>,
    pub(super) saved_to: Option<String>,
    since: u64,
    last_publish: Instant,
    rate_at: Instant,
    rate_bytes: u64,
    pub(super) cancel: Arc<Notify>,
    decide: Option<oneshot::Sender<bool>>,
}

impl Transfer {
    fn finished(&self) -> bool {
        matches!(self.stage, "done" | "failed" | "declined" | "canceled")
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileView {
    pub name: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferView {
    pub id: String,
    pub peer_id: String,
    pub peer_name: String,
    /// "send" or "receive".
    pub direction: &'static str,
    /// The first few files; `file_count` is how many there are.
    pub files: Vec<FileView>,
    pub file_count: usize,
    pub total: u64,
    pub done: u64,
    /// Index of the file in progress.
    pub current: usize,
    /// "offering" (the receiver is asked), "waiting" (for the receiver's answer),
    /// "active", "done", "failed", "declined", "canceled".
    pub stage: &'static str,
    /// Bytes per second, smoothed.
    pub rate: f64,
    pub error: Option<String>,
    /// Where the first received file was saved.
    pub saved_to: Option<String>,
    pub since: u64,
}

pub fn view(t: &Transfer) -> TransferView {
    TransferView {
        id: t.id.clone(),
        peer_id: t.peer_id.clone(),
        peer_name: t.peer_name.clone(),
        direction: if t.receiving { "receive" } else { "send" },
        files: t.files.iter().take(20).map(|f| FileView { name: f.name.clone(), size: f.size }).collect(),
        file_count: t.files.len(),
        total: t.total,
        done: t.done,
        current: t.current,
        stage: t.stage,
        rate: t.rate,
        error: t.error.clone(),
        saved_to: t.saved_to.clone(),
        since: t.since,
    }
}

/// A file name that is safe to create in the receiver's folder: no folders in
/// it, nothing Windows would refuse, never empty.
pub fn sanitize_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or("");
    let mut clean: String = last.chars().map(|c| if c.is_control() || "<>:\"|?*".contains(c) { '_' } else { c }).collect();
    clean = clean.trim_matches([' ', '.']).to_string();
    if clean.chars().count() > 200 {
        clean = clean.chars().take(200).collect();
    }
    let stem = clean.split('.').next().unwrap_or("").to_ascii_uppercase();
    const RESERVED: [&str; 22] = ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"];
    if clean.is_empty() {
        return "file".to_string();
    }
    if RESERVED.contains(&stem.as_str()) {
        clean.insert(0, '_');
    }
    clean
}

/// `dir/name`, or `dir/name (1).ext`, `(2)`… when that exists.
pub fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.').filter(|i| *i > 0) {
        Some(i) => (&name[..i], &name[i..]),
        None => (name, ""),
    };
    (1..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .expect("an unused name")
}

/// A path received from the other machine, made safe: every part cleaned the
/// way a file name is, and refused outright when it tries to climb out (`..`)
/// or is empty or absurdly deep.
pub fn sanitize_rel(path: &str) -> Option<String> {
    let parts: Vec<&str> = path.split('/').collect();
    if parts.is_empty() || parts.len() > 32 || parts.iter().any(|p| p.is_empty() || *p == "." || *p == "..") {
        return None;
    }
    Some(parts.iter().map(|p| sanitize_name(p)).collect::<Vec<_>>().join("/"))
}

/// The offer cut into messages that each fit in a frame.
pub(super) fn offer_batches(files: &[OfferFile]) -> Vec<Vec<OfferFile>> {
    let mut out: Vec<Vec<OfferFile>> = vec![Vec::new()];
    let mut used = 0;
    for f in files {
        let cost = 2 * f.name.len() + 60;
        if used + cost > OFFER_BATCH_BYTES && !out.last().unwrap().is_empty() {
            out.push(Vec::new());
            used = 0;
        }
        used += cost;
        out.last_mut().unwrap().push(f.clone());
    }
    out
}

/// Every regular file under `root`, named `root_name/relative/path`. Links
/// and special files are skipped, and so are empty folders (nothing to send).
pub(super) fn walk_dir(root: &Path) -> std::io::Result<Vec<(PathBuf, OfferFile)>> {
    let base = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "folder".into());
    let mut out = Vec::new();
    let mut stack = vec![(root.to_path_buf(), base)];
    while let Some((dir, rel)) = stack.pop() {
        let mut entries: Vec<_> = std::fs::read_dir(&dir)?.filter_map(Result::ok).collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let Ok(kind) = e.file_type() else { continue };
            let name = format!("{rel}/{}", e.file_name().to_string_lossy());
            if kind.is_dir() {
                stack.push((e.path(), name));
            } else if kind.is_file() {
                if let Ok(meta) = e.metadata() {
                    out.push((e.path(), OfferFile { name, size: meta.len() }));
                }
            }
            if out.len() > MAX_FILES {
                return Ok(out);
            }
        }
    }
    out.sort_by(|a, b| a.1.name.cmp(&b.1.name));
    Ok(out)
}

/// Frames on their own task into a bounded queue: waiting for one never cuts a
/// frame in half when another event wins a `select!`, and a slow disk slows the
/// sender down instead of piling bytes up in memory.
pub(super) fn spawn_frame_reader<S: AsyncRead + Send + 'static>(mut rx: Receiver<S>) -> mpsc::Receiver<Frame> {
    let (tx, out) = mpsc::channel(64);
    tokio::spawn(async move {
        while let Ok(f) = rx.recv_frame().await {
            if tx.send(f).await.is_err() {
                break;
            }
        }
    });
    out
}

/// Send the files, one after another, each closed by its hash. Ends when the
/// receiver has confirmed the last one. `progress` hears about every chunk.
pub(super) async fn push_files<S: AsyncRead + AsyncWrite>(
    tx: &mut Sender<S>,
    msgs: &mut mpsc::Receiver<Frame>,
    files: &[(PathBuf, OfferFile)],
    cancel: &Notify,
    mut progress: impl FnMut(u64, usize),
) -> Result<(), String> {
    let mut buf = vec![0u8; MAX_DATA];
    for (index, (path, offer)) in files.iter().enumerate() {
        let mut file = tokio::fs::File::open(path).await.map_err(|_| "io".to_string())?;
        let mut hasher = Blake2s256::new();
        let mut remaining = offer.size;
        progress(0, index);
        while remaining > 0 {
            let want = (remaining as usize).min(MAX_DATA);
            let n = tokio::select! {
                biased;
                _ = cancel.notified() => {
                    let _ = tx.send(&Msg::Cancel).await;
                    return Err("canceled".into());
                }
                r = file.read(&mut buf[..want]) => r.map_err(|_| "io".to_string())?,
            };
            if n == 0 {
                // Shorter than when it was offered.
                let _ = tx.send(&Msg::Cancel).await;
                return Err("file_changed".into());
            }
            hasher.update(&buf[..n]);
            tx.send_data(&buf[..n]).await.map_err(|_| "connection_lost".to_string())?;
            remaining -= n as u64;
            progress(n as u64, index);
            // The receiver may have stopped meanwhile.
            match msgs.try_recv() {
                Ok(Frame::Msg(Msg::Cancel)) => return Err("canceled".into()),
                Err(mpsc::error::TryRecvError::Disconnected) => return Err("connection_lost".into()),
                _ => {}
            }
        }
        tx.send(&Msg::FileEnd { hash: hex(&hasher.finalize()) }).await.map_err(|_| "connection_lost".to_string())?;
        match tokio::time::timeout(Duration::from_secs(60), msgs.recv()).await {
            Ok(Some(Frame::Msg(Msg::FileOk { ok: true }))) => {}
            Ok(Some(Frame::Msg(Msg::FileOk { ok: false }))) => return Err("hash_mismatch".into()),
            Ok(Some(Frame::Msg(Msg::Cancel))) => return Err("canceled".into()),
            _ => return Err("connection_lost".into()),
        }
    }
    Ok(())
}

/// Take the offered files into `dir`. A file is written under a temporary
/// name and gets its real one only after its hash matched; a failure leaves
/// nothing behind. Returns where the first file went.
pub(super) async fn pull_files<S: AsyncRead + AsyncWrite>(
    tx: &mut Sender<S>,
    msgs: &mut mpsc::Receiver<Frame>,
    files: &[OfferFile],
    dir: &Path,
    cancel: &Notify,
    mut progress: impl FnMut(u64, usize),
) -> Result<Option<String>, String> {
    tokio::fs::create_dir_all(dir).await.map_err(|_| "io".to_string())?;
    let mut first = None;
    // A picked folder lands in one folder of its own, renamed when that name is taken.
    let mut roots: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for (index, offer) in files.iter().enumerate() {
        let mut parts: Vec<&str> = offer.name.split('/').collect();
        let leaf = parts.pop().unwrap_or("file").to_string();
        let mut target = dir.to_path_buf();
        let mut root_dir = None;
        if let Some(top) = parts.first() {
            let mapped = roots.entry((*top).to_string()).or_insert_with(|| unique_path(dir, top).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| (*top).to_string())).clone();
            target = dir.join(&mapped);
            root_dir = Some(target.clone());
            for p in &parts[1..] {
                target.push(p);
            }
            tokio::fs::create_dir_all(&target).await.map_err(|_| "io".to_string())?;
        }
        let part = unique_path(&target, &format!("{leaf}.portway-part"));
        let mut file = tokio::fs::File::create(&part).await.map_err(|_| "io".to_string())?;
        let result = pull_one(tx, msgs, offer, index, &mut file, cancel, &mut progress).await;
        if let Err(code) = result {
            drop(file);
            let _ = tokio::fs::remove_file(&part).await;
            return Err(code);
        }
        file.flush().await.map_err(|_| "io".to_string())?;
        drop(file);
        let final_path = unique_path(&target, &leaf);
        tokio::fs::rename(&part, &final_path).await.map_err(|_| "io".to_string())?;
        if index == 0 {
            first = Some(root_dir.unwrap_or(final_path).to_string_lossy().into_owned());
        }
        tx.send(&Msg::FileOk { ok: true }).await.map_err(|_| "connection_lost".to_string())?;
    }
    Ok(first)
}

async fn pull_one<S: AsyncRead + AsyncWrite>(
    tx: &mut Sender<S>,
    msgs: &mut mpsc::Receiver<Frame>,
    offer: &OfferFile,
    index: usize,
    file: &mut tokio::fs::File,
    cancel: &Notify,
    progress: &mut impl FnMut(u64, usize),
) -> Result<(), String> {
    let mut hasher = Blake2s256::new();
    let mut received = 0u64;
    progress(0, index);
    while received < offer.size {
        tokio::select! {
            biased;
            _ = cancel.notified() => {
                let _ = tx.send(&Msg::Cancel).await;
                return Err("canceled".into());
            }
            m = msgs.recv() => match m {
                Some(Frame::Data(d)) => {
                    received += d.len() as u64;
                    if received > offer.size {
                        return Err("protocol".into());
                    }
                    hasher.update(&d);
                    file.write_all(&d).await.map_err(|_| "io".to_string())?;
                    progress(d.len() as u64, index);
                }
                Some(Frame::Msg(Msg::Cancel)) => return Err("canceled".into()),
                _ => return Err("connection_lost".into()),
            },
        }
    }
    let hash = match tokio::time::timeout(Duration::from_secs(30), msgs.recv()).await {
        Ok(Some(Frame::Msg(Msg::FileEnd { hash }))) => hash,
        Ok(Some(Frame::Msg(Msg::Cancel))) => return Err("canceled".into()),
        _ => return Err("connection_lost".into()),
    };
    if hash != hex(&hasher.finalize()) {
        let _ = tx.send(&Msg::FileOk { ok: false }).await;
        return Err("hash_mismatch".into());
    }
    Ok(())
}

impl Connect {
    pub(super) fn download_dir(&self) -> PathBuf {
        let configured = self.inner.app.state::<SettingsStore>().get().download_dir.map(|d| crate::paths::expand_tilde(&d));
        configured.filter(|d| d.is_dir()).or_else(|| self.inner.app.path().download_dir().ok()).unwrap_or_else(crate::paths::home_dir)
    }

    pub(super) fn with_transfer<R>(&self, id: &str, f: impl FnOnce(&mut Transfer) -> R) -> Option<R> {
        self.lock().transfers.iter_mut().find(|t| t.id == id).map(f)
    }

    pub(super) fn set_stage(&self, id: &str, stage: &'static str, error: Option<String>) {
        self.with_transfer(id, |t| {
            t.stage = stage;
            t.error = error;
            t.decide = None;
            if t.stage == "done" {
                t.rate = 0.0;
            }
        });
        self.publish();
    }

    pub(super) fn add_transfer(&self, t: Transfer) {
        let mut s = self.lock();
        s.transfers.push(t);
        // Make room: drop the oldest finished ones.
        while s.transfers.len() > KEEP {
            match s.transfers.iter().position(Transfer::finished) {
                Some(i) => {
                    s.transfers.remove(i);
                }
                None => break,
            }
        }
    }

    pub(super) fn progress(&self, id: &str, bytes: u64, index: usize) {
        let publish = self
            .with_transfer(id, |t| {
                t.done += bytes;
                t.current = index;
                let now = Instant::now();
                let dt = now.duration_since(t.rate_at).as_secs_f64();
                if dt >= 0.5 {
                    let inst = (t.done - t.rate_bytes) as f64 / dt;
                    t.rate = if t.rate == 0.0 { inst } else { 0.6 * t.rate + 0.4 * inst };
                    t.rate_at = now;
                    t.rate_bytes = t.done;
                }
                if now.duration_since(t.last_publish) >= Duration::from_millis(250) {
                    t.last_publish = now;
                    true
                } else {
                    false
                }
            })
            .unwrap_or(false);
        if publish {
            self.publish();
        }
    }

    pub(super) fn new_transfer(peer_id: &str, peer_name: &str, receiving: bool, files: Vec<OfferFile>, stage: &'static str) -> (String, Transfer) {
        let id = uuid::Uuid::new_v4().simple().to_string();
        let total = files.iter().map(|f| f.size).sum();
        let now = Instant::now();
        let t = Transfer {
            id: id.clone(),
            peer_id: peer_id.to_string(),
            peer_name: peer_name.to_string(),
            receiving,
            files,
            stage,
            done: 0,
            total,
            current: 0,
            rate: 0.0,
            error: None,
            saved_to: None,
            since: now_ms(),
            last_publish: now,
            rate_at: now,
            rate_bytes: 0,
            cancel: Arc::new(Notify::new()),
            decide: None,
        };
        (id, t)
    }

    // -- sending ------------------------------------------------------------------

    /// Offer these files to a paired machine; it answers when its user does.
    pub fn send_files(&self, peer_id: &str, paths: Vec<String>) -> AppResult<()> {
        if paths.is_empty() {
            return Err(AppError::new("no_files"));
        }
        let mut files = Vec::new();
        for p in &paths {
            let path = crate::paths::expand_tilde(p);
            let meta = std::fs::metadata(&path).map_err(|e| AppError::detail("io", format!("{p}: {e}")))?;
            if meta.is_dir() {
                let found = walk_dir(&path).map_err(|e| AppError::detail("io", format!("{p}: {e}")))?;
                if found.is_empty() {
                    return Err(AppError::detail("empty_folder", p));
                }
                files.extend(found);
            } else if meta.is_file() {
                let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
                files.push((path, OfferFile { name, size: meta.len() }));
            } else {
                return Err(AppError::detail("not_a_file", p));
            }
        }
        if files.len() > MAX_FILES {
            return Err(AppError::new("too_many_files"));
        }
        let (peer, targets) = {
            let s = self.lock();
            if s.run.is_none() {
                return Err(AppError::new("connect_off"));
            }
            let peer = s.store.peer(peer_id).ok_or_else(|| AppError::new("peer_not_found"))?.clone();
            let targets = targets_for(&s, peer_id, &peer);
            if targets.is_empty() {
                return Err(AppError::new("peer_not_found"));
            }
            (peer, targets)
        };
        let me = self.me().ok_or_else(|| AppError::new("keychain"))?;
        let (tid, t) = Self::new_transfer(peer_id, &peer.name, false, files.iter().map(|(_, f)| f.clone()).collect(), "waiting");
        let cancel = t.cancel.clone();
        self.add_transfer(t);
        self.publish();
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            let result = this.send_inner(&tid, &me, &peer, targets, &files, cancel).await;
            match result {
                Ok(()) => {
                    this.audit("send", &peer.name, true, Some(format!("{} files", files.len())));
                    this.set_stage(&tid, "done", None);
                }
                Err(code) => {
                    let stage = match code.as_str() {
                        "canceled" => "canceled",
                        "declined" => "declined",
                        _ => "failed",
                    };
                    this.audit("send", &peer.name, false, Some(code.clone()));
                    this.set_stage(&tid, stage, (stage == "failed").then_some(code));
                }
            }
        });
        Ok(())
    }

    async fn send_inner(&self, tid: &str, me: &Me, peer: &Peer, targets: Vec<SocketAddrV4>, files: &[(PathBuf, OfferFile)], cancel: Arc<Notify>) -> Result<(), String> {
        let (stream, _used) = tokio::select! {
            r = connect_any(&targets) => r.map_err(|f| f.code().to_string())?,
            _ = cancel.notified() => return Err("canceled".into()),
        };
        let est = tokio::time::timeout(HANDSHAKE_TIMEOUT, wire::initiate(stream, &me.key)).await.map_err(|_| "no_reply".to_string())?.map_err(|_| "handshake_failed".to_string())?;
        if hex(&est.remote_static) != peer.public_key {
            return Err("key_changed".into());
        }
        let (mut tx, mut rx) = est.channel.split();
        tx.send(&Msg::Hello { id: me.id.clone(), name: me.name.clone(), os: std::env::consts::OS.into(), version: VERSION, intent: Intent::Send, macs: vec![] }).await.map_err(|_| "connection_lost".to_string())?;
        match tokio::time::timeout(HANDSHAKE_TIMEOUT, rx.recv()).await.map_err(|_| "no_reply".to_string())?.map_err(|_| "connection_lost".to_string())? {
            Msg::Hello { id, version, .. } if id == peer.id && version == VERSION => {}
            Msg::Refuse { code } => return Err(format!("refused_{code}")),
            _ => return Err("handshake_failed".into()),
        }
        let mut msgs = spawn_frame_reader(rx);
        let offered: Vec<OfferFile> = files.iter().map(|(_, f)| f.clone()).collect();
        let batches = offer_batches(&offered);
        let last = batches.len() - 1;
        for (i, batch) in batches.into_iter().enumerate() {
            tx.send(&Msg::Offer { files: batch, more: i < last }).await.map_err(|_| "connection_lost".to_string())?;
        }

        // The receiver's user decides; wait for the answer.
        tokio::select! {
            m = msgs.recv() => match m {
                Some(Frame::Msg(Msg::Accept)) => {}
                Some(Frame::Msg(Msg::Refuse { code })) if code == "declined" || code == "timeout" => return Err("declined".into()),
                Some(Frame::Msg(Msg::Refuse { code })) => return Err(format!("refused_{code}")),
                Some(Frame::Msg(Msg::Cancel)) => return Err("declined".into()),
                _ => return Err("connection_lost".into()),
            },
            _ = cancel.notified() => {
                let _ = tx.send(&Msg::Cancel).await;
                return Err("canceled".into());
            }
            _ = tokio::time::sleep(OFFER_WAIT + Duration::from_secs(10)) => return Err("declined".into()),
        }
        self.set_stage(tid, "active", None);

        push_files(&mut tx, &mut msgs, files, &cancel, |bytes, index| self.progress(tid, bytes, index)).await?;
        let _ = tx.send(&Msg::Bye).await;
        Ok(())
    }

    // -- receiving ----------------------------------------------------------------

    /// A paired machine wants to hand over files. Ask the user, then take them.
    pub(super) async fn accept_send(&self, mut tx: Sender<Stream>, mut rx: Receiver<Stream>, peer: Peer) {
        let Ok(Ok(Msg::Offer { files: mut offered, mut more })) = tokio::time::timeout(HANDSHAKE_TIMEOUT, rx.recv()).await else { return };
        while more && offered.len() <= MAX_FILES {
            let Ok(Ok(Msg::Offer { files: next, more: again })) = tokio::time::timeout(HANDSHAKE_TIMEOUT, rx.recv()).await else { return };
            offered.extend(next);
            more = again;
        }
        // Names are the sender's to choose, never ours to trust.
        let cleaned: Vec<Option<OfferFile>> = offered.into_iter().map(|f| sanitize_rel(&f.name).map(|name| OfferFile { name, size: f.size })).collect();
        let sane = !more && !cleaned.is_empty() && cleaned.len() <= MAX_FILES && cleaned.iter().all(|f| f.as_ref().is_some_and(|f| f.size < (1u64 << 50)));
        let pending = self.lock().transfers.iter().filter(|t| t.receiving && t.stage == "offering").count();
        if !sane || pending >= MAX_PENDING_OFFERS {
            let _ = tx.send(&Msg::Refuse { code: if sane { "busy" } else { "bad_offer" }.into() }).await;
            return;
        }
        let files: Vec<OfferFile> = cleaned.into_iter().flatten().collect();
        let (decide_tx, decide_rx) = oneshot::channel();
        let (tid, mut t) = Self::new_transfer(&peer.id, &peer.name, true, files.clone(), "offering");
        t.decide = Some(decide_tx);
        let cancel = t.cancel.clone();
        self.add_transfer(t);
        self.publish();

        let mut msgs = spawn_frame_reader(rx);
        let accepted = tokio::select! {
            d = decide_rx => d.unwrap_or(false),
            m = msgs.recv() => {
                // The sender gave up (or the connection went) before the user answered.
                let _ = m;
                self.set_stage(&tid, "canceled", None);
                return;
            }
            _ = cancel.notified() => false,
            _ = tokio::time::sleep(OFFER_WAIT) => false,
        };
        if !accepted {
            let _ = tx.send(&Msg::Refuse { code: "declined".into() }).await;
            self.audit("receive", &peer.name, false, Some("declined".into()));
            self.set_stage(&tid, "declined", None);
            return;
        }
        if tx.send(&Msg::Accept).await.is_err() {
            self.set_stage(&tid, "failed", Some("connection_lost".into()));
            return;
        }
        self.set_stage(&tid, "active", None);
        match self.receive_files(&tid, &mut tx, &mut msgs, &files, cancel).await {
            Ok(()) => {
                self.audit("receive", &peer.name, true, Some(format!("{} files", files.len())));
                self.set_stage(&tid, "done", None);
            }
            Err(code) => {
                let stage = if code == "canceled" { "canceled" } else { "failed" };
                self.audit("receive", &peer.name, false, Some(code.clone()));
                self.set_stage(&tid, stage, (stage == "failed").then_some(code));
            }
        }
    }

    async fn receive_files(&self, tid: &str, tx: &mut Sender<Stream>, msgs: &mut mpsc::Receiver<Frame>, files: &[OfferFile], cancel: Arc<Notify>) -> Result<(), String> {
        let dir = self.download_dir();
        let first = pull_files(tx, msgs, files, &dir, &cancel, |bytes, index| self.progress(tid, bytes, index)).await?;
        if let Some(path) = first {
            self.with_transfer(tid, |t| t.saved_to = Some(path));
        }
        Ok(())
    }

    // -- the UI's side ------------------------------------------------------------

    pub fn transfer_decide(&self, id: &str, accept: bool) -> AppResult<()> {
        let tx = self.with_transfer(id, |t| t.decide.take()).flatten().ok_or_else(|| AppError::new("no_offer"))?;
        let _ = tx.send(accept);
        Ok(())
    }

    pub fn transfer_cancel(&self, id: &str) {
        if let Some(c) = self.with_transfer(id, |t| (!t.finished()).then(|| t.cancel.clone())).flatten() {
            c.notify_one();
        }
    }

    /// Forget the transfers that are over.
    pub fn transfers_clear(&self) {
        self.lock().transfers.retain(|t| !t.finished());
        self.publish();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_cannot_escape_the_folder_or_break_windows() {
        assert_eq!(sanitize_name("report.pdf"), "report.pdf");
        assert_eq!(sanitize_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_name("..\\..\\Windows\\system.ini"), "system.ini");
        assert_eq!(sanitize_name("a<b>:c|d?.txt"), "a_b__c_d_.txt");
        assert_eq!(sanitize_name("CON"), "_CON");
        assert_eq!(sanitize_name("nul.txt"), "_nul.txt");
        assert_eq!(sanitize_name("  .. "), "file");
        assert_eq!(sanitize_name(""), "file");
        assert_eq!(sanitize_name("trailing. "), "trailing");
        assert_eq!(sanitize_name("line\nbreak.txt"), "line_break.txt");
        assert_eq!(sanitize_name(&"x".repeat(300)).chars().count(), 200);
    }

    #[test]
    fn received_paths_cannot_climb_out() {
        assert_eq!(sanitize_rel("Photos/2024/a.jpg").as_deref(), Some("Photos/2024/a.jpg"));
        assert_eq!(sanitize_rel("a.txt").as_deref(), Some("a.txt"));
        assert_eq!(sanitize_rel("Photos/b:c/a?.jpg").as_deref(), Some("Photos/b_c/a_.jpg"));
        for bad in ["../x", "a/../x", "a//b", "", "/abs", ".", "a/./b"] {
            assert_eq!(sanitize_rel(bad), None, "{bad}");
        }
        assert_eq!(sanitize_rel(&vec!["d"; 33].join("/")), None);
    }

    #[test]
    fn a_long_offer_is_cut_into_frames_that_fit() {
        let files: Vec<OfferFile> = (0..5000).map(|i| OfferFile { name: format!("folder/sub{}/file-number-{i}.dat", i % 7), size: i }).collect();
        let batches = offer_batches(&files);
        assert!(batches.len() > 1);
        assert_eq!(batches.iter().map(Vec::len).sum::<usize>(), files.len());
        for b in &batches {
            let json = serde_json::to_vec(&Msg::Offer { files: b.clone(), more: true }).unwrap();
            assert!(json.len() < 60_000, "{}", json.len());
        }
        assert_eq!(offer_batches(&[]).len(), 1);
    }

    #[test]
    fn walking_a_folder_names_files_from_its_root() {
        let root = temp_dir("walk").join("Photos");
        std::fs::create_dir_all(root.join("2024/trip")).unwrap();
        std::fs::create_dir_all(root.join("empty")).unwrap();
        std::fs::write(root.join("a.jpg"), b"1").unwrap();
        std::fs::write(root.join("2024/b.jpg"), b"22").unwrap();
        std::fs::write(root.join("2024/trip/c.jpg"), b"333").unwrap();
        let found = walk_dir(&root).unwrap();
        let names: Vec<(&str, u64)> = found.iter().map(|(_, f)| (f.name.as_str(), f.size)).collect();
        assert_eq!(names, vec![("Photos/2024/b.jpg", 2), ("Photos/2024/trip/c.jpg", 3), ("Photos/a.jpg", 1)]);
        std::fs::remove_dir_all(root.parent().unwrap()).ok();
    }

    #[test]
    fn existing_files_are_never_overwritten() {
        let dir = std::env::temp_dir().join(format!("portway-unique-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(unique_path(&dir, "a.txt"), dir.join("a.txt"));
        std::fs::write(dir.join("a.txt"), "x").unwrap();
        assert_eq!(unique_path(&dir, "a.txt"), dir.join("a (1).txt"));
        std::fs::write(dir.join("a (1).txt"), "x").unwrap();
        assert_eq!(unique_path(&dir, "a.txt"), dir.join("a (2).txt"));
        std::fs::write(dir.join("noext"), "x").unwrap();
        assert_eq!(unique_path(&dir, "noext"), dir.join("noext (1)"));
        std::fs::write(dir.join(".hidden"), "x").unwrap();
        assert_eq!(unique_path(&dir, ".hidden"), dir.join(".hidden (1)"));
        std::fs::remove_dir_all(dir).ok();
    }

    // -- the byte path, end to end over a real encrypted channel --------------------

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("portway-transfer-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Two ends of an encrypted channel: (sender side, receiver side).
    async fn channel() -> ((Sender<tokio::io::DuplexStream>, mpsc::Receiver<Frame>), (Sender<tokio::io::DuplexStream>, mpsc::Receiver<Frame>)) {
        let (a, b) = tokio::io::duplex(1 << 16);
        let (ka, kb) = (wire::generate_keypair(), wire::generate_keypair());
        let (ea, eb) = tokio::join!(wire::initiate(a, &ka.private), wire::respond(b, &kb.private));
        let ((sa, ra), (sb, rb)) = (ea.ok().unwrap().channel.split(), eb.ok().unwrap().channel.split());
        ((sa, spawn_frame_reader(ra)), (sb, spawn_frame_reader(rb)))
    }

    fn make_files(dir: &Path) -> Vec<(PathBuf, OfferFile)> {
        let sizes = [0usize, 5, MAX_DATA, MAX_DATA + 1, 300_000];
        sizes
            .iter()
            .enumerate()
            .map(|(i, size)| {
                let name = format!("file{i}.bin");
                let bytes: Vec<u8> = (0..*size).map(|n| (n * 31 + i) as u8).collect();
                std::fs::write(dir.join(&name), &bytes).unwrap();
                (dir.join(&name), OfferFile { name, size: *size as u64 })
            })
            .collect()
    }

    #[tokio::test]
    async fn files_arrive_intact_and_progress_adds_up() {
        let (src, dst) = (temp_dir("src"), temp_dir("dst"));
        let files = make_files(&src);
        let offers: Vec<OfferFile> = files.iter().map(|(_, f)| f.clone()).collect();
        let ((mut stx, mut smsgs), (mut rtx, mut rmsgs)) = channel().await;
        let cancel = Notify::new();
        let (mut sent, mut got) = (0u64, 0u64);
        let (a, b) = tokio::join!(push_files(&mut stx, &mut smsgs, &files, &cancel, |n, _| sent += n), pull_files(&mut rtx, &mut rmsgs, &offers, &dst, &cancel, |n, _| got += n));
        assert_eq!(a, Ok(()));
        assert_eq!(b.as_ref().map(|p| p.is_some()), Ok(true));
        let total: u64 = offers.iter().map(|f| f.size).sum();
        assert_eq!((sent, got), (total, total));
        for (path, offer) in &files {
            assert_eq!(std::fs::read(dst.join(&offer.name)).unwrap(), std::fs::read(path).unwrap(), "{}", offer.name);
        }
        assert!(std::fs::read_dir(&dst).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".portway-part")));
        std::fs::remove_dir_all(src).ok();
        std::fs::remove_dir_all(dst).ok();
    }

    #[tokio::test]
    async fn a_file_with_the_same_name_is_kept_beside_the_new_one() {
        let (src, dst) = (temp_dir("src2"), temp_dir("dst2"));
        let files = make_files(&src);
        std::fs::write(dst.join("file1.bin"), b"mine").unwrap();
        let offers: Vec<OfferFile> = files.iter().map(|(_, f)| f.clone()).collect();
        let ((mut stx, mut smsgs), (mut rtx, mut rmsgs)) = channel().await;
        let cancel = Notify::new();
        let (a, b) = tokio::join!(push_files(&mut stx, &mut smsgs, &files, &cancel, |_, _| {}), pull_files(&mut rtx, &mut rmsgs, &offers, &dst, &cancel, |_, _| {}));
        assert!(a.is_ok() && b.is_ok());
        assert_eq!(std::fs::read(dst.join("file1.bin")).unwrap(), b"mine");
        assert_eq!(std::fs::read(dst.join("file1 (1).bin")).unwrap(), std::fs::read(&files[1].0).unwrap());
        std::fs::remove_dir_all(src).ok();
        std::fs::remove_dir_all(dst).ok();
    }

    #[tokio::test]
    async fn the_sender_can_cancel_and_the_receiver_keeps_nothing_half_written() {
        let (src, dst) = (temp_dir("src3"), temp_dir("dst3"));
        let files = make_files(&src);
        let offers: Vec<OfferFile> = files.iter().map(|(_, f)| f.clone()).collect();
        let ((mut stx, mut smsgs), (mut rtx, mut rmsgs)) = channel().await;
        let cancel = Notify::new();
        let none = Notify::new();
        // Cancel once the last, biggest file has started.
        let mut seen = 0u64;
        let (a, b) = tokio::join!(
            push_files(&mut stx, &mut smsgs, &files, &cancel, |n, i| {
                seen += n;
                if i == 4 && seen > 20_000 {
                    cancel.notify_one();
                }
            }),
            pull_files(&mut rtx, &mut rmsgs, &offers, &dst, &none, |_, _| {})
        );
        assert_eq!(a, Err("canceled".to_string()));
        assert_eq!(b, Err("canceled".to_string()));
        let left: Vec<String> = std::fs::read_dir(&dst).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert!(left.iter().all(|n| !n.ends_with(".portway-part")), "{left:?}");
        assert!(!left.contains(&"file4.bin".to_string()), "{left:?}");
        std::fs::remove_dir_all(src).ok();
        std::fs::remove_dir_all(dst).ok();
    }

    #[tokio::test]
    async fn a_wrong_hash_discards_the_file() {
        let dst = temp_dir("dst4");
        let ((mut stx, mut smsgs), (mut rtx, mut rmsgs)) = channel().await;
        let offers = vec![OfferFile { name: "x.bin".into(), size: 3 }];
        let cancel = Notify::new();
        let cheat = async {
            stx.send_data(&[1, 2, 3]).await.ok().unwrap();
            stx.send(&Msg::FileEnd { hash: "00".repeat(32) }).await.ok().unwrap();
            smsgs.recv().await
        };
        let (reply, got) = tokio::join!(cheat, pull_files(&mut rtx, &mut rmsgs, &offers, &dst, &cancel, |_, _| {}));
        assert_eq!(got, Err("hash_mismatch".to_string()));
        assert!(matches!(reply, Some(Frame::Msg(Msg::FileOk { ok: false }))));
        assert_eq!(std::fs::read_dir(&dst).unwrap().count(), 0);
        std::fs::remove_dir_all(dst).ok();
    }

    #[tokio::test]
    async fn more_bytes_than_offered_is_refused() {
        let dst = temp_dir("dst5");
        let ((mut stx, _smsgs), (mut rtx, mut rmsgs)) = channel().await;
        let offers = vec![OfferFile { name: "x.bin".into(), size: 3 }];
        let cancel = Notify::new();
        stx.send_data(&[1, 2, 3, 4, 5]).await.ok().unwrap();
        let got = pull_files(&mut rtx, &mut rmsgs, &offers, &dst, &cancel, |_, _| {}).await;
        assert_eq!(got, Err("protocol".to_string()));
        assert_eq!(std::fs::read_dir(&dst).unwrap().count(), 0);
        std::fs::remove_dir_all(dst).ok();
    }

    /// Run by hand: how fast the encrypted byte path is without a network.
    /// `cargo test --release throughput -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn throughput() {
        let (src, dst) = (temp_dir("src9"), temp_dir("dst9"));
        let path = src.join("big.bin");
        let size = 400usize << 20;
        let block = vec![7u8; 1 << 20];
        let mut f = std::fs::File::create(&path).unwrap();
        for _ in 0..size >> 20 {
            std::io::Write::write_all(&mut f, &block).unwrap();
        }
        let files = vec![(path, OfferFile { name: "big.bin".into(), size: size as u64 })];
        let offers = vec![files[0].1.clone()];
        let ((mut stx, mut smsgs), (mut rtx, mut rmsgs)) = channel().await;
        let cancel = Notify::new();
        let t = Instant::now();
        let (a, b) = tokio::join!(push_files(&mut stx, &mut smsgs, &files, &cancel, |_, _| {}), pull_files(&mut rtx, &mut rmsgs, &offers, &dst, &cancel, |_, _| {}));
        assert!(a.is_ok() && b.is_ok());
        println!("{} MB in {:.2?} = {:.0} MB/s", size >> 20, t.elapsed(), (size >> 20) as f64 / t.elapsed().as_secs_f64());
        std::fs::remove_dir_all(src).ok();
        std::fs::remove_dir_all(dst).ok();
    }

    #[tokio::test]
    async fn a_folder_arrives_as_one_folder_and_never_merges_into_an_existing_one() {
        let (src, dst) = (temp_dir("src6"), temp_dir("dst6"));
        let root = src.join("Photos");
        std::fs::create_dir_all(root.join("2024")).unwrap();
        std::fs::write(root.join("a.jpg"), b"aaa").unwrap();
        std::fs::write(root.join("2024/b.jpg"), vec![9u8; 100_000]).unwrap();
        let files = walk_dir(&root).unwrap();
        let offers: Vec<OfferFile> = files.iter().map(|(_, f)| f.clone()).collect();
        // A folder with that name is already there.
        std::fs::create_dir_all(dst.join("Photos")).unwrap();
        std::fs::write(dst.join("Photos/keep.txt"), b"mine").unwrap();
        let ((mut stx, mut smsgs), (mut rtx, mut rmsgs)) = channel().await;
        let cancel = Notify::new();
        let (a, b) = tokio::join!(push_files(&mut stx, &mut smsgs, &files, &cancel, |_, _| {}), pull_files(&mut rtx, &mut rmsgs, &offers, &dst, &cancel, |_, _| {}));
        assert_eq!(a, Ok(()));
        let first = b.unwrap().unwrap();
        assert!(first.ends_with("Photos (1)"), "{first}");
        assert_eq!(std::fs::read(dst.join("Photos/keep.txt")).unwrap(), b"mine");
        assert_eq!(std::fs::read(dst.join("Photos (1)/a.jpg")).unwrap(), b"aaa");
        assert_eq!(std::fs::read(dst.join("Photos (1)/2024/b.jpg")).unwrap().len(), 100_000);
        std::fs::remove_dir_all(src).ok();
        std::fs::remove_dir_all(dst).ok();
    }
}
