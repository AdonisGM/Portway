//! Remote files over SFTP: listing with what the session's user may do with
//! each entry, and the usual file operations. SFTP runs as the session's user;
//! only chown goes through a shell (root or sudo), since SFTP cannot map names.

use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags, StatusCode};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use crate::audit::AuditLog;
use crate::error::{AppError, AppResult};
use crate::i18n::tr;
use crate::trace;
use crate::ssh::{exec, exec_priv, shell_quote, Session, Sessions, MARK};

/// Who the session's user is on the server, and the uid/gid names.
#[derive(Debug)]
pub struct Identity {
    pub uid: u32,
    pub gids: Vec<u32>,
    pub users: HashMap<u32, String>,
    pub groups: HashMap<u32, String>,
}

fn parse_id_db(text: &str) -> HashMap<u32, String> {
    text.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split(':').collect();
            Some((f.get(2)?.parse().ok()?, f.first()?.to_string()))
        })
        .collect()
}

fn parse_identity(text: &str) -> Option<Identity> {
    let parts: Vec<&str> = text.split(MARK).collect();
    Some(Identity {
        uid: parts.first()?.trim().parse().ok()?,
        gids: parts.get(1)?.split_whitespace().filter_map(|g| g.parse().ok()).collect(),
        users: parse_id_db(parts.get(2).unwrap_or(&"")),
        groups: parse_id_db(parts.get(3).unwrap_or(&"")),
    })
}

pub(crate) async fn identity(session: &Session) -> AppResult<Arc<Identity>> {
    let mut slot = session.ident.lock().await;
    if let Some(i) = slot.as_ref() {
        return Ok(i.clone());
    }
    let out = exec(session, &format!("id -u; echo {MARK}; id -G; echo {MARK}; cat /etc/passwd; echo {MARK}; cat /etc/group"))
        .await?
        .stdout_or_err()?;
    let ident = Arc::new(parse_identity(&out).ok_or_else(|| AppError::detail("remote_command", "id -u"))?);
    *slot = Some(ident.clone());
    Ok(ident)
}

/// The session's SFTP channel, opened on first use and reopened after it broke.
pub(crate) async fn sftp(session: &Session) -> AppResult<Arc<SftpSession>> {
    let mut slot = session.sftp.lock().await;
    if let Some(s) = slot.as_ref() {
        return Ok(s.clone());
    }
    let span = trace::start(&session.server_id, &session.user, trace::Kind::Sftp, Some(tr("Mở kênh SFTP", "Open SFTP channel")), "sftp (subsystem)", false);
    let opened = async {
        let channel = session.handle.channel_open_session().await.map_err(|e| lost_or(e, session))?;
        channel.request_subsystem(true, "sftp").await.map_err(|e| lost_or(e, session))?;
        SftpSession::new(channel.into_stream()).await.map_err(|e| AppError::detail("sftp_unavailable", e))
    }
    .await;
    let s = match opened {
        Ok(s) => {
            span.ok(|_| {});
            s
        }
        Err(e) => {
            span.fail(e.detail.clone().unwrap_or_else(|| e.code.to_string()), |_| {});
            return Err(e);
        }
    };
    s.set_timeout(30);
    let s = Arc::new(s);
    *slot = Some(s.clone());
    Ok(s)
}

fn lost_or(e: russh::Error, session: &Session) -> AppError {
    if session.handle.is_closed() {
        AppError::detail("connection_lost", e)
    } else {
        AppError::detail("ssh", e)
    }
}

/// Map an SFTP error; anything but a status reply means the channel is unusable.
pub(crate) async fn sftp_err(e: SftpError, session: &Session, path: &str) -> AppError {
    match &e {
        SftpError::Status(s) => match s.status_code {
            StatusCode::NoSuchFile => AppError::detail("not_found", path),
            StatusCode::PermissionDenied => AppError::detail("permission_denied", path),
            _ => AppError::detail("sftp_failure", if s.error_message.is_empty() { format!("{}", s.status_code) } else { s.error_message.clone() }),
        },
        _ => {
            *session.sftp.lock().await = None;
            if session.handle.is_closed() {
                AppError::detail("connection_lost", e)
            } else {
                AppError::detail("sftp", e)
            }
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Dir,
    File,
    Link,
    Other,
}

/// Which permission bits apply to the user.
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Class {
    Root,
    Owner,
    Group,
    Other,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub kind: Kind,
    /// Kind of what a link points to; None for a broken link or a non-link.
    pub target_kind: Option<Kind>,
    pub link_target: Option<String>,
    pub size: u64,
    pub mtime: Option<u64>,
    pub atime: Option<u64>,
    /// Permission bits (0o7777).
    pub mode: u32,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub owner: Option<String>,
    pub group: Option<String>,
    pub class: Class,
    /// Read the file / list the directory.
    pub readable: bool,
    /// Write the file / create and delete inside the directory.
    pub writable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    /// Canonical absolute path.
    pub path: String,
    pub dir: Entry,
    pub entries: Vec<Entry>,
    /// The directory exists but the user may not list it.
    pub denied: bool,
    pub user: String,
}

fn kind_of(a: &FileAttributes) -> Kind {
    if a.is_symlink() {
        Kind::Link
    } else if a.is_dir() {
        Kind::Dir
    } else if a.is_regular() {
        Kind::File
    } else {
        Kind::Other
    }
}

fn access(ident: &Identity, uid: Option<u32>, gid: Option<u32>, mode: u32, dir: bool) -> (Class, bool, bool) {
    if ident.uid == 0 {
        return (Class::Root, true, true);
    }
    let (class, shift) = if uid == Some(ident.uid) {
        (Class::Owner, 6)
    } else if gid.is_some_and(|g| ident.gids.contains(&g)) {
        (Class::Group, 3)
    } else {
        (Class::Other, 0)
    };
    let bits = (mode >> shift) & 7;
    let (r, w, x) = (bits & 4 != 0, bits & 2 != 0, bits & 1 != 0);
    if dir {
        (class, r && x, w && x)
    } else {
        (class, r, w)
    }
}

fn entry(ident: &Identity, name: String, path: String, a: &FileAttributes, target: Option<(String, Option<FileAttributes>)>) -> Entry {
    let kind = kind_of(a);
    let target_attrs = target.as_ref().and_then(|t| t.1.clone());
    // For a link, what the user may do follows the target.
    let eff = target_attrs.as_ref().unwrap_or(a);
    let mode = a.permissions.unwrap_or(0) & 0o7777;
    let eff_dir = eff.is_dir();
    let (class, readable, writable) = access(ident, eff.uid, eff.gid, eff.permissions.unwrap_or(0) & 0o7777, eff_dir);
    Entry {
        name,
        path,
        kind,
        target_kind: target_attrs.as_ref().map(kind_of),
        link_target: target.map(|t| t.0),
        size: a.size.unwrap_or(0),
        mtime: a.mtime.map(u64::from),
        atime: a.atime.map(u64::from),
        mode,
        uid: a.uid,
        gid: a.gid,
        owner: a.uid.and_then(|u| ident.users.get(&u).cloned()),
        group: a.gid.and_then(|g| ident.groups.get(&g).cloned()),
        class,
        readable: if kind == Kind::Link && target_attrs.is_none() { false } else { readable },
        writable: if kind == Kind::Link && target_attrs.is_none() { false } else { writable },
    }
}

pub(crate) fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

fn parent_and_name(path: &str) -> (String, String) {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(0) => ("/".into(), trimmed[1..].to_string()),
        Some(i) => (trimmed[..i].to_string(), trimmed[i + 1..].to_string()),
        None => (".".into(), trimmed.to_string()),
    }
}

pub(crate) async fn list(session: &Session, path: &str) -> AppResult<Listing> {
    let sftp = sftp(session).await?;
    let ident = identity(session).await?;
    let wanted = if path.trim().is_empty() { "." } else { path.trim() };
    let canon = match sftp.canonicalize(wanted).await {
        Ok(p) => p,
        Err(e) => return Err(sftp_err(e, session, wanted).await),
    };
    let attrs = match sftp.metadata(&canon).await {
        Ok(a) => a,
        Err(e) => return Err(sftp_err(e, session, &canon).await),
    };
    if !attrs.is_dir() {
        return Err(AppError::detail("not_a_dir", &canon));
    }
    let (_, name) = parent_and_name(&canon);
    let dir = entry(&ident, if canon == "/" { "/".into() } else { name }, canon.clone(), &attrs, None);

    let read = match sftp.read_dir(&canon).await {
        Ok(r) => r,
        Err(SftpError::Status(s)) if s.status_code == StatusCode::PermissionDenied => {
            return Ok(Listing { path: canon, dir, entries: vec![], denied: true, user: session.user.clone() });
        }
        Err(e) => return Err(sftp_err(e, session, &canon).await),
    };
    let mut entries = Vec::new();
    for item in read {
        let name = item.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let full = join(&canon, &name);
        let a = item.metadata();
        let target = if a.is_symlink() {
            let text = sftp.read_link(&full).await.unwrap_or_default();
            Some((text, sftp.metadata(&full).await.ok()))
        } else {
            None
        };
        entries.push(entry(&ident, name, full, &a, target));
    }
    Ok(Listing { path: canon, dir, entries, denied: false, user: session.user.clone() })
}

#[tauri::command]
pub async fn sftp_list(sessions: tauri::State<'_, Sessions>, server_id: String, user: String, path: String) -> AppResult<Listing> {
    let run = async move {
        let session = sessions.get(&server_id, &user)?;
        let span = trace::start(&server_id, &user, trace::Kind::Sftp, None, &format!("ls {}", shell_quote(&path)), false);
        let r = list(&session, &path).await;
        match &r {
            Ok(l) => span.ok(|e| e.out_bytes = Some(l.entries.len() as u64)),
            Err(err) => span.fail(err.detail.clone().unwrap_or_else(|| err.code.to_string()), |_| {}),
        }
        r
    };
    let r: AppResult<Listing> = trace::labelled(tr("Tệp · mở thư mục", "Files · open folder"), run).await;
    r
}

pub(crate) fn check_name(name: &str) -> AppResult<()> {
    let n = name.trim();
    if n.is_empty() || n == "." || n == ".." || n.contains('/') || n.contains('\0') {
        return Err(AppError::field("invalid_name", "name"));
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_mkdir(
    sessions: tauri::State<'_, Sessions>,
    audit: tauri::State<'_, AuditLog>,
    server_id: String,
    user: String,
    dir: String,
    name: String,
) -> AppResult<String> {
    let run = async move {
        check_name(&name)?;
        let session = sessions.get(&server_id, &user)?;
        let s = sftp(&session).await?;
        let path = join(&dir, name.trim());
        let cmd = format!("mkdir {}", shell_quote(&path));
        let span = trace::start(&server_id, &user, trace::Kind::Sftp, None, &cmd, false);
        let r = s.create_dir(&path).await;
        finish(span, &session, &audit, &server_id, &user, "mkdir", cmd, r, &path).await.map(|_| path)
    };
    let r: AppResult<String> = trace::labelled(tr("Tệp · tạo thư mục", "Files · new folder"), run).await;
    r
}

#[tauri::command]
pub async fn sftp_touch(
    sessions: tauri::State<'_, Sessions>,
    audit: tauri::State<'_, AuditLog>,
    server_id: String,
    user: String,
    dir: String,
    name: String,
) -> AppResult<String> {
    let run = async move {
        check_name(&name)?;
        let session = sessions.get(&server_id, &user)?;
        let s = sftp(&session).await?;
        let path = join(&dir, name.trim());
        let cmd = format!("touch {}", shell_quote(&path));
        let span = trace::start(&server_id, &user, trace::Kind::Sftp, None, &cmd, false);
        // EXCLUDE: never truncate a file that is already there.
        let r = match s.open_with_flags(&path, OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE).await {
            Ok(f) => {
                let _ = f.close().await;
                Ok(())
            }
            Err(e) => Err(e),
        };
        finish(span, &session, &audit, &server_id, &user, "touch", cmd, r, &path).await.map(|_| path)
    };
    let r: AppResult<String> = trace::labelled(tr("Tệp · tạo tệp", "Files · new file"), run).await;
    r
}

#[tauri::command]
pub async fn sftp_rename(
    sessions: tauri::State<'_, Sessions>,
    audit: tauri::State<'_, AuditLog>,
    server_id: String,
    user: String,
    path: String,
    name: String,
) -> AppResult<String> {
    let run = async move {
        check_name(&name)?;
        let session = sessions.get(&server_id, &user)?;
        let s = sftp(&session).await?;
        let (dir, _) = parent_and_name(&path);
        let to = join(&dir, name.trim());
        if s.try_exists(&to).await.unwrap_or(false) {
            return Err(AppError::field("name_exists", "name"));
        }
        let cmd = format!("mv {} {}", shell_quote(&path), shell_quote(&to));
        let span = trace::start(&server_id, &user, trace::Kind::Sftp, None, &cmd, false);
        let r = s.rename(&path, &to).await;
        finish(span, &session, &audit, &server_id, &user, "rename", cmd, r, &path).await.map(|_| to)
    };
    let r: AppResult<String> = trace::labelled(tr("Tệp · đổi tên", "Files · rename"), run).await;
    r
}

/// Remove files, links and directories (recursively). Links are removed, never followed.
fn remove_tree<'a>(s: &'a SftpSession, path: &'a str) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), SftpError>> + Send + 'a>> {
    Box::pin(async move {
        let a = s.symlink_metadata(path).await?;
        if a.is_dir() && !a.is_symlink() {
            for item in s.read_dir(path).await? {
                let name = item.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                remove_tree(s, &join(path, &name)).await?;
            }
            s.remove_dir(path).await
        } else {
            s.remove_file(path).await
        }
    })
}

#[tauri::command]
pub async fn sftp_remove(
    sessions: tauri::State<'_, Sessions>,
    audit: tauri::State<'_, AuditLog>,
    server_id: String,
    user: String,
    paths: Vec<String>,
) -> AppResult<()> {
    let run = async move {
        let session = sessions.get(&server_id, &user)?;
        let s = sftp(&session).await?;
        let quoted: Vec<String> = paths.iter().map(|p| shell_quote(p)).collect();
        let cmd = format!("rm -r {}", quoted.join(" "));
        let span = trace::start(&server_id, &user, trace::Kind::Sftp, None, &cmd, false);
        let (mut r, mut at) = (Ok(()), "");
        for p in &paths {
            r = remove_tree(&s, p).await;
            if r.is_err() {
                at = p;
                break;
            }
        }
        finish(span, &session, &audit, &server_id, &user, "remove", cmd, r, at).await
    };
    let r: AppResult<()> = trace::labelled(tr("Tệp · xoá", "Files · delete"), run).await;
    r
}

fn chmod_tree<'a>(s: &'a SftpSession, path: &'a str, mode: u32, recursive: bool) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), SftpError>> + Send + 'a>> {
    Box::pin(async move {
        let a = s.symlink_metadata(path).await?;
        if a.is_symlink() {
            // chmod on a link changes its target; leave links alone like chmod -R.
            return Ok(());
        }
        let mut set = FileAttributes::empty();
        set.permissions = Some(mode);
        s.set_metadata(path, set).await?;
        if recursive && a.is_dir() {
            for item in s.read_dir(path).await? {
                let name = item.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                chmod_tree(s, &join(path, &name), mode, true).await?;
            }
        }
        Ok(())
    })
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn sftp_chmod(
    sessions: tauri::State<'_, Sessions>,
    audit: tauri::State<'_, AuditLog>,
    server_id: String,
    user: String,
    paths: Vec<String>,
    mode: u32,
    recursive: bool,
) -> AppResult<()> {
    let run = async move {
        if mode > 0o7777 {
            return Err(AppError::field("invalid_mode", "mode"));
        }
        let session = sessions.get(&server_id, &user)?;
        let s = sftp(&session).await?;
        let quoted: Vec<String> = paths.iter().map(|p| shell_quote(p)).collect();
        let cmd = format!("chmod {}{:o} {}", if recursive { "-R " } else { "" }, mode, quoted.join(" "));
        let span = trace::start(&server_id, &user, trace::Kind::Sftp, None, &cmd, false);
        let (mut r, mut at) = (Ok(()), "");
        for p in &paths {
            r = chmod_tree(&s, p, mode, recursive).await;
            if r.is_err() {
                at = p;
                break;
            }
        }
        finish(span, &session, &audit, &server_id, &user, "chmod", cmd, r, at).await
    };
    let r: AppResult<()> = trace::labelled(tr("Tệp · sửa quyền", "Files · change permissions"), run).await;
    r
}

/// A user or group name as useradd accepts it: letters, digits, `_ - .`, not
/// starting with '-' (chown would read it as an option), and `$` only at the
/// end (Samba machine accounts). It is quoted in the command anyway.
fn valid_account(name: &str) -> bool {
    let body = name.strip_suffix('$').unwrap_or(name);
    !body.is_empty() && name.len() <= 32 && !name.starts_with('-') && body.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

/// Change owner and group. Only root can; runs chown as root or through sudo.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn sftp_chown(
    sessions: tauri::State<'_, Sessions>,
    audit: tauri::State<'_, AuditLog>,
    server_id: String,
    user: String,
    paths: Vec<String>,
    owner: String,
    group: String,
    recursive: bool,
) -> AppResult<()> {
    let run = async move {
        if !valid_account(&owner) || !valid_account(&group) {
            return Err(AppError::field("invalid_owner", "owner"));
        }
        let session = sessions.get(&server_id, &user)?;
        if !session.is_root() && !session.sudo_on() {
            return Err(AppError::new("needs_root"));
        }
        let quoted: Vec<String> = paths.iter().map(|p| shell_quote(p)).collect();
        let cmd = format!("chown {}{} -- {}", if recursive { "-R " } else { "" }, shell_quote(&format!("{owner}:{group}")), quoted.join(" "));
        let out = exec_priv(&session, &cmd, Duration::from_secs(60)).await?;
        let ok = out.code == Some(0);
        // Logged as it ran: through sudo unless the session is root.
        let shown = crate::ssh::shown_as_run(&session, &cmd);
        audit.record(&server_id, &user, "chown", &shown, ok, (!ok).then(|| out.stderr.trim().to_string()));
        if ok {
            Ok(())
        } else {
            Err(AppError::detail("remote_command", out.stderr.trim()))
        }
    };
    let r: AppResult<()> = trace::labelled(tr("Tệp · đổi owner", "Files · change owner"), run).await;
    r
}

/// Log a file operation and turn its SFTP result into the app's error.
#[allow(clippy::too_many_arguments)]
async fn finish(
    span: trace::Span,
    session: &Session,
    audit: &AuditLog,
    server_id: &str,
    user: &str,
    action: &str,
    cmd: String,
    r: Result<(), SftpError>,
    path: &str,
) -> AppResult<()> {
    match r {
        Ok(()) => {
            span.ok(|_| {});
            audit.record(server_id, user, action, cmd, true, None);
            Ok(())
        }
        Err(e) => {
            let err = sftp_err(e, session, path).await;
            let text = err.detail.clone().unwrap_or_else(|| err.code.to_string());
            span.fail(&text, |_| {});
            audit.record(server_id, user, action, cmd, false, Some(text));
            Err(err)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ident(uid: u32, gids: &[u32]) -> Identity {
        Identity { uid, gids: gids.to_vec(), users: HashMap::new(), groups: HashMap::new() }
    }

    #[test]
    fn access_follows_owner_group_other() {
        let me = ident(1000, &[1000, 27]);
        assert_eq!(access(&me, Some(1000), Some(1000), 0o640, false), (Class::Owner, true, true));
        assert_eq!(access(&me, Some(0), Some(27), 0o640, false), (Class::Group, true, false));
        assert_eq!(access(&me, Some(0), Some(0), 0o640, false), (Class::Other, false, false));
        // A directory needs x to be listed or written into.
        assert_eq!(access(&me, Some(0), Some(0), 0o754, true), (Class::Other, false, false));
        assert_eq!(access(&me, Some(0), Some(0), 0o755, true), (Class::Other, true, false));
        assert_eq!(access(&ident(0, &[0]), Some(5), Some(5), 0o000, true), (Class::Root, true, true));
    }

    #[test]
    fn paths_and_names() {
        assert_eq!(join("/", "etc"), "/etc");
        assert_eq!(join("/var/www", "a"), "/var/www/a");
        assert_eq!(parent_and_name("/var/www/a"), ("/var/www".into(), "a".into()));
        assert_eq!(parent_and_name("/etc"), ("/".into(), "etc".into()));
        assert!(check_name("ok.txt").is_ok());
        assert!(check_name("a/b").is_err() && check_name("..").is_err() && check_name(" ").is_err());
        assert!(valid_account("www-data") && !valid_account("root;rm"));
    }

    #[test]
    fn parses_identity() {
        let i = parse_identity("1001\n@@PORTWAY@@\n1001 27\n@@PORTWAY@@\nroot:x:0:0::/root:/bin/bash\ndeploy:x:1001:1001::/home/deploy:/bin/bash\n@@PORTWAY@@\nroot:x:0:\nsudo:x:27:deploy\n").unwrap();
        assert_eq!((i.uid, i.gids.clone()), (1001, vec![1001, 27]));
        assert_eq!(i.users[&1001], "deploy");
        assert_eq!(i.groups[&27], "sudo");
    }

    #[test]
    fn account_names_cannot_become_options_or_expansions() {
        for ok in ["www-data", "deploy", "svc.web", "HOST$", "_apt"] {
            assert!(valid_account(ok), "{ok}");
        }
        for bad in ["", "-R", "www$HOME", "a$IFS-R", "a b", "a;b", "$", "a/b"] {
            assert!(!valid_account(bad), "{bad}");
        }
    }
}
