import { open } from '@tauri-apps/plugin-dialog'
import { t } from '../i18n'

/** Let the user pick any app on this Mac; null when cancelled. */
export async function pickApp(title: string): Promise<string | null> {
  const picked = await open({ title, defaultPath: '/Applications', filters: [{ name: t('Ứng dụng'), extensions: ['app'] }] })
  return typeof picked === 'string' ? picked : null
}
