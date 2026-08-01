import { listen } from '@tauri-apps/api/event'
import { logBacklog, type AppLogLine } from '@/lib/api'
import { inTauri } from '@/lib/tauri'

/**
 * The live log, in this window.
 *
 * One listener per window, started the first time the debug panel is opened and
 * left running afterwards — reopening it should be instant, and a listener that
 * receives a few lines a minute costs nothing to leave in place.
 *
 * The same race `sshBus` has, solved the same way and then some. `listen` is a
 * round trip, and so is asking for the backlog: whichever order they are done
 * in, lines can arrive in the gap between them. Registering the listener first
 * means those lines are *received* rather than missed; the sequence number,
 * which the backend hands out monotonically, is what lets the backlog then be
 * merged under them without duplicating the overlap.
 */

/** How many lines this window keeps. The backend's own ring is 3000. */
const MAX = 5000

let lines: AppLogLine[] = []
let started: Promise<void> | null = null
const watchers = new Set<() => void>()

function announce() {
  for (const watcher of watchers) watcher()
}

/** Newest last, one entry per `seq`. */
function merge(incoming: AppLogLine[]) {
  if (incoming.length === 0) return
  const seen = new Map<number, AppLogLine>()
  for (const line of lines) seen.set(line.seq, line)
  for (const line of incoming) seen.set(line.seq, line)

  let merged = [...seen.values()].sort((a, b) => a.seq - b.seq)
  if (merged.length > MAX) merged = merged.slice(merged.length - MAX)

  lines = merged
  announce()
}

async function start() {
  if (!inTauri()) return
  // Listener first — see above.
  await listen<AppLogLine>('log://line', (event) => merge([event.payload]))
  merge(await logBacklog())
}

/** Resolves once the backlog is in and the listener is live. */
export function ready(): Promise<void> {
  if (!started) started = start().catch(() => {})
  return started
}

export function snapshot(): AppLogLine[] {
  return lines
}

/** For `useSyncExternalStore`. */
export function subscribe(onChange: () => void): () => void {
  watchers.add(onChange)
  return () => {
    watchers.delete(onChange)
  }
}

/**
 * Empties this window's view.
 *
 * The file is untouched, and so is the backend's ring — this is "I have read
 * these, show me what happens next", not a delete. Saying so in the panel
 * matters: a Clear that quietly destroyed the record would be the worst button
 * in a diagnostic tool.
 */
export function clear() {
  lines = []
  announce()
}
