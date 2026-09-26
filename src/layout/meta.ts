import type { ModuleId, Screen } from '../app/nav'
import { t } from '../i18n'

/** Name of a server module, in the current language. */
export function moduleLabel(id: ModuleId): string {
  switch (id) {
    case 'overview':
      return t('Tổng quan')
    case 'files':
      return t('Tệp (SFTP)')
    case 'nginx':
      return 'Nginx'
    case 'http':
      return 'HTTP (curl)'
    case 'docker':
      return 'Docker'
    case 'services':
      return t('Dịch vụ')
    case 'firewall':
      return 'Firewall'
  }
}

const MODULE_IDS: ModuleId[] = ['overview', 'files', 'nginx', 'http', 'docker', 'services', 'firewall']

/** Module names by id; each read goes through moduleLabel, so it follows the language. */
export const MODULE_LABELS = Object.defineProperties(
  {},
  Object.fromEntries(MODULE_IDS.map((id) => [id, { get: () => moduleLabel(id), enumerable: true }])),
) as Readonly<Record<ModuleId, string>>

/** Context shown next to the app name in the title bar. */
export function screenTitle(s: Screen, serverName: (id: string) => string | undefined) {
  switch (s.kind) {
    case 'servers':
      return t('Tất cả server')
    case 'keys':
      return t('Khoá SSH')
    case 'tunnels':
      return 'Tunnel'
    case 'transfer':
      return t('Chuyển tệp')
    case 'settings':
      return t('Cài đặt')
    case 'server':
      return `${serverName(s.serverId) ?? s.serverId} — ${moduleLabel(s.module)}`
  }
}
