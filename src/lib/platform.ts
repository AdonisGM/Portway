/**
 * The system Portway runs on, and what differs between them in the UI.
 * WebView2 (Windows) says "Windows NT" in its user agent, WKWebView (macOS)
 * "Macintosh"; nothing else is needed, so no plugin or permission.
 */
export const isWindows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)

/** Last component of a path on this computer (Windows separates with "\" too). */
export function localBaseName(p: string): string {
  const parts = isWindows ? p.replace(/[\\/]+$/, '').split(/[\\/]/) : p.replace(/\/+$/, '').split('/')
  return parts.pop() || p
}

/**
 * A path from this computer (the home folder, a picked or typed folder) in
 * the form the file panes use: on Windows "C:\Users\x" → "/c/Users/x", the
 * way the Rust side lists them (see src-tauri/src/paths.rs). Unchanged elsewhere.
 */
export function panePath(p: string): string {
  if (!isWindows) return p
  const m = /^([a-zA-Z]):(?:[\\/](.*))?$/.exec(p.trim())
  if (!m) return p.replace(/\\/g, '/')
  const rest = (m[2] ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  return '/' + m[1].toLowerCase() + (rest ? '/' + rest : '')
}

/** How a pane path segment is shown: a drive letter right under "/" is "C:" on Windows. */
export const segmentLabel = (segment: string, index: number) => (isWindows && index === 0 && /^[a-z]$/i.test(segment) ? segment.toUpperCase() + ':' : segment)

/**
 * The UI text is written for macOS. On Windows these words are swapped as the
 * text is shown (both languages): the Keychain is Credential Manager, Finder
 * is File Explorer, ⌘ is Ctrl, an app is an .exe, "this Mac" is "this PC".
 * Longer phrases first, so a word inside them is not swapped on its own.
 */
const WINDOWS_WORDS: [string, string][] = [
  ['Ctrl or ⌘-click', 'Ctrl-click'],
  ['Ctrl hoặc ⌘ + bấm', 'Ctrl + bấm'], // i18n-ignore
  ['this Mac’s Keychain', 'Windows Credential Manager'],
  ["this Mac's Keychain", 'Windows Credential Manager'],
  ['Keychain của máy này', 'Credential Manager của Windows'], // i18n-ignore
  ['Keychain của máy', 'Credential Manager của Windows'], // i18n-ignore
  ['the Keychain', 'Credential Manager'],
  ['Keychain', 'Credential Manager'],
  ['this Mac’s', 'this PC’s'],
  ["this Mac's", "this PC's"],
  ['your Mac’s', 'your PC’s'],
  ['this Mac', 'this PC'],
  ['This Mac', 'This PC'],
  ['your Mac', 'your PC'],
  ['this-Mac-IP', 'this-PC-IP'],
  ['Mac ↔ server', 'PC ↔ server'],
  ['Finder', 'File Explorer'],
  ['macOS', 'Windows'],
  ['any .app', 'any .exe'],
  ['.app nào', '.exe nào'], // i18n-ignore
  ['(.app)', '(.exe)'],
  ['⌘', 'Ctrl+'],
]

export function platformWords(text: string): string {
  if (!isWindows) return text
  let out = text
  for (const [from, to] of WINDOWS_WORDS) if (out.includes(from)) out = out.split(from).join(to)
  return out
}
