import { useEffect, useRef } from 'react'
import { listen } from '@tauri-apps/api/event'
import type { SettingChanged } from '@/lib/api'
import { useApp } from './appStore'

/**
 * Keeps this window's preferences in step with the rest of the app.
 *
 * Every window runs its own copy of the frontend, and therefore its own copy
 * of the store. Without this, a font size chosen in the main window would
 * reach a session window only when that window was closed and opened again —
 * and the two would disagree about the accent colour in the meantime.
 *
 * Returns nothing: the settings are in the store, where the components that
 * care already read them from. `onReady` fires once the first read is in —
 * the main window uses it to hold the reveal until it knows its own accent.
 */
export function useSettingsSync(onReady?: () => void): void {
  const loadSettings = useApp((s) => s.loadSettings)
  const applySetting = useApp((s) => s.applySetting)
  const accent = useApp((s) => s.settings.accent)

  // Through a ref so an inline callback does not re-run the effect — which
  // would re-read the settings and re-subscribe on every render.
  const ready = useRef(onReady)
  ready.current = onReady

  useEffect(() => {
    void loadSettings().finally(() => ready.current?.())
    const pending = listen<SettingChanged>('settings://changed', (event) => {
      applySetting(event.payload.key, event.payload.value)
    })
    return () => {
      void pending.then((un) => un())
    }
  }, [loadSettings, applySetting])

  // One variable write repaints every accent surface in the window, because
  // each Tailwind utility compiles down to var(--color-accent).
  useEffect(() => {
    document.documentElement.style.setProperty('--color-accent', accent)
  }, [accent])
}
