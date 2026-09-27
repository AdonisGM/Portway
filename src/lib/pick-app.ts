import { open } from '@tauri-apps/plugin-dialog'
import { t } from '../i18n'
import { isWindows } from './platform'

/** Let the user pick any app on this computer (a .app on macOS, an .exe on
 *  Windows); null when cancelled. */
export async function pickApp(title: string): Promise<string | null> {
  const picked = await open({
    title,
    defaultPath: isWindows ? 'C:\\Program Files' : '/Applications',
    filters: [{ name: t('Ứng dụng'), extensions: [isWindows ? 'exe' : 'app'] }],
  })
  return typeof picked === 'string' ? picked : null
}
