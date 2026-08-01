# Portway

SSH/SFTP desktop client — Tauri (Rust) + React + TypeScript.

**SSH and SFTP are live.** Hosts are stored in SQLite, sessions open a real PTY over SSH
(`russh`), the SFTP pane browses the remote filesystem, and every command that reaches a host
is written to an audit trail. Key passphrases go to the OS keychain, so an encrypted key
opens. The SSH Keys screen reads `~/.ssh` and a running ssh-agent. Tunnels are real forwards —
`-L`, `-R` and `-D`, each on its own connection. Still mock: the Known hosts screen. Password
auth is still refused with a message rather than guessed at.

The UI is built from `design_handoff_ssh_client/`, which is high-fidelity: colours, type, and
spacing in that handoff are final and were transcribed rather than reinterpreted.

## Data layer

SQLite at **`~/.portway/portway.db`**, via `rusqlite` (bundled, so there is no system
dependency). Schema migrations are keyed off `PRAGMA user_version` in `src-tauri/src/db.rs` —
append a step, never edit one that has shipped.

| Command | Purpose |
|---|---|
| `list_hosts` | Read all hosts, ordered by id so rows never jump on rename |
| `create_host` / `update_host` | Validate, write, and return the saved row |
| `delete_host` | Remove a host; the UI also drops any open session for it |
| `touch_host` | Stamp `last_used_at` — what makes "Recent" and "Last used" real |
| `set_host_favorite` | Available; no control in the design sets it yet |

Layout: `db.rs` (connection + migrations), `models.rs` (`Host`, `HostInput`, validation),
`hosts.rs` (queries + commands), `error.rs` (one error type that serialises to a message the
form can display).

**Labels are unique**, enforced by a unique index on `hosts.name` (migration v2). Two layers
sit on top of it: the form disables Save and shows the clash in Checks before any write, and
`map_conflict` in `hosts.rs` turns the SQLite constraint error into readable text for anything
that slips past. Duplicate picks the next free number rather than appending blindly —
`web-01.prod` → `web-01.prod 2`, and duplicating *that* gives `web-01.prod 3`, skipping names
already in use. The logic exists twice on purpose: `nextCopyName` in `src/lib/naming.ts` for
the form, and `next_free_name` in `db.rs` so the v2 migration can renumber databases written
before the constraint existed. Keep the two in step.

**No secrets are stored in the database.** The summary column in the form promises that
credentials live in the OS keychain and the app keeps only references — so the database holds
the auth *method*, the key path, and the keychain toggles, and never a password or passphrase.

The passphrase now honours that literally. It rides in on `HostInput` — the seam this was
always meant to use — and `hosts.rs` diverts it to `keychain.rs` after the row is written;
every other field of the input is bound to a column, that one never is. It is a `Secret`
rather than a `String` so that `HostInput`'s `derive(Debug)` cannot print it into a panic or
a future trace line. Password is still component-local state discarded on save, because
password auth has no backend yet.

Three behaviours are worth knowing because none of them is visible from the UI:

- **An empty passphrase box means "unchanged", not "clear".** The box is empty every time a
  host is opened for editing, including one whose passphrase is stored, because nothing reads
  a secret back out. Treating empty as "clear" would drop the secret on any unrelated edit.
- **Turning "Unlock via keychain" off is how you forget one**, and it is the only way.
- **Deleting a host deletes its entry**, best-effort: the row is gone either way, and failing
  the delete over a credential store would leave a host that cannot be removed.

Entries are keyed by host id (`host:{id}:passphrase` under service `com.portway.ssh`), not by
key path. The toggle is per-host on a per-host form, so per-host entries keep turning it off,
or deleting a host, from reaching into another host that uses the same key file.

## SSH, SFTP and the audit trail

`ssh.rs` opens a connection with `russh`, authenticates, and requests a PTY plus a shell. One
task owns the channel — a russh channel cannot be shared — so keystrokes, resizes and output
all funnel through a single `tokio::select!`. Output reaches the webview as `ssh://data`
events; both directions carry base64, because terminal traffic is arbitrary bytes and a JSON
string will not survive them. `sftp.rs` opens a second channel on the *same* connection, which
is why a session has one audit trail rather than two.

**Host keys use trust-on-first-use and refuse on change.** The three outcomes of
`check_known_hosts_path` are easy to invert, and getting them backwards means accepting a
changed key, so they are spelled out at the call site: `Ok(true)` matches, `Ok(false)` means
*no entry yet* (learn it), and `Err(KeyChanged)` means the key is different (refuse). The
design leaves the "host key changed" confirmation undrawn, so refusing is the safe half of
that missing dialog. Every decision is recorded.

### What gets logged

Every command that reaches a host lands in `command_log`, tagged with:

- **`origin`** — `user` for what the person did, `system` for what Portway did on its own: the
  connection handshake, the host-key decision, `run on connect`, and the first SFTP listing
  when a pane opens.
- **`kind`** — `shell`, `exec`, `sftp` or `auth`.
- the exact command text, plus `detail` for things like the negotiated host key.

Shell commands are reconstructed from the PTY input stream by `LineReader`, because SSH
carries keystrokes and not commands, and reading them is the only way to see what a person ran
without changing the remote host. It tracks the line being edited, handles backspace a whole
character at a time, and buffers *bytes* so a UTF-8 sequence split across two writes — or an
accented argument — survives intact. Its limits are inherent rather than unfinished: shell
aliases are not expanded, keystrokes inside a full-screen program are recorded as typed, and a
command a remote script runs was never typed and so cannot appear. Anything Portway issues is
logged where it is issued, so `origin` stays trustworthy even though the reconstruction is
approximate.

### Trying it against a container

```bash
ssh-keygen -t ed25519 -f ~/.portway/test_ed25519 -N "" -C portway-test
docker run -d --name portway-test -p 2222:2222 \
  -e PUBLIC_KEY="$(cat ~/.portway/test_ed25519.pub)" \
  -e USER_NAME=deploy -e PASSWORD_ACCESS=false \
  lscr.io/linuxserver/openssh-server:latest
```

Then add a host: `127.0.0.1`, port `2222`, user `deploy`, private key
`~/.portway/test_ed25519`.

## Tunnels: what the map is claiming

Three fields decide a forward, and two of them are addresses, which is the thing this screen
kept getting asked about: *I picked the server — why does it want another IP?* Because `Via
host` is the **route** and the destination is where the route **ends**, and the two are only
the same machine some of the time.

The destination is resolved **on the far end**, not here. That is the entire point: the server
is a doorway to a network position you do not have. So `127.0.0.1` in that box means *the via
host itself* — a port bound to its own loopback, closed to the world, which is the commonest
forward there is and the one the form now offers as a choice rather than a box wanting an
address you have already given.

The map draws two nodes or three, per tunnel, and the difference is a real one:

| | drawn as | because |
| --- | --- | --- |
| destination is the via host | local → via | there is no third machine |
| destination is somewhere else | local → via → destination | the via host is *relaying*, in `channel_open_direct_tcpip`, which runs on the server |
| `remote` | local → via | the far end is this machine; the local card already carries its port |
| `dynamic` | local → via | each client names its own destination, so there is none to draw |

Not to be confused with the handoff's bastion column, which is still absent and still should
be: `hosts.jump_host` is stored and `ssh.rs` never implements ProxyJump, so a relay drawn
*before* the via host would be a hop that does not happen.

**The two hops are coloured separately**, which is the reason for splitting the line at all. A
forward whose SSH connection is perfect and whose destination refuses is one good hop and one
bad one; drawing the whole route as broken sends you looking in the wrong place. Red — and a
cross through the middle of the leg that failed, because colour alone does not survive a
glance.

The far leg is never probed on its own initiative. A forward set to `on launch` would then dial
somebody's production database at boot to decide the colour of a line, and a probe that
succeeded half an hour ago would still be drawn as true now. So it is `not tried` until
something real goes through it — or until you press **Test**, which opens one connection over
the tunnel's existing SSH handle and closes it, bounded at 8 seconds because an address routed
nowhere never refuses, it just says nothing.

## The application log and the debug console

There are two records in Portway and they answer different questions. The audit trail above is
**what reached a server**, kept in the database for as long as the host exists. The application
log is **what Portway did**, written to a file and thrown away after a week. `logging.rs` owns
it; `⌘⇧L` (Ctrl+Shift+L elsewhere) opens the console — *Portway — Debug & logs*, a window of its
own, one for the whole app. The chord works from any window and raises the console if it is
already up; pressing it inside the console closes it again.

```
~/.portway/logs/portway-2026-08-02.log        one file a day, rolled again at 8 MB, pruned after 7
```

**The log never carries input.** `ssh_write` sees every keystroke, including whatever is typed
at a remote `sudo` prompt, and none of it comes here — nor do passphrases, key material or
keychain values, which are logged as *having happened* and never as their contents. That is
what makes the file safe to send to somebody. The audit trail is where typed command lines live,
by design and in the database, not in a text file in a folder.

**Durations, not just events.** `Span` times the steps that can hang — the handshake, the
authentication, reading the private key, bringing a tunnel up — and a span asked to log at
`debug` is promoted to `info` when it took longer than 400 ms. That rule exists because of a
real morning lost to it: a key under `~/Documents` makes macOS put a consent dialog in front of
the read, drawn outside the app, and from inside the app that is indistinguishable from a server
that has stopped answering. It now reads as one line with `45.2s` on it, and the console warns
about the gated folder before you even connect.

Everything goes three places at once: the file, a 3000-line ring so a console opened afterwards
still has the history, and a `log://line` event so one already open is live. The frontend's own
lines — plus every uncaught error, unhandled rejection and `console.error`, captured by
`lib/log.ts` — take the round trip through Rust rather than being drawn locally, because a
session window is a second copy of the frontend and only the backend can put both windows'
lines in one order.

What it deliberately stays out of: the `ssh://data` pump, the 120 ms transfer progress, and the
three delete lanes. Operations report a summary and their failures, not their contents — a
401-entry delete adds three lines, at the noisiest setting.

A window rather than a panel over the app, because both things it is for need it *beside* what
it is describing: watching a connection go through while you look at the terminal it belongs to,
or parking it on a second screen while something long runs. An overlay covers the thing you
opened it to explain. It is the third thing `index.html` can be — `?debug=1`, next to
`?host=<id>` — and like a session window it is a second copy of the frontend sharing one Rust
process. It is also named in `capabilities/default.json`; a window that list does not name gets
no `core:event` at all, so the stream would be permanently empty.

| in the console | |
| --- | --- |
| `All / Info / Warnings / Errors` | filters what is shown |
| `Verbose` | changes what the backend *records* — `debug` for this run |
| `Copy` | the filtered lines, formatted as the file is |
| `Clear view` | this window's view only; the file is untouched |
| `Close` / `⌘W` / `⌘⇧L` | all close the window |

`PORTWAY_LOG=debug npm run tauri dev` starts verbose instead of switching it on afterwards.

## Running it

```bash
npm install
npm run tauri dev      # dev app with HMR
npm run tauri build    # installer in src-tauri/target/release/bundle/
```

On Windows: Rust (MSVC toolchain) and WebView2, which ships with Windows 11.

On macOS: Rust and the Xcode Command Line Tools — `rusqlite` is built from bundled C, so a
compiler has to be there. WKWebView is part of the OS. `npm run tauri build` produces both
`bundle/macos/Portway.app` and `bundle/dmg/`, for whichever architecture you are on; the binary
is ad-hoc signed, so on any machine that did not build it Gatekeeper will refuse to open it until
it is signed and notarised, or the first launch goes through right-click → Open.

## How it's put together

Three layers, built bottom-up. Screens are almost entirely composed of the layers below them.

**1. Tokens — `src/styles/theme.css`.** The handoff's whole token table lives in one Tailwind v4
`@theme` block, which generates a named utility per entry. It is the only file in the app where
a hex value or raw px measurement appears. The design's awkward values become named utilities
(`text-body` = 13.5px, `bg-field`, `border-w06`), so no component ever writes `text-[13.5px]`.

Spacing uses a fixed 4px base, so the design's odd values are ordinary scale steps:
9px = `2.25`, 7px = `1.75`, 11px = `2.75`, 18px = `4.5`, 26px = `6.5`.

That token block is also what makes a recolour a small change. The design's second
revision lifted every surface off near-black (base `#0c0d0f` → `#1b1e22`) and brightened
the text with it; because nothing outside `@theme` names a colour, the app followed from
editing that one block. Four values do *not* live there and have to be moved by hand —
`--color-ink` (a separate token that happens to equal the base, since `text-base` is
already Tailwind's font size), the window `backgroundColor` in both Tauri configs, and
the splash in `index.html`. Miss the last two and a cold start shows the old black for a
third of a second before the UI paints over it, which is the exact flash the splash
exists to prevent.

**2. Primitives — `src/components/ui/`.** `Button`, `Chip`, `Segmented`, `Toggle`, `Field`,
`Select`, `StatusDot`, `Drawer` and friends. Variants are declared once per component with
`tailwind-variants`, so call sites read `<Button variant="soft" size="sm">` instead of carrying
long conditional class strings.

`Select` is custom rather than a native `<select>`, and every dropdown in the app goes through
it — the form's boxed controls via `variant="field"`, the Settings rows via `variant="inline"`.
The native popup is drawn by the OS in system colours: it cannot be brought in line with the
design tokens and looks wrong in a dark, dense tool. The panel is portalled to `document.body`
and positioned `fixed` from the trigger's rect, because both places it is used sit inside
`overflow-y-auto` columns that would otherwise clip it; it flips above the trigger when there
is no room below. Keyboard: Enter/Space/arrows open, arrows and Home/End move, Enter commits,
Escape closes and returns focus to the trigger.

`QueryInput` is the GitHub-style filter field: `key:value` qualifiers are tinted and a
suggestion list offers first the keys, then that key's values. It is domain-agnostic — it takes
a list of `QualifierSpec`s and returns a string — so any screen that wants the same filtering
supplies its own specs. The grammar lives in `src/lib/query.ts` (positioned tokens, caret-aware
editing); the Servers half is `src/lib/hostQuery.ts` (which field each key reads, how a host is
matched). Colouring a substring is impossible inside an `<input>`, so the text is painted by a
mirrored overlay behind a transparent input; the two must keep identical font metrics or the
caret drifts off the glyphs.

`useAnchoredPanel` is the shared popover mechanic behind both `Select` and `QueryInput`:
portalled to `document.body`, positioned `fixed` from the anchor, flipped when there is no room
below, dismissed on outside press, scroll and resize.

**3. Layout — `src/components/layout/`.** `ScreenShell` captures the skeleton every screen
shares (bordered header, scrolling body, mono footer). `DataTable` drives all five tables —
Servers, SSH Keys, Tunnels, Known hosts and the SFTP file list — from a `gridTemplate` string
and a column spec, so row dividers, hover and selected states have a single definition.

A column marked `sortable` turns its heading into a button that cycles asc → desc → unsorted,
reported through `onToggleSort`; the comparison itself stays with the caller, which is the only
side that knows what a column means. Note `headerClassName` is separate from `className` on
purpose — a cell's font and colour must not leak into the heading, which takes its look from
`table-head`. A `<button>` heading has to restate `uppercase` and `tracking-head` because the
UA stylesheet resets those on form controls.

State is a flat Zustand store (`src/store/appStore.ts`) mirroring the prototype's own state,
plus search/filter/accent for the parts that are live.

### Things worth knowing before editing

- **No arbitrary values, no raw hex in components.** If you need `text-[11.5px]`, the token is
  missing — add it to `@theme`. Inline `style` is only for genuinely dynamic values: the grid
  templates, the drawer transform, the progress-bar width.
- **Base CSS must stay inside `@layer base`** (`src/styles/global.css`). Unlayered rules beat
  every layered one, so an unlayered `button { background: none }` silently strips `.bg-accent`
  off every button in the app.
- **Don't bake accent into data.** Store semantic status (`loaded`/`legacy`/`unloaded`,
  `active`/`idle`, `verified`/`changed`) and map it to a colour at render. Writing the accent
  hex into data would make the Settings accent picker recolour unrelated status dots.
- **Custom font sizes are registered with tailwind-merge** in `src/lib/tv.ts`. Without that,
  `text-cell` looks like a colour to tailwind-merge and silently cancels `text-fg-2`.
- **The titlebar's caption buttons must not sit inside a `data-tauri-drag-region`.** Tauri
  claims mousedown for anything inside one, turning button clicks into window drags.
- **Window IPC needs `src-tauri/capabilities/default.json`.** Tauri v2 denies every command not
  listed there; without it minimize/maximize/close silently do nothing.
- **Don't put `-webkit-font-smoothing: antialiased` back.** It reads like a polish setting and
  is nearly a reflex in web projects, but on macOS it swaps subpixel antialiasing for
  greyscale, and light text on a dark background is where that costs the most — measured on the
  nav labels it took out 19% of the ink and 28% of the solid stem pixels, which is the whole
  difference between "crisp" and "spindly". It mattered little against the vendored IBM Plex
  and a great deal against a system stack. The prototype sets no smoothing hint, so the
  browser default *is* the design.
- **The CSP needs `style-src-elem 'unsafe-inline'`, or the terminal loses every colour in
  release builds and only in release builds.** xterm's DOM renderer paints colour by creating
  a `<style>` element and writing `.xterm-fg-N { color: … }` into it. Tauri rewrites the CSP
  at build time to add a nonce to `style-src` — and by the CSP spec a nonce *disables*
  `'unsafe-inline'`, so that element is blocked. What you get is a terminal that parses escape
  sequences correctly (underline works, the codes are not echoed) and renders every one of
  them in the plain foreground. `npm run tauri dev` applies no CSP, so it looks perfect right
  up until you ship. `style-src-elem` is consulted before `style-src` for `<style>` elements,
  which is what buys the exception back without widening anything else.
- **The terminal's 16 ANSI colours must be named in the xterm theme.** With only `background`
  and `foreground` given, `@xterm/xterm` 6 renders every colour a program emits as the plain
  foreground: escape sequences are parsed — underline works, the codes are not echoed — but
  `ls` loses its directories and `git diff` loses its sides, and the pane reads as though it
  has no colour support at all. The palette lives in `@theme` with everything else; the
  fallbacks in `TerminalPane` exist only for the plain-browser dev path where the tokens are
  present anyway.
- **Never pass `None` as the hash algorithm for a public-key auth.** For an RSA key russh maps
  `None` to `ssh-rsa`, which is RSA over SHA-1, and OpenSSH has refused that by default since
  8.8 — so a perfectly good RSA key gets "the server rejected the key" and the search goes
  looking for a wrong key, which is the one thing it is not. `ssh.rs` asks the server through
  `best_supported_rsa_hash()` instead. That call waits up to a second for the `server-sig-algs`
  extension, so a server too old to send one costs a second and then correctly falls back to
  SHA-1. Non-RSA keys are unaffected: `PrivateKeyWithHashAlg::new` drops the hash algorithm for
  anything that is not RSA.
- **The ssh-agent is reached differently on each platform, and the difference is a compile
  error rather than a runtime one.** Unix publishes a Unix-domain socket in `SSH_AUTH_SOCK`;
  Windows OpenSSH publishes a named pipe and sets no such variable. russh reflects that in its
  types — `AgentClient::connect_env` exists only under `#[cfg(unix)]` — so calling it
  unconditionally does not degrade on Windows, it fails to build. `keys.rs::agent_identities`
  is split accordingly.
- **Editing hands the file to a local application rather than embedding an editor.** A bundled
  editor is several megabytes of somebody else's preferences, needs web workers the CSP would
  have to be widened for, and would still be the wrong editor. Instead the file is downloaded to
  `~/.portway/edit/<session>/`, opened with the OS's registered application (or one chosen from
  a picker), and *watched*: the backend polls the scratch copy's mtime and uploads it when it
  moves. Polling rather than a filesystem watcher, because editors save by writing a temp file
  and renaming it over the original at least as often as they write in place, and a stat does
  not care which happened.
- **The 5MB edit limit is enforced in Rust, not the dialog.** The dialog is the courtesy; the
  backend check is what stops a mis-click reading a gigabyte over the wire. The frontend passes
  `confirmedLarge` only after the user has answered, so the guard cannot be reached by accident
  and cannot be argued with by a caller that forgets to ask.
- **Destructive confirms are held, not clicked** (`HoldButton`, wired in `ConfirmDialog` for
  the `dangerSolid` variant only). A dialog already asks once, but it is answered by a click in
  roughly the place the click that opened it landed — the reflex that dismisses a dialog is the
  same motion that confirms it. A held gesture cannot happen by reflex, and it gives back what a
  modal takes away: the chance to change your mind *during* the action rather than only before
  it. Letting go rewinds, faster than it filled, so hesitating is not punished.

  Non-destructive confirms stay ordinary buttons on purpose. Making Rename hold would teach the
  user to hold everything, which is exactly how the gesture stops meaning anything.
- **Deleting a folder over SFTP has to empty it first.** `remove_dir` only takes an empty
  directory, so `sftp.rs::remove` descends collecting directories, deletes the files it finds,
  then removes the directories in reverse discovery order — deepest first, which is the only
  order the protocol permits and the same one `rm -r` uses. The dialog says so for the folder
  case: agreeing to delete a folder is agreeing to everything inside it, and there is no undo
  on the far end.
- **`openSession` and `openSessionTab` mean different things.** The SSH button says "get me to
  this server", so it reuses a live tab for that host — being taken to the one already open is
  the helpful answer. The `+` picker says "another tab", so it always makes one, even for a host
  that is already open: a button labelled `+` that sometimes adds nothing looks broken.
- **The status bar only advertises keys that are bound.** It used to promise a Windows chord on
  a Mac and a `⌘D` split that does not exist. A status bar naming shortcuts that do nothing
  teaches the user their keyboard is broken, which is a worse outcome than saying less. The
  new-tab shortcut is captured on `window` rather than bubbled, because the terminal holds focus
  most of the time this screen is open and xterm would otherwise see the key first.
- **The native context menu is off everywhere** (`App.tsx`), because a desktop app that opens
  the webview's "Reload / Inspect Element" menu reads as a web page in a frame. The terminal was
  the one candidate for an exception — some terminals paste on right-click — but xterm does not
  bind it and ours pastes with the platform shortcut, so leaving one pane with a browser menu
  would be stranger than having none. `DataTable` also clears the selection on right-click:
  WebKit selects the word under the cursor even through `user-select: none`, which otherwise
  leaves the filename highlighted behind the menu as though it were being edited.
- **Never build an SFTP attribute change on `Metadata::default()`.** It is not a blank: it is
  `size: Some(0)`, `uid`/`gid` `Some(0)`, `permissions: Some(0o777 | DIR)` and zeroed
  timestamps, and the protocol's flags word is derived from which fields are `Some`. A chmod
  written on top of it would truncate the file to nothing, hand it to root and date it to 1970.
  `sftp.rs::only()` exists to make the empty case the easy one.
- **A failed file operation must not replace the listing.** The pane has two error slots on
  purpose: one means "this folder could not be read" and takes the table's place, the other is a
  dismissible line above a listing that is still there. Losing your place in a directory is a
  worse outcome than the failure being reported.
- **A dropped file cannot come from an HTML5 `drop` handler.** The webview hands JavaScript a
  `File` with its path withheld — the same wall "Choose file…" hit — so OS drops arrive through
  `getCurrentWebview().onDragDropEvent()` with real paths instead. That event is *window*-wide,
  not per-element, so the SFTP pane hit-tests the drop position against its own rectangle;
  without that, dropping on the terminal would upload. The positions are physical pixels and
  `getBoundingClientRect` is CSS pixels, so they are divided by `devicePixelRatio` — on a 2×
  display, skipping that makes the pane appear to start halfway across the window.
- **The SFTP table's grid template and its column list are derived from one array.** They were
  two independent strings; a hidden column has to leave both in lockstep, and missing one puts
  every header over the wrong cell — which reads as a data bug, not a layout one. `Name` has no
  toggle, because a file browser with the filenames off is not a state worth reaching.
- **Owner is numeric, and that is the ceiling.** SFTP v3 carries owner and group *names* only in
  the `longname` field of a readdir reply, and russh-sftp's client drops it before the caller
  sees it. Names would mean reading `/etc/passwd` and `/etc/group` off the host — two reads the
  user never asked for, plus a cache and a fallback for servers that refuse them. `1000:1000` is
  always correct; names are a follow-up, not a missing piece of this one.
- **The session split is dragged, clamped and remembered.** The handoff fixes the SFTP pane at
  470px and then asks for exactly this — "make this divider draggable in production; remember
  the split" — so 470 is a starting width, not the width, and it stays in `@theme` because that
  is still where the design value belongs. Both sides have a floor for a reason worth keeping:
  the terminal's is a *column* count, and because the PTY is told its real size, dragging past
  it would reflow the remote shell's own output and outlive the drag. The width lives in
  `localStorage` rather than the database — it is a property of this window on this machine,
  not of the hosts.
- **One scan feeds three places.** `list_ssh_keys` is read by the Keys screen, the rail's
  count and agent line, and the server form — both its "From SSH Keys" picker and the list of
  agent-loaded keys under the Agent auth method. They were separate mocks and disagreed; a
  single command is what keeps them honest. It is deliberately not cached in Rust: a directory
  and an agent both change behind the app's back, which is why the screen has a Refresh rather
  than a promise.
- **Nothing on that screen opens a private key.** Type, size and fingerprint all come from the
  `.pub` beside it, age from the directory entry. A key with no readable `.pub` lists with `—`
  in those columns rather than being decrypted to fill them — the footer's "private keys never
  leave this machine" would be a strange thing to print underneath a screen that had just read
  one. `read_public_key` takes a *name*, not a path, and appends `.pub` itself, so it cannot be
  pointed anywhere else.
- **`weak` and `inAgent` are separate fields, not one status.** The design draws three dot
  colours — loaded, legacy, not loaded — which reads as an enum, but a key can be weak *and*
  loaded, and then the header's "N loaded in agent" has to count agent membership rather than
  the dot. Collapsing them is what makes that number start lying.
- **The private key field's two buttons read the real machine, not the mock.** "From SSH Keys"
  lists a scan of `~/.ssh` (`keys.rs`), not `SSH_KEYS` from `data/mock.ts`, because the path it
  writes is handed straight to `load_secret_key` on connect — offering the mock's invented names
  would build a host that cannot authenticate, and the failure would only surface at the first
  connection. The Keys *screen* is still mock, so the two disagree until it is given a real
  backend. That scan sniffs each file's header rather than matching names: `config`,
  `known_hosts` and `.pub` files share the directory and nothing but the content distinguishes
  them.
- **`tauri.macos.conf.json` repeats the whole window object, and has to.** Tauri merges the
  platform config with RFC 7396 semantics, where arrays are *replaced*, not merged — so
  `app.windows` there is the entire window, not a patch of it. Change a window property in
  `tauri.conf.json` and you must change it in both. The one that hurts if you forget is
  `visible: false`: drop it and the splash handoff below is gone, and macOS launches into a
  blank dark rectangle until the webview paints.

## Window chrome is per-platform

Windows keeps the frameless look the app was built with: `decorations: false`, and the caption
buttons in `components/chrome/WindowControls.tsx` are ours, drawn from the same tokens as
everything else.

macOS cannot use that — a frameless Tauri window there has no traffic lights at all, so the
window loses the one control cluster every Mac user reaches for, at the corner they reach for it
in. `tauri.macos.conf.json` therefore keeps the real frame and hides only its title bar:
`decorations: true` + `titleBarStyle: "Overlay"` + `hiddenTitle: true`. The system draws the
traffic lights over our content; we draw nothing on the right.

- **`trafficLightPosition` is measured, not computed.** `{ x: 14, y: 18 }` centres the lights in
  the 32px `--spacing-titlebar` bar. The `x` lands where you'd expect; `y` does not — it sits
  about 8px above the value you give it, so `18` puts the button tops at 10 and their centres at
  16. If the titlebar height ever changes, re-measure rather than re-derive: screenshot the
  corner and read the pixels.
- **`--spacing-lights` (86px) is the gutter the brand block indents by** so "Portway" clears the
  lights, which end at x≈74. The block stays 214px wide — that width continues the sidebar’s
  column hairline, so widening it to make room would misalign every row beneath it. The accent
  dot is dropped on macOS instead: three coloured circles already do that job in that corner.
- **Platform is detected synchronously** in `src/lib/platform.ts`, off `navigator.userAgent`,
  not via `@tauri-apps/plugin-os` whose `platform()` is async. The titlebar is in the first
  paint; an awaited answer would draw Windows caption buttons for a frame and then swap them.

## Deliberate departures from the mock

1. List bodies scroll (`overflow-y: auto`). The mock uses `overflow: hidden` because it only
   renders 9–11 rows; with 70 hosts that clips.
2. The Servers table is virtualized (70 rows). The other tables are 4–9 rows and are not.
3. Servers row SSH/SFTP buttons appear on hover/focus, as the handoff asks for in production.
   Actions on SSH Keys and Known hosts stay visible — `Verified` reads as status, not an action.
4. No webfont at all. The design's second revision specifies system stacks, which is the
   strongest form of the rule the vendored `@fontsource` files were serving — an app that asks
   for no font cannot reach for Google's.
5. **Custom 32px titlebar** replaces the Windows system frame. Not in the handoff — it was
   requested — so it is built from the same tokens. The brand mark moved out of the sidebar
   into it. The window opens at 1550×1015 — the 1240×812 baseline plus the 25% that was asked
   for — so the area below the titlebar keeps the design's proportions. Dragging, double-click-to-maximize and edge/corner resizing all still work
   (the window keeps `WS_THICKFRAME`), but **Windows Snap Layouts is lost**: the flyout needs
   the OS to hit-test a real `HTMAXBUTTON`, which a DOM button can't provide. If that matters,
   `tauri-plugin-decorum` extends the client area under a native frame and keeps snap — the
   `TitleBar` markup would not have to change.
6. The Servers footer reads `N of 70 hosts` while a search or filter is narrowing the list, and
   the mock's exact `70 hosts` otherwise.
7. All UI strings are English; the prototype mixed English and Vietnamese.
8. **The drawer's `Terminal…` chip is gone.** The handoff draws it between Duplicate and Del
   but never says what it does, the prototype leaves it inert, and it is absent from the list
   of things the handoff marks as undesigned — so there was nothing to build against. Rather
   than invent a behaviour, it was removed: a control that does nothing when pressed teaches
   the user the app is broken, and Edit and Duplicate get its width.

### Two places the handoff no longer matches reality

- **One action, not two.** The design draws SSH and SFTP as separate buttons on a row and in
  the drawer. SFTP turned out to be a second channel on the *same* connection, so both buttons
  opened an identical session. Only SSH remains; the tab badge always reads `SSH`, and
  `Session` has no `kind`.
- **Terminal line height is 1.3, not the handoff's 1.75.** The handoff asks for body text at
  `12px/1.75` *and* a 7×14px block cursor. A block cursor fills its cell, so at 1.75 the cell
  is 21px and the cursor towers over the text — the two cannot both hold in a real terminal.
  1.3 puts the cell near the 14px the design draws while keeping the lines comfortably spaced.

## Designed on request — not from the handoff

Two surfaces the handoff leaves open were designed because the work needed them. Both stay
inside the existing vocabulary rather than introducing new patterns, and both are flagged here
so they are not mistaken for transcription:

- **`ConfirmDialog`** (`components/ui/`) — reuses the drawer's surface, hairline, shadow and
  scrim, the screen-title type scale, and the existing button variants. Escape and a scrim
  click both cancel; focus lands on Cancel so a stray Enter is never destructive. One new
  button variant, `dangerSolid`, built exactly like `accent`.
- **The Servers empty state** — body copy, a mono footnote and the toolbar's accent button,
  centred where the table would be.
- **The favourite star** in the table's 12px first column. The design puts a group dot there;
  the dot carried no action and the group is already spelled out in the Group column, so that
  column is now purely the Favorite control — empty at rest, a star on row hover, and a filled
  accent star for a favourited host so favourites stay visible without hovering every row. The
  button is always mounted and only fades on opacity, which keeps it keyboard-reachable and
  stops the row shifting.

  Group dots still appear in the sidebar's Groups list and the drawer header, so Settings ›
  "Colour hosts by group" continues to govern those two.

- **The boot splash**, defined inline in `index.html`, plus the hidden-window start in
  `src/lib/splash.ts`. Measured on a release build: the Tauri window is on screen ~60ms after
  launch but WebView2 does not paint the document until ~440ms, so a normal window spends a
  third of a second as a blank dark rectangle. The window is therefore created with
  `visible: false` and revealed from `App`'s first effect, with the splash still covering it,
  held for `MIN_SPLASH_VISIBLE_MS` and then faded through to the UI — nothing, then branding,
  then the app, never a blank frame.

  Three things can reveal the window, whichever gets there first: a plain inline script in
  `index.html` right after the document paints (~450ms, the fast path — this is what
  `withGlobalTauri` is enabled for), `revealApp()` once React has mounted (~885ms), and
  `lib.rs` unconditionally after five seconds. The last is the guarantee: a frontend that
  breaks before mount still puts a branded window on screen rather than leaving the app
  looking like it never launched.

  The splash CSS has to be inline; anything imported through the bundle arrives after the gap
  it exists to fill, which is why the accent is hard-coded there and nowhere else. The hold is
  measured from `window.__portwayShownAt`, stamped by whichever path revealed the window, so
  the splash is on screen for the same length of time either way.

Form validation reuses the summary column's existing **Checks** list rather than adding a
toast: Save is disabled until Label, Host and Username are filled, and a backend error appears
there as a `!` line.

## Not designed yet — don't invent these

The handoff still leaves these open: connect progress and error states, the host-key-changed
confirmation, empty states for SSH Keys, an offline/unreachable indicator, and the `+`
new-session picker. All of these are stubbed inert.

The Settings `Auto | Dark` theme control is also inert — only a dark theme was designed.
