import { invoke } from '@tauri-apps/api/core'
import type {
  Host,
  HostInput,
  TunnelAutostart,
  TunnelKind,
  TunnelRunState,
} from '@/data/types'
import { hostTitle } from '@/lib/command'

/**
 * Thin typed wrappers over the Rust commands in `src-tauri/src/hosts.rs`.
 * Everything that touches the database goes through here, so there is one
 * place to look when the backend grows.
 *
 * Errors arrive as plain strings (see `error.rs`); `message()` unwraps them
 * into something a form can display.
 */

export const listHosts = () => invoke<Host[]>('list_hosts')

export const createHost = (input: HostInput) => invoke<Host>('create_host', { input })

export const updateHost = (id: number, input: HostInput) =>
  invoke<Host>('update_host', { id, input })

export const deleteHost = (id: number) => invoke<void>('delete_host', { id })

/** Stamps `lastUsedAt` — what gives the Recent filter and Last used meaning. */
export const touchHost = (id: number) => invoke<Host>('touch_host', { id })

export const setHostFavorite = (id: number, favorite: boolean) =>
  invoke<Host>('set_host_favorite', { id, favorite })

/* ---------------------------------------------------------------------------
   Private keys on this machine
--------------------------------------------------------------------------- */

/**
 * A key found by scanning `~/.ssh`, plus what can be known about it without
 * opening the private half: type and fingerprint from the `.pub`, age from the
 * directory entry, agent membership from a running ssh-agent, and a use count
 * from the saved hosts. The Keys screen, the rail's count and the server form's
 * picker all read the same record, so none of them can disagree.
 */
export interface KeyFile {
  name: string
  /** In `~/` form, matching what the field shows and what the backend expands. */
  path: string
  /** `ed25519`, `rsa 4096`, … or null when there is no readable `.pub`. */
  kind: string | null
  /** `SHA256:…`, or null for the same reason. */
  fingerprint: string | null
  /** Offered by a running ssh-agent. */
  inAgent: boolean
  /**
   * An algorithm or size not to start new work with. Orthogonal to `inAgent` —
   * a key can be weak *and* loaded, which is why these are two fields and not
   * one status enum.
   */
  weak: boolean
  /** Saved hosts whose key path resolves to this file. */
  usedBy: number
  /** File mtime, epoch ms. */
  addedAt: number | null
}

export const listSshKeys = () => invoke<KeyFile[]>('list_ssh_keys')

/** The `.pub` beside a key, by key name. Never returns private key material. */
export const readPublicKey = (name: string) => invoke<string>('read_public_key', { name })

/* ---------------------------------------------------------------------------
   Known hosts — ~/.ssh/known_hosts, the file `ssh` and Portway both consult
--------------------------------------------------------------------------- */

/**
 * One **line** of the file, not one host: `web-01,10.20.4.11 ssh-ed25519 …` is
 * a single key that two names answer to, and there is no way to drop one of
 * those names without rewriting the line.
 */
export interface KnownHost {
  /** Which line, from zero. Named on removal together with the fingerprint. */
  line: number
  /** Every name on the line. Empty when the entry is hashed. */
  patterns: string[]
  /** `HashKnownHosts yes` — the name is an HMAC and cannot be read back. */
  hashed: boolean
  /** `@cert-authority` or `@revoked`. */
  marker: string | null
  kind: string | null
  fingerprint: string | null
  weak: boolean
  comment: string | null
  /** Saved servers whose address this line answers for. */
  usedBy: number
  /**
   * A saved server matching this line was last refused: what it offers now is
   * not what is written here. The only fact on the screen the file itself
   * cannot supply — it comes from the audit trail.
   */
  changed: boolean
}

export const listKnownHosts = () => invoke<KnownHost[]>('list_known_hosts')

/** Removes one line and returns what is left. Rejects a stale line number. */
export const removeKnownHost = (line: number, fingerprint: string | null) =>
  invoke<KnownHost[]>('remove_known_host', { line, fingerprint })

/* ---------------------------------------------------------------------------
   SSH / SFTP
   Bytes cross as base64 so control characters and binary output survive JSON.
--------------------------------------------------------------------------- */

export interface SessionInfo {
  id: string
  hostId: number
  hostName: string
  user: string
  /** The key algorithm the handshake actually negotiated, e.g. `ssh-ed25519`. */
  serverKey: string
  startedAt: number
}

export interface RemoteFile {
  name: string
  /** Bytes; null for a directory, which the table prints as `—`. */
  size: number | null
  /** Epoch seconds, or null when the server does not report one. */
  modified: number | null
  kind: 'dir' | 'file'
  /** Numeric owner and group. What `chown` takes, so always present. */
  uid: number | null
  gid: number | null
  /** The names the server resolved those ids to, when it gave any. */
  owner: string | null
  group: string | null
  /** `755`. */
  mode: string | null
  /** `rwxr-xr-x` — the same bits, read rather than typed. */
  modeText: string | null
}

export interface Listing {
  /** Canonical path, so the breadcrumb shows where we really are. */
  path: string
  files: RemoteFile[]
}

export type LogOrigin = 'user' | 'system'
export type LogKind = 'shell' | 'exec' | 'sftp' | 'auth'

export interface LogEntry {
  id: number
  hostId: number
  sessionId: string | null
  origin: LogOrigin
  kind: LogKind
  command: string
  detail: string | null
  exitCode: number | null
  createdAt: number
}

export const sshConnect = (hostId: number, sessionId: string) =>
  invoke<SessionInfo>('ssh_connect', { hostId, sessionId })

export const sshWrite = (sessionId: string, data: string) =>
  invoke<void>('ssh_write', { sessionId, data })

export const sshResize = (sessionId: string, cols: number, rows: number) =>
  invoke<void>('ssh_resize', { sessionId, cols, rows })

export const sshDisconnect = (sessionId: string) =>
  invoke<void>('ssh_disconnect', { sessionId })

/** `system: true` marks the listing Portway fetches itself when a pane opens. */
export const sftpList = (sessionId: string, path: string, system = false) =>
  invoke<Listing>('sftp_list', { sessionId, path, system })

export const sftpDownload = (sessionId: string, remote: string, local: string) =>
  invoke<number>('sftp_download', { sessionId, remote, local })

export const sftpUpload = (sessionId: string, local: string, remote: string) =>
  invoke<number>('sftp_upload', { sessionId, local, remote })

/** A dropped path — file or whole directory — into the folder being shown. */
export const sftpUploadPath = (sessionId: string, local: string, remoteDir: string) =>
  invoke<number>('sftp_upload_path', { sessionId, local, remoteDir })

export const sftpRename = (sessionId: string, from: string, to: string) =>
  invoke<void>('sftp_rename', { sessionId, from, to })

/** `mode` is permission bits only — file-type bits are the server's business. */
export const sftpChmod = (sessionId: string, path: string, mode: number) =>
  invoke<void>('sftp_chmod', { sessionId, path, mode })

/** Returns how many entries changed, so a recursive run can say what it did. */
export const sftpChown = (
  sessionId: string,
  path: string,
  uid: number,
  gid: number,
  recursive: boolean,
) => invoke<number>('sftp_chown', { sessionId, path, uid, gid, recursive })

/** Anything above this asks first — see `sftp.rs::LARGE_FILE`. */
export const LARGE_FILE = 5 * 1024 * 1024

/**
 * Opens a remote file in a local application and keeps it in sync: the file is
 * downloaded to a scratch copy, handed to the app, and written back whenever
 * that app saves. Returns the local path.
 */
export const sftpEdit = (
  sessionId: string,
  remote: string,
  opener: string | null,
  confirmedLarge = false,
) => invoke<string>('sftp_edit', { sessionId, remote, opener, confirmedLarge })

/**
 * Deletes a file, or a directory and everything under it. Returns how many
 * entries went. There is no undo on the far end.
 */
export const sftpRemove = (sessionId: string, path: string, isDir: boolean) =>
  invoke<number>('sftp_remove', { sessionId, path, isDir })

/** Opens a session for this host in a window of its own. */
export const openSessionWindow = (host: Host) =>
  invoke<void>('open_session_window', { hostId: host.id, title: hostTitle(host) })

/** Opens the debug console, or raises the one already open. */
export const openDebugWindow = () => invoke<void>('open_debug_window')

/* ---------------------------------------------------------------------------
   Tunnels
--------------------------------------------------------------------------- */

export interface Tunnel {
  id: number
  label: string
  hostId: number
  /** The host's label, joined in by the backend so a row always says which
   *  server it goes through — the table can render before hosts have loaded. */
  via: string
  kind: TunnelKind
  bindAddress: string
  bindPort: number
  /** Null for a dynamic forward, which is told where to go per connection. */
  targetHost: string | null
  targetPort: number | null
  autostart: TunnelAutostart
  createdAt: number
  updatedAt: number
}

export interface TunnelInput {
  label: string
  hostId: number
  kind: TunnelKind
  bindAddress: string
  bindPort: number
  targetHost: string | null
  targetPort: number | null
  autostart: TunnelAutostart
}

export interface TunnelState {
  id: number
  state: TunnelRunState
  /** Why it stopped, when it stopped badly. */
  error: string | null
  /**
   * What happened on the **far leg** — the hop from the server to the
   * destination for a local forward, from this machine for a remote one.
   * `null` means nothing has tried it since the tunnel came up.
   *
   * Never probed on a timer or at startup: a forward set to `on launch` would
   * then dial somebody's production database at boot to decide the colour of a
   * line. It is what the last real connection did, or what Test found.
   */
  reachable: boolean | null
}

export const listTunnels = () => invoke<Tunnel[]>('list_tunnels')

/** Every tunnel's live state, for a screen that opened after the events fired. */
export const tunnelStates = () => invoke<TunnelState[]>('tunnel_states')

export const createTunnel = (input: TunnelInput) => invoke<Tunnel>('create_tunnel', { input })

export const updateTunnel = (id: number, input: TunnelInput) =>
  invoke<Tunnel>('update_tunnel', { id, input })

export const deleteTunnel = (id: number) => invoke<void>('delete_tunnel', { id })

export const startTunnel = (id: number) => invoke<void>('start_tunnel', { id })

export const stopTunnel = (id: number) => invoke<void>('stop_tunnel', { id })

/** Opens one connection to the destination and closes it. `true` if it worked. */
export const checkTunnel = (id: number) => invoke<boolean>('check_tunnel', { id })

/** Hands a link to the browser. The backend accepts `https` and nothing else. */
export const openUrl = (url: string) => invoke<void>('open_url', { url })

export const hostLog = (hostId: number, limit?: number) =>
  invoke<LogEntry[]>('host_log', { hostId, limit })

/* ---------------------------------------------------------------------------
   The application log

   Not to be confused with `hostLog` above. That is the audit trail — what was
   run on a *server*, kept in the database for as long as the host exists. This
   is what *Portway* did: connections, transfers, tunnels, failures and how long
   each took, written to a file under ~/.portway/logs and rotated after a week.
--------------------------------------------------------------------------- */

export type AppLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface AppLogLine {
  /** Monotonic within a run. The debug panel orders and de-duplicates on it. */
  seq: number
  at: number
  level: AppLogLevel
  /** `app`, `db`, `ssh`, `sftp`, `tunnel`, `ui`… */
  target: string
  message: string
  detail: string | null
}

/** Everything the backend still holds above `after`, oldest first. */
export const logBacklog = (after?: number) => invoke<AppLogLine[]>('log_backlog', { after })

/**
 * A line from this window.
 *
 * It goes to Rust and comes back on `log://line` rather than being drawn
 * straight into the panel: two windows each run their own copy of the frontend,
 * and a locally rendered line would be missing from the file and out of order
 * with everything else.
 */
export const logWrite = (
  level: AppLogLevel,
  target: string,
  message: string,
  detail?: string | null,
) => invoke<void>('log_write', { level, target, message, detail: detail ?? null })

/** Raises or lowers what the backend records. Returns the level it settled on. */
export const setLogLevel = (level: AppLogLevel) => invoke<AppLogLevel>('set_log_level', { level })

/* ---------------------------------------------------------------------------
   Settings

   Values cross as the plain text they are written as — `true`, `13`,
   `accept-new` — and the frontend reads each one's type off its own default.
   See `settings.rs` for why they are not JSON.
--------------------------------------------------------------------------- */

/** Only the keys that have been set. Anything absent is at its default. */
export const getSettings = () => invoke<Record<string, string>>('get_settings')

/** Saves one setting and tells every window on `settings://changed`. */
export const putSetting = (key: string, value: string) =>
  invoke<void>('set_setting', { key, value })

/** The `settings://changed` payload. */
export interface SettingChanged {
  key: string
  value: string
}

export interface DebugInfo {
  version: string
  os: string
  arch: string
  level: AppLogLevel
  /** This window's Tauri label — `main`, or `session-<hostId>`. */
  window: string
  startedAt: number
  database: string
  logFile: string
  logsDir: string
  sessions: number
  tunnelsActive: number
  windows: string[]
  /**
   * Hosts whose private key sits in a folder macOS keeps behind a permission
   * prompt. Empty on every other platform.
   */
  gatedKeys: string[]
}

export const debugInfo = () => invoke<DebugInfo>('debug_info')

/** Opens ~/.portway/logs in the file manager. Takes no path, deliberately. */
export const revealLogs = () => invoke<void>('reveal_logs')

export function message(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return 'Something went wrong'
}
