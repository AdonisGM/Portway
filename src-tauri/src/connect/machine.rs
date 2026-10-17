//! What a machine tells the one it is linked with about itself: operating
//! system, CPU, memory, disk, network cards, and which optional features this
//! build of Portway has. Sent only over a link, so only to a machine already
//! trusted; never announced over mDNS and never written to the audit log.

use serde::{Deserialize, Serialize};
use sysinfo::{Disks, System};

use super::net::Card;

/// Optional features a build can have, listed in `MachineInfo::features` so the
/// other side can tell what to offer without another protocol version.
pub const FEATURE_SPEED: &str = "speed";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardInfo {
    pub name: String,
    /// "ethernet", "wifi" or "other"
    pub kind: String,
    /// Link speed the card negotiated, in megabits per second, when the system says.
    pub mbps: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MachineInfo {
    /// "macOS 27.0.1", "Windows 11 Pro"…
    pub os_version: String,
    pub arch: String,
    pub cpu: String,
    /// Physical cores, 0 when the system does not say.
    pub cores: u32,
    pub threads: u32,
    /// Bytes
    pub ram: u64,
    pub disk_total: u64,
    pub disk_free: u64,
    pub app_version: String,
    /// Seconds since the machine started.
    pub uptime: u64,
    pub cards: Vec<CardInfo>,
    pub features: Vec<String>,
}

impl MachineInfo {
    pub fn has(&self, feature: &str) -> bool {
        self.features.iter().any(|f| f == feature)
    }
}

/// Read this machine. Takes a moment (disks are listed), so callers off the UI path.
pub fn collect(cards: &[Card]) -> MachineInfo {
    let mut sys = System::new();
    sys.refresh_cpu_list(sysinfo::CpuRefreshKind::nothing());
    sys.refresh_memory();
    let cpu = sys.cpus().first().map(|c| c.brand().trim().to_string()).unwrap_or_default();
    let (disk_total, disk_free) = system_disk();
    let mut seen = std::collections::BTreeSet::new();
    let cards = cards
        .iter()
        .filter(|c| c.physical)
        .filter(|c| seen.insert((c.name.clone(), c.kind.code())))
        .map(|c| CardInfo { name: c.name.clone(), kind: c.kind.code().to_string(), mbps: c.mbps })
        .collect();
    MachineInfo {
        os_version: System::long_os_version().or_else(System::name).unwrap_or_default(),
        arch: System::cpu_arch(),
        cpu,
        cores: System::physical_core_count().unwrap_or(0) as u32,
        threads: sys.cpus().len() as u32,
        ram: sys.total_memory(),
        disk_total,
        disk_free,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        uptime: System::uptime(),
        cards,
        features: vec![FEATURE_SPEED.to_string()],
    }
}

/// (total, free) of the disk the user's files live on: the data volume on
/// macOS (the system volume is a small read-only snapshot there), `C:` on
/// Windows, `/` elsewhere; failing those, the biggest disk.
fn system_disk() -> (u64, u64) {
    let disks = Disks::new_with_refreshed_list();
    let at = |mount: &str| disks.list().iter().find(|d| d.mount_point().to_string_lossy().eq_ignore_ascii_case(mount));
    let pick = at("/System/Volumes/Data").or_else(|| at("C:\\")).or_else(|| at("/")).or_else(|| disks.list().iter().max_by_key(|d| d.total_space()));
    pick.map(|d| (d.total_space(), d.available_space())).unwrap_or((0, 0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_machine_can_be_read() {
        let info = collect(&[]);
        assert!(info.ram > 0);
        assert!(info.threads > 0);
        assert!(!info.cpu.is_empty() || cfg!(target_os = "linux"));
        assert!(info.has(FEATURE_SPEED));
        assert_eq!(info.app_version, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn a_description_from_an_older_or_newer_build_still_reads() {
        let older: MachineInfo = serde_json::from_str(r#"{"osVersion":"Windows 11","cpu":"x"}"#).unwrap();
        assert_eq!(older.os_version, "Windows 11");
        assert!(!older.has(FEATURE_SPEED));
        let newer: MachineInfo = serde_json::from_str(r#"{"osVersion":"x","gpu":"something new","features":["speed","teleport"]}"#).unwrap();
        assert!(newer.has(FEATURE_SPEED));
    }
}
