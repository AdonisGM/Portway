/** Group keys as the design names them. Fixed set — the handoff draws four. */
export type GroupId = 'prod' | 'staging' | 'dev' | 'home'

export type AuthMethod = 'password' | 'key' | 'agent'

/**
 * A host as it comes back from the database. Mirrors `models::Host` on the
 * Rust side.
 *
 * There is no password or passphrase field, and that is deliberate: the UI
 * promises credentials live in the OS keychain and the app stores only
 * references, so the database keeps the auth *method* and key path and never a
 * secret in plaintext.
 */
export interface Host {
  id: number
  name: string
  address: string
  port: number
  user: string
  group: GroupId
  auth: AuthMethod
  keyPath: string | null
  jumpHost: string | null
  runOnConnect: string | null
  agentForwarding: boolean
  keepAlive: boolean
  saveToKeychain: boolean
  unlockViaKeychain: boolean
  favorite: boolean
  /**
   * Free-form labels, in the order they were typed. The four groups are a fixed
   * set that every host has exactly one of; these are however many a host needs
   * and whatever the estate is actually organised by — a customer, a role, a
   * ticket. Stored as one comma-separated column, so a tag cannot contain one.
   */
  tags: string[]
  /** Epoch ms, or null when the host has never been opened. */
  lastUsedAt: number | null
  createdAt: number
  updatedAt: number
}

/** What the form sends on save — a Host without the server-assigned fields. */
/**
 * Asymmetric with `Host` on purpose: the two secrets travel in and never come
 * back. They are written to the OS keychain, never to a column, so there is
 * nothing to read them out of — and the form is not meant to redisplay a secret
 * anyway. Empty or omitted means "leave what is stored alone"; clearing one is
 * what turning its toggle off does — `unlockViaKeychain` for the passphrase,
 * `saveToKeychain` for the password.
 */
export type HostInput = Omit<Host, 'id' | 'lastUsedAt' | 'createdAt' | 'updatedAt'> & {
  passphrase?: string | null
  password?: string | null
}

/**
 * Semantic status, never a colour. Writing the accent hex into data would make
 * the Settings accent picker recolour unrelated status dots.
 */
export type TunnelKind = 'local' | 'dynamic' | 'remote'

/**
 * Wider than the design's `active | idle`, which cannot tell "still
 * connecting" from "stopped because something went wrong". A forward that
 * silently reads idle after failing to bind its port is one the user will keep
 * starting and keep watching do nothing.
 */
export type TunnelRunState = 'idle' | 'starting' | 'active' | 'error'

export type TunnelAutostart = 'manual' | 'session' | 'launch'

/** Where a session is in its life. */
export type SessionStatus = 'connecting' | 'open' | 'closed' | 'error'

/**
 * One SSH connection, carrying both the terminal and the SFTP pane.
 *
 * The design modelled SSH and SFTP as two kinds of session; in practice SFTP
 * is a second channel on the same connection, so there is only one kind and
 * the tab badge always reads `SSH`.
 */
export interface Session {
  id: string
  hostId: number
  name: string
  status: SessionStatus
  /** Set when `status === 'error'`; shown in the terminal. */
  error?: string
  /** Filled in once the handshake succeeds. */
  info?: {
    user: string
    serverKey: string
    startedAt: number
  }
}
