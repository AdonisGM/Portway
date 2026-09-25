import { invoke, isTauri } from '@tauri-apps/api/core'

// Types mirror the Rust structs in src-tauri/src (serde camelCase).

export type Auth = { kind: 'key'; path: string } | { kind: 'password' }
export type Account = { user: string; auth: Auth }

export type Server = {
  id: string
  name: string
  host: string
  port: number
  group: string
  tags: string[]
  note: string
  /** The first account is the default one. */
  accounts: Account[]
  /** Detected on connect, e.g. "Ubuntu 24.04"; null until then. */
  os: string | null
  pinned: boolean
  createdAt: number
  updatedAt: number
}

export type ServerInput = {
  id?: string
  name: string
  host: string
  port: number
  group: string
  tags: string[]
  note: string
  accounts: Account[]
  pinned?: boolean
}

export type SshKey = {
  name: string
  /** `~/.ssh/<name>`, the form stored on accounts. */
  path: string
  kind: string | null
  bits: number | null
  fingerprint: string | null
  comment: string | null
  createdAt: number | null
}

export type GenerateKeyInput = {
  name: string
  kind: 'ed25519' | 'rsa'
  /** Empty means user@host. */
  comment: string
  /** Empty means no passphrase. */
  passphrase: string
}

export type ImportReport = { found: number; added: Server[]; skipped: string[] }

export type AppError = { code: string; field?: string; detail?: string }

export type HostKeyIssue =
  | { kind: 'unknown'; fingerprint: string; algorithm: string }
  | { kind: 'changed'; fingerprint: string; algorithm: string; line: number }

export type HostInfo = { os: string | null; hostname: string; kernel: string; uptimeSecs: number }

export type ConnectResult =
  | { status: 'connected'; info: HostInfo }
  | { status: 'hostKey'; issue: HostKeyIssue }
  | { status: 'needPassword'; retry: boolean }
  | { status: 'needPassphrase'; keyPath: string; retry: boolean }

export type ProcessRow = {
  pid: number
  /** Full command line, or `[name]` for kernel threads. */
  command: string
  /** From the server's /etc/passwd; null when the uid only exists in a container. */
  user: string | null
  uid: number | null
  container: string | null
  /** % of one core over the last interval, like top. */
  cpuPercent: number
  rss: number
}

export type Processes = { at: number; rows: ProcessRow[] }

export type ConnectOptions = {
  password?: string
  passphrase?: string
  /** Keep the password or passphrase in the Keychain (default true). */
  remember?: boolean
  /** Fingerprint the user accepted for an unknown host key. */
  trustFingerprint?: string
}

/** Live resource numbers; sizes in bytes, rates in bytes per second. */
export type Stats = {
  cpuPercent: number | null
  load: [number, number, number]
  cores: number
  memTotal: number
  memUsed: number
  diskTotal: number
  diskUsed: number
  diskAvail: number
  netRxRate: number | null
  netTxRate: number | null
  uptimeSecs: number
}

export function isAppError(e: unknown): e is AppError {
  return typeof e === 'object' && e !== null && 'code' in e
}

type Api = {
  listServers(): Promise<Server[]>
  saveServer(input: ServerInput): Promise<Server>
  deleteServer(id: string): Promise<void>
  importSshConfig(): Promise<ImportReport>
  listKeys(): Promise<SshKey[]>
  publicKey(path: string): Promise<string>
  generateKey(input: GenerateKeyInput): Promise<SshKey>
  setPinned(id: string, pinned: boolean): Promise<Server>
  connect(serverId: string, user: string, opts?: ConnectOptions): Promise<ConnectResult>
  disconnect(serverId: string, user: string): Promise<void>
  disconnectAll(): Promise<void>
  stats(serverId: string, user: string): Promise<Stats>
  processes(serverId: string, user: string): Promise<Processes>
  /** Open Terminal with ssh; `tool` runs a known remote program (e.g. htop). */
  openTerminal(serverId: string, user: string, tool?: 'htop'): Promise<void>
}

const tauriApi: Api = {
  listServers: () => invoke('servers_list'),
  saveServer: (input) => invoke('server_save', { input }),
  deleteServer: (id) => invoke('server_delete', { id }),
  importSshConfig: () => invoke('servers_import_ssh_config'),
  listKeys: () => invoke('ssh_keys_list'),
  publicKey: (path) => invoke('ssh_key_public', { path }),
  generateKey: (input) => invoke('ssh_key_generate', { input }),
  setPinned: (id, pinned) => invoke('server_set_pinned', { id, pinned }),
  connect: (serverId, user, opts = {}) => invoke('ssh_connect', { serverId, user, ...opts }),
  disconnect: (serverId, user) => invoke('ssh_disconnect', { serverId, user }),
  disconnectAll: () => invoke('ssh_disconnect_all'),
  stats: (serverId, user) => invoke('server_stats', { serverId, user }),
  processes: (serverId, user) => invoke('server_processes', { serverId, user }),
  openTerminal: (serverId, user, tool) => invoke('open_terminal', { serverId, user, tool }),
}

/** Stand-in used when the UI runs in a plain browser (vite dev without Tauri):
 *  keeps servers in localStorage and applies the same basic validation. */
function browserApi(): Api {
  const KEY = 'portway:dev-servers'
  const keys: SshKey[] = [
    { name: 'id_ed25519', path: '~/.ssh/id_ed25519', kind: 'ED25519', bits: null, fingerprint: 'SHA256:q3Vt8bN0dev', comment: 'dev@browser', createdAt: Date.UTC(2025, 1, 3) },
  ]
  const read = (): Server[] => {
    try {
      return JSON.parse(localStorage.getItem(KEY) ?? '[]')
    } catch {
      return []
    }
  }
  const write = (list: Server[]) => localStorage.setItem(KEY, JSON.stringify(list))
  const fail = (code: string, field?: string): never => {
    throw { code, field } satisfies AppError
  }

  return {
    async listServers() {
      return read()
    },
    async saveServer(input) {
      const list = read()
      const name = input.name.trim()
      const host = input.host.trim()
      const accounts = input.accounts.map((a) => ({ ...a, user: a.user.trim() })).filter((a) => a.user)
      if (!name) fail('required', 'name')
      if (list.some((s) => s.id !== input.id && s.name.toLowerCase() === name.toLowerCase())) fail('name_taken', 'name')
      if (!host) fail('required', 'host')
      if (!accounts.length) fail('no_account', 'accounts')
      const now = Date.now()
      const prev = list.find((s) => s.id === input.id)
      const server: Server = {
        ...input,
        id: prev?.id ?? crypto.randomUUID(),
        os: prev?.os ?? null,
        createdAt: prev?.createdAt ?? now,
        name,
        host,
        accounts,
        pinned: input.pinned ?? prev?.pinned ?? false,
        updatedAt: now,
      }
      write(prev ? list.map((s) => (s.id === server.id ? server : s)) : [...list, server])
      return server
    },
    async deleteServer(id) {
      write(read().filter((s) => s.id !== id))
    },
    async importSshConfig() {
      return { found: 0, added: [], skipped: [] }
    },
    async listKeys() {
      return [...keys]
    },
    async publicKey(path) {
      const k = keys.find((x) => x.path === path)
      if (!k) fail('no_public_key')
      return `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDevBrowserStandIn ${k!.comment ?? ''}`.trim()
    },
    async generateKey(input) {
      if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(input.name) || input.name.endsWith('.pub')) fail('invalid_key_name', 'name')
      if (keys.some((k) => k.name === input.name)) fail('key_exists', 'name')
      const key: SshKey = {
        name: input.name,
        path: `~/.ssh/${input.name}`,
        kind: input.kind === 'rsa' ? 'RSA' : 'ED25519',
        bits: input.kind === 'rsa' ? 4096 : null,
        fingerprint: 'SHA256:' + crypto.randomUUID().replace(/-/g, '').slice(0, 43),
        comment: input.comment || 'dev@browser',
        createdAt: Date.now(),
      }
      keys.push(key)
      return key
    },
    async setPinned(id, pinned) {
      const list = read()
      const s = list.find((x) => x.id === id)
      if (!s) fail('not_found')
      const next = { ...s!, pinned }
      write(list.map((x) => (x.id === id ? next : x)))
      return next
    },
    // SSH needs the Rust side; in a plain browser say so instead of faking it.
    async connect() {
      return fail('needs_app')
    },
    async disconnect() {},
    async disconnectAll() {},
    async stats() {
      return fail('needs_app')
    },
    async processes() {
      return fail('needs_app')
    },
    async openTerminal() {
      fail('needs_app')
    },
  }
}

export const api: Api = isTauri() ? tauriApi : browserApi()
