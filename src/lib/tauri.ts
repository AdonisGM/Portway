import type { Window } from '@tauri-apps/api/window'

/**
 * The window API only exists when the page is hosted by Tauri. Guarding it
 * means the same UI can be opened in a plain browser against the Vite dev
 * server — useful for devtools work — instead of dying at module load.
 */
export const inTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

let cached: Window | null = null

export async function appWindow(): Promise<Window | null> {
  if (!inTauri()) return null
  if (!cached) {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    cached = getCurrentWindow()
  }
  return cached
}
