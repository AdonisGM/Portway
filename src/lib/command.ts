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
