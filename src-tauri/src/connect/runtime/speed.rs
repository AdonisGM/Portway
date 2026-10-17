//! Measuring how fast bytes go between two linked machines. A test is its own
//! encrypted connection (not the live link, whose pings go on meanwhile) and
//! sends zeros for a moment each way; the numbers are what Portway itself gets,
//! encryption included, which is what a file transfer would get too. Nothing is
//! stored on either side and nobody is asked.

use super::*;
use tokio::io::{AsyncRead, AsyncWrite};
use wire::{Frame, WireError, WireResult, MAX_DATA};

/// How long bytes flow each way.
const TEST_MILLIS: u32 = 1500;
/// Never more than this each way, on a very fast link.
const MAX_TEST_BYTES: u64 = 200 << 20;
/// The most a machine that asks will be sent, whatever it says.
const MAX_ASKED_MILLIS: u32 = 5000;
/// A silence this long ends the test.
const IDLE: Duration = Duration::from_secs(10);

#[derive(Debug, Clone)]
pub struct SpeedState {
    /// "up" (sending), "down" (receiving), then "done" or "failed".
    pub stage: &'static str,
    pub up_bps: Option<u64>,
    pub down_bps: Option<u64>,
    /// The address the test went through.
    pub addr: String,
    pub at: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedView {
    pub stage: &'static str,
    /// Bits per second, this machine to the other.
    pub up_bps: Option<u64>,
    /// Bits per second, the other machine to this.
    pub down_bps: Option<u64>,
    pub addr: String,
    pub at: u64,
    pub error: Option<String>,
}

pub fn view(s: &SpeedState) -> SpeedView {
    SpeedView { stage: s.stage, up_bps: s.up_bps, down_bps: s.down_bps, addr: s.addr.clone(), at: s.at, error: s.error.clone() }
}

fn bits_per_second(bytes: u64, micros: u64) -> u64 {
    if micros == 0 {
        return 0;
    }
    (bytes as u128 * 8 * 1_000_000 / micros as u128) as u64
}

/// Send zeros for `millis` (or until `MAX_TEST_BYTES`), then `SpeedEnd`.
async fn blast<S: AsyncWrite>(tx: &mut Sender<S>, millis: u32) -> WireResult<()> {
    let chunk = vec![0u8; MAX_DATA];
    let (start, mut sent) = (Instant::now(), 0u64);
    while start.elapsed() < Duration::from_millis(millis as u64) && sent < MAX_TEST_BYTES {
        tx.send_data(&chunk).await?;
        sent += chunk.len() as u64;
    }
    tx.send(&Msg::SpeedEnd).await
}

/// Count data frames until `SpeedEnd`: (bytes, microseconds from the first
/// frame to the end).
async fn sink<S: AsyncRead>(rx: &mut Receiver<S>) -> WireResult<(u64, u64)> {
    let (mut bytes, mut first): (u64, Option<Instant>) = (0, None);
    loop {
        let frame = tokio::time::timeout(IDLE, rx.recv_frame()).await.map_err(|_| WireError::Protocol("silent"))??;
        match frame {
            Frame::Data(d) => {
                first.get_or_insert_with(Instant::now);
                bytes += d.len() as u64;
                if bytes > MAX_TEST_BYTES * 2 {
                    return Err(WireError::Protocol("too much"));
                }
            }
            Frame::Msg(Msg::SpeedEnd) => return Ok((bytes, first.map(|t| t.elapsed().as_micros() as u64).unwrap_or(0))),
            Frame::Msg(_) => return Err(WireError::Protocol("unexpected message")),
        }
    }
}

/// The machine that asked: send, then receive. `phase` hears when sending is over.
async fn measure<S: AsyncRead + AsyncWrite>(tx: &mut Sender<S>, rx: &mut Receiver<S>, mut phase: impl FnMut(u64)) -> WireResult<(u64, u64)> {
    tx.send(&Msg::SpeedUp).await?;
    blast(tx, TEST_MILLIS).await?;
    let up = match tokio::time::timeout(IDLE, rx.recv()).await.map_err(|_| WireError::Protocol("silent"))?? {
        Msg::SpeedResult { bytes, micros } => bits_per_second(bytes, micros),
        _ => return Err(WireError::Protocol("unexpected message")),
    };
    phase(up);
    tx.send(&Msg::SpeedDown { millis: TEST_MILLIS }).await?;
    let (bytes, micros) = sink(rx).await?;
    Ok((up, bits_per_second(bytes, micros)))
}

/// The machine that was asked: do what it is told until it hangs up.
async fn serve<S: AsyncRead + AsyncWrite>(tx: &mut Sender<S>, rx: &mut Receiver<S>) -> WireResult<()> {
    loop {
        match tokio::time::timeout(IDLE, rx.recv()).await.map_err(|_| WireError::Protocol("silent"))?? {
            Msg::SpeedUp => {
                let (bytes, micros) = sink(rx).await?;
                tx.send(&Msg::SpeedResult { bytes, micros }).await?;
            }
            Msg::SpeedDown { millis } => blast(tx, millis.min(MAX_ASKED_MILLIS)).await?,
            _ => return Ok(()),
        }
    }
}

impl Connect {
    /// Measure the speed to a paired machine that is on the network. The result
    /// arrives in the view, under that machine.
    pub fn speed_test(&self, peer_id: &str) -> AppResult<()> {
        let (peer, targets) = {
            let mut s = self.lock();
            if s.run.is_none() {
                return Err(AppError::new("connect_off"));
            }
            let peer = s.store.peer(peer_id).ok_or_else(|| AppError::new("peer_not_found"))?.clone();
            // An older build would answer the unknown intent with a misleading "version".
            if !peer.info.as_ref().is_some_and(|i| i.has(FEATURE_SPEED)) {
                return Err(AppError::new("speed_unsupported"));
            }
            if s.speeds.values().any(|t| matches!(t.stage, "up" | "down")) {
                return Err(AppError::new("speed_busy"));
            }
            let targets = targets_for(&s, peer_id, &peer);
            if targets.is_empty() {
                return Err(AppError::new("peer_not_found"));
            }
            s.speeds.insert(peer_id.to_string(), SpeedState { stage: "up", up_bps: None, down_bps: None, addr: String::new(), at: now_ms(), error: None });
            (peer, targets)
        };
        let Some(me) = self.me() else {
            self.lock().speeds.remove(peer_id);
            return Err(AppError::new("keychain"));
        };
        self.publish();
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            let result = this.speed_inner(&me, &peer, targets).await;
            let ok = result.is_ok();
            {
                let mut s = this.lock();
                if let Some(t) = s.speeds.get_mut(&peer.id) {
                    t.at = now_ms();
                    match result {
                        Ok((up, down)) => {
                            t.stage = "done";
                            t.up_bps = Some(up);
                            t.down_bps = Some(down);
                        }
                        Err(code) => {
                            t.stage = "failed";
                            t.error = Some(code);
                        }
                    }
                }
            }
            this.audit("speed", &peer.name, ok, None);
            this.publish();
        });
        Ok(())
    }

    async fn speed_inner(&self, me: &Me, peer: &Peer, targets: Vec<SocketAddrV4>) -> Result<(u64, u64), String> {
        let (stream, used) = connect_any(&targets).await.map_err(|f| f.code().to_string())?;
        if let Some(t) = self.lock().speeds.get_mut(&peer.id) {
            t.addr = used.to_string();
        }
        self.publish();
        let est = tokio::time::timeout(HANDSHAKE_TIMEOUT, wire::initiate(stream, &me.key)).await.map_err(|_| "no_reply".to_string())?.map_err(|_| "handshake_failed".to_string())?;
        if hex(&est.remote_static) != peer.public_key {
            return Err("key_changed".into());
        }
        let (mut tx, mut rx) = est.channel.split();
        tx.send(&Msg::Hello { id: me.id.clone(), name: me.name.clone(), os: std::env::consts::OS.into(), version: VERSION, intent: Intent::Speed, macs: vec![] }).await.map_err(|_| "connection_lost".to_string())?;
        match tokio::time::timeout(HANDSHAKE_TIMEOUT, rx.recv()).await.map_err(|_| "no_reply".to_string())?.map_err(|_| "connection_lost".to_string())? {
            Msg::Hello { id, version, .. } if id == peer.id && version == VERSION => {}
            Msg::Refuse { code } => return Err(format!("refused_{code}")),
            _ => return Err("handshake_failed".into()),
        }
        let id = peer.id.clone();
        let result = measure(&mut tx, &mut rx, |up| {
            if let Some(t) = self.lock().speeds.get_mut(&id) {
                t.stage = "down";
                t.up_bps = Some(up);
            }
            self.publish();
        })
        .await
        .map_err(|_| "connection_lost".to_string());
        let _ = tx.send(&Msg::Bye).await;
        result
    }

    /// A paired machine wants to measure the speed to this one.
    pub(super) async fn accept_speed(&self, mut tx: Sender<Stream>, mut rx: Receiver<Stream>) {
        // One test at a time on this side: it uses all the bandwidth there is.
        let taken = {
            let mut s = self.lock();
            !std::mem::replace(&mut s.speed_serving, true)
        };
        if !taken {
            let _ = tx.send(&Msg::Refuse { code: "busy".into() }).await;
            return;
        }
        let _ = serve(&mut tx, &mut rx).await;
        self.lock().speed_serving = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn channel() -> ((Sender<tokio::io::DuplexStream>, Receiver<tokio::io::DuplexStream>), (Sender<tokio::io::DuplexStream>, Receiver<tokio::io::DuplexStream>)) {
        let (a, b) = tokio::io::duplex(1 << 16);
        let (ka, kb) = (wire::generate_keypair(), wire::generate_keypair());
        let (ea, eb) = tokio::join!(wire::initiate(a, &ka.private), wire::respond(b, &kb.private));
        (ea.ok().unwrap().channel.split(), eb.ok().unwrap().channel.split())
    }

    #[test]
    fn rates_are_bits_per_second() {
        assert_eq!(bits_per_second(1_000_000, 1_000_000), 8_000_000);
        assert_eq!(bits_per_second(0, 1_000_000), 0);
        assert_eq!(bits_per_second(5, 0), 0);
    }

    #[tokio::test]
    async fn both_directions_are_measured_and_the_other_side_stops_cleanly() {
        let ((mut ta, mut ra), (mut tb, mut rb)) = channel().await;
        let server = tokio::spawn(async move { serve(&mut tb, &mut rb).await });
        let mut phases = 0;
        let (up, down) = measure(&mut ta, &mut ra, |_| phases += 1).await.ok().unwrap();
        assert_eq!(phases, 1);
        assert!(up > 1_000_000 && down > 1_000_000, "up {up} down {down}");
        ta.send(&Msg::Bye).await.ok().unwrap();
        assert!(server.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn a_machine_cannot_ask_for_more_than_the_limit() {
        let ((mut ta, mut ra), (mut tb, mut rb)) = channel().await;
        let server = tokio::spawn(async move { serve(&mut tb, &mut rb).await });
        let t = Instant::now();
        ta.send(&Msg::SpeedDown { millis: u32::MAX }).await.ok().unwrap();
        // Take what comes until the end marker; the server must stop on its own.
        let (bytes, _) = tokio::time::timeout(Duration::from_secs(20), sink(&mut ra)).await.unwrap().ok().unwrap();
        assert!(bytes > 0);
        assert!(t.elapsed() < Duration::from_secs(MAX_ASKED_MILLIS as u64 / 1000 + 3));
        ta.send(&Msg::Bye).await.ok().unwrap();
        let _ = server.await;
    }
}
