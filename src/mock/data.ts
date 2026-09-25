// Mock data taken from the Claude Design prototype (Portway.dc.html).
// Used until the Rust backend provides real servers, keys, tunnels and sessions.

export type Server = {
  id: string
  host: string
  port: number
  os: string
  group: string
  online: boolean
  cpu?: number
  ram?: number
  disk?: number
  uptime?: string
  load?: string
  accounts: { user: string; key: string }[]
}

type Raw = Omit<Server, 'accounts'> & { user: string; key: string }

const RAW: Raw[] = [
  { id: 'web-01', host: '103.21.44.10', user: 'root', port: 22, os: 'Ubuntu 24.04', group: 'production', online: true, cpu: 34, ram: 61, disk: 72, uptime: '41 ngày', key: 'id_ed25519', load: '0,82' },
  { id: 'db-01', host: '103.21.44.11', user: 'root', port: 22, os: 'Ubuntu 24.04', group: 'production', online: true, cpu: 12, ram: 78, disk: 88, uptime: '41 ngày', key: 'id_ed25519', load: '0,31' },
  { id: 'blog-vps', host: '45.77.10.3', user: 'deploy', port: 2222, os: 'Debian 12', group: 'cá nhân', online: true, cpu: 5, ram: 32, disk: 41, uptime: '118 ngày', key: 'blog_rsa', load: '0,04' },
  { id: 'staging', host: 'staging.portway.dev', user: 'root', port: 22, os: 'Ubuntu 24.04', group: 'staging', online: true, cpu: 61, ram: 55, disk: 23, uptime: '3 ngày', key: 'id_ed25519', load: '1,40' },
  { id: 'bastion', host: 'bastion.congty.vn', user: 'dev', port: 22, os: 'Ubuntu 22.04', group: 'công ty', online: true, cpu: 4, ram: 22, disk: 31, uptime: '64 ngày', key: 'id_ed25519', load: '0,05' },
  { id: 'nas-home', host: '192.168.1.20', user: 'admin', port: 22, os: 'Ubuntu 22.04', group: 'cá nhân', online: false, key: 'nas_home' },
  ...(
    [
      ['shop-web', 'khách hàng'], ['shop-api', 'khách hàng'], ['shop-db', 'khách hàng'], ['crm-01', 'khách hàng'],
      ['mail-01', 'hạ tầng'], ['vpn-sg', 'hạ tầng'], ['ci-runner-1', 'hạ tầng'], ['ci-runner-2', 'hạ tầng'],
      ['minio-01', 'hạ tầng'], ['grafana', 'hạ tầng'], ['edge-hn', 'production'], ['edge-hcm', 'production'],
      ['game-mc', 'cá nhân'], ['backup-01', 'hạ tầng'],
    ] as const
  ).map(([id, group], i): Raw => ({
    id,
    group,
    host: `${[103, 45, 139, 172][i % 4]}.${(i * 37) % 250}.${(i * 53 + 11) % 250}.${(i * 17 + 4) % 250}`,
    user: i % 3 ? 'root' : 'deploy',
    port: 22,
    os: i % 4 === 3 ? 'Debian 12' : 'Ubuntu 24.04',
    online: true,
    cpu: (i * 23 + 7) % 80,
    ram: (i * 31 + 20) % 90,
    disk: id === 'backup-01' ? 91 : (i * 19 + 15) % 80,
    uptime: `${(i * 13) % 90 + 1} ngày`,
    key: 'id_ed25519',
    load: '0,' + ((i * 7) % 90 + 10),
  })),
]

// Servers with more than one login; the rest use their single user/key.
const ACCOUNTS: Record<string, [string, string][]> = {
  'web-01': [['root', 'id_ed25519'], ['deploy', 'id_ed25519']],
  'db-01': [['root', 'id_ed25519'], ['backup', '__pw']],
  staging: [['root', 'id_ed25519'], ['deploy', 'id_ed25519'], ['ci', 'id_ed25519']],
  'shop-api': [['root', 'id_ed25519'], ['deploy', 'id_ed25519']],
  'nas-home': [['admin', 'nas_home'], ['media', '__pw']],
  'game-mc': [['root', '__pw']],
}

export const SERVERS: Server[] = RAW.map(({ user, key, ...s }) => ({
  ...s,
  accounts: (ACCOUNTS[s.id] ?? [[user, key]]).map(([u, k]) => ({ user: u, key: k })),
}))

export const KEYS = [
  { name: 'id_ed25519', path: '~/.ssh/id_ed25519', type: 'ED25519', fp: 'SHA256:q3Vt8bN0…Jd29kXw', added: '02/2025' },
  { name: 'blog_rsa', path: '~/.ssh/blog_rsa', type: 'RSA 4096', fp: 'SHA256:Lm0pZr7c…Ty82aQe', added: '11/2023' },
  { name: 'nas_home', path: '~/.ssh/nas_home', type: 'ED25519', fp: 'SHA256:9fKe1wQa…Pp03mNs', added: '06/2024' },
]

export type TunnelStatus = 'run' | 'connecting' | 'retry' | 'error' | 'off'

export const TUNNELS: { id: string; name: string; host: string; status: TunnelStatus }[] = [
  { id: 't1', name: 'Postgres portway', host: 'web-01', status: 'run' },
  { id: 't2', name: 'Umami', host: 'web-01', status: 'run' },
  { id: 't3', name: 'DB công ty', host: 'bastion', status: 'retry' },
  { id: 't4', name: 'Mạng nội bộ', host: 'bastion', status: 'off' },
  { id: 't5', name: 'Redis staging', host: 'staging', status: 'error' },
]

/** Open SSH sessions, one per server × user. */
export const SESSIONS: { serverId: string; user: string }[] = [
  { serverId: 'web-01', user: 'root' },
  { serverId: 'web-01', user: 'deploy' },
  { serverId: 'staging', user: 'root' },
]

export const LOG_SOURCES = [
  { id: 'nginx-access', label: 'Nginx access' },
  { id: 'nginx-error', label: 'Nginx error' },
  { id: 'docker:portway-web', label: 'Container web' },
  { id: 'docker:portway-api', label: 'Container api' },
  { id: 'syslog', label: 'syslog' },
]

/** Menu counters for the server modules until each module has real data. */
export const MODULE_COUNTS = {
  containers: 8,
  compose: 2,
  images: 12,
  volumes: 3,
  services: 7,
  jobs: 5,
  failedServices: 2,
  firewallRules: 7,
}
