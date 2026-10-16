//! Portway as the SSH_ASKPASS program of a terminal it opens on Windows, where
//! ssh.exe is started with no Unix shell to run a helper script. The map in
//! the environment holds no secret, only which Credential Manager entry
//! answers which prompt; anything it cannot answer is asked on the terminal.

use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::time::Duration;
use std::os::windows::io::AsRawHandle;

use windows_sys::Win32::System::Console::{GetConsoleMode, SetConsoleMode, ENABLE_ECHO_INPUT};

use crate::ssh::AskSecret;

pub const MAP_ENV: &str = "PORTWAY_ASKPASS_MAP";
/// Names the terminal launch, so its askpass calls can tell what they gave out.
pub const ID_ENV: &str = "PORTWAY_ASKPASS_ID";

fn used_file(id: &str) -> PathBuf {
    std::env::temp_dir().join("portway").join(format!("askpass-{id}.used"))
}

/// Askpass files left by terminals that ended long ago.
pub fn remove_stale() {
    let Ok(dir) = std::fs::read_dir(std::env::temp_dir().join("portway")) else { return };
    let day = Duration::from_secs(24 * 3600);
    for f in dir.flatten() {
        let old = f.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > day);
        if old && f.file_name().to_string_lossy().starts_with("askpass-") {
            let _ = std::fs::remove_file(f.path());
        }
    }
}

/// The saved secret for the prompt (ssh's one argument), at most once per
/// terminal: ssh asks again after a wrong answer, and giving the same wrong
/// password three times would count as three failed logins.
fn lookup(asks: &[AskSecret], prompt: &str, id: &str) -> Option<String> {
    let ask = asks.iter().find(|a| a.contains.iter().all(|c| prompt.contains(c.as_str())))?;
    let file = used_file(id);
    if std::fs::read_to_string(&file).is_ok_and(|used| used.lines().any(|l| l == ask.account)) {
        return None;
    }
    let secret = crate::secrets::get(&ask.account)?;
    std::fs::create_dir_all(file.parent()?).ok()?;
    let mut f = OpenOptions::new().create(true).append(true).open(&file).ok()?;
    writeln!(f, "{}", ask.account).ok()?;
    Some(secret)
}

/// Ask on the console ssh runs in, the way ssh itself would: confirmations
/// visibly, passwords hidden.
fn ask_console(prompt: &str) -> Option<String> {
    let mut out = OpenOptions::new().write(true).open("CONOUT$").ok()?;
    let input = OpenOptions::new().read(true).write(true).open("CONIN$").ok()?;
    let kind = std::env::var("SSH_ASKPASS_PROMPT").unwrap_or_default();
    write!(out, "{prompt}").ok()?;
    if kind == "none" {
        write!(out, "\r\n").ok()?;
        return Some(String::new());
    }
    let handle = input.as_raw_handle();
    let mut mode = 0;
    // SAFETY: `handle` is the open console input handle of `input`.
    let hide = kind != "confirm" && unsafe { GetConsoleMode(handle, &mut mode) } != 0;
    if hide {
        unsafe { SetConsoleMode(handle, mode & !ENABLE_ECHO_INPUT) };
    }
    let mut line = String::new();
    let read = BufReader::new(&input).read_line(&mut line);
    if hide {
        unsafe { SetConsoleMode(handle, mode) };
        let _ = write!(out, "\r\n");
    }
    read.ok()?;
    Some(line.trim_end_matches(['\r', '\n']).to_string())
}

/// When ssh started this process as its askpass, answer and exit; otherwise
/// return so the app starts normally.
pub fn run_if_requested() {
    let Some(map) = std::env::var_os(MAP_ENV) else { return };
    let prompt = std::env::args().nth(1).unwrap_or_default();
    let asks: Vec<AskSecret> = serde_json::from_str(&map.to_string_lossy()).unwrap_or_default();
    let id = std::env::var(ID_ENV).unwrap_or_default();
    match lookup(&asks, &prompt, &id).or_else(|| ask_console(&prompt)) {
        Some(answer) => {
            let _ = writeln!(std::io::stdout(), "{answer}");
            std::process::exit(0);
        }
        None => std::process::exit(1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_must_contain_every_piece() {
        let asks = vec![AskSecret { contains: vec!["(me@h)".into(), "assword".into()], account: "no-such-entry".into() }];
        assert_eq!(lookup(&asks, "(me@h) Password: ", "test"), None);
        assert_eq!(lookup(&asks, "other Password: ", "test"), None);
    }
}
