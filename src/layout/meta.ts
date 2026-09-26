import type { ModuleId, Screen } from '../app/nav'

export const MODULE_LABELS: Record<ModuleId, string> = {
  overview: 'Tổng quan',
  files: 'Tệp (SFTP)',
  docker: 'Docker',
  services: 'Dịch vụ',
  firewall: 'Firewall',
}

/** Context shown next to the app name in the title bar. */
export function screenTitle(s: Screen, serverName: (id: string) => string | undefined) {
  switch (s.kind) {
    case 'servers':
      return 'Tất cả server'
    case 'keys':
      return 'Khoá SSH'
    case 'tunnels':
      return 'Tunnel'
    case 'transfer':
      return 'Chuyển tệp'
    case 'settings':
      return 'Cài đặt'
    case 'server':
      return `${serverName(s.serverId) ?? s.serverId} — ${MODULE_LABELS[s.module]}`
  }
}
