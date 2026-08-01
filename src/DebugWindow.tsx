import { useEffect, useState } from 'react'
import { TitleBar } from './components/chrome/TitleBar'
import { DebugPanel } from './components/debug/DebugPanel'
import { isDebugChord } from './components/debug/chord'
import { StatusDot } from './components/ui/primitives'
import { revealApp } from './lib/splash'
import { debugInfo, type DebugInfo } from './lib/api'
import { appWindow } from './lib/tauri'
import { useSettingsSync } from './store/useSettingsSync'

/**
 * The debug console, in a window of its own.
 *
 * The third thing `index.html` can be — `?debug=1`, next to `?host=<id>` for a
 * session. Like a session window it is a *second copy of the app* rather than a
 * view inside the first, and like a session window what it shares is the Rust
 * process: the log lives there, so a console in any window is looking at the
 * same one file and the same one sequence.
 *
 * A window rather than the overlay this started as. Both things it is for need
 * it beside what it is describing — watching a connection go through while you
 * look at the terminal it belongs to, or parking it on a second screen while
 * something long runs. An overlay covers the very thing you opened it to
 * explain.
 */
export default function DebugWindow() {
  // For the accent alone — this window has no terminal and no tables — but it
  // is the same one line, and a console in a different green from the app it
  // is describing would be a puzzle with no answer.
  useSettingsSync()

  const [info, setInfo] = useState<DebugInfo | null>(null)

  // No splash hold: this window is opened with a keystroke while the app is
  // already on screen, and 1.2 seconds of branding on the way in would read as
  // a stall rather than a start.
  useEffect(() => {
    revealApp(0)
  }, [])

  // Just for the titlebar — the panel reads its own copy for the strip.
  useEffect(() => {
    void debugInfo()
      .then(setInfo)
      .catch(() => {})
  }, [])

  // The same chord that opened it closes it, so it toggles from wherever you
  // are. ⌘W does it too, from Tauri's default macOS menu.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isDebugChord(e)) return
      e.preventDefault()
      e.stopPropagation()
      void close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <div className="flex h-full flex-col bg-base text-fg">
      <TitleBar
        subject={
          <>
            <StatusDot tone="accent" size="sm" />
            <span className="flex-none text-body font-semibold">Debug &amp; logs</span>
            {/* Which log. A console that will not say what it is reading is a
                console you have to go and check somewhere else. */}
            <span className="cell-ellipsis font-mono text-cell text-muted">
              {info ? info.logFile : '~/.portway/logs'}
            </span>
          </>
        }
      />

      <DebugPanel onClose={close} />
    </div>
  )
}

async function close() {
  const win = await appWindow()
  await win?.close()
}
