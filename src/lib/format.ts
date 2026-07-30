const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Renders the "Last used" column in the vocabulary the design uses:
 * `2 min ago` · `1 h ago` · `yesterday` · `Jul 24`
 * (SSH Client.dc.html:766-778).
 *
 * A host that has never been opened shows `—`, matching how the drawer writes
 * every other absent value.
 */
export function relativeTime(ts: number | null, now: number = Date.now()): string {
  if (ts === null) return '—'
  const delta = now - ts
  if (delta < MIN) return 'just now'
  if (delta < HOUR) return `${Math.floor(delta / MIN)} min ago`
  if (delta < DAY) return `${Math.floor(delta / HOUR)} h ago`
  if (delta < 2 * DAY) return 'yesterday'
  const d = new Date(ts)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

/** "Recent" in the toolbar filter means: used within the last day. */
export function isRecent(ts: number | null, now: number = Date.now()): boolean {
  return ts !== null && now - ts < DAY
}
