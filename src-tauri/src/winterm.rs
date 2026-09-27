//! Terminal windows on Windows. Programs are started directly (CreateProcess,
//! arguments quoted by the standard library), never through cmd.exe or
//! PowerShell, so no argument is ever read as shell syntax. A new console
//! opens in Windows Terminal when it is the default terminal (Windows 11).

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::error::{AppError, AppResult};

const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

/// Windows' own OpenSSH client (Windows 10 1809 and later), else one on PATH
/// (Git for Windows ships one).
pub fn ssh_exe() -> AppResult<PathBuf> {
    let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let builtin = root.join(r"System32\OpenSSH\ssh.exe");
    if builtin.is_file() {
        return Ok(builtin);
    }
    let on_path = std::env::var_os("PATH").and_then(|p| std::env::split_paths(&p).map(|d| d.join("ssh.exe")).find(|f| f.is_file()));
    on_path.ok_or_else(|| AppError::new("ssh_client_missing"))
}

/// Start `program args` in a new console window, in `dir`.
pub fn spawn(program: &Path, args: &[String], dir: &Path) -> AppResult<()> {
    Command::new(program)
        .args(args)
        .current_dir(dir)
        .creation_flags(CREATE_NEW_CONSOLE)
        .spawn()
        .map(|_| ())
        .map_err(|e| AppError::detail("terminal", format!("{}: {e}", program.display())))
}

/// A shell (PowerShell) in a new console window, in `dir`.
pub fn open(dir: &Path) -> AppResult<()> {
    let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let ps = root.join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    let program = if ps.is_file() { ps } else { PathBuf::from("powershell.exe") };
    spawn(&program, &["-NoLogo".to_string()], dir)
}
