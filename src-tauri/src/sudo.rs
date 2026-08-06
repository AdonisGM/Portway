use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager};
use zeroize::Zeroizing;

use crate::error::{Error, Result};
use crate::logging;
use crate::ssh;

/// Running one command as root on a host this session is already logged into.
///
/// SFTP has no idea what privilege is. The subsystem the server starts runs as
/// the account that logged in, the protocol has no "and now as root", and no
/// amount of asking it nicely will open `/etc/nginx/nginx.conf` for writing.
/// The elevation therefore happens beside SFTP rather than inside it: the bytes
/// go up the ordinary way, and one short command run over its own channel moves
/// them into place.
///
/// Everything here goes through `ssh::run`, which opens a channel with no PTY
/// and never touches the interactive shell. That is what keeps the password out
/// of the audit trail — `LineReader` writes down every line typed at the shell,
/// and a password typed there would be one of them.

/// Sudo passwords, in memory, for as long as the session lives.
///
/// Not the keychain, and not `Slot::Password`. This is a *second* secret: the
/// account's own password on the far end, which a key-authenticated host has
/// never given us and which is not the passphrase that unlocked the key.
/// `keychain.rs` explains why its two slots are kept apart, and the same
/// argument applies with more force to a secret nobody asked to have stored —
/// so it is held nowhere but here, and dropped when the session closes.
#[derive(Default)]
pub struct Passwords(pub Mutex<HashMap<String, Zeroizing<String>>>);

/// Where `sudo` stands on this session, as far as the pane needs to know.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    /// It runs without asking — NOPASSWD, a timestamp still warm from the
    /// user's own terminal, or a password already given here.
    Ready,
    /// It works, and wants the account password first.
    NeedsPassword,
    /// This account cannot use `sudo` on this host at all.
    Refused,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub status: Status,
    /// The server's own words, when it refused. Empty otherwise — there is
    /// nothing to explain about a yes.
    pub detail: String,
}

/// Nothing here reads a command's output except the probe, which prints
/// nothing. The cap exists so a host that answers `sudo` with a novel cannot
/// spend the app's memory on it.
const OUTPUT_LIMIT: usize = 64 * 1024;

/// Whether a password for this session is already in hand.
pub fn unlocked(app: &AppHandle, session_id: &str) -> bool {
    app.state::<Passwords>().0.lock().unwrap().contains_key(session_id)
}

/// Drops a session's password. Called when it is refused, and when the session
/// itself goes away.
pub fn forget(app: &AppHandle, session_id: &str) {
    let dropped = app.state::<Passwords>().0.lock().unwrap().remove(session_id);
    if dropped.is_some() {
        logging::debug("sudo", "forgot the password", Some(&format!("session={session_id}")));
    }
}

/// Asks the host what it would do, without doing anything and without asking
/// the user for anything.
///
/// `sudo -n` is the whole probe: it either runs, or says why it will not. This
/// is what keeps a NOPASSWD host — and there are a great many of them — from
/// ever being shown a password box it has no use for.
pub async fn check(app: &AppHandle, session_id: &str) -> Result<Check> {
    // Already unlocked here. Asking the server would only re-answer a question
    // this side can answer, and would spend a round trip doing it.
    if unlocked(app, session_id) {
        return Ok(Check { status: Status::Ready, detail: String::new() });
    }

    let out = ssh::run(app, session_id, &plain(VALIDATE), None, OUTPUT_LIMIT).await?;
    if out.status == 0 {
        return Ok(Check { status: Status::Ready, detail: String::new() });
    }

    // 127 is the shell's "no such command" — a host with no `sudo` on it. No
    // password will change that, so it is a refusal rather than a prompt.
    let status = if out.status == 127 || not_permitted(&out.stderr) {
        Status::Refused
    } else {
        // Anything else is treated as "it wants the password", including
        // wording this does not recognise. Being wrong that way costs one
        // dialog and then shows the server's real message; being wrong the
        // other way hides a working feature behind a guess.
        Status::NeedsPassword
    };
    Ok(Check { status, detail: said(&out.stderr) })
}

/// Takes the account password, checks it against the host, and keeps it for the
/// session if it holds.
pub async fn unlock(app: &AppHandle, session_id: &str, password: String) -> Result<()> {
    let password = Zeroizing::new(password);
    let out = with_password(app, session_id, VALIDATE, &password, OUTPUT_LIMIT).await?;
    if out.status != 0 {
        return Err(refusal(&out.stderr));
    }

    app.state::<Passwords>()
        .0
        .lock()
        .unwrap()
        .insert(session_id.to_string(), password);
    logging::info("sudo", "unlocked", Some(&format!("session={session_id}")));
    Ok(())
}

/// Runs one command as root, asking the host for as little as possible.
///
/// With a password in hand it always goes through `-S`, which works whether or
/// not sudo's own timestamp is still valid — one round trip that cannot fail
/// for a reason the caller would have to retry. With no password it tries `-n`,
/// which is a straight success on a NOPASSWD host and otherwise says what is
/// missing.
///
/// `command` is appended after `--` and must already be quoted by the caller —
/// see `quoted`.
pub async fn run(
    app: &AppHandle,
    session_id: &str,
    command: &str,
    limit: usize,
) -> Result<ssh::Output> {
    // Cloned out of the map rather than held across the await: this lock is
    // taken by every save, and a `.await` inside it would serialise them behind
    // whichever one is on the wire.
    let password = app
        .state::<Passwords>()
        .0
        .lock()
        .unwrap()
        .get(session_id)
        .cloned();

    let args = format!("-- {command}");
    let out = match &password {
        Some(secret) => with_password(app, session_id, &args, secret, limit).await?,
        None => ssh::run(app, session_id, &plain(&args), None, limit).await?,
    };
    if out.status == 0 {
        return Ok(out);
    }

    // A password the host has stopped accepting is worse than none at all:
    // every save after this would fail the same way, and nothing in the message
    // would suggest that the stored one is the problem. Dropping it puts the
    // next attempt back at "unlock", which is where it belongs.
    if wrong_password(&out.stderr) {
        forget(app, session_id);
    }
    Err(refusal(&out.stderr))
}

/// The `-n` form: run it if that needs nothing, and say so if it does not.
///
/// `args` is the whole tail after sudo's own options — either `VALIDATE`, or
/// `--` and a command already quoted by the caller.
fn plain(args: &str) -> String {
    format!("{LOCALE} sudo -n {args}")
}

/// Asks about sudo itself rather than about a command.
///
/// The probe and the password check both want to know whether this account can
/// use sudo here, and `-v` is the way sudo is asked that: it refreshes or
/// checks the credentials and runs nothing.
///
/// Emphatically not `-- true`. That asks whether **`/bin/true`** is permitted,
/// which is a different question with a different answer: a host with
/// `opc ALL=(ALL) NOPASSWD: /bin/cp` says no to it and yes to the one that
/// matters, and the feature would be hidden behind a command it never runs.
/// Worse with a password — the user would type a correct one and be told they
/// may not run sudo, and go looking for a sudoers entry that is not the problem.
const VALIDATE: &str = "-v";

/// Forces sudo's own messages into English.
///
/// The wording below is what tells a wrong password from a missing sudoers
/// entry, and a host whose account is set to another language would answer in
/// it — leaving the two indistinguishable, and the user sent to fix the wrong
/// thing.
///
/// Through `env` rather than a bare `LC_ALL=C` prefix, because the string is
/// handed to whatever login shell the account has, and `VAR=value command` is a
/// Bourne-shell construction. csh and tcsh — still root's shell on the BSDs —
/// read it as a command name and answer "LC_ALL=C: Command not found". `env` is
/// a program, and every shell runs a program the same way.
const LOCALE: &str = "env LC_ALL=C";

/// The `-S` form: password on stdin, prompt silenced.
///
/// `-p ''` matters as much as `-S` does. Without it sudo writes its own prompt
/// to stderr, and stderr is what the messages below are read out of — the
/// prompt would arrive mixed into the server's actual complaint.
///
/// Because the password travels on stdin it appears in no command string
/// anywhere, so nothing that logs a command can log it. That is the promise
/// `logging.rs` makes about sudo prompts, and this must not be what breaks it.
async fn with_password(
    app: &AppHandle,
    session_id: &str,
    args: &str,
    password: &str,
    limit: usize,
) -> Result<ssh::Output> {
    let line = format!("{LOCALE} sudo -S -p '' {args}");

    let mut stdin = Zeroizing::new(String::with_capacity(password.len() + 1));
    stdin.push_str(password);
    stdin.push('\n');

    ssh::run(app, session_id, &line, Some(stdin.as_bytes()), limit).await
}

/// sudo puts the useful sentence last — a wrong password is three attempts and
/// then the complaint, and the first two lines are the ones nobody needs.
fn said(stderr: &str) -> String {
    stderr.lines().rev().map(str::trim).find(|line| !line.is_empty()).unwrap_or("").to_string()
}

fn wrong_password(stderr: &str) -> bool {
    let text = stderr.to_ascii_lowercase();
    text.contains("try again")
        || text.contains("incorrect password")
        || text.contains("authentication failure")
        || text.contains("no password was provided")
}

fn not_permitted(stderr: &str) -> bool {
    let text = stderr.to_ascii_lowercase();
    text.contains("not in the sudoers")
        || text.contains("may not run")
        || text.contains("not allowed to execute")
        || missing(&text)
}

/// No `sudo` on the host at all.
///
/// Nothing here is sudo complaining, because there was no sudo to complain.
/// `env` is what reports it, since `env` is what runs sudo — GNU and BSD word
/// that differently, and a host reached without the `env` prefix at all would
/// have its shell answer instead. Hence three shapes rather than one.
///
/// The exit status is the reliable half of this: whatever the wording, a
/// command that is not there is 127, which is what `check` reads. These strings
/// are for the message, so that the one failure no password can fix says so.
fn missing(stderr: &str) -> bool {
    let text = stderr.to_ascii_lowercase();
    text.contains("command not found")
        || text.contains("unknown command")
        || (text.contains("env:") && text.contains("no such file"))
}

fn needs_a_terminal(stderr: &str) -> bool {
    let text = stderr.to_ascii_lowercase();
    text.contains("must have a tty") || text.contains("no tty present")
}

/// Turns what sudo said into what the user should do about it.
///
/// The three failures are genuinely different actions, and a single "sudo
/// failed" would hide which one this is: a wrong password is retyped, a missing
/// sudoers entry is not the user's to fix from here, and `requiretty` is a
/// setting on the server that no amount of typing will get past.
///
/// Every message starts `sudo: `, which is also how the pane recognises one of
/// these and offers to unlock rather than only showing the line.
fn refusal(stderr: &str) -> Error {
    let hint = if wrong_password(stderr) {
        "that password was not accepted. Try again.".to_string()
    } else if missing(stderr) {
        "there is no sudo on this server, so nothing here can be written as root.".to_string()
    } else if not_permitted(stderr) {
        format!(
            "this account may not run sudo on this server — {}",
            or_else(stderr, "the server gave no reason")
        )
    } else if needs_a_terminal(stderr) {
        "this server's sudoers file has `requiretty`, so sudo will not run without a terminal. \
         Portway runs it on a channel of its own, deliberately, so that the password never \
         reaches the shell — removing `Defaults requiretty` on the server is what fixes this."
            .to_string()
    } else if stderr.to_ascii_lowercase().contains("password is required") {
        "the account password is needed. Unlock sudo and try again.".to_string()
    } else {
        or_else(stderr, "it refused, and said nothing about why")
    };
    Error::Ssh(format!("sudo: {hint}"))
}

fn or_else(stderr: &str, fallback: &str) -> String {
    let last = said(stderr);
    if last.is_empty() { fallback.to_string() } else { last }
}

#[cfg(test)]
mod tests {
    use super::{needs_a_terminal, not_permitted, refusal, said, wrong_password};

    /// Captured from real hosts. These three drive three different messages,
    /// and getting them the wrong way round sends the user to fix the wrong
    /// thing.
    #[test]
    fn tells_the_three_failures_apart() {
        let bad = "[sudo] password for opc: \nSorry, try again.\nsudo: 3 incorrect password attempts";
        assert!(wrong_password(bad));
        assert!(!not_permitted(bad));

        let refused = "opc is not in the sudoers file.  This incident will be reported.";
        assert!(not_permitted(refused));
        assert!(!wrong_password(refused));

        let tty = "sudo: sorry, you must have a tty to run sudo";
        assert!(needs_a_terminal(tty));
        assert!(!not_permitted(tty));
        assert!(!wrong_password(tty));
    }

    /// A host with no `sudo` gets its own message, and the wording is the
    /// shell's rather than sudo's — there was nothing there to answer.
    #[test]
    fn says_so_when_there_is_no_sudo_at_all() {
        for stderr in [
            // What `env` says, which is what actually reports this: BSD first,
            // then GNU. Captured from a real run.
            "env: sudo: No such file or directory",
            "env: 'sudo': No such file or directory",
            "bash: sudo: command not found",
            "sudo: Command not found.",
            "fish: Unknown command: sudo",
        ] {
            let message = refusal(stderr).to_string();
            assert!(message.contains("no sudo on this server"), "{stderr:?} → {message}");
        }
    }

    /// The last line is the one that says something; the prompt and the retries
    /// above it are noise.
    #[test]
    fn keeps_the_last_thing_said() {
        assert_eq!(said("[sudo] password for opc: \nSorry, try again.\n\n"), "Sorry, try again.");
        assert_eq!(said(""), "");
        assert_eq!(said("   \n  \n"), "");
    }

    /// Every refusal is recognisable as one, which is what the pane keys off to
    /// offer the password box rather than only printing the line.
    #[test]
    fn every_refusal_names_sudo() {
        for stderr in [
            "Sorry, try again.",
            "opc is not in the sudoers file.",
            "sudo: sorry, you must have a tty to run sudo",
            "sudo: a password is required",
            "",
        ] {
            let message = refusal(stderr).to_string();
            assert!(message.starts_with("sudo: "), "{stderr:?} → {message}");
        }
    }
}
