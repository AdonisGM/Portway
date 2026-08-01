import { useCallback, useEffect, useRef, useState } from 'react'
import { log } from '@/lib/log'
import { DebugPanel } from './DebugPanel'
import { isDebugChord } from './chord'

/**
 * Holds the chord and, when it fires, the console.
 *
 * Mounted in both window types — the main window and every session window —
 * because both are worth being able to look inside, and each is a separate copy
 * of the frontend that has to bind its own key.
 *
 * The listener is on `window` in the **capture** phase, which is the only place
 * it works: a session window's focus is almost always inside xterm, and xterm
 * reads keystrokes off its own textarea. Capture runs before the event reaches
 * it, and stopping the event there is what keeps ⇧⌘L from also being typed into
 * whatever shell is running.
 */
export function DebugRoot() {
  const [open, setOpen] = useState(false)

  /**
   * What had focus when the console opened.
   *
   * The panel takes focus deliberately — leaving it in the terminal underneath
   * would mean every keystroke aimed at the filter box was quietly typed into
   * somebody's shell instead. Which makes handing it back on close part of the
   * same decision: the terminal was where you were, and you should be back
   * there without having to click.
   */
  const restoreTo = useRef<HTMLElement | null>(null)

  const close = useCallback(() => {
    setOpen(false)
    const target = restoreTo.current
    restoreTo.current = null
    // After the panel is gone; focusing an element under an overlay that is
    // still mounted does not stick.
    window.setTimeout(() => target?.focus?.(), 0)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isDebugChord(e)) {
        e.preventDefault()
        e.stopPropagation()
        if (open) {
          close()
        } else {
          // Read before the state changes, so it is the terminal that is
          // remembered and not the filter box the panel is about to focus.
          restoreTo.current = document.activeElement as HTMLElement | null
          setOpen(true)
        }
        return
      }
      // Only while it is open, and only then: Escape belongs to the terminal —
      // it is half of vim — and a global binding for it would be intolerable.
      if (open && e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close()
      }
    }

    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, close])

  // The console being opened is itself worth a line: it timestamps the moment
  // somebody started looking, which is what you line the file up against when
  // reading it back later.
  useEffect(() => {
    if (open) log.debug('ui', 'the debug console was opened')
  }, [open])

  return open ? <DebugPanel onClose={close} /> : null
}
