import { useEffect, useState } from 'react'

/**
 * Which host OS is drawing the window frame.
 *
 * Deliberately synchronous and userAgent-based rather than
 * `@tauri-apps/plugin-os`, whose `platform()` is async: the titlebar is in the
 * first paint, and an awaited answer would render Windows caption buttons for
 * a frame and then swap them out — visible in the splash handoff described in
 * README (§Splash), which is tuned to the millisecond.
 *
 * WKWebView always reports "Macintosh; Intel Mac OS X" in its userAgent, on
 * Apple Silicon too, so the match holds on arm64.
 */
export const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')

/**
 * The "open this somewhere else" modifier, as each platform spells it: ⌘ on
 * macOS, Ctrl elsewhere. Same convention as a browser opening a link in a new
 * window, which is where a user's expectation for it comes from.
 */
export const opensElsewhere = (e: { metaKey: boolean; ctrlKey: boolean }): boolean =>
  isMac ? e.metaKey : e.ctrlKey

/** How to name that modifier in a label. */
export const ELSEWHERE_KEY = isMac ? '⌘' : 'Ctrl'

/**
 * Whether that modifier is held right now, so a button can say what it is about
 * to do instead of leaving the user to remember.
 *
 * The state is re-read from every event's flags rather than tracked as a
 * keydown/keyup pair. A keyup that lands while another app has focus — ⌘-Tab,
 * or any system shortcut that swallows the release — never arrives, and a
 * button left advertising "New window" when the key is long since up is worse
 * than one that never offered.
 */
export function useOpensElsewhere(): boolean {
  const [held, setHeld] = useState(false)

  useEffect(() => {
    const sync = (e: KeyboardEvent | MouseEvent) => setHeld(opensElsewhere(e))
    const clear = () => setHeld(false)

    window.addEventListener('keydown', sync)
    window.addEventListener('keyup', sync)
    // Moving the pointer re-syncs even when no key event was seen at all, which
    // is the case after returning from another application.
    window.addEventListener('mousemove', sync)
    window.addEventListener('blur', clear)

    return () => {
      window.removeEventListener('keydown', sync)
      window.removeEventListener('keyup', sync)
      window.removeEventListener('mousemove', sync)
      window.removeEventListener('blur', clear)
    }
  }, [])

  return held
}
