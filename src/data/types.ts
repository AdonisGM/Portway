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
  /** Epoch ms, or null when the host has never been opened. */
  lastUsedAt: number | null
  createdAt: number
  updatedAt: number
}

/** What the form sends on save — a Host without the server-assigned fields. */
/**
 * Asymmetric with `Host` on purpose: the passphrase travels in and never comes
 * back. It is written to the OS keychain, never to a column, so there is
 * nothing to read it out of — and the form is not meant to redisplay a secret
 * anyway. Empty or omitted means "leave what is stored alone"; clearing one is
 * what turning `unlockViaKeychain` off does.
 */
export type HostInput = Omit<Host, 'id' | 'lastUsedAt' | 'createdAt' | 'updatedAt'> & {
  passphrase?: string | null
}

/**
 * Semantic status, never a colour. Writing the accent hex into data would make
 * the Settings accent picker recolour unrelated status dots.
 */
export type KeyStatus = 'loaded' | 'legacy' | 'unloaded'

export interface SshKey {
  name: string
  type: string
  fingerprint: string
  usedBy: string
  added: string
  status: KeyStatus
}

export type TunnelType = 'local' | 'dynamic' | 'remote'
export type TunnelState = 'active' | 'idle'

export interface Tunnel {
  label: string
  type: TunnelType
  forward: string
  via: string
  autostart: string
  state: TunnelState
}

export type KnownHostStatus = 'verified' | 'changed'

export interface KnownHost {
  host: string
  type: string
  fingerprint: string
  firstSeen: string
  status: KnownHostStatus
}

export interface SftpFile {
  name: string
  size: string
  modified: string
  kind: 'parent' | 'dir' | 'file'
}

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
