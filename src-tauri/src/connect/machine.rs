//! What a machine tells the one it is linked with about itself: operating
//! system, CPU, memory, disk, network cards, and which optional features this
//! build of Portway has. Sent only over a link, so only to a machine already
//! trusted; never announced over mDNS and never written to the audit log.

use serde::{Deserialize, Serialize};
use sysinfo::{Disks, Networks, System};

use super::net::Card;

/// Optional features a build can have, listed in `MachineInfo::features` so the
/// other side can tell what to offer without another protocol version.
pub const FEATURE_SPEED: &str = "speed";
/// Files copied on one machine can be pasted on the other.
pub const FEATURE_CLIPFILES: &str = "clipfiles";
/// A copied picture (a screenshot) can be pasted on the other machine.
pub const FEATURE_CLIPIMAGE: &str = "clipimage";
/// Copied text keeps its formatting (HTML) on the other machine.
pub const FEATURE_CLIPRICH: &str = "cliprich";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardInfo {
    pub name: String,
    /// "ethernet", "wifi" or "other"
    pub kind: String,
    /// Link speed the card negotiated, in megabits per second, when the system says.
    pub mbps: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub name: String,
    /// Dedicated video memory in bytes; 0 when it is shared with the system or unknown.
    pub vram: u64,
    /// Graphics cores, when the system says (Apple silicon).
    pub cores: Option<u32>,
}

/// What changes by the second: sent as `Stats`, never stored.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LiveStats {
    /// Percent of all cores, 0 to 100.
    pub cpu: f32,
    /// Bytes of memory in use.
    pub ram_used: u64,
    /// Bytes per second received and sent over all the network interfaces.
    pub net_rx: u64,
    pub net_tx: u64,
    /// Percent of the busiest graphics engine; None when the system does not say
    /// (or it was not asked: it costs a little, so only while linked).
    pub gpu: Option<f32>,
}

impl Default for LiveStats {
    fn default() -> Self {
        Self { cpu: 0.0, ram_used: 0, net_rx: 0, net_tx: 0, gpu: None }
    }
}

/// Read once per run: they do not change, and reading them runs a program (macOS)
/// or walks the registry (Windows).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Statics {
    pub model: String,
    pub gpus: Vec<GpuInfo>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MachineInfo {
    /// "Mac mini (Mac14,12)", "ASUS TUF GAMING B650-PLUS"…
    pub model: String,
    pub gpus: Vec<GpuInfo>,
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
pub fn collect(cards: &[Card], statics: &Statics) -> MachineInfo {
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
        model: statics.model.clone(),
        gpus: statics.gpus.clone(),
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
        features: vec![FEATURE_SPEED.to_string(), FEATURE_CLIPFILES.to_string(), FEATURE_CLIPIMAGE.to_string(), FEATURE_CLIPRICH.to_string()],
    }
}

/// CPU and memory use. Keep one `System` for the whole run: the CPU figure is
/// the change since the previous call, so a fresh one always says 0.
pub struct Sampler {
    sys: System,
    nets: Networks,
    at: std::time::Instant,
    #[cfg(windows)]
    gpu: Option<win::GpuCounter>,
}

impl Sampler {
    pub fn new() -> Self {
        let mut sys = System::new();
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        Self { sys, nets: Networks::new_with_refreshed_list(), at: std::time::Instant::now(), #[cfg(windows)] gpu: None }
    }

    pub fn sample(&mut self, with_gpu: bool) -> LiveStats {
        self.sys.refresh_cpu_usage();
        self.sys.refresh_memory();
        // `received()` is what arrived since the last refresh, so it divides by the time since.
        self.nets.refresh(true);
        let secs = self.at.elapsed().as_secs_f64().max(0.1);
        self.at = std::time::Instant::now();
        let (mut rx, mut tx) = (0u64, 0u64);
        for (name, data) in self.nets.iter() {
            if name.starts_with("lo") {
                continue;
            }
            rx += data.received();
            tx += data.transmitted();
        }
        let gpu = if with_gpu { self.gpu_load() } else { None };
        LiveStats { cpu: self.sys.global_cpu_usage().clamp(0.0, 100.0), ram_used: self.sys.used_memory(), net_rx: (rx as f64 / secs) as u64, net_tx: (tx as f64 / secs) as u64, gpu }
    }

    #[cfg(target_os = "macos")]
    fn gpu_load(&mut self) -> Option<f32> {
        let out = std::process::Command::new("ioreg").args(["-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"]).output().ok()?;
        parse_ioreg(&String::from_utf8_lossy(&out.stdout))
    }

    /// The counter is a rate: it needs two readings, so the first one after it is opened says nothing.
    #[cfg(windows)]
    fn gpu_load(&mut self) -> Option<f32> {
        if self.gpu.is_none() {
            self.gpu = win::GpuCounter::open();
        }
        self.gpu.as_mut()?.read()
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    fn gpu_load(&mut self) -> Option<f32> {
        None
    }
}

/// The busiest accelerator's "Device Utilization %" in `ioreg -c IOAccelerator` output.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn parse_ioreg(text: &str) -> Option<f32> {
    let key = "\"Device Utilization %\"=";
    text.match_indices(key)
        .filter_map(|(i, _)| {
            let digits: String = text[i + key.len()..].chars().take_while(|c| c.is_ascii_digit()).collect();
            digits.parse::<f32>().ok()
        })
        .reduce(f32::max)
}

/// Model and graphics cards. Slow (up to a couple of seconds), so call it once,
/// off the async threads.
pub fn read_statics() -> Statics {
    #[cfg(target_os = "macos")]
    {
        mac::read()
    }
    #[cfg(windows)]
    {
        win::read()
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        Statics::default()
    }
}

/// Adapters that are drivers for remote or virtual screens, not graphics cards.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn is_virtual_adapter(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    ["basic display", "basic render", "remote", "virtual", "parsec", "hyper-v", "citrix", "vmware", "virtualbox", "displaylink", "indirect display", "idd"]
        .iter()
        .any(|bad| n.contains(bad))
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;

    pub fn read() -> Statics {
        let out = std::process::Command::new("system_profiler").args(["SPHardwareDataType", "SPDisplaysDataType", "-json"]).output();
        match out {
            Ok(o) => parse(&String::from_utf8_lossy(&o.stdout)),
            Err(_) => Statics::default(),
        }
    }

    /// `system_profiler ... -json`: the hardware overview and the display adapters.
    pub fn parse(json: &str) -> Statics {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else { return Statics::default() };
        let hw = &v["SPHardwareDataType"][0];
        let (name, model) = (hw["machine_name"].as_str().unwrap_or(""), hw["machine_model"].as_str().unwrap_or(""));
        let model = match (name.is_empty(), model.is_empty()) {
            (false, false) => format!("{name} ({model})"),
            (false, true) => name.to_string(),
            _ => model.to_string(),
        };
        let gpus = v["SPDisplaysDataType"]
            .as_array()
            .map(|list| {
                list.iter()
                    .filter_map(|g| {
                        let name = g["sppci_model"].as_str().or_else(|| g["_name"].as_str())?.to_string();
                        let cores = g["sppci_cores"].as_str().and_then(|c| c.trim().parse().ok());
                        Some(GpuInfo { name, vram: 0, cores })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Statics { model, gpus }
    }
}

#[cfg(windows)]
mod win {
    use super::*;
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    use std::collections::HashMap;
    use windows_sys::Win32::System::Performance::{
        PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW, PdhOpenQueryW, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_MORE_DATA,
    };

    /// "\\GPU Engine(*)\\Utilization Percentage": one instance per process and engine,
    /// named like `pid_4321_luid_0x00000000_0x0000A1B2_phys_0_eng_0_engtype_3D`. Added by
    /// its English name so it works on a Windows in any language.
    pub struct GpuCounter {
        query: isize,
        counter: isize,
    }

    impl GpuCounter {
        pub fn open() -> Option<Self> {
            let path: Vec<u16> = r"\GPU Engine(*)\Utilization Percentage".encode_utf16().chain(std::iter::once(0)).collect();
            unsafe {
                let mut query = 0isize;
                if PdhOpenQueryW(std::ptr::null(), 0, &mut query) != 0 {
                    return None;
                }
                let mut counter = 0isize;
                if PdhAddEnglishCounterW(query, path.as_ptr(), 0, &mut counter) != 0 {
                    PdhCloseQuery(query);
                    return None;
                }
                // A rate: this first reading is the baseline.
                PdhCollectQueryData(query);
                Some(Self { query, counter })
            }
        }

        /// The busiest engine, which is what Task Manager's GPU figure follows: the
        /// processes' shares of one engine add up, engines are not added together.
        pub fn read(&mut self) -> Option<f32> {
            unsafe {
                if PdhCollectQueryData(self.query) != 0 {
                    return None;
                }
                let (mut size, mut count) = (0u32, 0u32);
                if PdhGetFormattedCounterArrayW(self.counter, PDH_FMT_DOUBLE, &mut size, &mut count, std::ptr::null_mut()) != PDH_MORE_DATA || size == 0 {
                    return None;
                }
                // Aligned for the items it holds.
                let mut buf = vec![0u64; (size as usize).div_ceil(8)];
                let items = buf.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
                if PdhGetFormattedCounterArrayW(self.counter, PDH_FMT_DOUBLE, &mut size, &mut count, items) != 0 {
                    return None;
                }
                let mut engines: HashMap<String, f64> = HashMap::new();
                for i in 0..count as usize {
                    let item = &*items.add(i);
                    if item.FmtValue.CStatus != 0 {
                        continue;
                    }
                    let name = wide_to_string(item.szName);
                    // Drop "pid_N_" so the processes of one engine share a key.
                    let engine = name.split_once("_luid_").map(|(_, rest)| rest.to_string()).unwrap_or(name);
                    *engines.entry(engine).or_default() += item.FmtValue.Anonymous.doubleValue;
                }
                engines.values().copied().reduce(f64::max).map(|v| v.clamp(0.0, 100.0) as f32)
            }
        }
    }

    impl Drop for GpuCounter {
        fn drop(&mut self) {
            unsafe {
                PdhCloseQuery(self.query);
            }
        }
    }

    unsafe fn wide_to_string(p: *const u16) -> String {
        if p.is_null() {
            return String::new();
        }
        let mut len = 0;
        while *p.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
    }

    const DISPLAY_CLASS: &str = r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";

    pub fn read() -> Statics {
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        let model = hklm
            .open_subkey_with_flags(r"HARDWARE\DESCRIPTION\System\BIOS", KEY_READ)
            .map(|k| {
                let maker: String = k.get_value("SystemManufacturer").unwrap_or_default();
                let product: String = k.get_value("SystemProductName").unwrap_or_default();
                let board: String = k.get_value("BaseBoardProduct").unwrap_or_default();
                // Prebuilt PCs name the product; self-built ones only the board.
                let product = if product.is_empty() || product.to_ascii_lowercase().contains("system product name") { board } else { product };
                [maker, product].into_iter().filter(|p| !p.trim().is_empty() && !p.to_ascii_lowercase().contains("system manufacturer")).collect::<Vec<_>>().join(" ")
            })
            .unwrap_or_default();
        let mut gpus = Vec::new();
        if let Ok(class) = hklm.open_subkey_with_flags(DISPLAY_CLASS, KEY_READ) {
            for sub in class.enum_keys().flatten().filter(|n| n.len() == 4 && n.chars().all(|c| c.is_ascii_digit())) {
                let Ok(key) = class.open_subkey_with_flags(&sub, KEY_READ) else { continue };
                let Ok(name) = key.get_value::<String, _>("DriverDesc") else { continue };
                if is_virtual_adapter(&name) {
                    continue;
                }
                // A 64-bit size (the older 32-bit one stops at 4 GB).
                let vram = key.get_value::<u64, _>("HardwareInformation.qwMemorySize").ok().unwrap_or(0);
                if !gpus.iter().any(|g: &GpuInfo| g.name == name) {
                    gpus.push(GpuInfo { name, vram, cores: None });
                }
            }
        }
        Statics { model, gpus }
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
        let info = collect(&[], &Statics::default());
        assert!(info.ram > 0);
        assert!(info.threads > 0);
        assert!(!info.cpu.is_empty() || cfg!(target_os = "linux"));
        assert!(info.has(FEATURE_SPEED));
        assert_eq!(info.app_version, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn virtual_screens_are_not_graphics_cards() {
        for bad in ["Microsoft Basic Display Adapter", "Parsec Virtual Display Adapter", "Microsoft Remote Display Adapter", "VMware SVGA 3D"] {
            assert!(is_virtual_adapter(bad), "{bad}");
        }
        for good in ["NVIDIA GeForce RTX 4060", "AMD Radeon(TM) Graphics", "Intel(R) UHD Graphics 770", "Apple M2 Pro"] {
            assert!(!is_virtual_adapter(good), "{good}");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_mac_model_and_graphics_come_out_of_system_profiler() {
        let json = r#"{"SPHardwareDataType":[{"machine_name":"Mac mini","machine_model":"Mac14,12","chip_type":"Apple M2 Pro"}],
            "SPDisplaysDataType":[{"_name":"Apple M2 Pro","sppci_model":"Apple M2 Pro","sppci_cores":"19","spdisplays_ndrvs":[]}]}"#;
        let s = mac::parse(json);
        assert_eq!(s.model, "Mac mini (Mac14,12)");
        assert_eq!(s.gpus, vec![GpuInfo { name: "Apple M2 Pro".into(), vram: 0, cores: Some(19) }]);
        assert_eq!(mac::parse("not json"), Statics::default());
    }

    #[test]
    fn the_busiest_accelerator_is_the_one_that_counts() {
        let two = r#""PerformanceStatistics" = {"Device Utilization %"=7,"Renderer Utilization %"=6}
            "PerformanceStatistics" = {"Tiler Utilization %"=2,"Device Utilization %"=41}"#;
        assert_eq!(parse_ioreg(two), Some(41.0));
        assert_eq!(parse_ioreg("nothing here"), None);
    }

    #[test]
    fn live_figures_are_sane() {
        let mut s = Sampler::new();
        std::thread::sleep(std::time::Duration::from_millis(300));
        let l = s.sample(false);
        assert_eq!(l.gpu, None);
        assert!((0.0..=100.0).contains(&l.cpu));
        assert!(l.ram_used > 0);
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
