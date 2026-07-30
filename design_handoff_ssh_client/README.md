# Handoff: Portway — SSH/SFTP desktop client

> **Everything written below describes the *first* handoff. It is kept for
> history — the current design is `SSH Client.dc.html` beside it.**
>
> That prototype was re-imported from the Claude Design project
> (`SSH Desktop App Design`, `a221556e-0f42-419b-9878-7cc3316bc0e3`) and carries
> a second revision: the whole palette lifted off near-black, five nav icons,
> typography moved from IBM Plex to system stacks with every size up about a
> point, and the nav rail widened 194 → 214px. **The app implements that
> revision**, so every colour, size and font named below is now out of date by
> exactly one revision. Read the prototype, or `src/styles/theme.css`, which
> holds the same values as tokens.
>
> Two things the prototype will not tell you, both found by comparing the two
> revisions byte for byte:
>
> - Its own token table claims the white hairline alphas roughly tripled
>   (`.03 → .09`, `.06 → .13`, and so on). **Its markup disagrees** — nav rail
>   border, table row divider, field border and chip fills are byte-identical to
>   the first handoff. The only overlay the revision actually adds is
>   `#ffffff17`, on the five nav items' hover. The markup was taken as the
>   source of truth, since it is what renders.
> - Its typography section says "nothing goes below 11.5px" and then specifies
>   an 11px badge. The explicit value won.

## Overview
A personal cross-platform SSH desktop client. Left nav (Servers, SSH Keys, Tunnels, Known hosts, Settings), main area on the right. The Servers screen is a dense full-width table; clicking a row slides a detail drawer **over** the table (the table never resizes). SSH/SFTP opens a session screen with horizontal tabs, terminal on the left and an SFTP file browser on the right. A New/Edit server form covers password, private key + passphrase, ssh-agent, jump host and agent forwarding.

Scale: ~70 hosts, 4 groups (Production, Staging, Development, Homelab). Dense "pro tool" density, dark theme, English UI labels.

## About the design files
`SSH Client.dc.html` in this bundle is a **design reference created in HTML** — a prototype showing intended look and behavior, not production code to copy. Recreate these screens in the target codebase's environment (e.g. Electron/Tauri + React, or SwiftUI) using its established patterns and libraries. If no app scaffold exists yet, Tauri (Rust) or Electron with React + a virtualized table is a reasonable choice; real SSH/SFTP work must run in the native/host process, never in the renderer.

Open the file in a browser to interact with it. It contains an options canvas: turn **2** at the top is the chosen, built-out direction (option `2a`, the interactive one — **implement this**). Turn **1** below it holds four earlier explorations of the Servers screen (`1a`–`1d`) — reference only; `1a` is what `2a` grew from.

## Fidelity
**High-fidelity.** Colors, typography, spacing, and states below are final and exact. Recreate pixel-faithfully using the codebase's libraries. The prototype uses fake data and fake shell output; all values are placeholders for real SSH data.

---

## Screens / Views

### Shell (all screens)
- App window content area in the prototype: 1240 × 780 px. Real window is resizable; treat 1240×780 as the design baseline and the layout as fluid (nav fixed width, main area flexes).
- Root: `display:flex`. Background `#0c0d0f`, text `#e8e8e6`.
- **Left nav**: width **194px**, `flex:none`, background `#0a0b0c`, right border `1px solid rgba(255,255,255,.06)`, `display:flex;flex-direction:column`.
  - Brand row: padding `16px 16px 14px`, `display:flex;align-items:center;gap:9px`. Mark = 18×18px, `border-radius:4px`, filled with the accent color. Wordmark "Portway", 600 12.5px IBM Plex Sans, `letter-spacing:.02em`.
  - Nav list: padding `4px 8px`, `gap:1px`. Each item: `display:flex;justify-content:space-between`, padding `7px 9px`, `border-radius:5px`, font-size 12.5px. Idle color `#a6aab1`; hover background `rgba(255,255,255,.03)`; active background `rgba(255,255,255,.06)` + color `#e8e8e6`. Trailing count in IBM Plex Mono 11px `#6b7078`.
    Items: Servers (70), SSH Keys (4), Tunnels (2), Known hosts (41), Settings (no count).
    Servers stays visually active while on the session or form screen.
  - Section label style (used for "Groups", "Sessions" and every panel heading): 500 10px IBM Plex Sans, `letter-spacing:.09em`, `text-transform:uppercase`, color `#6b7078`.
  - Groups list: dot 6×6px `border-radius:50%` in the group colour, label 12px `#a6aab1`, count right-aligned mono 11px.
  - Sessions list (bottom, `margin-top:auto`): accent dot 5×5px + host name in mono 11.5px + kind (`SSH`/`SFTP`) 10px `#6b7078`. Clicking one opens the session screen.
  - Footer: top border, padding `11px 16px`, mono 11px `#6b7078`, text `agent · 3 keys loaded`.
- **Main area**: `flex:1;min-width:0;position:relative;overflow:hidden`. Each screen is `position:absolute;inset:0;display:flex;flex-direction:column` so switching screens never reflows the shell.

### 1. Servers
Purpose: find a host among ~70 and connect (SSH or SFTP), or inspect/edit it.

- **Toolbar** (padding `12px 16px`, bottom border `1px solid rgba(255,255,255,.06)`, `gap:10px`):
  - Search field: `flex:1`, background `#15171a`, border `1px solid rgba(255,255,255,.07)`, `border-radius:6px`, padding `6px 10px`; leading `/` in mono 12px `#6b7078`; placeholder "Search host, user, tag…" 12.5px `#83878e`. `/` focuses it.
  - Segmented filter: All | Recent | Favorites — same field background/border, `border-radius:6px`, items padding `6px 11px` font-size 11.5px; selected background `rgba(255,255,255,.07)` color `#e8e8e6`, others `#83878e`.
  - Primary button "New server": padding `6px 12px`, `border-radius:6px`, 12px/500, text `#0c0d0f` on accent.
- **Table**: header row + body rows share the grid
  `grid-template-columns: 12px 2.1fr 1.5fr 96px 104px 100px 68px 118px; gap:10px; padding:8px 16px` (header) / `9px 16px` (rows).
  - Header: 500 10px IBM Plex Sans, `letter-spacing:.08em`, uppercase, `#6b7078` — (dot), Host, Address, User, Group, Last used, Auth, (actions).
  - Row: `border-bottom:1px solid rgba(255,255,255,.03)`, font-size 12.5px, `cursor:pointer`; hover background `rgba(255,255,255,.04)`; selected (drawer open on it) background `rgba(255,255,255,.07)`.
  - Col 1: 7×7px group dot. Col Host: 12.5px `#e8e8e6`, single line with ellipsis (`min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`) — the host name must get the widest track; do not put a pill next to it.
  - Address / User: IBM Plex Mono 12px `#a6aab1`. Group: 12.5px `#a6aab1`. Last used: 12px `#83878e`. Auth: mono 11px `#83878e`, values `key` / `pass`.
  - Actions cell (right-aligned, `gap:5px`): "SSH" — padding `3px 9px`, `border-radius:4px`, 11px, `#e8e8e6` on `rgba(255,255,255,.07)`, hover `rgba(255,255,255,.15)`; "SFTP" — same box, `#a6aab1` on `rgba(255,255,255,.05)`. Both must `stopPropagation` so they don't also select the row. In production show these on row hover/focus (and keyboard-reachable).
  - Rows should be virtualized for 70+ hosts.
- **Footer bar**: top border, padding `9px 16px`, mono 11px `#6b7078`: left `70 hosts · 4 groups`, right `click row → details · ↵ ssh · ⇧↵ sftp`.
- **Detail drawer (key behavior)**: `position:absolute;top:0;right:0;bottom:0;width:330px`, background `#101114`, left border `1px solid rgba(255,255,255,.10)`, shadow `-18px 0 40px rgba(0,0,0,.45)`.
  - Closed: `transform:translateX(106%)`. Open: `translateX(0)`. Transition `transform .22s cubic-bezier(.32,.72,0,1)`.
  - Scrim behind it: `position:absolute;inset:0;background:rgba(0,0,0,.35)`, `opacity` 0→1 with `transition:opacity .18s ease`, `pointer-events:none` when closed. Clicking the scrim closes.
  - It **overlays** the table — the table's column widths must not change when it opens/closes.
  - Header block (padding `15px 16px 14px`, bottom border): group dot + host name 600 14.5px (ellipsis) + close `×` button 22×22px `border-radius:5px` `#83878e` on `rgba(255,255,255,.05)`, hover `rgba(255,255,255,.12)`. Below: `user@host:port` mono 12px `#83878e`.
  - Actions: row of two — "SSH" `flex:1` padding 8px `border-radius:6px` 12.5px/500 dark-on-accent; "SFTP" `flex:1` same size, `border:1px solid rgba(255,255,255,.12)`, transparent, hover `rgba(255,255,255,.06)`. Second row (`gap:6px`, `margin-top:8px`, 11.5px, `#a6aab1` on `rgba(255,255,255,.05)`, hover `rgba(255,255,255,.10)`): Edit, Duplicate, Terminal… and a `Del` chip in `#d9776a` with hover background `rgba(217,119,106,.15)`.
  - Meta list (padding `14px 16px`, `gap:9px`, 12px; labels `#6b7078`, values mono 12px right-aligned): Auth (`key · id_ed25519` / `password · keychain`), Passphrase (`keychain` / `—`), Jump host (`bastion.corp` / `—`), Agent forward (`on`/`off`), Group, Last used.
  - Recent activity: rows `ssh · 14m` / `sftp · 3 files` with relative time `#6b7078`.
  - Tags: chips padding `3px 8px`, `border-radius:4px`, mono 11px `#a6aab1` on `rgba(255,255,255,.06)`.
  - Footer (`margin-top:auto`, top border): the resolved command, mono 11px/1.6 `#6b7078`, `word-break:break-all`, prefixed `$ `.
  - Escape closes the drawer. Delete/Edit are the only destructive/navigating actions in it.
  - Production suggestion (not in mock): let the user drag the drawer's left edge to resize, persisted.

### 2. Session (SSH + SFTP side by side)
Purpose: work on one host — shell plus file transfer.

- **Tab strip** (background `#0a0b0c`, bottom border): leading "‹ hosts" button (padding `0 13px`, mono 12px `#83878e`, right border) returns to Servers. Then one tab per session: padding `9px 13px`, right border, font-size 12px, `gap:8px` — accent dot 6×6px, host name in mono, kind badge (`SSH`/`SFTP`) padding `1px 5px` `border-radius:3px` 9.5px `letter-spacing:.06em` on `rgba(255,255,255,.08)` color `#a6aab1`, and a `×`. Active tab background `#131417` color `#e8e8e6`; inactive transparent `#83878e`. Trailing `+` button `#6b7078`.
- **Body**: `flex:1;display:flex`.
  - **Terminal pane** `flex:1;min-width:0`, background `#08090a`.
    - Pane header: padding `8px 14px`, bottom border, mono 11px `#6b7078` — accent dot + `TERMINAL · user@host`, right side `ed25519 · 14m` (auth + uptime).
    - Body: padding `12px 14px`, IBM Plex Mono 12px/1.75, color `#a8aea8`, `white-space:pre-wrap`; block cursor = inline 7×14px accent block. Use a real terminal emulator here (xterm.js or native).
    - Status bar: padding `7px 14px`, top border, mono 10.5px `#4f545a` — `utf-8`, `80×24`, right `⌘T new tab · ⌘D split`.
  - **SFTP pane** width **470px** `flex:none`, background `#0e0f11`, left border `1px solid rgba(255,255,255,.08)`. Make this divider draggable in production; remember the split.
    - Header: `#c9a15f` dot + `SFTP`, right `local ⇄ remote` toggle, mono 11px `#6b7078`.
    - Path bar: padding `8px 12px`, mono 11.5px `#a6aab1`, `↑` + breadcrumb with `/` separators in `#6b7078`; right "Upload" chip padding `2px 7px` `border-radius:4px` on `rgba(255,255,255,.05)`.
    - File table grid `1.7fr 78px 100px; gap:10px`, header in the section-label style (Name, Size right-aligned, Modified). Rows padding `6px 12px`, mono 12px `#a6aab1`, hover `rgba(255,255,255,.04)` + `#e8e8e6`; directories and `..` render brighter (`#e8e8e6` / `#83878e`), size `—` for folders.
    - Transfer footer: filename + `62% · 3.1 MB/s` in mono 11px `#83878e`; progress track `height:3px;border-radius:2px;background:rgba(255,255,255,.08)` with an accent fill.

### 3. New / Edit server
Purpose: create or edit a host with any auth method.

- **Header bar** (padding `13px 20px`, bottom border): "‹ hosts", title "New server" 600 14px, right-aligned buttons — Cancel (`#a6aab1` on `rgba(255,255,255,.05)`), "Test connection" (outline `1px solid rgba(255,255,255,.14)`), Save (dark-on-accent, padding `7px 16px`). All `border-radius:6px`, 12px.
- **Body**: form column `flex:1` padding `20px 24px`, `gap:22px`; summary column width **300px** `flex:none`, left border, background `#0e0f11`, padding 18px.
- Field style: label 11.5px `#83878e` above a box — padding `8px 10px`, `border-radius:6px`, background `#15171a`, border `1px solid rgba(255,255,255,.08)`, value IBM Plex Mono 12.5px. Focused field border = accent at ~27% alpha. Dropdowns show a `⌄` and use color `#a6aab1`.
- **Connection** section: row 1 grid `1.6fr 74px` → Label, Group. Row 2 grid `1.6fr 74px 1fr` → Host, Port (default 22), Username.
- **Authentication** section: segmented control `Password | Private key | Agent` (width `max-content`, items padding `7px 14px` 12px; selected background `rgba(255,255,255,.08)` `#e8e8e6`, others `#83878e`). Only the selected method's fields render:
  - *Password*: masked Password field with a `show` affordance (11px `#6b7078`), plus toggle "Save to system keychain".
  - *Private key*: key path field + "Choose file…" (outline button) + "From SSH Keys" (soft button) on one row; then grid `1fr 1fr` → Passphrase (masked, `show`, label hint "(nếu key có)") and toggle "Unlock via keychain"; then a mono 11.5px `#6b7078` line `fingerprint SHA256:9pQ…hK4 · ed25519 · added Mar 2026`. Passphrase field is only meaningful when the key is encrypted — detect and disable otherwise.
  - *Agent*: explanatory 12.5px line, then a bordered list of agent-loaded keys (`border-radius:6px`, rows background `#15171a`, mono 12px) — accent `●` for usable, `#6b7078` for others, fingerprint right-aligned.
- **Advanced** section: grid `1fr 1fr` → "Jump host / bastion" (select of existing hosts) and "Run on connect" (e.g. `tmux attach -t main`). Below, two toggles in a row `gap:26px`: Agent forwarding (on), Keep alive (60s) (off).
- **Summary column**: "Resulting command" box (background `#101114`, border `1px solid rgba(255,255,255,.08)`, mono 11.5px/1.7 `#a6aab1`, `word-break:break-all`) that updates live from the form; "Checks" list — accent `✓` DNS / host reachable, accent `✓` Port 22 open via bastion, `#c9a15f` `!` Host key chưa có trong known_hosts; footer note (mono 11px `#6b7078`) that credentials live in the OS keychain and the app stores only references.
- Toggle switch spec (used across form + settings): track 30×17px `border-radius:9px`; on = accent with a 13×13px `#0c0d0f` knob at `top:2px;right:2px`; off = `rgba(255,255,255,.12)` with an `#83878e` knob at `left:2px`.

### 4. SSH Keys
Header: title 600 14px + `4 keys · 3 loaded in agent` (mono 11.5px `#6b7078`); right buttons "Import…" (outline) and "Generate key" (accent).
Table grid `12px 1.5fr 82px 1.6fr 90px 96px 118px; gap:10px`, rows padding `10px 16px`. Columns: status dot (accent = loaded in agent, `#c9a15f` = legacy/weak, `#6b7078` = not loaded), Name (mono 12.5px), Type (`ed25519`, `rsa 4096`), Fingerprint (mono 11.5px `#83878e`, ellipsis), Used by (`38 hosts`), Added, actions "Copy pub" + `···`.
Footer: `private keys không bao giờ rời khỏi máy` / right `passphrase lưu trong OS keychain`.

### 5. Tunnels
Header: title + `2 active · 2 idle`, right "New tunnel" (accent).
Grid `1.2fr 78px 2fr 1.1fr 88px 96px`. Columns: Label, Type (`local` / `dynamic` / `remote`, mono 11px), Forward (`127.0.0.1:5432 → 10.20.4.31:5432`, mono 11.5px `#83878e`), Via host, Autostart (`on session` / `on launch` / `manual`), State (dot + text; active = accent, idle = `#6b7078`).
Footer: `tunnel tự mở lại khi session tương ứng reconnect`.

### 6. Known hosts
Header: title, a filter field (max-width 280px, placeholder "Filter ~/.ssh/known_hosts"), right warning `1 host key changed` in `#c9a15f` mono 11.5px.
Grid `12px 1.6fr 90px 2fr 100px 118px`. Columns: status dot (accent verified, `#c9a15f` changed), Host (mono 12px), Key type, Fingerprint, First seen, actions — `Verified`/`Trust new` chip + `Remove` chip in `#d9776a`.
Footer: `41 entries · đọc trực tiếp từ ~/.ssh/known_hosts`.

### 7. Settings
Header: title + `config lưu tại ~/.portway/config.toml`.
Body: `display:grid;grid-template-columns:1fr 1fr;gap:26px 34px;align-content:start`, padding `20px 24px`. Each group has a section label and rows `display:flex;justify-content:space-between` 12.5px, label `#a6aab1`, control right-aligned (mono `#83878e` for selects, toggles per spec above).
- Appearance: Theme (Auto | Dark segmented), Accent (four 17px swatches `#5ec8b0` `#c9a15f` `#9b8fd6` `#e8e8e6`; selected has `box-shadow:0 0 0 2px rgba(255,255,255,.15)`), Row density (compact), Colour hosts by group (toggle on).
- Terminal: Font (IBM Plex Mono · 13px), Cursor (block · blink), Scrollback (10 000 lines), Bell (off).
- Security: Store secrets in OS keychain (on), Confirm before connecting to prod (on), Lock app after idle (15 min), Strict host key checking (ask).
- Transfers & sync: Default download folder (~/Downloads), Parallel transfers (4), Import from ~/.ssh/config → "Sync now" button, Config backup (local only).
Footer: `Portway 0.4.1 · openssh 9.7p1`.

---

## Interactions & behavior
- Nav item click → switch screen, close the drawer. Servers reads as active for the session and form screens too.
- Servers row click → select + open drawer. Row's SSH/SFTP buttons and the drawer's SSH/SFTP → open the session screen with that host as the active tab (kind recorded as SSH or SFTP). Drawer "Edit" and toolbar "New server" → form screen (drawer closes).
- Drawer close: `×`, scrim click, or Escape (global keydown listener, removed on unmount).
- Session: tab click switches the active tab; "‹ hosts" returns to Servers; `×` closes a tab; `+` opens a new session picker. Keyboard: `⌘T` new tab, `⌘D` split, `↵` ssh / `⇧↵` sftp from the list, `/` focus search.
- Form: segmented auth control swaps the field set; the "Resulting command" box recomputes on every change; Save/Cancel return to Servers.
- Transitions: drawer `transform .22s cubic-bezier(.32,.72,0,1)`; scrim `opacity .18s ease`. Everything else is instant except hover colour changes (leave at browser default or ~120ms ease).
- Not yet designed (call out to the user before inventing): connect progress / error states, host-key-changed confirmation dialog, delete confirmation, empty states (no hosts, no keys), form validation messages, offline/unreachable host indicator.

## Command construction (as prototyped)
`ssh` + (` -J bastion.corp` when the host has a jump host — every prod host except bastion.corp itself) + (` -i ~/.ssh/id_ed25519` when auth is key) + `user@ip` + (` -p <port>` when port ≠ 22).
Example: `ssh -J bastion.corp -i ~/.ssh/id_ed25519 postgres@10.20.4.31`.

## State management
Prototype state (single component):
- `screen`: `'servers' | 'session' | 'form' | 'keys' | 'tunnels' | 'known' | 'settings'`
- `sel`: index of the selected host
- `drawer`: boolean (detail drawer open)
- `kind`: `'SSH' | 'SFTP'` — kind of the session just opened
- `auth`: `'password' | 'key' | 'agent'` — form's auth method
- `tab`: active session tab index

Real app additionally needs: host list + groups (persisted config), search query and filter (All/Recent/Favorites), open sessions with live PTY handles, per-session SFTP cwd and transfer queue, keys enumerated from `~/.ssh` + ssh-agent, tunnel processes and their state, known_hosts parse, settings. Data fetching: read/write `~/.portway/config.toml`, import `~/.ssh/config`, secrets via OS keychain, all SSH/SFTP over the native process (IPC to the UI).

## Design tokens
Colors
- Background base `#0c0d0f`; nav / deepest `#0a0b0c`; terminal `#08090a`; panel `#0e0f11`; drawer & code blocks `#101114`; field / raised `#15171a`; active tab `#131417`.
- Text primary `#e8e8e6`; secondary `#a6aab1`; muted `#83878e`; faint `#6b7078`; terminal body `#a8aea8`; terminal status `#4f545a`.
- Hairlines & fills over dark: `rgba(255,255,255,.03)` (row divider), `.05` (soft button), `.06` (border / active nav), `.07`–`.08` (field border, selected row), `.10`–`.12` (outline button, toggle off), `.15` (hover soft button), `.26` (chip hover).
- Accent (default) `#5ec8b0`; alternates `#c9a15f`, `#9b8fd6`, `#e8e8e6`. Accent text sits on `#0c0d0f`.
- Group / status: Production `#d9776a`, Staging `#c9a15f`, Development `#5ec8b0`, Homelab `#9b8fd6`. Warning `#c9a15f`; destructive `#d9776a` (hover fill `rgba(217,119,106,.15)`).
- Scrim `rgba(0,0,0,.35)`; drawer shadow `-18px 0 40px rgba(0,0,0,.45)`.

Typography — IBM Plex Sans (UI) 400/500/600 and IBM Plex Mono (anything a shell would print: hosts, addresses, ports, fingerprints, paths, commands) 400/500.
- Screen title 600 14px; drawer host 600 14.5px; body 12.5px; table cell 12–12.5px; mono cell 11.5–12px; meta/footnote mono 11px; section label 500 10px uppercase `letter-spacing:.09em`; table header 500 10px uppercase `letter-spacing:.08em`; badge 9.5–10px.

Spacing — 4px base. Screen padding `12px 16px` (bars) / `20px 24px` (form, settings). Table rows `9–10px 16px`. Panel sections `14–18px 16px`. Gaps 5, 6, 8, 10, 12, 22, 26px.

Radii — 3px badge, 4px chip, 5px nav item / small button, 6px field / button / card, 8px card (turn-1 explorations only), 9px toggle track, 50% dots.

Shadows — only two: drawer `-18px 0 40px rgba(0,0,0,.45)`; selected accent swatch `0 0 0 2px rgba(255,255,255,.15)`.

## Assets
No image assets. The brand mark is a plain 18×18px accent square with 4px radius — replace with the real icon. No icon set is used: actions are text labels, status is coloured dots, and `↑ × + ⌄ ‹ ● ✓ ! ⇄ ↵ ⇧` are plain glyphs. If the codebase has an icon library, substituting icons for the `···`, `×`, `↑`, `+` affordances is fine; keep text labels on SSH/SFTP/Edit/Duplicate/Delete.

## Files
- `SSH Client.dc.html` — the design prototype. Turn 2 / option `2a` (top of the page) is the spec-carrying interactive design; turn 1 (`1a`–`1d`) are earlier Servers-screen explorations, reference only.
