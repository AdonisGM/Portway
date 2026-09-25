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

export type SshKey = { name: string; path: string; kind: string | null; comment: string | null }

export type ImportReport = { found: number; added: Server[]; skipped: string[] }

export type AppError = { code: string; field?: string; detail?: string }

export function isAppError(e: unknown): e is AppError {
  return typeof e === 'object' && e !== null && 'code' in e
}

type Api = {
  listServers(): Promise<Server[]>
  saveServer(input: ServerInput): Promise<Server>
  deleteServer(id: string): Promise<void>
  importSshConfig(): Promise<ImportReport>
  listKeys(): Promise<SshKey[]>
}

const tauriApi: Api = {
  listServers: () => invoke('servers_list'),
  saveServer: (input) => invoke('server_save', { input }),
  deleteServer: (id) => invoke('server_delete', { id }),
  importSshConfig: () => invoke('servers_import_ssh_config'),
  listKeys: () => invoke('ssh_keys_list'),
}

/** Stand-in used when the UI runs in a plain browser (vite dev without Tauri):
 *  keeps servers in localStorage and applies the same basic validation. */
function browserApi(): Api {
  const KEY = 'portway:dev-servers'
  const keys: SshKey[] = [{ name: 'id_ed25519', path: '~/.ssh/id_ed25519', kind: 'ED25519', comment: null }]
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
      return keys
    },
  }
}

export const api: Api = isTauri() ? tauriApi : browserApi()
