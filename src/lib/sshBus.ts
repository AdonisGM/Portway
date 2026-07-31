import { listen } from '@tauri-apps/api/event'
import { decodeBytes } from './bytes'
import { inTauri } from './tauri'

/**
 * One subscription to the SSH event stream per window, with a short memory.
 *
 * Two problems come from letting each terminal pane call `listen` for itself.
 *
 * The first is that `listen` is a round trip: the handler is not registered
 * until Rust has answered. A pane that mounts and connects in the same tick
 * therefore has a window in which the shell is already talking and nothing is
 * listening, and those bytes are gone — the greeting and the first prompt, which
 * is exactly the output that tells you the connection worked. It was visible in
 * the main window as a missing MOTD, and in a session window, where the whole
 * app boots and connects at once, as an entirely blank terminal.
 *
 * The second is that a pane is not a stable place to hold a session's output.
 * `SessionScreen` renders only the active tab and keys the pane on the session,
 * so switching tabs destroys the terminal and coming back builds a new, empty
 * one.
 *
 * So the listener lives here instead — registered once, before any connection
 * is asked for, and remembering what it has seen. Subscribing replays that
 * memory into the fresh terminal and then streams. A pane can be created and
 * destroyed as often as the tab strip likes without the session noticing.
 */

/** Data and closure share one ordered log, so a session that dies mid-boot
 *  replays its last output *before* the "shell ended" notice rather than after. */
type Entry = { kind: 'data'; bytes: Uint8Array } | { kind: 'closed'; reason: string }

export interface Handlers {
  onData: (bytes: Uint8Array) => void
  onClosed: (reason: string) => void
}

/**
 * How much output a session remembers. Enough to cover a boot and a few
 * screenfuls of scrollback on return to a tab; small enough that a process
 * spewing megabytes into a tab nobody is looking at cannot grow without bound.
 */
const MAX_REMEMBERED_BYTES = 512 * 1024

interface Buffer {
  entries: Entry[]
  bytes: number
}

const buffers = new Map<string, Buffer>()
const subscribers = new Map<string, Set<Handlers>>()

let started: Promise<void> | null = null

/**
 * Resolves once this window is actually receiving SSH events.
 *
 * Callers that are about to open a connection await it first, so no session can
 * start producing output before there is anywhere for it to land.
 */
export function ready(): Promise<void> {
  if (!started) started = start()
  return started
}

async function start(): Promise<void> {
  // Outside Tauri — the UI opened against the Vite dev server — there is no
  // event system to subscribe to, and the panes should still mount.
  if (!inTauri()) return

  await Promise.all([
    listen<{ sessionId: string; data: string }>('ssh://data', (event) => {
      record(event.payload.sessionId, { kind: 'data', bytes: decodeBytes(event.payload.data) })
    }),
    listen<{ sessionId: string; reason: string }>('ssh://closed', (event) => {
      record(event.payload.sessionId, { kind: 'closed', reason: event.payload.reason })
    }),
  ])
}

function record(sessionId: string, entry: Entry): void {
  const buffer = buffers.get(sessionId) ?? { entries: [], bytes: 0 }
  buffer.entries.push(entry)
  buffer.bytes += entry.kind === 'data' ? entry.bytes.length : entry.reason.length

  // Whole entries leave from the front rather than a byte count being trimmed:
  // cutting a chunk in half can cut an escape sequence in half, and the replay
  // would paint the top of the terminal with its remains.
  while (buffer.bytes > MAX_REMEMBERED_BYTES && buffer.entries.length > 1) {
    const dropped = buffer.entries.shift()!
    buffer.bytes -= dropped.kind === 'data' ? dropped.bytes.length : dropped.reason.length
  }
  buffers.set(sessionId, buffer)

  for (const handlers of subscribers.get(sessionId) ?? []) deliver(handlers, entry)
}

function deliver(handlers: Handlers, entry: Entry): void {
  if (entry.kind === 'data') handlers.onData(entry.bytes)
  else handlers.onClosed(entry.reason)
}

/**
 * Attaches a terminal to a session: everything so far, then everything after.
 *
 * The replay and the registration happen in the same synchronous stretch, so no
 * chunk can arrive between them and be either missed or shown twice.
 */
export function subscribe(sessionId: string, handlers: Handlers): () => void {
  void ready()

  for (const entry of buffers.get(sessionId)?.entries ?? []) deliver(handlers, entry)

  const set = subscribers.get(sessionId) ?? new Set<Handlers>()
  set.add(handlers)
  subscribers.set(sessionId, set)

  return () => {
    const current = subscribers.get(sessionId)
    if (!current) return
    current.delete(handlers)
    if (current.size === 0) subscribers.delete(sessionId)
  }
}

/** Drops a closed session's memory. Without it a long-lived window keeps every
 *  tab it ever opened. */
export function forget(sessionId: string): void {
  buffers.delete(sessionId)
  subscribers.delete(sessionId)
}
