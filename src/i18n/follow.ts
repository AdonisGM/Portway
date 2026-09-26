import { isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { api, type Settings } from '../lib/api'
import { setLang } from '.'

/** Keep this window's language on the saved one, including changes made in another window. */
export function followLanguage() {
  document.documentElement.lang = 'vi'
  void api
    .settings()
    .then((s) => setLang(s.language))
    .catch(() => {})
  if (isTauri()) void listen<Settings>('settings', (e) => setLang(e.payload.language))
}
