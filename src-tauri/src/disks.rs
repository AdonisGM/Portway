//! Mounted filesystems and Docker disk usage for the overview.

use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mount {
    pub path: String,
    pub device: String,
    pub fs_type: Option<String>,
    pub total: u64,
    pub used: u64,
    pub avail: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerUsage {
    /// "Images", "Containers", "Local Volumes", "Build Cache" as docker names them.
    pub kind: String,
    pub total: u32,
    pub active: u32,
    pub size: u64,
    pub reclaimable: u64,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DockerDisk {
    NotInstalled,
    NoAccess { detail: String },
    DaemonDown { detail: String },
    Ok { rows: Vec<DockerUsage> },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Disks {
    pub mounts: Vec<Mount>,
}

pub const DISKS_SCRIPT: &str = r#"
df -kP 2>/dev/null | tail -n +2 | while read -r fs total used avail cap mnt; do
  [ -d "$mnt" ] && printf '%s\t%s\t%s\t%s\t%s\n' "$fs" "$total" "$used" "$avail" "$mnt"
done
echo @@PORTWAY@@
cat /proc/mounts 2>/dev/null
"#;

pub const DOCKER_DF_SCRIPT: &str = r#"
if command -v docker >/dev/null 2>&1; then
  out=$(docker system df --format '{{.Type}}\t{{.TotalCount}}\t{{.Active}}\t{{.Size}}\t{{.Reclaimable}}' 2>&1); echo "rc=$?"; echo "$out"
else echo notinstalled; fi
"#;

/// Filesystems that are not real disks.
const PSEUDO: [&str; 16] = [
    "tmpfs", "devtmpfs", "squashfs", "proc", "sysfs", "devpts", "cgroup", "cgroup2", "mqueue", "nsfs", "efivarfs", "autofs",
    "fuse.snapfuse", "fuse.lxcfs", "ramfs", "overlay",
];

/// /proc/mounts escapes spaces and tabs as octal (\040, \011).
fn unescape_mount(s: &str) -> String {
    s.replace("\\040", " ").replace("\\011", "\t").replace("\\134", "\\")
}

fn parse_mounts(df: &str, proc_mounts: &str) -> Vec<Mount> {
    let types: HashMap<String, String> = proc_mounts
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            Some((unescape_mount(f.get(1)?), f.get(2)?.to_string()))
        })
        .collect();
    let mut out: Vec<Mount> = Vec::new();
    for line in df.lines() {
        let f: Vec<&str> = line.splitn(5, '\t').collect();
        if f.len() < 5 {
            continue;
        }
        let num = |s: &str| s.trim().parse::<u64>().unwrap_or(0) * 1024;
        let m = Mount {
            device: f[0].to_string(),
            total: num(f[1]),
            used: num(f[2]),
            avail: num(f[3]),
            path: f[4].trim_end().to_string(),
            fs_type: types.get(f[4].trim_end()).cloned(),
        };
        // The root filesystem is kept even when it is an overlay (containers).
        let pseudo = m.fs_type.as_deref().is_some_and(|t| PSEUDO.contains(&t)) || m.device == "shm";
        if m.total == 0 || (pseudo && m.path != "/") {
            continue;
        }
        // Bind mounts of the same filesystem show the same numbers: keep one.
        if let Some(dup) = out.iter_mut().find(|o| o.device == m.device && o.total == m.total && o.used == m.used) {
            if m.path.len() < dup.path.len() {
                *dup = m;
            }
            continue;
        }
        out.push(m);
    }
    out.sort_by(|a, b| (a.path != "/", &a.path).cmp(&(b.path != "/", &b.path)));
    out
}

/// Docker sizes: "6.763GB", "630.8kB", "0B" (decimal units).
pub(crate) fn docker_bytes(s: &str) -> u64 {
    let s = s.split_whitespace().next().unwrap_or("").trim();
    let split = s.find(|c: char| c.is_ascii_alphabetic()).unwrap_or(s.len());
    let (n, unit) = s.split_at(split);
    let n: f64 = n.parse().unwrap_or(0.0);
    let mult = match unit.to_ascii_uppercase().as_str() {
        "B" | "" => 1.0,
        "KB" => 1e3,
        "MB" => 1e6,
        "GB" => 1e9,
        "TB" => 1e12,
        _ => 1.0,
    };
    (n * mult).round() as u64
}

pub fn parse_docker_df(section: &str) -> DockerDisk {
    let mut lines = section.lines();
    let first = lines.next().unwrap_or("").trim();
    if first == "notinstalled" {
        return DockerDisk::NotInstalled;
    }
    let rest: Vec<&str> = lines.collect();
    if first != "rc=0" {
        let detail = rest.join("\n").trim().to_string();
        return if detail.contains("permission denied") { DockerDisk::NoAccess { detail } } else { DockerDisk::DaemonDown { detail } };
    }
    let rows = rest
        .iter()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\t').collect();
            (f.len() >= 5).then(|| DockerUsage {
                kind: f[0].to_string(),
                total: f[1].trim().parse().unwrap_or(0),
                active: f[2].trim().parse().unwrap_or(0),
                size: docker_bytes(f[3]),
                reclaimable: docker_bytes(f[4]),
            })
        })
        .collect();
    DockerDisk::Ok { rows }
}

pub fn parse_disks(text: &str) -> Disks {
    let parts: Vec<&str> = text.split(crate::ssh::MARK).collect();
    let get = |i: usize| parts.get(i).copied().unwrap_or("");
    Disks { mounts: parse_mounts(get(0), get(1)) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_real_directories_once() {
        let df = "overlay\t474064968\t35415176\t414495120\t/\ntmpfs\t65536\t0\t65536\t/dev\nshm\t65536\t0\t65536\t/dev/shm\n\
/dev/sda1\t999\t500\t499\t/boot\n/dev/sdb1\t2000\t100\t1900\t/mnt/my data\n/dev/sdb1\t2000\t100\t1900\t/mnt/my data/bind\n";
        let mounts = "overlay / overlay rw 0 0\ntmpfs /dev tmpfs rw 0 0\nshm /dev/shm tmpfs rw 0 0\n/dev/sda1 /boot ext4 rw 0 0\n/dev/sdb1 /mnt/my\\040data xfs rw 0 0\n";
        let m = parse_mounts(df, mounts);
        let paths: Vec<&str> = m.iter().map(|x| x.path.as_str()).collect();
        assert_eq!(paths, ["/", "/boot", "/mnt/my data"]);
        assert_eq!(m[2].fs_type.as_deref(), Some("xfs"));
        assert_eq!(m[0].total, 474_064_968 * 1024);
    }

    #[test]
    fn parses_docker_system_df() {
        assert_eq!(docker_bytes("6.763GB"), 6_763_000_000);
        assert_eq!(docker_bytes("93.85MB (1%)"), 93_850_000);
        assert_eq!(docker_bytes("630.8kB"), 630_800);
        assert_eq!(docker_bytes("0B"), 0);
        let text = "rc=0\nImages\t13\t12\t6.763GB\t93.85MB (1%)\nBuild Cache\t74\t0\t2.623GB\t1.907GB\n";
        match parse_docker_df(text) {
            DockerDisk::Ok { rows } => {
                assert_eq!((rows[0].total, rows[0].active, rows[0].reclaimable), (13, 12, 93_850_000));
                assert_eq!(rows[1].kind, "Build Cache");
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(parse_docker_df("rc=1\npermission denied while trying to connect"), DockerDisk::NoAccess { .. }));
        assert!(matches!(parse_docker_df("notinstalled"), DockerDisk::NotInstalled));
    }
}
