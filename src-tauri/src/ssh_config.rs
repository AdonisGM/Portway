//! Minimal reader for OpenSSH client config (~/.ssh/config), enough to import hosts:
//! `Host` blocks with HostName, User, Port, IdentityFile and ProxyJump, `Include`, and the
//! values of a `Host *` block as defaults. Wildcard hosts and `Match` blocks are
//! not imported since they do not name a single server.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::paths::{expand_tilde, ssh_dir};

#[derive(Debug, Clone, PartialEq)]
pub struct ConfigHost {
    pub alias: String,
    pub host_name: String,
    pub port: u16,
    pub user: Option<String>,
    /// As written in the config, e.g. `~/.ssh/id_ed25519`.
    pub identity_file: Option<String>,
    /// First hop of ProxyJump as written, e.g. `deploy@bastion`; `none` is dropped.
    pub proxy_jump: Option<String>,
}

#[derive(Default, Clone)]
struct Block {
    patterns: Vec<String>,
    host_name: Option<String>,
    port: Option<u16>,
    user: Option<String>,
    identity_file: Option<String>,
    proxy_jump: Option<String>,
}

impl Block {
    /// OpenSSH keeps the first value it sees for each option.
    fn set(&mut self, key: &str, value: &str) {
        match key {
            "hostname" => { self.host_name.get_or_insert_with(|| value.to_string()); }
            "user" => { self.user.get_or_insert_with(|| value.to_string()); }
            "port" => {
                if self.port.is_none() {
                    self.port = value.parse().ok();
                }
            }
            "identityfile" => { self.identity_file.get_or_insert_with(|| value.to_string()); }
            "proxyjump" => { self.proxy_jump.get_or_insert_with(|| value.split(',').next().unwrap_or("").trim().to_string()); }
            _ => {}
        }
    }

    fn is_wildcard_default(&self) -> bool {
        self.patterns.iter().any(|p| p == "*")
    }
}

/// Read and parse ~/.ssh/config (and anything it includes).
pub fn read_default() -> std::io::Result<Vec<ConfigHost>> {
    let path = ssh_dir().join("config");
    let text = fs::read_to_string(&path)?;
    Ok(parse(&text, &ssh_dir()))
}

/// Parse config text; `base` resolves relative `Include` paths (normally ~/.ssh).
pub fn parse(text: &str, base: &Path) -> Vec<ConfigHost> {
    let mut blocks = Vec::new();
    let mut seen = HashSet::new();
    collect_blocks(text, base, &mut blocks, &mut seen, 0);

    let defaults = blocks.iter().filter(|b| b.is_wildcard_default()).fold(Block::default(), |mut acc, b| {
        if let Some(v) = &b.host_name { acc.set("hostname", v) }
        if let Some(v) = &b.user { acc.set("user", v) }
        if let Some(v) = b.port { acc.set("port", &v.to_string()) }
        if let Some(v) = &b.identity_file { acc.set("identityfile", v) }
        if let Some(v) = &b.proxy_jump { acc.set("proxyjump", v) }
        acc
    });

    let mut hosts = Vec::new();
    for block in &blocks {
        for alias in &block.patterns {
            if is_pattern(alias) {
                continue;
            }
            hosts.push(ConfigHost {
                alias: alias.clone(),
                host_name: block.host_name.clone().or_else(|| defaults.host_name.clone()).unwrap_or_else(|| alias.clone()),
                port: block.port.or(defaults.port).unwrap_or(22),
                user: block.user.clone().or_else(|| defaults.user.clone()),
                identity_file: block.identity_file.clone().or_else(|| defaults.identity_file.clone()),
                proxy_jump: block.proxy_jump.clone().or_else(|| defaults.proxy_jump.clone()).filter(|j| !j.is_empty() && j != "none"),
            });
        }
    }
    hosts
}

fn collect_blocks(text: &str, base: &Path, blocks: &mut Vec<Block>, seen: &mut HashSet<PathBuf>, depth: u8) {
    // `None` while inside a `Match` block, whose options we skip.
    let mut current: Option<Block> = Some(Block::default());
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = split_line(line);
        let key = key.to_ascii_lowercase();
        match key.as_str() {
            "host" => {
                if let Some(b) = current.take() {
                    blocks.push(b);
                }
                current = Some(Block { patterns: value.split_whitespace().map(unquote).collect(), ..Default::default() });
            }
            "match" => {
                if let Some(b) = current.take() {
                    blocks.push(b);
                }
            }
            "include" if depth < 8 => {
                for path in value.split_whitespace().flat_map(|p| resolve_include(&unquote(p), base)) {
                    if seen.insert(path.clone()) {
                        if let Ok(inner) = fs::read_to_string(&path) {
                            // Included files start in the context of the enclosing block,
                            // but in practice they hold their own Host blocks.
                            collect_blocks(&inner, base, blocks, seen, depth + 1);
                        }
                    }
                }
            }
            _ => {
                if let Some(b) = current.as_mut() {
                    b.set(&key, &unquote(value));
                }
            }
        }
    }
    if let Some(b) = current {
        blocks.push(b);
    }
}

/// `Keyword value`, `Keyword=value` or `Keyword = value`.
fn split_line(line: &str) -> (&str, &str) {
    let end = line.find(|c: char| c.is_whitespace() || c == '=').unwrap_or(line.len());
    let key = &line[..end];
    let rest = line[end..].trim_start();
    let rest = rest.strip_prefix('=').unwrap_or(rest).trim();
    (key, rest)
}

fn unquote(s: &str) -> String {
    s.trim().trim_matches('"').to_string()
}

fn is_pattern(alias: &str) -> bool {
    alias.contains(['*', '?', '!'])
}

/// Include paths are relative to ~/.ssh and may use `*` or `?` in the file name.
fn resolve_include(pattern: &str, base: &Path) -> Vec<PathBuf> {
    let path = if pattern.starts_with('~') || pattern.starts_with('/') || Path::new(pattern).is_absolute() { expand_tilde(pattern) } else { base.join(pattern) };
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else { return vec![] };
    if !is_pattern(name) {
        return vec![path];
    }
    let Some(dir) = path.parent() else { return vec![] };
    let Ok(entries) = fs::read_dir(dir) else { return vec![] };
    let mut matches: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.file_name().and_then(|n| n.to_str()).is_some_and(|n| glob_match(name, n)))
        .collect();
    matches.sort();
    matches
}

/// `*` and `?` wildcard match on a single file name.
fn glob_match(pattern: &str, name: &str) -> bool {
    fn go(p: &[u8], n: &[u8]) -> bool {
        match (p.first(), n.first()) {
            (None, None) => true,
            (Some(b'*'), _) => go(&p[1..], n) || (!n.is_empty() && go(p, &n[1..])),
            (Some(b'?'), Some(_)) => go(&p[1..], &n[1..]),
            (Some(a), Some(b)) if a == b => go(&p[1..], &n[1..]),
            _ => false,
        }
    }
    go(pattern.as_bytes(), name.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
# personal
Host blog blog-alt
  HostName 45.77.10.3
  Port 2222
  User deploy
  IdentityFile ~/.ssh/blog_rsa

Host web-01
  HostName=103.21.44.10
  IdentityFile ~/.ssh/first
  IdentityFile ~/.ssh/second

Host *.internal !skip
  User ops

Match host foo
  User nobody

Host bare

Host *
  User root
  IdentityFile ~/.ssh/id_ed25519
"#;

    #[test]
    fn parses_hosts_with_defaults() {
        let hosts = parse(SAMPLE, Path::new("/nonexistent"));
        let aliases: Vec<_> = hosts.iter().map(|h| h.alias.as_str()).collect();
        assert_eq!(aliases, ["blog", "blog-alt", "web-01", "bare"]);

        let blog = &hosts[0];
        assert_eq!(blog.host_name, "45.77.10.3");
        assert_eq!(blog.port, 2222);
        assert_eq!(blog.user.as_deref(), Some("deploy"));
        assert_eq!(blog.identity_file.as_deref(), Some("~/.ssh/blog_rsa"));

        let web = &hosts[2];
        assert_eq!(web.host_name, "103.21.44.10");
        assert_eq!(web.port, 22);
        assert_eq!(web.user.as_deref(), Some("root"), "falls back to Host *");
        assert_eq!(web.identity_file.as_deref(), Some("~/.ssh/first"), "first value wins");

        let bare = &hosts[3];
        assert_eq!(bare.host_name, "bare", "HostName defaults to the alias");
    }

    #[test]
    fn follows_includes() {
        let dir = std::env::temp_dir().join(format!("portway-ssh-config-{}", std::process::id()));
        fs::create_dir_all(dir.join("conf.d")).unwrap();
        fs::write(dir.join("conf.d/a.conf"), "Host inc-a\n  HostName 10.0.0.1\n").unwrap();
        fs::write(dir.join("conf.d/b.conf"), "Host inc-b\n  HostName 10.0.0.2\n").unwrap();
        let hosts = parse("Include conf.d/*.conf\nHost main\n", &dir);
        let aliases: Vec<_> = hosts.iter().map(|h| h.alias.as_str()).collect();
        assert_eq!(aliases, ["inc-a", "inc-b", "main"]);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn glob() {
        assert!(glob_match("*.conf", "a.conf"));
        assert!(glob_match("h?st", "host"));
        assert!(!glob_match("*.conf", "a.txt"));
    }

    #[test]
    fn reads_first_proxy_jump() {
        let hosts = parse("Host app\n  HostName 10.0.0.5\n  ProxyJump deploy@bastion:2222,other\nHost direct\n  ProxyJump none\n", Path::new("/nonexistent"));
        assert_eq!(hosts[0].proxy_jump.as_deref(), Some("deploy@bastion:2222"));
        assert_eq!(hosts[1].proxy_jump, None);
    }
}
