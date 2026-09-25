import type { ModuleId, Screen } from '../app/nav'
import { SERVERS, type Server } from '../mock/data'

export const MODULE_LABELS: Record<ModuleId, string> = {
  overview: 'Tổng quan',
  files: 'Tệp (SFTP)',
  docker: 'Docker',
  services: 'Dịch vụ',
  firewall: 'Firewall',
  logs: 'Log',
}

export const serverById = (id: string): Server | undefined => SERVERS.find((s) => s.id === id)

/** OS badge: first letter and brand colour of the distro. */
const OS_BADGES: Record<string, [string, string]> = {
  Ubuntu: ['U', '#E95420'],
  Debian: ['D', '#A81D33'],
  CentOS: ['C', '#932279'],
  Rocky: ['R', '#10B981'],
  AlmaLinux: ['A', '#0F4266'],
  Fedora: ['F', '#51A2DA'],
  Alpine: ['A', '#0D597F'],
  Arch: ['A', '#1793D1'],
}

export function osBadge(os: string | undefined) {
  const name = Object.keys(OS_BADGES).find((n) => os?.startsWith(n))
  return name
    ? { letter: OS_BADGES[name][0], bg: OS_BADGES[name][1] }
    : { letter: '?', bg: 'var(--muted)' }
}

/** Health dot: offline is red, a nearly full disk or RAM is amber. */
export function statusDot(s: Server | undefined) {
  if (!s || !s.online) return 'var(--danger)'
  return (s.disk ?? 0) >= 85 || (s.ram ?? 0) >= 85 ? 'var(--warn)' : 'var(--success)'
}

/** Context shown next to the app name in the title bar. */
export function screenTitle(s: Screen) {
  switch (s.kind) {
    case 'servers':
      return 'Tất cả server'
    case 'keys':
      return 'Khoá SSH'
    case 'tunnels':
      return 'Tunnel'
    case 'server':
      return `${s.serverId} — ${MODULE_LABELS[s.module]}`
  }
}
