import { useEffect } from 'react'
import { openDebugWindow } from '@/lib/api'
import { isDebugChord } from './chord'

/**
 * The chord, in whichever window you happen to be in.
 *
 * It opens nothing here — it asks the backend for the console window, which is
 * one window for the whole app. Mounted in both window types because both are
 * places you might be standing when you want it, and each is a separate copy of
 * the frontend that has to bind its own key.
 *
 * The listener is on `window` in the **capture** phase, which is the only place
 * it works: a session window's focus is almost always inside xterm, and xterm
 * reads keystrokes off its own textarea. Capture runs before the event reaches
 * it, and stopping the event there is what keeps ⇧⌘L from also being typed into
 * whatever shell is running.
 */
export function DebugShortcut() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isDebugChord(e)) return
      e.preventDefault()
      e.stopPropagation()
      void openDebugWindow().catch(() => {})
    }

    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return null
}
