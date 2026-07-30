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
