import { appWindow } from './tauri'

/**
 * How long the splash stays on screen once the window is visible.
 *
 * Measured on a release build the shell is ready ~640ms after launch, so
 * without a floor the splash would flash past and the app would appear to
 * blink into existence. Holding it makes the start legible.
 */
const MIN_SPLASH_VISIBLE_MS = 1200

/** Set by the inline reveal script in index.html when it wins the race. */
declare global {
  interface Window {
    __portwayShownAt?: number
  }
}

/**
 * Boot sequence.
 *
 * The window is created hidden (`visible: false` in tauri.conf.json). A Tauri
 * window is on screen ~60ms after launch, but WebView2 does not paint the
 * document until ~440ms — so a visible-from-the-start window spends a third of
 * a second as a blank dark rectangle, which reads as a broken app rather than
 * a starting one.
 *
 * Two things can reveal it, whichever gets there first:
 *
 *   1. the inline script in index.html, right after the document paints (~450ms)
 *   2. this function, once React has mounted (~885ms)
 *   3. lib.rs, unconditionally after five seconds
 *
 * (1) is the fast path and (2) only matters if it failed; (3) guarantees the
 * app is never invisible because the frontend broke. Whichever runs, the
 * splash is already covering the window, so the user sees branding rather than
 * an empty frame, and the handover to the UI is a fade.
 */
/**
 * `hold` is how long the splash owes. It defaults to the figure above, which is
 * right for a window somebody launched and waited for; a utility window opened
 * from a keystroke passes 0. Branding on the way into a tool you hit a chord
 * for is a stutter, not an entrance — the app is already running and already on
 * screen, and there is nothing left to cover.
 */
export function revealApp(hold: number = MIN_SPLASH_VISIBLE_MS): void {
  void (async () => {
    try {
      // No-op when the inline script already showed it.
      const win = await appWindow()
      if (win) {
        await win.show()
        await win.setFocus()
      }
    } finally {
      // In `finally` so a failed show() can never strand the splash on screen.
      window.setTimeout(hideSplash, remainingSplashTime(hold))
    }
  })()
}

/**
 * Time the splash still owes, measured from when the window actually became
 * visible — not from launch, so the hold is the same length whichever path
 * revealed it.
 */
function remainingSplashTime(hold: number): number {
  if (hold <= 0) return 0
  const shownAt = window.__portwayShownAt
  if (shownAt === undefined) return hold
  const elapsed = performance.now() - shownAt
  return Math.max(0, hold - elapsed)
}

/** Idempotent — StrictMode runs mount effects twice in development. */
function hideSplash(): void {
  const splash = document.getElementById('splash')
  if (!splash || splash.classList.contains('is-hidden')) return

  splash.classList.add('is-hidden')
  // Matches the 180ms fade in index.html; removing it frees the pointer
  // events the overlay would otherwise keep swallowing.
  window.setTimeout(() => splash.remove(), 200)
}
