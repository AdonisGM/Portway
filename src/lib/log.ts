import { logWrite, type AppLogLevel } from '@/lib/api'
import { inTauri } from '@/lib/tauri'

/**
 * The frontend's end of the application log.
 *
 * Everything written here crosses to Rust and is drawn only when it comes back
 * on `log://line`. That looks like the long way round and is the only way round
 * that works: a session window is a *second copy of this module* in a second
 * webview, so a line rendered locally would be missing from the file, missing
 * from the other window, and out of order with everything the backend wrote in
 * between. One writer, one sequence, one order.
 *
 * What the app cannot say about itself is the reason the global handlers below
 * exist. A React error inside an effect, a promise nobody awaited, a command
 * that rejected in a `.catch(() => {})` — none of those reach a user, and
 * without this they leave no trace at all once the devtools are closed, which
 * in a shipped bundle they always are.
 */

/**
 * At most this many lines a second.
 *
 * A component that throws on every render throws sixty times a second, and the
 * one thing a diagnostic must never do is fill the disk describing its own
 * distress. Past the limit the lines are dropped and a single line says so.
 */
const PER_SECOND = 20

let spent = 0
let windowStart = 0
let suppressed = 0

/**
 * Guards the whole send path.
 *
 * `console.error` is patched below, and `invoke` is entitled to use it — a
 * failing send that logged its own failure would be an unbounded loop, and the
 * first thing it would take down is the window it was reporting from.
 */
let sending = false

function allowed(): boolean {
  const now = Date.now()
  if (now - windowStart >= 1000) {
    windowStart = now
    spent = 0
    if (suppressed > 0) {
      const dropped = suppressed
      suppressed = 0
      // Counted as spent so the notice itself cannot become the flood.
      spent = 1
      send('warn', 'ui', `${dropped} log lines were dropped`, 'more than 20 in one second')
    }
  }
  if (spent >= PER_SECOND) {
    suppressed += 1
    return false
  }
  spent += 1
  return true
}

function send(level: AppLogLevel, target: string, message: string, detail?: string | null) {
  if (!inTauri() || sending) return
  sending = true
  try {
    void logWrite(level, target, message, detail).catch(() => {})
  } catch {
    // Nothing. There is nowhere left to report a failure to report.
  } finally {
    sending = false
  }
}

function write(level: AppLogLevel, target: string, message: string, detail?: string | null) {
  if (!allowed()) return
  send(level, target, message, detail)
}

export const log = {
  debug: (target: string, message: string, detail?: string | null) =>
    write('debug', target, message, detail),
  info: (target: string, message: string, detail?: string | null) =>
    write('info', target, message, detail),
  warn: (target: string, message: string, detail?: string | null) =>
    write('warn', target, message, detail),
  error: (target: string, message: string, detail?: string | null) =>
    write('error', target, message, detail),
}

/** How many frames of a stack are worth keeping. Past this it is scenery. */
const FRAMES = 8

/** One line: `Error: boom`, or whatever a thrown non-Error stringifies to. */
function summarise(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * The frames, trimmed — and with the message put back on the front if it is
 * missing.
 *
 * WebKit's `Error.stack` starts at the first frame, where V8's starts with
 * `Error: message`. Logging the stack alone therefore drops the one part that
 * says what went wrong on the engine this app actually runs on, which is how a
 * rejection came out as fifteen hundred characters of React internals with no
 * mention of the error.
 */
function stackOf(value: unknown): string | null {
  if (!(value instanceof Error) || !value.stack) return null
  const frames = value.stack.split('\n').slice(0, FRAMES).join('\n')
  return frames.includes(value.message) ? frames : `${summarise(value)}\n${frames}`
}

/** What `console.error('a', 1, {b:2})` should read as in a log line. */
function joinArgs(args: unknown[]): string {
  return args.map((arg) => (typeof arg === 'string' ? arg : summarise(arg))).join(' ')
}

let installed = false

/**
 * Catches what the app does not catch itself. Called once per window.
 *
 * The console patches chain the originals rather than replacing them, so
 * devtools still show everything during development — this adds a destination,
 * it does not take one away.
 */
export function installLogCapture(label: string) {
  if (installed) return
  installed = true

  window.addEventListener('error', (event) => {
    const where = `${event.filename}:${event.lineno}:${event.colno}`
    const stack = stackOf(event.error)
    log.error(
      'ui',
      event.message || 'an uncaught error',
      stack ? `${where}\n${stack}` : where,
    )
  })

  // The message goes in the message, not buried in the stack: a line that says
  // only "a promise rejected" is a line that has told you nothing.
  window.addEventListener('unhandledrejection', (event) => {
    log.error(
      'ui',
      `a promise rejected with nobody waiting — ${summarise(event.reason)}`,
      stackOf(event.reason),
    )
  })

  const originalError = console.error
  console.error = (...args: unknown[]) => {
    log.error('ui', joinArgs(args))
    originalError(...args)
  }

  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => {
    log.warn('ui', joinArgs(args))
    originalWarn(...args)
  }

  log.info('ui', 'window ready', `${label} · ${window.location.search || 'no query'}`)
}
