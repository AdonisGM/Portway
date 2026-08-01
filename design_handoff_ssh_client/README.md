# Handoff: Portway — SSH/SFTP desktop client

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
- Root: `display:flex`. Background `#1b1e22`, text `#f1f2f4`.
- **Left nav**: width **194px**, `flex:none`, background `#14161a`, right border `1px solid rgba(255,255,255,.13)`, `display:flex;flex-direction:column`.
  - Brand row: padding `16px 16px 14px`, `display:flex;align-items:center;gap:9px`. Mark = 18×18px, `border-radius:4px`, filled with the accent color. Wordmark "Portway", 600 13.5px, `letter-spacing:.02em`.
  - Nav list: padding `4px 8px`, `gap:1px`. Each item: `display:flex;justify-content:space-between`, padding `7px 9px`, `border-radius:5px`, font-size 13.5px. Idle color `#c5cad1`; hover background `rgba(255,255,255,.08)`; active background `rgba(255,255,255,.13)` + color `#f1f2f4`. Trailing count in mono 12.5px `#939aa3`.
    Items: Servers (70), SSH Keys (4), Tunnels (2), Known hosts (41), Settings (no count).
    Servers stays visually active while on the session or form screen.
  - Section label style (used for "Groups", "Sessions" and every panel heading): 500 11.5px, `letter-spacing:.09em`, `text-transform:uppercase`, color `#939aa3`.
  - Groups list: dot 6×6px `border-radius:50%` in the group colour, label 13px `#c5cad1`, count right-aligned mono 12.5px.
  - Sessions list (bottom, `margin-top:auto`): accent dot 5×5px + host name in mono 13px + kind (`SSH`/`SFTP`) 11.5px `#939aa3`. Clicking one opens the session screen.
  - Footer: top border, padding `11px 16px`, mono 12.5px `#939aa3`, text `agent · 3 keys loaded`.
- **Main area**: `flex:1;min-width:0;position:relative;overflow:hidden`. Each screen is `position:absolute;inset:0;display:flex;flex-direction:column` so switching screens never reflows the shell.

### 1. Servers
Purpose: find a host among ~70 and connect (SSH or SFTP), or inspect/edit it.

- **Toolbar** (padding `12px 16px`, bottom border `1px solid rgba(255,255,255,.13)`, `gap:10px`):
  - Search field: `flex:1`, background `#2a2e34`, border `1px solid rgba(255,255,255,.15)`, `border-radius:6px`, padding `6px 10px`; leading `/` in mono 13px `#939aa3`; placeholder "Search host, user, tag…" 13.5px `#a9afb7`. `/` focuses it.
  - Segmented filter: All | Recent | Favorites — same field background/border, `border-radius:6px`, items padding `6px 11px` font-size 13px; selected background `rgba(255,255,255,.15)` color `#f1f2f4`, others `#a9afb7`.
  - Primary button "New server": padding `6px 12px`, `border-radius:6px`, 13px/500, text `#1b1e22` on accent.
- **Table**: header row + body rows share the grid
  `grid-template-columns: 12px 2.1fr 1.5fr 96px 104px 100px 68px 118px; gap:10px; padding:8px 16px` (header) / `9px 16px` (rows).
  - Header: 500 11.5px, `letter-spacing:.08em`, uppercase, `#939aa3` — (dot), Host, Address, User, Group, Last used, Auth, (actions).
  - Row: `border-bottom:1px solid rgba(255,255,255,.09)`, font-size 13.5px, `cursor:pointer`; hover background `rgba(255,255,255,.08)`; selected (drawer open on it) background `rgba(255,255,255,.15)`.
  - Col 1: 7×7px group dot. Col Host: 13.5px `#f1f2f4`, single line with ellipsis (`min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`) — the host name must get the widest track; do not put a pill next to it.
  - Address / User: mono 13px `#c5cad1`. Group: 13.5px `#c5cad1`. Last used: 13px `#a9afb7`. Auth: mono 12.5px `#a9afb7`, values `key` / `pass`.
  - Actions cell (right-aligned, `gap:5px`): "SSH" — padding `3px 9px`, `border-radius:4px`, 12.5px, `#f1f2f4` on `rgba(255,255,255,.15)`, hover `rgba(255,255,255,.28)`; "SFTP" — same box, `#c5cad1` on `rgba(255,255,255,.10)`. Both must `stopPropagation` so they don't also select the row. In production show these on row hover/focus (and keyboard-reachable).
  - Rows should be virtualized for 70+ hosts.
- **Footer bar**: top border, padding `9px 16px`, mono 12.5px `#939aa3`: left `70 hosts · 4 groups`, right `click row → details · ↵ ssh · ⇧↵ sftp`.
- **Detail drawer (key behavior)**: `position:absolute;top:0;right:0;bottom:0;width:330px`, background `#22262b`, left border `1px solid rgba(255,255,255,.19)`, shadow `-18px 0 40px rgba(0,0,0,.45)`.
  - Closed: `transform:translateX(106%)`. Open: `translateX(0)`. Transition `transform .22s cubic-bezier(.32,.72,0,1)`.
  - Scrim behind it: `position:absolute;inset:0;background:rgba(0,0,0,.35)`, `opacity` 0→1 with `transition:opacity .18s ease`, `pointer-events:none` when closed. Clicking the scrim closes.
  - It **overlays** the table — the table's column widths must not change when it opens/closes.
  - Header block (padding `15px 16px 14px`, bottom border): group dot + host name 600 15.5px (ellipsis) + close `×` button 22×22px `border-radius:5px` `#a9afb7` on `rgba(255,255,255,.10)`, hover `rgba(255,255,255,.24)`. Below: `user@host:port` mono 13px `#a9afb7`.
  - Actions: row of two — "SSH" `flex:1` padding 8px `border-radius:6px` 13.5px/500 dark-on-accent; "SFTP" `flex:1` same size, `border:1px solid rgba(255,255,255,.24)`, transparent, hover `rgba(255,255,255,.13)`. Second row (`gap:6px`, `margin-top:8px`, 12.5px, `#c5cad1` on `rgba(255,255,255,.10)`, hover `rgba(255,255,255,.19)`): Edit, Duplicate, Terminal… and a `Del` chip in `#d9776a` with hover background `rgba(217,119,106,.15)`.
  - Meta list (padding `14px 16px`, `gap:9px`, 13px; labels `#939aa3`, values mono 13px right-aligned): Auth (`key · id_ed25519` / `password · keychain`), Passphrase (`keychain` / `—`), Jump host (`bastion.corp` / `—`), Agent forward (`on`/`off`), Group, Last used.
  - Recent activity: rows `ssh · 14m` / `sftp · 3 files` with relative time `#939aa3`.
  - Tags: chips padding `3px 8px`, `border-radius:4px`, mono 12.5px `#c5cad1` on `rgba(255,255,255,.13)`.
  - Footer (`margin-top:auto`, top border): the resolved command, mono 12.5px/1.6 `#939aa3`, `word-break:break-all`, prefixed `$ `.
  - Escape closes the drawer. Delete/Edit are the only destructive/navigating actions in it.
  - Production suggestion (not in mock): let the user drag the drawer's left edge to resize, persisted.

### 2. Session (SSH + SFTP side by side)
Purpose: work on one host — shell plus file transfer.

- **Tab strip** (background `#14161a`, bottom border): leading "‹ hosts" button (padding `0 13px`, mono 13px `#a9afb7`, right border) returns to Servers. Then one tab per session: padding `9px 13px`, right border, font-size 13px, `gap:8px` — accent dot 6×6px, host name in mono, kind badge (`SSH`/`SFTP`) padding `1px 5px` `border-radius:3px` 11px `letter-spacing:.06em` on `rgba(255,255,255,.16)` color `#c5cad1`, and a `×`. Active tab background `#262a30` color `#f1f2f4`; inactive transparent `#a9afb7`. Trailing `+` button `#939aa3`.
- **Body**: `flex:1;display:flex`.
  - **Terminal pane** `flex:1;min-width:0`, background `#121417`.
    - Pane header: padding `8px 14px`, bottom border, mono 12.5px `#939aa3` — accent dot + `TERMINAL · user@host`, right side `ed25519 · 14m` (auth + uptime).
    - Body: padding `12px 14px`, mono 13px/1.75, color `#ced4ce`, `white-space:pre-wrap`; block cursor = inline 7×14px accent block. Use a real terminal emulator here (xterm.js or native).
    - Status bar: padding `7px 14px`, top border, mono 12px `#8d939b` — `utf-8`, `80×24`, right `⌘T new tab · ⌘D split`.
  - **SFTP pane** width **470px** `flex:none`, background `#1f2226`, left border `1px solid rgba(255,255,255,.16)`. Make this divider draggable in production; remember the split.
    - Header: `#c9a15f` dot + `SFTP`, right `local ⇄ remote` toggle, mono 12.5px `#939aa3`.
    - Path bar: padding `8px 12px`, mono 13px `#c5cad1`, `↑` + breadcrumb with `/` separators in `#939aa3`; right "Upload" chip padding `2px 7px` `border-radius:4px` on `rgba(255,255,255,.10)`.
    - File table grid `1.7fr 78px 100px; gap:10px`, header in the section-label style (Name, Size right-aligned, Modified). Rows padding `6px 12px`, mono 13px `#c5cad1`, hover `rgba(255,255,255,.08)` + `#f1f2f4`; directories and `..` render brighter (`#f1f2f4` / `#a9afb7`), size `—` for folders.
    - Transfer footer: filename + `62% · 3.1 MB/s` in mono 12.5px `#a9afb7`; progress track `height:3px;border-radius:2px;background:rgba(255,255,255,.16)` with an accent fill.

### 3. New / Edit server
Purpose: create or edit a host with any auth method.

- **Header bar** (padding `13px 20px`, bottom border): "‹ hosts", title "New server" 600 15px, right-aligned buttons — Cancel (`#c5cad1` on `rgba(255,255,255,.10)`), "Test connection" (outline `1px solid rgba(255,255,255,.26)`), Save (dark-on-accent, padding `7px 16px`). All `border-radius:6px`, 13px.
- **Body**: form column `flex:1` padding `20px 24px`, `gap:22px`; summary column width **300px** `flex:none`, left border, background `#1f2226`, padding 18px.
- Field style: label 13px `#a9afb7` above a box — padding `8px 10px`, `border-radius:6px`, background `#2a2e34`, border `1px solid rgba(255,255,255,.17)`, value mono 13.5px. Focused field border = accent at ~27% alpha. Dropdowns show a `⌄` and use color `#c5cad1`.
- **Connection** section: row 1 grid `1.6fr 74px` → Label, Group. Row 2 grid `1.6fr 74px 1fr` → Host, Port (default 22), Username.
- **Authentication** section: segmented control `Password | Private key | Agent` (width `max-content`, items padding `7px 14px` 13px; selected background `rgba(255,255,255,.16)` `#f1f2f4`, others `#a9afb7`). Only the selected method's fields render:
  - *Password*: masked Password field with a `show` affordance (12.5px `#939aa3`), plus toggle "Save to system keychain".
  - *Private key*: key path field + "Choose file…" (outline button) + "From SSH Keys" (soft button) on one row; then grid `1fr 1fr` → Passphrase (masked, `show`, label hint "(nếu key có)") and toggle "Unlock via keychain"; then a mono 13px `#939aa3` line `fingerprint SHA256:9pQ…hK4 · ed25519 · added Mar 2026`. Passphrase field is only meaningful when the key is encrypted — detect and disable otherwise.
  - *Agent*: explanatory 13.5px line, then a bordered list of agent-loaded keys (`border-radius:6px`, rows background `#2a2e34`, mono 13px) — accent `●` for usable, `#939aa3` for others, fingerprint right-aligned.
- **Advanced** section: grid `1fr 1fr` → "Jump host / bastion" (select of existing hosts) and "Run on connect" (e.g. `tmux attach -t main`). Below, two toggles in a row `gap:26px`: Agent forwarding (on), Keep alive (60s) (off).
- **Summary column**: "Resulting command" box (background `#22262b`, border `1px solid rgba(255,255,255,.17)`, mono 13px/1.7 `#c5cad1`, `word-break:break-all`) that updates live from the form; "Checks" list — accent `✓` DNS / host reachable, accent `✓` Port 22 open via bastion, `#c9a15f` `!` Host key chưa có trong known_hosts; footer note (mono 12.5px `#939aa3`) that credentials live in the OS keychain and the app stores only references.
- Toggle switch spec (used across form + settings): track 30×17px `border-radius:9px`; on = accent with a 13×13px `#1b1e22` knob at `top:2px;right:2px`; off = `rgba(255,255,255,.24)` with an `#a9afb7` knob at `left:2px`.

### 4. SSH Keys
Header: title 600 15px + `4 keys · 3 loaded in agent` (mono 13px `#939aa3`); right buttons "Import…" (outline) and "Generate key" (accent).
Table grid `12px 1.5fr 82px 1.6fr 90px 96px 118px; gap:10px`, rows padding `10px 16px`. Columns: status dot (accent = loaded in agent, `#c9a15f` = legacy/weak, `#939aa3` = not loaded), Name (mono 13.5px), Type (`ed25519`, `rsa 4096`), Fingerprint (mono 13px `#a9afb7`, ellipsis), Used by (`38 hosts`), Added, actions "Copy pub" + `···`.
Footer: `private keys không bao giờ rời khỏi máy` / right `passphrase lưu trong OS keychain`.

### 5. Tunnels — topology map (redesigned)
Purpose: see at a glance what is forwarded where, from this machine through any bastion to the target hosts.

Layout: header bar, then a **pannable/zoomable map canvas** (`flex:1;min-height:520px;position:relative;overflow:hidden`, background `#191c20`, cursor `grab` / `grabbing` while dragging), then the tunnel **list** as a sibling below the canvas (never inside it).

- **Header**: title 600 15px + `2 active · 2 idle` (mono 13px `#939aa3`); right side a `Map | List` segmented control (same style as the auth segmented control) and "New tunnel" (accent).
- **Dot grid**: `position:absolute;inset:0;opacity:.5;background-image:radial-gradient(rgba(255,255,255,.09) 1px,transparent 1px)`; its `background-size` is `26px` × zoom and `background-position` = the pan offset, so the grid moves and scales with the diagram.
- **Stage**: one absolutely positioned layer, `width:1026px;height:520px;transform:translate(panX,panY) scale(zoom);transform-origin:0 0`, holding the SVG edges, the node cards and the port chips. Toolbar, legend and the list stay outside the stage (never transformed).
- **Nodes** (all `position:absolute`, `box-sizing:border-box`, `border-radius:9px`; active = `background:#22262b` + `1px solid` accent at ~24–35% alpha; idle = `background:#1f2226` + `1px dashed rgba(255,255,255,.24)`):
  - `This machine` — left 38, top 170, 222×196, accent border + `box-shadow:0 8px 26px rgba(0,0,0,.28)`. Contents: monitor glyph + "This machine" 600 13.5px, `root@localhost` mono 13px `#a9afb7`, section label "LOCAL PORTS", pulsing accent dot + `2 of 4 forwards up`, and `↑ 184 KB/s · ↓ 3.3 MB/s`.
  - `bastion.corp` — left 396, top 206, 182×92: accent dot + name, `jump@203.0.113.7`, `relaying 2 tunnels`.
  - `socks proxy` — left 396, top 96, 182×66, idle style: `dynamic · idle`.
  - `db-primary.prod` — left 736, top 52, 252×88: group dot `#d9776a`, name, right-aligned `active` in accent, `10.20.4.31 · postgres`, `↑ 96 KB/s · ↓ 3.1 MB/s`.
  - `api-gw.prod` — left 736, top 178, 252×88, same pattern (`↑ 88 KB/s · ↓ 184 KB/s`).
  - `nas.home` — left 736, top 380, 252×88, idle style: purple dot, `idle`, `192.168.1.20 · admin`, `direct · no bastion`.
- **Port chips** — every port is its own chip **fully outside** the card edge, vertically centred on the connection endpoint: status dot 5px + port label, padding `3px 8px`, `border-radius:5px`, background `#22262b`, mono 13px; active = accent border (~50% alpha) + accent text + pulsing dot, idle = `rgba(255,255,255,.24)` border + `#a9afb7` text + grey dot. `z-index:2`.
  - Right-edge chips: `left:<edge>+6px; transform:translate(0,-50%)` — This machine `:5432` (260,212), `:3000` (260,252), `:1080` (260,292), `:5000` (260,332); bastion out `:5432` (578,232), `:3000` (578,268).
  - Left-edge chips: `left:<edge>-6px; transform:translate(-100%,-50%)` — bastion `:22` (396,250), `socks` (396,129), db `:5432` (736,96), api `:3000` (736,222), nas `:5000` (736,424).
  - Chips must never overlap card copy — park them outside the border, don't straddle it.
- **Edges** — **one line per tunnel**, carrying both directions (no parallel send/receive pair). Each drawn as three stacked paths on identical geometry: a base `rgba(255,255,255,.17)` 2px track, the visible stroke (colour/width/dash from state), and a `stroke:transparent;stroke-width:16;pointer-events:stroke;cursor:pointer` hit path for clicking.
  - Geometry (SVG `viewBox="0 0 1026 520"`): tunnel 0 = `M260 212 C 322 212, 336 250, 396 250` + `M578 232 C 640 232, 664 96, 736 96`; tunnel 1 = `M260 252 C 322 252, 336 250, 396 250` + `M578 268 C 640 268, 664 222, 736 222`; tunnel 2 (socks) = `M260 292 C 320 292, 330 129, 396 129`; tunnel 3 (nas) = `M260 332 C 420 360, 560 424, 736 424`. Endpoints sit exactly on the real card edges.
  - Active: accent stroke, `stroke-dasharray:9 11`, `animation:tunFlow 1.15s/1.4s linear infinite` where `@keyframes tunFlow{to{stroke-dashoffset:-40}}` — a continuous flow toward the remote end. Idle: `rgba(255,255,255,.33)`, `stroke-dasharray:6 7`, no animation.
  - Selected: stroke-width 3.4 (idle lines also brighten to `#c5cad1`).
  - Receive-end pulse: `circle r=6` in accent at each active target port with `@keyframes tunHalo{0%{transform:scale(1);opacity:.5}70%,100%{transform:scale(2.6);opacity:0}}`, 1.9s, staggered .6s; `transform-origin` set to the circle centre.
- **Click a line → its tunnel's info**: sets the selected tunnel; the matching row in the list below gets `background:rgba(255,255,255,.10)` + `box-shadow:inset 3px 0 0 <accent>`, and the line thickens. Rows are clickable too (same selection). Each row carries `id="tun-<i>"` so the selection can be linked/anchored. In production this should also reveal the tunnel's detail (edit form or side panel) — the mock only highlights.
- **Navigation tools**: cluster at `right:16px;top:16px`, `padding:5px`, `border-radius:8px`, background `rgba(27,30,34,.9)`, border `1px solid rgba(255,255,255,.17)`, shadow `0 6px 20px rgba(0,0,0,.28)`. Buttons 28×28px `border-radius:6px`, icon 14px `currentColor` `#c5cad1`, hover background `rgba(255,255,255,.13)`: zoom out (−), the zoom % label (mono 13px, click = reset), zoom in (+), a 1px divider, fit to screen, reset view.
  - Pan: mouse-down on the canvas background then drag (window-level mousemove/mouseup listeners, removed on release).
  - Wheel zoom: `preventDefault`, factor 1.08 / 0.93 per notch, anchored at the cursor (`pan = c - (c - pan) * k`).
  - Zoom clamped to **0.45–2.0**; buttons step ±0.15. Fit = zoom .78 at pan (96, 40); Reset = zoom 1 at pan (0, 0).
- **Legend** (bottom-left, mono 13px `#939aa3`, outside the stage): accent 16×2px swatch "active (2 chiều)", dashed swatch "idle / manual", then the hint `kéo nền để di chuyển · scroll để zoom · click line để xem tunnel`.
- **List below the map**: top border, background `#1b1e22`, grid `1.2fr 78px 2fr 1.1fr 88px 96px; gap:12px`, rows padding `9px 20px`. Columns: Label, Type (`local`/`dynamic`, mono 12.5px), Forward (`127.0.0.1:5432 → 10.20.4.31:5432`, mono 13px `#a9afb7`), Via host, Autostart (`on session`/`on launch`/`manual`), State (dot + text; active = accent, idle = `#939aa3`). Footer note: `tunnel tự mở lại khi session tương ứng reconnect`.
- Data shown: `pg replica` (local, via db-primary.prod, on session, active), `grafana` (local, via api-gw.prod, on launch, active), `socks proxy` (dynamic, via bastion.corp, manual, idle), `nas webui` (local, via nas.home, manual, idle).
- Real implementation notes: node positions are hand-authored in the mock — in production either persist per-node positions (drag to arrange) or run a simple layered layout (local → bastions → targets). Rates come from the live tunnel process; idle tunnels render dashed with no animation. Respect `prefers-reduced-motion` by dropping the dash and halo animations.

### 6. Known hosts
Header: title, a filter field (max-width 280px, placeholder "Filter ~/.ssh/known_hosts"), right warning `1 host key changed` in `#c9a15f` mono 13px.
Grid `12px 1.6fr 90px 2fr 100px 118px`. Columns: status dot (accent verified, `#c9a15f` changed), Host (mono 13px), Key type, Fingerprint, First seen, actions — `Verified`/`Trust new` chip + `Remove` chip in `#d9776a`.
Footer: `41 entries · đọc trực tiếp từ ~/.ssh/known_hosts`.

### 7. Settings
Header: title + `config lưu tại ~/.portway/config.toml`.
Body: `display:grid;grid-template-columns:1fr 1fr;gap:26px 34px;align-content:start`, padding `20px 24px`. Each group has a section label and rows `display:flex;justify-content:space-between` 13.5px, label `#c5cad1`, control right-aligned (mono `#a9afb7` for selects, toggles per spec above).
- Appearance: Theme (Auto | Dark segmented), Accent (four 17px swatches `#5ec8b0` `#c9a15f` `#9b8fd6` `#e8e8e6`; selected has `box-shadow:0 0 0 2px rgba(255,255,255,.15)`), Row density (compact), Colour hosts by group (toggle on).
- Terminal: Font (SF Mono / Consolas · 13px), Cursor (block · blink), Scrollback (10 000 lines), Bell (off).
- Security: Store secrets in OS keychain (on), Confirm before connecting to prod (on), Lock app after idle (15 min), Strict host key checking (ask).
- Transfers & sync: Default download folder (~/Downloads), Parallel transfers (4), Import from ~/.ssh/config → "Sync now" button, Config backup (local only).
Footer: `Portway 0.4.1 · openssh 9.7p1`.

---

## Interactions & behavior
- Tunnels map: drag the canvas background to pan; wheel to zoom at the cursor (0.45–2.0); toolbar −/%/+ , fit, reset. Clicking a connection line selects that tunnel and highlights its row in the list below (and vice versa).
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
- `selTun`: index of the selected tunnel (map ⇄ list selection)
- `zoom`, `panX`, `panY`, `panning`: tunnels map viewport
- `screen`: `'servers' | 'session' | 'form' | 'keys' | 'tunnels' | 'known' | 'settings'`
- `sel`: index of the selected host
- `drawer`: boolean (detail drawer open)
- `kind`: `'SSH' | 'SFTP'` — kind of the session just opened
- `auth`: `'password' | 'key' | 'agent'` — form's auth method
- `tab`: active session tab index

Real app additionally needs: host list + groups (persisted config), search query and filter (All/Recent/Favorites), open sessions with live PTY handles, per-session SFTP cwd and transfer queue, keys enumerated from `~/.ssh` + ssh-agent, tunnel processes and their state, known_hosts parse, settings. Data fetching: read/write `~/.portway/config.toml`, import `~/.ssh/config`, secrets via OS keychain, all SSH/SFTP over the native process (IPC to the UI).

## Design tokens
Colors
- Background base `#1b1e22`; nav / deepest `#14161a`; terminal `#121417`; panel `#1f2226`; drawer & code blocks `#22262b`; field / raised `#2a2e34`; active tab `#262a30`.
- Text primary `#f1f2f4`; secondary `#c5cad1`; muted `#a9afb7`; faint `#939aa3`; terminal body `#ced4ce`; terminal status `#8d939b`.
- Hairlines & fills over dark (white at alpha): `.09` (row divider), `.10` (soft button), `.13` (border / active nav), `.15`–`.17` (field border, selected row), `.19`–`.26` (outline button, toggle off), `.28` (hover soft button), `.33` (chip hover).
- Accent (default) `#5ec8b0`; alternates `#c9a15f`, `#9b8fd6`, `#e8e8e6`. Accent text sits on `#1b1e22`.
- Group / status: Production `#d9776a`, Staging `#c9a15f`, Development `#5ec8b0`, Homelab `#9b8fd6`. Warning `#c9a15f`; destructive `#d9776a` (hover fill `rgba(217,119,106,.15)`).
- Scrim `rgba(0,0,0,.35)`; drawer shadow `-18px 0 40px rgba(0,0,0,.45)`.

Typography — no webfont, system stacks only.
- UI: `system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif` at 400/500/600.
- Anything a shell would print (hosts, addresses, ports, fingerprints, paths, commands): `ui-monospace,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace` at 400/500.
- Screen title 600 15px; drawer host 600 15.5px; body 13.5px; table cell 13–13.5px; mono cell 13px; meta/footnote mono 12.5px; section label 500 11.5px uppercase `letter-spacing:.09em`; table header 500 11.5px uppercase `letter-spacing:.08em`; badge 11px. Nothing goes below 11.5px.

Spacing — 4px base. Screen padding `12px 16px` (bars) / `20px 24px` (form, settings). Table rows `9–10px 16px`. Panel sections `14–18px 16px`. Gaps 5, 6, 8, 10, 12, 22, 26px.

Radii — 3px badge, 4px chip, 5px nav item / small button, 6px field / button / card, 8px card (turn-1 explorations only), 9px toggle track, 50% dots.

Shadows — drawer `-18px 0 40px rgba(0,0,0,.45)`; selected accent swatch `0 0 0 2px rgba(255,255,255,.15)`; map node `0 8px 26px rgba(0,0,0,.28)`; map toolbar `0 6px 20px rgba(0,0,0,.28)`.

Motion — `@keyframes tunFlow{to{stroke-dashoffset:-40}}` (active tunnel flow, 1.15–1.4s linear infinite), `@keyframes tunPulse{0%,100%{opacity:.35}50%{opacity:1}}` (live port dots, 1.6s), `@keyframes tunHalo{0%{transform:scale(1);opacity:.5}70%,100%{transform:scale(2.6);opacity:0}}` (receive-end pulse, 1.9s).

## Assets
No image assets. The brand mark is a plain 18×18px accent square with 4px radius — replace with the real icon. No icon set is used: actions are text labels, status is coloured dots, and `↑ × + ⌄ ‹ ● ✓ ! ⇄ ↵ ⇧` are plain glyphs. If the codebase has an icon library, substituting icons for the `···`, `×`, `↑`, `+` affordances is fine; keep text labels on SSH/SFTP/Edit/Duplicate/Delete.

## Files
- `SSH Client.dc.html` — the design prototype. Turn 2 / option `2a` (top of the page) is the spec-carrying interactive design; turn 1 (`1a`–`1d`) are earlier Servers-screen explorations, reference only.
