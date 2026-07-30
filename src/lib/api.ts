import { invoke } from '@tauri-apps/api/core'
import type { Host, HostInput } from '@/data/types'

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
  /** Numeric only — SFTP carries owner *names* in a field russh-sftp drops. */
  uid: number | null
  gid: number | null
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

export const hostLog = (hostId: number, limit?: number) =>
  invoke<LogEntry[]>('host_log', { hostId, limit })

export function message(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return 'Something went wrong'
}
