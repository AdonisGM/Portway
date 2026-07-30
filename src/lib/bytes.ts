/**
 * Base64 for the SSH byte stream.
 *
 * Terminal traffic is arbitrary bytes — control characters, partial UTF-8
 * sequences, binary output from `cat` on the wrong file — none of which
 * survives a JSON string intact. Both directions therefore carry base64, and
 * decoding stops at bytes rather than text so xterm.js can do the UTF-8
 * assembly itself across chunk boundaries.
 */

export function encodeBytes(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function decodeBytes(text: string): Uint8Array {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

const encoder = new TextEncoder()

export const encodeText = (text: string): string => encodeBytes(encoder.encode(text))

/** `412 MB`, `28 KB`, `96 B` — the vocabulary the design's file table uses. */
export function formatSize(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `Jul 30 11:38` — the design's Modified column. */
export function formatMtime(seconds: number | null): string {
  if (seconds === null) return ''
  const d = new Date(seconds * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${MONTHS[d.getMonth()]} ${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
