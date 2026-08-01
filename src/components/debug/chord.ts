import { isMac } from '@/lib/platform'

/**
 * The keystroke that opens the debug console, and how to write it down.
 *
 * `L` for log. Matched on `event.code` rather than `event.key`, which with
 * Shift held is `"L"` on one layout and something else entirely on another —
 * the physical key is what was meant.
 *
 * Deliberately not a plain modifier + letter: ⌘L and Ctrl-L are both taken by
 * things people use constantly (Ctrl-L clears a shell), and this chord has to
 * work while a terminal has focus. Adding Shift puts it somewhere nothing else
 * is listening.
 */
export const DEBUG_CHORD = isMac ? '⌘⇧L' : 'Ctrl+Shift+L'

export function isDebugChord(e: KeyboardEvent): boolean {
  if (e.code !== 'KeyL' || !e.shiftKey || e.altKey) return false
  return isMac ? e.metaKey : e.ctrlKey
}
