import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Button } from '@/components/ui/Button'
import { Segmented } from '@/components/ui/Segmented'
import { StatusDot } from '@/components/ui/primitives'
import * as api from '@/lib/api'
import type { AppLogLevel, AppLogLine, DebugInfo } from '@/lib/api'
import { clear, ready, snapshot, subscribe } from '@/lib/logBus'
import { DEBUG_CHORD } from './chord'

/**
 * The debug console: what the app is doing, as it does it.
 *
 * Deliberately an overlay rather than a screen or a window of its own. A screen
 * would only exist in the main window, and half of what is worth watching
 * happens in a session window; a window of its own would need adding to the
 * capability list, would not share a store with either parent, and would be one
 * more thing to arrange on screen. An overlay opens over whatever you were
 * already looking at, in the window you were looking at it in, and closes
 * again — which is what a diagnostic should do.
 *
 * It starts below the titlebar on purpose: covering it would take the traffic
 * lights and the drag region with it, and a debug tool that makes the window
 * unmovable is its own bug report.
 */

type View = 'all' | 'info' | 'warn' | 'error'

/** How much of each level to show. `all` is the only one that lets debug in. */
const FLOOR: Record<View, number> = { all: 0, info: 1, warn: 2, error: 3 }
const RANK: Record<AppLogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

const VIEWS: { value: View; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warnings' },
  { value: 'error', label: 'Errors' },
]

const LEVEL_COLOUR: Record<AppLogLevel, string> = {
  debug: 'text-faint',
  info: 'text-fg-2',
  warn: 'text-warn',
  error: 'text-danger',
}

/** `14:22:07.482` — local, because the person reading it is here. */
function clockOf(at: number): string {
  const d = new Date(at)
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

/** `2h 04m` since the process started. */
function uptimeOf(startedAt: number, now: number): string {
  if (!startedAt) return '—'
  const minutes = Math.max(0, Math.floor((now - startedAt) / 60_000))
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

export function DebugPanel({ onClose }: { onClose: () => void }) {
  const lines = useSyncExternalStore(subscribe, snapshot)
  const [view, setView] = useState<View>('all')
  const [needle, setNeedle] = useState('')
  const [info, setInfo] = useState<DebugInfo | null>(null)
  const [verbose, setVerbose] = useState(false)
  const [follow, setFollow] = useState(true)
  const [opened, setOpened] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const scrollRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void ready()
    // Takes focus off whatever was behind — usually a terminal, where every
    // keystroke aimed at this panel would otherwise land in a live shell.
    // `DebugRoot` hands it back when the panel closes.
    filterRef.current?.focus()
  }, [])

  // Re-read while open: the counts are the point of showing them, and a
  // session that opened thirty seconds ago should be in the number.
  useEffect(() => {
    let alive = true
    const read = () => {
      void api
        .debugInfo()
        .then((next) => {
          if (!alive) return
          setInfo(next)
          setVerbose(next.level === 'debug')
          setNow(Date.now())
        })
        .catch(() => {})
    }
    read()
    const timer = window.setInterval(read, 3000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  const shown = useMemo(() => {
    const floor = FLOOR[view]
    const query = needle.trim().toLowerCase()
    return lines.filter((line) => {
      if (RANK[line.level] < floor) return false
      if (!query) return true
      return (
        line.message.toLowerCase().includes(query) ||
        line.target.toLowerCase().includes(query) ||
        (line.detail?.toLowerCase().includes(query) ?? false)
      )
    })
  }, [lines, view, needle])

  const virtualizer = useVirtualizer({
    count: shown.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 21,
    overscan: 12,
  })

  // Following means the newest line is the one you are looking at. It stops the
  // moment the user scrolls away from the bottom — a view that yanks itself
  // back down while somebody is reading is unusable — and resumes when they
  // come back to it, so there is nothing to remember to switch on again.
  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
  }, [])

  // Keyed on the newest sequence, not the count. The bus keeps the last 5000
  // lines and then shifts, so past that the length never changes again — a
  // count would stop firing exactly when the log is busiest, leaving the view
  // frozen under a footer still claiming to follow.
  const newest = shown.length > 0 ? shown[shown.length - 1].seq : 0
  useEffect(() => {
    if (!follow || shown.length === 0) return
    virtualizer.scrollToIndex(shown.length - 1, { align: 'end' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follow, newest, virtualizer])

  const toggleVerbose = () => {
    const next: AppLogLevel = verbose ? 'info' : 'debug'
    setVerbose(!verbose)
    void api.setLogLevel(next).catch(() => {})
  }

  const copy = () => {
    const text = shown
      .map(
        (line) =>
          `${clockOf(line.at)} ${line.level.toUpperCase().padEnd(5)} ${line.target.padEnd(8)} ${
            line.message
          }${line.detail ? ` | ${line.detail}` : ''}`,
      )
      .join('\n')
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1400)
      },
      () => {},
    )
  }

  // Two passes over five thousand lines, and a render happens per arriving
  // line — cheap enough at `info`, not for free at `debug` under load.
  const { errors, warnings } = useMemo(
    () => ({
      errors: lines.filter((l) => l.level === 'error').length,
      warnings: lines.filter((l) => l.level === 'warn').length,
    }),
    [lines],
  )

  return (
    // Fixed rather than absolute, and starting below the titlebar: it has to
    // cover the rail and every screen whichever window it is in, and it must
    // not cover the bar — that is where the traffic lights and the drag region
    // are, and a debug tool that pins the window in place is its own bug.
    <div className="fixed inset-x-0 top-titlebar bottom-0 z-40 flex flex-col bg-base">
      <div className="flex flex-none items-center gap-2.5 border-b border-w06 px-4.5 py-3">
        <StatusDot tone={errors > 0 ? 'warn' : 'accent'} size="sm" />
        <span className="flex-none text-title font-semibold">Debug</span>
        <span className="flex-none font-mono text-meta text-faint">
          {lines.length} lines · {warnings} warnings · {errors} errors
        </span>

        <span className="ml-auto flex items-center gap-2">
          <input
            ref={filterRef}
            value={needle}
            onChange={(e) => setNeedle(e.target.value)}
            placeholder="filter"
            aria-label="Filter the log"
            // Otherwise WebKit offers its saved-form suggestions under a box
            // that has nothing to do with a form, and they cover the first
            // line of the stream.
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className="w-44 rounded-field border border-w08 bg-field px-2.5 py-1.25 font-mono text-mono text-fg placeholder:text-faint focus:border-accent-50 focus:outline-none"
          />
          <Segmented aria-label="Level" size="xs" options={VIEWS} value={view} onChange={setView} />
          {/* Two different things, and they are not merged on purpose: the
              segmented control filters what is *shown*, this decides what the
              backend bothers to *record*. Turning it on mid-problem is the
              usual way in. */}
          <Button size="sm" variant={verbose ? 'accent' : 'soft'} onClick={toggleVerbose}>
            Verbose
          </Button>
          <Button size="sm" onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button size="sm" onClick={() => void api.revealLogs().catch(() => {})}>
            Log folder
          </Button>
          <Button size="sm" onClick={clear} title="Clears this view only — the file is untouched">
            Clear view
          </Button>
          <Button size="sm" variant="outline" onClick={onClose}>
            Close · Esc
          </Button>
        </span>
      </div>

      <SystemStrip info={info} now={now} />

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto bg-term px-3.5 py-2 font-mono text-mono"
      >
        {shown.length === 0 ? (
          <div className="py-8 text-center text-faint">
            {lines.length === 0 ? 'nothing logged yet' : 'nothing matches that filter'}
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize() }} className="relative w-full">
            {virtualizer.getVirtualItems().map((item) => {
              const line = shown[item.index]
              return (
                <div
                  key={line.seq}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  className="absolute top-0 left-0 w-full"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <Line
                    line={line}
                    open={opened === line.seq}
                    onToggle={() => setOpened(opened === line.seq ? null : line.seq)}
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="flex flex-none items-center gap-4 border-t border-w06 px-4 py-2.5 font-mono text-mono text-faint">
        <span>{info ? info.logFile : '~/.portway/logs'}</span>
        <span>{follow ? 'following' : 'scrolled back — scroll to the bottom to follow again'}</span>
        <span className="ml-auto">{DEBUG_CHORD} to close</span>
      </div>
    </div>
  )
}

/**
 * One line, clipped to a single row until it is clicked.
 *
 * A stack trace is four hundred characters and every row would be as tall as
 * the one that needs the room, which makes the stream unreadable exactly when
 * there is a lot of it. Clicking one opens it in place.
 */
function Line({
  line,
  open,
  onToggle,
}: {
  line: AppLogLine
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`flex w-full items-start gap-2.5 rounded-chip px-1.5 py-0.5 text-left transition-colors hover:bg-w04 ${
        open ? 'bg-w05' : ''
      }`}
    >
      <span className="flex-none text-term-dim">{clockOf(line.at)}</span>
      <span className={`w-11 flex-none uppercase ${LEVEL_COLOUR[line.level]}`}>{line.level}</span>
      <span className="w-14 flex-none text-faint">{line.target}</span>
      <span className={`min-w-0 flex-1 ${open ? 'break-words whitespace-pre-wrap' : 'truncate'}`}>
        <span className="text-term-fg">{line.message}</span>
        {line.detail ? <span className="text-faint"> · {line.detail}</span> : null}
      </span>
    </button>
  )
}

/** Where things are and what is running — the half of "debug" that is not a stream. */
function SystemStrip({ info, now }: { info: DebugInfo | null; now: number }) {
  if (!info) {
    return (
      <div className="flex-none border-b border-w06 px-4.5 py-2.5 font-mono text-mono text-faint">
        reading…
      </div>
    )
  }

  const facts: [string, string][] = [
    ['version', `${info.version} · ${info.os} ${info.arch}`],
    ['uptime', uptimeOf(info.startedAt, now)],
    ['window', info.window],
    ['windows open', String(info.windows.length)],
    ['sessions', String(info.sessions)],
    ['tunnels up', String(info.tunnelsActive)],
    ['recording', info.level],
    ['database', info.database],
  ]

  return (
    <div className="flex-none border-b border-w06 px-4.5 py-2.5">
      <div className="grid grid-cols-4 gap-x-6 gap-y-1 font-mono text-mono">
        {facts.map(([label, value]) => (
          <div key={label} className="flex min-w-0 items-baseline gap-2">
            <span className="flex-none text-faint">{label}</span>
            <span className="cell-ellipsis text-fg-2">{value}</span>
          </div>
        ))}
      </div>

      {/* The one diagnostic that has already cost a day: a key under ~/Documents
          makes macOS put a consent dialog in front of the read, drawn outside
          the app, so from in here the connection simply stops for a minute. */}
      {info.gatedKeys.length > 0 ? (
        <div className="mt-2 flex items-start gap-2 font-mono text-mono text-warn">
          <span className="flex-none">!</span>
          <span>
            {info.gatedKeys.join(', ')} — the key is in a folder macOS keeps behind a permission
            prompt. The first connection blocks until that dialog is answered, and an unsigned
            build is asked again after every rebuild. Moving the key to ~/.ssh ends it.
          </span>
        </div>
      ) : null}
    </div>
  )
}
