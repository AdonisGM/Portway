import { isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { api, type Settings, type Theme } from './api'

const dark = window.matchMedia('(prefers-color-scheme: dark)')
/** Last theme, so the first paint of the next launch already has it. */
const CACHE_KEY = 'portway.theme'
let current: Theme = 'dark'

function paint() {
  const mode = current === 'system' ? (dark.matches ? 'dark' : 'light') : current
  document.documentElement.dataset.theme = mode
  // The native traffic lights and window chrome follow too.
  if (isTauri()) void getCurrentWindow().setTheme(current === 'system' ? null : current).catch(() => {})
}

export function applyTheme(theme: Theme) {
  current = theme
  paint()
  try {
    localStorage.setItem(CACHE_KEY, theme)
  } catch {
    // Only saves a flash of the old colours at launch.
  }
}

/** Keep this window's colours on the saved theme, including later changes
 *  made in another window and macOS switching light/dark. */
export function followTheme() {
  try {
    const cached = localStorage.getItem(CACHE_KEY)
    if (cached === 'dark' || cached === 'light' || cached === 'system') applyTheme(cached)
  } catch {
    // Settings below still apply it.
  }
  dark.addEventListener('change', () => current === 'system' && paint())
  void api.settings().then((s) => applyTheme(s.theme)).catch(() => {})
  if (isTauri()) void listen<Settings>('settings', (e) => applyTheme(e.payload.theme))
}
