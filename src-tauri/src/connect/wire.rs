//! The encrypted channel between two Portways: a Noise XX handshake over any
//! byte stream, then length-prefixed JSON messages. Both sides learn each
//! other's static key during the handshake; whether that key is trusted is
//! decided above this layer (pairing, or the list of paired machines).

use super::machine::{LiveStats, MachineInfo};
use blake2::{Blake2s256, Digest};
use serde::{Deserialize, Serialize};
use snow::{Builder, StatelessTransportState};
use std::io;
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadHalf, WriteHalf};

const PATTERN: &str = "Noise_XX_25519_ChaChaPoly_BLAKE2s";
/// A frame is a u16 length and that many bytes, so this is the most one can carry.
const MAX_FRAME: usize = u16::MAX as usize;
const TAG: usize = 16;
/// Protocol version, sent in `Hello` and announced over mDNS; bumped whenever
/// the bytes on the wire change, because an older peer cannot read a newer one
/// at all. 2: every message carries a kind byte (file bytes share the channel).
/// 3: `Clip`, and a message this side does not know parses as `Unknown`
/// (ignored) instead of ending the link, so adding a message needs no new version.
pub const VERSION: u32 = 3;

/// Callers map every variant to a stable error code; the payloads are there for
/// `Debug` output when something has to be diagnosed.
#[derive(Debug)]
#[allow(dead_code)]
pub enum WireError {
    Io(io::Error),
    Noise(snow::Error),
    /// The other side sent something that is not a message of this protocol.
    Protocol(&'static str),
}

impl From<io::Error> for WireError {
    fn from(e: io::Error) -> Self {
        WireError::Io(e)
    }
}

impl From<snow::Error> for WireError {
    fn from(e: snow::Error) -> Self {
        WireError::Noise(e)
    }
}

pub type WireResult<T> = Result<T, WireError>;

pub struct Keypair {
    pub private: Vec<u8>,
    pub public: Vec<u8>,
}

pub fn generate_keypair() -> Keypair {
    let kp = Builder::new(PATTERN.parse().expect("valid pattern")).generate_keypair().expect("keypair");
    Keypair { private: kp.private, public: kp.public }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Intent {
    /// First meeting: both users compare a code before either side trusts the other.
    Pair,
    /// Already paired: the key must be one the receiver knows.
    Link,
    /// Already paired, and has files to hand over: the key must be known, and the
    /// receiver's user decides whether to take them.
    Send,
    /// Already paired: measure how fast bytes go between the two machines.
    /// Nothing is stored and nobody is asked.
    Speed,
}

/// A network card another machine can wake this one through.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MacInfo {
    /// "aa:bb:cc:dd:ee:ff"
    pub mac: String,
    pub name: String,
    /// "ethernet" or "wifi"
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OfferFile {
    pub name: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum Msg {
    /// `macs` is sent only once the other side is trusted (a link), and an older
    /// peer that does not send it is read as having none.
    Hello {
        id: String,
        name: String,
        os: String,
        version: u32,
        intent: Intent,
        #[serde(default)]
        macs: Vec<MacInfo>,
    },
    /// Why the receiver will not go on (`not_paired`, `busy`, `pairing_declined`…).
    Refuse { code: String },
    /// Pairing step 1, from the machine that was asked: a commitment to its random number.
    Commit { digest: String },
    /// Pairing step 2, from the machine that asked: its random number.
    Nonce { n: String },
    /// Pairing step 3: the number committed to in step 1.
    Reveal { n: String },
    /// Sending files: what is on offer, in as many messages as the list needs
    /// (`more` is set on all but the last). The receiver then answers `Accept`
    /// or `Refuse`. A name is a path relative to what was picked, with `/`.
    Offer {
        files: Vec<OfferFile>,
        #[serde(default)]
        more: bool,
    },
    Accept,
    /// After a file's bytes: its BLAKE2s hash, hex.
    FileEnd { hash: String },
    /// The receiver's verdict on the file just finished.
    FileOk { ok: bool },
    /// Either side stops the transfer.
    Cancel,
    /// Text copied on the other machine, sent over the live link.
    Clip { text: String },
    /// What the other machine is, sent once when a link comes up.
    Info { info: MachineInfo },
    /// CPU and memory use right now, every few seconds while linked; not stored.
    Stats { stats: LiveStats },
    /// Speed test, step 1: the sender's bytes follow as data frames, then `SpeedEnd`.
    SpeedUp,
    /// Speed test, step 2: send data frames for this many milliseconds, then `SpeedEnd`.
    SpeedDown { millis: u32 },
    SpeedEnd,
    /// What the receiver of step 1 counted, from its first data frame to `SpeedEnd`.
    SpeedResult { bytes: u64, micros: u64 },
    PairConfirm {
        ok: bool,
        /// Sent with a yes, so the machine just paired with can wake this one.
        #[serde(default)]
        macs: Vec<MacInfo>,
    },
    Ping { seq: u64 },
    Pong { seq: u64 },
    Bye,
    /// A message from a newer Portway that this one has no name for: ignored.
    #[serde(other)]
    Unknown,
}

async fn write_frame<W: AsyncWrite + Unpin>(w: &mut W, bytes: &[u8]) -> io::Result<()> {
    debug_assert!(bytes.len() <= MAX_FRAME);
    let mut out = Vec::with_capacity(2 + bytes.len());
    out.extend_from_slice(&(bytes.len() as u16).to_be_bytes());
    out.extend_from_slice(bytes);
    w.write_all(&out).await?;
    w.flush().await
}

async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> io::Result<Vec<u8>> {
    let mut len = [0u8; 2];
    r.read_exact(&mut len).await?;
    let mut buf = vec![0u8; u16::from_be_bytes(len) as usize];
    r.read_exact(&mut buf).await?;
    Ok(buf)
}

/// What both sides know once the handshake is done.
pub struct Established<S> {
    pub channel: Channel<S>,
    /// The other machine's static public key.
    pub remote_static: Vec<u8>,
    /// Same on both sides; pairing derives the code the users compare from it.
    pub hash: Vec<u8>,
}

pub struct Channel<S> {
    stream: S,
    transport: StatelessTransportState,
}

async fn finish<S>(stream: S, hs: snow::HandshakeState) -> WireResult<Established<S>> {
    let hash = hs.get_handshake_hash().to_vec();
    let remote_static = hs.get_remote_static().ok_or(WireError::Protocol("no remote key"))?.to_vec();
    let transport = hs.into_stateless_transport_mode()?;
    Ok(Established { channel: Channel { stream, transport }, remote_static, hash })
}

/// Start the handshake (the side that connected).
pub async fn initiate<S: AsyncRead + AsyncWrite + Unpin>(mut stream: S, key: &[u8]) -> WireResult<Established<S>> {
    let mut hs = Builder::new(PATTERN.parse().expect("valid pattern")).local_private_key(key).build_initiator()?;
    let mut buf = vec![0u8; MAX_FRAME];
    let n = hs.write_message(&[], &mut buf)?; // -> e
    write_frame(&mut stream, &buf[..n]).await?;
    let m = read_frame(&mut stream).await?; // <- e, ee, s, es
    hs.read_message(&m, &mut buf)?;
    let n = hs.write_message(&[], &mut buf)?; // -> s, se
    write_frame(&mut stream, &buf[..n]).await?;
    finish(stream, hs).await
}

/// Answer the handshake (the side that accepted).
pub async fn respond<S: AsyncRead + AsyncWrite + Unpin>(mut stream: S, key: &[u8]) -> WireResult<Established<S>> {
    let mut hs = Builder::new(PATTERN.parse().expect("valid pattern")).local_private_key(key).build_responder()?;
    let mut buf = vec![0u8; MAX_FRAME];
    let m = read_frame(&mut stream).await?; // <- e
    hs.read_message(&m, &mut buf)?;
    let n = hs.write_message(&[], &mut buf)?; // -> e, ee, s, es
    write_frame(&mut stream, &buf[..n]).await?;
    let m = read_frame(&mut stream).await?; // <- s, se
    hs.read_message(&m, &mut buf)?;
    finish(stream, hs).await
}

pub struct Sender<S> {
    half: WriteHalf<S>,
    transport: Arc<StatelessTransportState>,
    nonce: u64,
}

pub struct Receiver<S> {
    half: ReadHalf<S>,
    transport: Arc<StatelessTransportState>,
    nonce: u64,
}

impl<S: AsyncRead + AsyncWrite> Channel<S> {
    /// Separate sending from receiving, so one task can read while another writes.
    pub fn split(self) -> (Sender<S>, Receiver<S>) {
        let transport = Arc::new(self.transport);
        let (r, w) = tokio::io::split(self.stream);
        (Sender { half: w, transport: transport.clone(), nonce: 0 }, Receiver { half: r, transport, nonce: 0 })
    }
}

/// Most file bytes one frame carries: a frame holds 65535 bytes, minus the
/// authentication tag and the one-byte kind.
pub const MAX_DATA: usize = MAX_FRAME - TAG - 1;

/// What came over the channel: a message, or raw file bytes.
pub enum Frame {
    Msg(Msg),
    Data(Vec<u8>),
}

const KIND_MSG: u8 = 0;
const KIND_DATA: u8 = 1;

impl<S: AsyncWrite> Sender<S> {
    async fn send_frame(&mut self, kind: u8, body: &[u8]) -> WireResult<()> {
        if body.len() + 1 + TAG > MAX_FRAME {
            return Err(WireError::Protocol("message too large"));
        }
        let mut plain = Vec::with_capacity(body.len() + 1);
        plain.push(kind);
        plain.extend_from_slice(body);
        let mut out = vec![0u8; plain.len() + TAG];
        let n = self.transport.write_message(self.nonce, &plain, &mut out)?;
        self.nonce += 1;
        let mut half = std::pin::Pin::new(&mut self.half);
        write_frame(&mut half, &out[..n]).await?;
        Ok(())
    }

    pub async fn send(&mut self, msg: &Msg) -> WireResult<()> {
        let json = serde_json::to_vec(msg).map_err(|_| WireError::Protocol("cannot encode"))?;
        self.send_frame(KIND_MSG, &json).await
    }

    /// File bytes, at most `MAX_DATA` per call.
    pub async fn send_data(&mut self, bytes: &[u8]) -> WireResult<()> {
        self.send_frame(KIND_DATA, bytes).await
    }
}

impl<S: AsyncRead> Receiver<S> {
    pub async fn recv_frame(&mut self) -> WireResult<Frame> {
        let mut half = std::pin::Pin::new(&mut self.half);
        let frame = read_frame(&mut half).await?;
        let mut out = vec![0u8; frame.len()];
        let n = self.transport.read_message(self.nonce, &frame, &mut out)?;
        self.nonce += 1;
        out.truncate(n);
        if out.is_empty() {
            return Err(WireError::Protocol("empty frame"));
        }
        let kind = out.remove(0);
        match kind {
            KIND_MSG => serde_json::from_slice(&out).map(Frame::Msg).map_err(|_| WireError::Protocol("unknown message")),
            KIND_DATA => Ok(Frame::Data(out)),
            _ => Err(WireError::Protocol("unknown frame")),
        }
    }

    /// The next message; file bytes here are a protocol error.
    pub async fn recv(&mut self) -> WireResult<Msg> {
        match self.recv_frame().await? {
            Frame::Msg(m) => Ok(m),
            Frame::Data(_) => Err(WireError::Protocol("unexpected file bytes")),
        }
    }
}

fn digest(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Blake2s256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn nonce() -> [u8; 32] {
    let (a, b) = (uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
    let mut n = [0u8; 32];
    n[..16].copy_from_slice(a.as_bytes());
    n[16..].copy_from_slice(b.as_bytes());
    n
}

fn nonce_from(hex_text: &str) -> WireResult<Vec<u8>> {
    unhex(hex_text).filter(|b| b.len() == 32).ok_or(WireError::Protocol("bad number"))
}

/// The six digits both users compare, "123 456". They come from the handshake
/// hash (which covers both machines' keys) and from a random number each side
/// contributed. See `code_as_initiator`.
fn pairing_code(hash: &[u8], n_i: &[u8], n_r: &[u8]) -> String {
    let d = digest(&[b"portway-pair-v1", hash, n_i, n_r]);
    let n = u32::from_be_bytes([d[0], d[1], d[2], d[3]]) % 1_000_000;
    format!("{:03} {:03}", n / 1000, n % 1000)
}

/// Agree on the code, as the machine that was asked. Neither side shows a code
/// before both have given a number, and the asked side commits to its number
/// before seeing the other's. Without that a machine in the middle could keep
/// making new keys until the two sessions happen to give the same six digits:
/// about a million tries, a second of work.
pub async fn code_as_responder<S: AsyncRead + AsyncWrite>(tx: &mut Sender<S>, rx: &mut Receiver<S>, hash: &[u8]) -> WireResult<String> {
    let n_r = nonce();
    tx.send(&Msg::Commit { digest: hex(&digest(&[&n_r])) }).await?;
    let n_i = match rx.recv().await? {
        Msg::Nonce { n } => nonce_from(&n)?,
        _ => return Err(WireError::Protocol("expected a number")),
    };
    tx.send(&Msg::Reveal { n: hex(&n_r) }).await?;
    Ok(pairing_code(hash, &n_i, &n_r))
}

/// The same, as the machine that asked.
pub async fn code_as_initiator<S: AsyncRead + AsyncWrite>(tx: &mut Sender<S>, rx: &mut Receiver<S>, hash: &[u8]) -> WireResult<String> {
    let commit = match rx.recv().await? {
        Msg::Commit { digest } => nonce_from(&digest)?,
        _ => return Err(WireError::Protocol("expected a commitment")),
    };
    let n_i = nonce();
    tx.send(&Msg::Nonce { n: hex(&n_i) }).await?;
    let n_r = match rx.recv().await? {
        Msg::Reveal { n } => nonce_from(&n)?,
        _ => return Err(WireError::Protocol("expected a reveal")),
    };
    if digest(&[&n_r])[..] != commit[..] {
        return Err(WireError::Protocol("number does not match its commitment"));
    }
    Ok(pairing_code(hash, &n_i, &n_r))
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 || !s.is_ascii() {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    async fn pair() -> (Established<tokio::io::DuplexStream>, Established<tokio::io::DuplexStream>, Keypair, Keypair) {
        let (a, b) = duplex(1 << 20);
        let (ka, kb) = (generate_keypair(), generate_keypair());
        let (ra, rb) = tokio::join!(initiate(a, &ka.private), respond(b, &kb.private));
        (ra.ok().unwrap(), rb.ok().unwrap(), ka, kb)
    }

    #[tokio::test]
    async fn handshake_agrees_on_keys_and_code() {
        let (a, b, ka, kb) = pair().await;
        assert_eq!(a.remote_static, kb.public);
        assert_eq!(b.remote_static, ka.public);
        assert_eq!(a.hash, b.hash);
    }

    #[tokio::test]
    async fn both_sides_get_the_same_six_digits() {
        let (a, b, _, _) = pair().await;
        let hash = a.hash.clone();
        let ((mut sa, mut ra), (mut sb, mut rb)) = (a.channel.split(), b.channel.split());
        let (asker, asked) = tokio::join!(code_as_initiator(&mut sa, &mut ra, &hash), code_as_responder(&mut sb, &mut rb, &hash));
        let (asker, asked) = (asker.ok().unwrap(), asked.ok().unwrap());
        assert_eq!(asker, asked);
        assert_eq!(asker.len(), 7);
        assert_eq!(asker.chars().filter(|c| c.is_ascii_digit()).count(), 6);
    }

    #[tokio::test]
    async fn a_number_that_does_not_match_its_commitment_is_rejected() {
        let (a, b, _, _) = pair().await;
        let hash = a.hash.clone();
        let ((mut sa, mut ra), (mut sb, mut rb)) = (a.channel.split(), b.channel.split());
        // The other side commits to one number and reveals another.
        let cheat = async {
            sb.send(&Msg::Commit { digest: hex(&digest(&[&nonce()])) }).await.ok().unwrap();
            rb.recv().await.ok().unwrap();
            sb.send(&Msg::Reveal { n: hex(&nonce()) }).await.ok().unwrap();
        };
        let (asker, _) = tokio::join!(code_as_initiator(&mut sa, &mut ra, &hash), cheat);
        assert!(matches!(asker, Err(WireError::Protocol(_))));
    }

    #[tokio::test]
    async fn the_code_depends_on_both_numbers() {
        let hash = [7u8; 32];
        let (n1, n2, n3) = (nonce(), nonce(), nonce());
        assert_eq!(pairing_code(&hash, &n1, &n2), pairing_code(&hash, &n1, &n2));
        assert_ne!(pairing_code(&hash, &n1, &n2), pairing_code(&hash, &n1, &n3));
        assert_ne!(pairing_code(&hash, &n1, &n2), pairing_code(&hash, &n3, &n2));
    }

    #[tokio::test]
    async fn two_connections_get_different_hashes() {
        let (a1, _, _, _) = pair().await;
        let (a2, _, _, _) = pair().await;
        assert_ne!(a1.hash, a2.hash);
    }

    #[tokio::test]
    async fn messages_flow_both_ways() {
        let (a, b, _, _) = pair().await;
        let ((mut sa, mut ra), (mut sb, mut rb)) = (a.channel.split(), b.channel.split());
        let hello = Msg::Hello { id: "abc".into(), name: "Mac".into(), os: "macos".into(), version: VERSION, intent: Intent::Pair, macs: vec![] };
        sa.send(&hello).await.ok().unwrap();
        sa.send(&Msg::Ping { seq: 7 }).await.ok().unwrap();
        assert_eq!(rb.recv().await.ok().unwrap(), hello);
        assert_eq!(rb.recv().await.ok().unwrap(), Msg::Ping { seq: 7 });
        sb.send(&Msg::Pong { seq: 7 }).await.ok().unwrap();
        sb.send(&Msg::Refuse { code: "busy".into() }).await.ok().unwrap();
        assert_eq!(ra.recv().await.ok().unwrap(), Msg::Pong { seq: 7 });
        assert_eq!(ra.recv().await.ok().unwrap(), Msg::Refuse { code: "busy".into() });
    }

    #[tokio::test]
    async fn closed_stream_is_an_error_not_a_hang() {
        let (a, b, _, _) = pair().await;
        let (_sa, mut ra) = a.channel.split();
        drop(b);
        assert!(ra.recv().await.is_err());
    }

    #[test]
    fn hex_round_trip() {
        let key = generate_keypair().public;
        assert_eq!(unhex(&hex(&key)), Some(key));
        assert_eq!(unhex("abc"), None);
        assert_eq!(unhex("zz"), None);
    }

    #[test]
    fn an_older_peer_without_macs_still_parses() {
        let old = r#"{"t":"hello","id":"a","name":"n","os":"macos","version":1,"intent":"link"}"#;
        assert!(matches!(serde_json::from_str::<Msg>(old), Ok(Msg::Hello { macs, .. }) if macs.is_empty()));
        let old = r#"{"t":"pairConfirm","ok":true}"#;
        assert!(matches!(serde_json::from_str::<Msg>(old), Ok(Msg::PairConfirm { ok: true, macs }) if macs.is_empty()));
    }

    #[tokio::test]
    async fn file_bytes_and_messages_share_a_channel() {
        let (a, b, _, _) = pair().await;
        let ((mut sa, _ra), (_sb, mut rb)) = (a.channel.split(), b.channel.split());
        let chunk = vec![0xABu8; MAX_DATA];
        sa.send(&Msg::Offer { files: vec![OfferFile { name: "a.bin".into(), size: 3 }], more: false }).await.ok().unwrap();
        sa.send_data(&chunk).await.ok().unwrap();
        sa.send_data(&[1, 2, 3]).await.ok().unwrap();
        sa.send(&Msg::FileEnd { hash: "00".into() }).await.ok().unwrap();
        assert!(matches!(rb.recv_frame().await.ok().unwrap(), Frame::Msg(Msg::Offer { .. })));
        assert!(matches!(rb.recv_frame().await.ok().unwrap(), Frame::Data(d) if d == chunk));
        assert!(matches!(rb.recv_frame().await.ok().unwrap(), Frame::Data(d) if d == [1, 2, 3]));
        assert!(matches!(rb.recv().await.ok().unwrap(), Msg::FileEnd { .. }));
    }

    #[tokio::test]
    async fn one_byte_too_many_for_a_frame_is_refused() {
        let (a, _b, _, _) = pair().await;
        let (mut sa, _ra) = a.channel.split();
        assert!(sa.send_data(&vec![0u8; MAX_DATA + 1]).await.is_err());
    }

    #[test]
    fn a_message_from_the_future_is_unknown_not_an_error() {
        let m: Msg = serde_json::from_str(r#"{"t":"somethingNew","x":1}"#).unwrap();
        assert_eq!(m, Msg::Unknown);
        let c: Msg = serde_json::from_str(r#"{"t":"clip","text":"hi"}"#).unwrap();
        assert_eq!(c, Msg::Clip { text: "hi".into() });
    }

    /// Protocol 3 (0.12.0) has no `Info`; it must read one, whole with its
    /// nested fields, as `Unknown` and keep the link.
    #[test]
    fn a_build_without_info_reads_a_full_info_message_as_unknown() {
        #[derive(Debug, PartialEq, Deserialize)]
        #[serde(tag = "t", rename_all = "camelCase")]
        enum V3 {
            Ping { seq: u64 },
            #[serde(other)]
            Unknown,
        }
        let info = Msg::Info { info: MachineInfo { os_version: "macOS 27".into(), cpu: "Apple M4".into(), cores: 4, ram: 16 << 30, features: vec!["speed".into()], ..Default::default() } };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains(r#""t":"info""#));
        assert_eq!(serde_json::from_str::<V3>(&json).unwrap(), V3::Unknown);
        assert_eq!(serde_json::from_str::<V3>(r#"{"t":"ping","seq":3}"#).unwrap(), V3::Ping { seq: 3 });
        assert_eq!(serde_json::from_str::<Msg>(&json).unwrap(), info);
    }
}
