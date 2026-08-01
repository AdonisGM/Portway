import type { Host } from '@/data/types'

export interface CommandParts {
  user: string
  address: string
  port: number
  /** `null` when the host connects directly. */
  jumpHost: string | null
  /** Key path when authenticating with a private key, otherwise `null`. */
  identityFile: string | null
}

/**
 * Builds the `ssh` invocation exactly as the handoff specifies
 * (README §Command construction, SSH Client.dc.html:811-814):
 *
 *   ssh [-J <jump>] [-i <key>] user@ip [-p <port>]
 *
 * The `-p` flag is omitted on port 22. Shared by the Servers drawer footer and
 * the form's live "Resulting command" box so the two can never disagree.
 */
export function buildSshCommand({
  user,
  address,
  port,
  jumpHost,
  identityFile,
}: CommandParts): string {
  const parts = ['ssh']
  if (jumpHost) parts.push('-J', jumpHost)
  if (identityFile) parts.push('-i', identityFile)
  parts.push(`${user}@${address}`)
  if (port !== 22) parts.push('-p', String(port))
  return parts.join(' ')
}

/**
 * How a host names itself outside the app's own UI: the window title, which is
 * what Mission Control, the Window menu and the taskbar show. The label alone
 * is what you called it; the address is what tells two windows named `db` apart
 * when the app is not on screen to draw the rest.
 */
export const hostTitle = (host: Host): string =>
  `${host.name} — ${host.user}@${host.address}:${host.port}`

/**
 * What a forward moves, in one line: `127.0.0.1:5432 → 10.20.4.31:5432`.
 *
 * Derived rather than stored, so the arrow can never disagree with the ports
 * either side of it. A dynamic forward has only the listening half — it learns
 * its destination from whatever connects.
 */
export function tunnelForward(t: {
  kind: string
  bindAddress: string
  bindPort: number
  targetHost: string | null
  targetPort: number | null
}): string {
  const listen = `${t.bindAddress}:${t.bindPort}`
  if (t.kind === 'dynamic') return listen
  const target = `${t.targetHost ?? '?'}:${t.targetPort ?? '?'}`
  // A remote forward listens on the far end and delivers here, so the arrow
  // points the other way round.
  return t.kind === 'remote' ? `${target} ← ${listen}` : `${listen} → ${target}`
}

export const DEFAULT_KEY_PATH = '~/.ssh/id_ed25519'

/**
 * The drawer's resolved command. Reads the host's own stored jump host and key
 * path — the prototype inferred both from the group, which would contradict
 * whatever the user typed in the form now that hosts are editable.
 */
export function hostCommand(host: Host): string {
  return buildSshCommand({
    user: host.user,
    address: host.address,
    port: host.port,
    jumpHost: host.jumpHost,
    identityFile: host.auth === 'key' ? (host.keyPath ?? DEFAULT_KEY_PATH) : null,
  })
}
