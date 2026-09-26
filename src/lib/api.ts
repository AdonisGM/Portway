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
  /** systemd units shown in "Dịch vụ"; null until first chosen. */
  watchedUnits?: string[] | null
  /** Display names the user gave units. */
  unitNames?: Record<string, string>
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

export type HostInfo = {
  os: string | null
  hostname: string
  kernel: string
  uptimeSecs: number
  /** The docker CLI is installed; the Docker module shows only then. */
  docker: boolean
  /** systemd runs as init; the services view shows only then. */
  systemd: boolean
}

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

export type ContainerBrief = { name: string; state: string; status: string }

export type Health = {
  docker:
    | { kind: 'notInstalled' }
    | { kind: 'noAccess'; detail: string }
    | { kind: 'daemonDown'; detail: string }
    | { kind: 'ok'; running: number; total: number; failed: ContainerBrief[]; finished: ContainerBrief[] }
  systemd: { kind: 'notSystemd' } | { kind: 'ok'; services: number; failed: string[] }
  updates:
    | { kind: 'unsupported' }
    | { kind: 'noIndex'; manager: string }
    | { kind: 'ok'; manager: string; upgrades: Array<{ name: string; version: string; security: boolean }>; indexAt: number | null }
}

export type Listen = {
  proto: 'tcp' | 'udp'
  port: number
  bind: string
  scope: 'loopback' | 'private' | 'public'
  process: string | null
  container: string | null
}

export type UfwRule = { to: string; action: string; from: string; both: boolean }

export type PortWarning =
  | { kind: 'databasePublic'; name: string; port: number; bind: string; via: string | null; docker: boolean; guessed: boolean }
  | { kind: 'dockerBypass'; port: number; container: string }
  | { kind: 'ruleIneffective'; port: number; from: string; container: string }
  | { kind: 'ruleUnused'; to: string }

export type Ports = {
  listening: Listen[]
  firewall:
    | { kind: 'notInstalled' }
    | { kind: 'needsRoot' }
    | { kind: 'error'; detail: string }
    | { kind: 'inactive' }
    | { kind: 'active'; defaultIncoming: string; rules: UfwRule[] }
  warnings: PortWarning[]
  processesComplete: boolean
}

export type Mount = { path: string; device: string; fsType: string | null; total: number; used: number; avail: number }
export type DockerUsage = { kind: string; total: number; active: number; size: number; reclaimable: number }
export type Disks = { mounts: Mount[] }
export type DockerDisk =
  | { kind: 'notInstalled' }
  | { kind: 'noAccess'; detail: string }
  | { kind: 'daemonDown'; detail: string }
  | { kind: 'ok'; rows: DockerUsage[] }

export type SudoResult = { status: 'enabled' } | { status: 'needPassword'; retry: boolean } | { status: 'notAllowed'; detail: string }

export type AuditEntry = {
  id: string
  at: number
  serverId: string
  user: string
  /** connect, reconnect, disconnect, trustHostKey, openTerminal, sudoOn, sudoOff,
   *  mkdir, touch, rename, remove, chmod, chown, download, upload, dockerStart,
   *  dockerStop, dockerRestart, composeUp, composePullUp, composeRestart,
   *  composeDown, dockerDaemonStart, imagePrune, volumeRemove */
  action: string
  command: string
  ok: boolean
  detail?: string
}

export type FileKind = 'dir' | 'file' | 'link' | 'other'

export type FileEntry = {
  name: string
  path: string
  kind: FileKind
  /** What a link points to; null for a broken link or a non-link. */
  targetKind: FileKind | null
  linkTarget: string | null
  size: number
  /** Seconds since epoch. */
  mtime: number | null
  atime: number | null
  /** Permission bits (0o7777). */
  mode: number
  uid: number | null
  gid: number | null
  owner: string | null
  group: string | null
  /** Which permission bits apply to the session's user. */
  class: 'root' | 'owner' | 'group' | 'other'
  readable: boolean
  writable: boolean
}

export type Listing = { path: string; dir: FileEntry; entries: FileEntry[]; denied: boolean; user: string }

export type DockerPort = { hostIp: string; hostPort: number; containerPort: number; proto: string; public: boolean }
export type DockerMount = { kind: string; name: string | null; source: string; destination: string; rw: boolean }
export type Container = {
  id: string
  name: string
  image: string
  imageId: string
  /** created, running, paused, restarting, removing, exited, dead */
  state: string
  exitCode: number
  health: string | null
  healthFailures: number
  restarts: number
  policy: string
  /** RFC 3339 */
  created: string
  startedAt: string | null
  finishedAt: string | null
  command: string
  ports: DockerPort[]
  mounts: DockerMount[]
  env: { key: string; value: string }[]
  networks: string[]
  project: string | null
  service: string | null
  configFiles: string[]
  /** Every compose file is still on the server. */
  configFound: boolean
  workingDir: string | null
}
export type DockerState =
  | { kind: 'notInstalled' }
  | { kind: 'noAccess'; detail: string }
  | { kind: 'daemonDown'; detail: string; systemd: boolean }
  | { kind: 'ok'; version: string; compose: string | null; containers: Container[] }
/** `cpu` is a share of all the server's cores (0–100); `mem` in bytes. */
export type DockerStats = { cores: number; rows: { id: string; cpu: number; mem: number }[] }
export type DockerLogLine = { ts: string; text: string; err: boolean }
export type DockerImage = { id: string; repo: string; tag: string; created: string; size: number; usedBy: string[] }
export type DockerVolume = { name: string; driver: string; mountpoint: string; usedBy: string[] }
export type ComposeAction = 'up' | 'pullUp' | 'restart' | 'down'
export type TerminalTool = 'htop' | 'dockerExec' | 'dockerLogs' | 'dockerDaemonLog' | 'unitLog'

/** A service unit from `systemctl list-units --all` / `list-unit-files`. */
export type UnitBrief = { name: string; description: string; active: string; fileState: string | null }
export type Unit = {
  name: string
  /** Other names of the unit, e.g. sshd.service for ssh.service. */
  aliases: string[]
  description: string
  loadState: string
  activeState: string
  subState: string
  fileState: string
  mainPid: number | null
  memory: number | null
  restarts: number
  /** ms since epoch */
  activeSince: number | null
  inactiveSince: number | null
  exitStatus: number | null
  exitCode: string | null
  result: string
  fragmentPath: string
  runAs: string | null
}
/** syslog priority: 0 emerg … 3 err, 4 warning, 6 info, 7 debug. */
export type JournalLine = { at: number; priority: number | null; message: string }
export type JournalPage = { lines: JournalLine[]; cursor: string | null; limited: boolean }
export type ServiceAction = 'start' | 'stop' | 'restart' | 'enable' | 'disable' | 'resetFailed'

export type TraceKind = 'exec' | 'sftp' | 'connect' | 'transfer'
export type TraceStatus = 'waiting' | 'running' | 'ok' | 'error'
/** One thing Portway did on a server, from the debug trace. */
export type TraceEntry = {
  id: number
  /** ms since epoch */
  at: number
  serverId: string
  user: string
  kind: TraceKind
  label: string
  command: string
  status: TraceStatus
  waitMs: number | null
  durationMs: number | null
  exitCode: number | null
  outBytes: number | null
  errBytes: number | null
  stdout: string | null
  stderr: string | null
  error: string | null
}

export type Transfer = {
  id: string
  serverId: string
  user: string
  direction: 'up' | 'down'
  name: string
  from: string
  to: string
  /** Local file for a download, remote path for an upload. */
  target: string
  size: number
  done: number
  speed: number
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  error: string | null
  startedAt: number
  finishedAt: number | null
}

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
  setWatchedUnits(id: string, units: string[]): Promise<Server>
  setUnitName(id: string, unit: string, name: string): Promise<Server>
  connect(serverId: string, user: string, opts?: ConnectOptions): Promise<ConnectResult>
  /** Reopen a dropped session with the credential it was opened with. */
  reconnect(serverId: string, user: string): Promise<ConnectResult>
  disconnect(serverId: string, user: string): Promise<void>
  sudo(serverId: string, user: string, password?: string): Promise<SudoResult>
  sudoOff(serverId: string, user: string): Promise<void>
  auditList(serverId: string | null, limit: number): Promise<AuditEntry[]>
  disconnectAll(): Promise<void>
  stats(serverId: string, user: string): Promise<Stats>
  processes(serverId: string, user: string): Promise<Processes>
  health(serverId: string, user: string): Promise<Health>
  ports(serverId: string, user: string): Promise<Ports>
  disks(serverId: string, user: string): Promise<Disks>
  /** Slow on servers with large volumes (docker system df). */
  dockerDisk(serverId: string, user: string): Promise<DockerDisk>
  /** Open Terminal with ssh; `tool` runs a known remote program (e.g. htop), `cwd` starts in a directory. */
  /** `target` is the container (dockerExec, dockerLogs) or the unit (unitLog). */
  openTerminal(serverId: string, user: string, tool?: TerminalTool, cwd?: string, target?: string): Promise<void>
  /** Open (or bring to the front) the debug trace window. */
  openDebugWindow(): Promise<void>
  servicesAll(serverId: string, user: string): Promise<UnitBrief[]>
  servicesStatus(serverId: string, user: string, units: string[]): Promise<Unit[]>
  servicesJournal(serverId: string, user: string, unit: string, tail: number, cursor?: string | null): Promise<JournalPage>
  servicesUnitFile(serverId: string, user: string, unit: string): Promise<string>
  servicesAction(serverId: string, user: string, unit: string, action: ServiceAction): Promise<void>
  traceList(): Promise<TraceEntry[]>
  traceClear(): Promise<void>
  dockerOverview(serverId: string, user: string): Promise<DockerState>
  dockerStats(serverId: string, user: string): Promise<DockerStats>
  dockerContainer(serverId: string, user: string, name: string, action: 'start' | 'stop' | 'restart'): Promise<void>
  /** Returns docker compose's output. */
  dockerCompose(serverId: string, user: string, project: string, files: string[], workingDir: string | null, action: ComposeAction): Promise<string>
  dockerStartDaemon(serverId: string, user: string): Promise<void>
  dockerLogs(serverId: string, user: string, id: string, tail: number, since?: string): Promise<DockerLogLine[]>
  dockerImages(serverId: string, user: string): Promise<DockerImage[]>
  /** Returns the reclaimed space as Docker prints it, e.g. "1.2GB". */
  dockerImagePrune(serverId: string, user: string, all: boolean): Promise<string>
  dockerVolumes(serverId: string, user: string): Promise<DockerVolume[]>
  dockerVolumeSizes(serverId: string, user: string): Promise<Record<string, number>>
  dockerVolumeRemove(serverId: string, user: string, name: string): Promise<void>
  sftpList(serverId: string, user: string, path: string): Promise<Listing>
  sftpMkdir(serverId: string, user: string, dir: string, name: string): Promise<string>
  sftpTouch(serverId: string, user: string, dir: string, name: string): Promise<string>
  sftpRename(serverId: string, user: string, path: string, name: string): Promise<string>
  sftpRemove(serverId: string, user: string, paths: string[]): Promise<void>
  sftpChmod(serverId: string, user: string, paths: string[], mode: number, recursive: boolean): Promise<void>
  sftpChown(serverId: string, user: string, paths: string[], owner: string, group: string, recursive: boolean): Promise<void>
  /** `dest` is the local folder the user picked. */
  download(serverName: string, serverId: string, user: string, paths: string[], dest: string): Promise<Transfer[]>
  upload(serverName: string, serverId: string, user: string, localPaths: string[], remoteDir: string, overwrite: boolean): Promise<Transfer[]>
  transfers(): Promise<Transfer[]>
  cancelTransfer(id: string): Promise<void>
  retryTransfer(id: string): Promise<void>
  clearTransfers(): Promise<Transfer[]>
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
  setWatchedUnits: (id, units) => invoke('server_set_watched_units', { id, units }),
  setUnitName: (id, unit, name) => invoke('server_set_unit_name', { id, unit, name }),
  connect: (serverId, user, opts = {}) => invoke('ssh_connect', { serverId, user, ...opts }),
  reconnect: (serverId, user) => invoke('ssh_reconnect', { serverId, user }),
  disconnect: (serverId, user) => invoke('ssh_disconnect', { serverId, user }),
  sudo: (serverId, user, password) => invoke('ssh_sudo', { serverId, user, password }),
  sudoOff: (serverId, user) => invoke('ssh_sudo_off', { serverId, user }),
  auditList: (serverId, limit) => invoke('audit_list', { serverId, limit }),
  disconnectAll: () => invoke('ssh_disconnect_all'),
  stats: (serverId, user) => invoke('server_stats', { serverId, user }),
  processes: (serverId, user) => invoke('server_processes', { serverId, user }),
  health: (serverId, user) => invoke('server_health', { serverId, user }),
  ports: (serverId, user) => invoke('server_ports', { serverId, user }),
  disks: (serverId, user) => invoke('server_disks', { serverId, user }),
  dockerDisk: (serverId, user) => invoke('server_docker_disk', { serverId, user }),
  openTerminal: (serverId, user, tool, cwd, target) => invoke('open_terminal', { serverId, user, tool, cwd, target }),
  openDebugWindow: () => invoke('open_debug_window'),
  servicesAll: (serverId, user) => invoke('services_all', { serverId, user }),
  servicesStatus: (serverId, user, units) => invoke('services_status', { serverId, user, units }),
  servicesJournal: (serverId, user, unit, tail, cursor) => invoke('services_journal', { serverId, user, unit, tail, cursor }),
  servicesUnitFile: (serverId, user, unit) => invoke('services_unit_file', { serverId, user, unit }),
  servicesAction: (serverId, user, unit, action) => invoke('services_action', { serverId, user, unit, action }),
  traceList: () => invoke('trace_list'),
  traceClear: () => invoke('trace_clear'),
  dockerOverview: (serverId, user) => invoke('docker_overview', { serverId, user }),
  dockerStats: (serverId, user) => invoke('docker_stats', { serverId, user }),
  dockerContainer: (serverId, user, name, action) => invoke('docker_container', { serverId, user, name, action }),
  dockerCompose: (serverId, user, project, files, workingDir, action) =>
    invoke('docker_compose', { serverId, user, project, files, workingDir, action }),
  dockerStartDaemon: (serverId, user) => invoke('docker_start_daemon', { serverId, user }),
  dockerLogs: (serverId, user, id, tail, since) => invoke('docker_logs', { serverId, user, id, tail, since }),
  dockerImages: (serverId, user) => invoke('docker_images', { serverId, user }),
  dockerImagePrune: (serverId, user, all) => invoke('docker_image_prune', { serverId, user, all }),
  dockerVolumes: (serverId, user) => invoke('docker_volumes', { serverId, user }),
  dockerVolumeSizes: (serverId, user) => invoke('docker_volume_sizes', { serverId, user }),
  dockerVolumeRemove: (serverId, user, name) => invoke('docker_volume_remove', { serverId, user, name }),
  sftpList: (serverId, user, path) => invoke('sftp_list', { serverId, user, path }),
  sftpMkdir: (serverId, user, dir, name) => invoke('sftp_mkdir', { serverId, user, dir, name }),
  sftpTouch: (serverId, user, dir, name) => invoke('sftp_touch', { serverId, user, dir, name }),
  sftpRename: (serverId, user, path, name) => invoke('sftp_rename', { serverId, user, path, name }),
  sftpRemove: (serverId, user, paths) => invoke('sftp_remove', { serverId, user, paths }),
  sftpChmod: (serverId, user, paths, mode, recursive) => invoke('sftp_chmod', { serverId, user, paths, mode, recursive }),
  sftpChown: (serverId, user, paths, owner, group, recursive) => invoke('sftp_chown', { serverId, user, paths, owner, group, recursive }),
  download: (serverName, serverId, user, paths, dest) => invoke('transfer_download', { serverName, serverId, user, paths, dest }),
  upload: (serverName, serverId, user, localPaths, remoteDir, overwrite) =>
    invoke('transfer_upload', { serverName, serverId, user, localPaths, remoteDir, overwrite }),
  transfers: () => invoke('transfer_list'),
  cancelTransfer: (id) => invoke('transfer_cancel', { id }),
  retryTransfer: (id) => invoke('transfer_retry', { id }),
  clearTransfers: () => invoke('transfer_clear'),
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
    setWatchedUnits: async () => fail('needs_app'),
    setUnitName: async () => fail('needs_app'),
    // SSH needs the Rust side; in a plain browser say so instead of faking it.
    async connect() {
      return fail('needs_app')
    },
    async reconnect() {
      return fail('needs_app')
    },
    async disconnect() {},
    async sudo() {
      return fail('needs_app')
    },
    async sudoOff() {},
    async auditList() {
      return []
    },
    async disconnectAll() {},
    async stats() {
      return fail('needs_app')
    },
    async processes() {
      return fail('needs_app')
    },
    async health() {
      return fail('needs_app')
    },
    async ports() {
      return fail('needs_app')
    },
    async disks() {
      return fail('needs_app')
    },
    async dockerDisk() {
      return fail('needs_app')
    },
    async openTerminal() {
      fail('needs_app')
    },
    openDebugWindow: async () => fail('needs_app'),
    servicesAll: async () => fail('needs_app'),
    servicesStatus: async () => fail('needs_app'),
    servicesJournal: async () => fail('needs_app'),
    servicesUnitFile: async () => fail('needs_app'),
    servicesAction: async () => fail('needs_app'),
    traceList: async () => [],
    traceClear: async () => {},
    dockerOverview: async () => fail('needs_app'),
    dockerStats: async () => fail('needs_app'),
    dockerContainer: async () => fail('needs_app'),
    dockerCompose: async () => fail('needs_app'),
    dockerStartDaemon: async () => fail('needs_app'),
    dockerLogs: async () => fail('needs_app'),
    dockerImages: async () => fail('needs_app'),
    dockerImagePrune: async () => fail('needs_app'),
    dockerVolumes: async () => fail('needs_app'),
    dockerVolumeSizes: async () => fail('needs_app'),
    dockerVolumeRemove: async () => fail('needs_app'),
    sftpList: async () => fail('needs_app'),
    sftpMkdir: async () => fail('needs_app'),
    sftpTouch: async () => fail('needs_app'),
    sftpRename: async () => fail('needs_app'),
    sftpRemove: async () => fail('needs_app'),
    sftpChmod: async () => fail('needs_app'),
    sftpChown: async () => fail('needs_app'),
    download: async () => fail('needs_app'),
    upload: async () => fail('needs_app'),
    transfers: async () => [],
    cancelTransfer: async () => {},
    retryTransfer: async () => {},
    clearTransfers: async () => [],
  }
}

export const api: Api = isTauri() ? tauriApi : browserApi()
