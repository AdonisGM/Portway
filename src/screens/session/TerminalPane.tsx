import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { listen } from '@tauri-apps/api/event'
import '@xterm/xterm/css/xterm.css'

import type { Session } from '@/data/types'
import { sshResize, sshWrite } from '@/lib/api'
import { decodeBytes, encodeText } from '@/lib/bytes'
import { StatusDot } from '@/components/ui/primitives'
import { useApp } from '@/store/appStore'

/**
 * The real terminal: xterm.js on the front, an SSH PTY on the back.
 *
 * Bytes go out through `ssh_write` and come back on the `ssh://data` event.
 * Nothing here interprets them — the shell owns the screen, and the same
 * keystrokes are separately reconstructed into command lines by the Rust side
 * for the audit trail.
 */

/** Reads a CSS custom property so the terminal follows the app's tokens. */
function token(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

export function TerminalPane({ session }: { session: Session }) {
  const mountRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const [size, setSize] = useState({ cols: 80, rows: 24 })
  const setSessionStatus = useApp((s) => s.setSessionStatus)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const term = new Terminal({
      fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
      fontSize: 12,
      // The handoff asks for two things a real terminal cannot both honour:
      // body text at 12px/1.75 *and* a 7×14px block cursor. A block cursor
      // fills its cell, so at 1.75 the cell is 21px and the cursor towers over
      // the text. 1.3 puts the cell at ~16px — near the 14px the design draws,
      // and still comfortably spaced.
      lineHeight: 1.3,
      cursorBlink: true,
      // `bar` would be the obvious choice, but the design draws a solid block.
      cursorStyle: 'block',
      scrollback: 10_000,
      theme: {
        background: token('--color-term', '#08090a'),
        foreground: token('--color-term-fg', '#a8aea8'),
        cursor: token('--color-accent', '#5ec8b0'),
        cursorAccent: token('--color-term', '#08090a'),
        selectionBackground: token('--color-w15', '#ffffff26'),
        // The palette has to be given explicitly. Left out, every colour a
        // program emits renders as the plain foreground — `ls` loses its
        // directories, `git diff` loses its sides, and the pane looks like it
        // does not support colour at all.
        black: token('--color-ansi-black', '#3b4043'),
        red: token('--color-ansi-red', '#d9776a'),
        green: token('--color-ansi-green', '#7fbf8a'),
        yellow: token('--color-ansi-yellow', '#c9a15f'),
        blue: token('--color-ansi-blue', '#6f9fd8'),
        magenta: token('--color-ansi-magenta', '#b48ac4'),
        cyan: token('--color-ansi-cyan', '#5ec8b0'),
        white: token('--color-ansi-white', '#a8aea8'),
        brightBlack: token('--color-ansi-bright-black', '#6b7078'),
        brightRed: token('--color-ansi-bright-red', '#e89184'),
        brightGreen: token('--color-ansi-bright-green', '#98d3a2'),
        brightYellow: token('--color-ansi-bright-yellow', '#dbb877'),
        brightBlue: token('--color-ansi-bright-blue', '#8ab6e6'),
        brightMagenta: token('--color-ansi-bright-magenta', '#c9a4d8'),
        brightCyan: token('--color-ansi-bright-cyan', '#7fd9c4'),
        brightWhite: token('--color-ansi-bright-white', '#e8e8e6'),
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(mount)
    termRef.current = term

    // Keystrokes out.
    const typed = term.onData((data) => {
      void sshWrite(session.id, encodeText(data)).catch(() => {})
    })

    // Output in. The listener is per-pane and filters by session id, so two
    // open tabs never bleed into one another.
    const unlistenData = listen<{ sessionId: string; data: string }>('ssh://data', (event) => {
      if (event.payload.sessionId !== session.id) return
      term.write(decodeBytes(event.payload.data))
    })

    const unlistenClosed = listen<{ sessionId: string; reason: string }>(
      'ssh://closed',
      (event) => {
        if (event.payload.sessionId !== session.id) return
        setSessionStatus(session.id, 'closed')
        term.write(`\r\n\x1b[38;5;245m— ${event.payload.reason} —\x1b[0m\r\n`)
      },
    )

    // Keep the PTY the same size as the pane, so full-screen programs line up.
    const applyFit = () => {
      try {
        fit.fit()
      } catch {
        return
      }
      setSize({ cols: term.cols, rows: term.rows })
      void sshResize(session.id, term.cols, term.rows).catch(() => {})
    }
    const observer = new ResizeObserver(applyFit)
    observer.observe(mount)
    applyFit()
    term.focus()

    return () => {
      typed.dispose()
      observer.disconnect()
      void unlistenData.then((un) => un())
      void unlistenClosed.then((un) => un())
      term.dispose()
      termRef.current = null
    }
  }, [session.id, setSessionStatus])

  // Connection failures are written into the terminal rather than a banner:
  // it is where the user is already looking, and the design has no error
  // surface for a session.
  useEffect(() => {
    if (session.status === 'error' && session.error && termRef.current) {
      termRef.current.write(`\r\n\x1b[31m${session.error}\x1b[0m\r\n`)
    }
  }, [session.status, session.error])

  const uptime = useUptime(session.info?.startedAt ?? null)

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-term">
      <div className="flex flex-none items-center gap-2.25 border-b border-w06 px-3.5 py-2 font-mono text-mono text-faint">
        <StatusDot
          tone={session.status === 'open' ? 'accent' : session.status === 'error' ? 'warn' : 'faint'}
          size="sm"
        />
        TERMINAL · {session.info?.user ?? '…'}@{session.name}
        <span className="ml-auto">
          {session.status === 'open'
            ? `${session.info?.serverKey ?? ''} · ${uptime}`
            : session.status === 'connecting'
              ? 'connecting…'
              : session.status === 'error'
                ? 'failed'
                : 'closed'}
        </span>
      </div>

      <div ref={mountRef} className="min-h-0 flex-1 overflow-hidden px-3.5 py-3" />

      <div className="flex flex-none gap-4.5 border-t border-w06 px-3.5 py-1.75 font-mono text-status text-term-dim">
        <span>utf-8</span>
        <span>
          {size.cols}×{size.rows}
        </span>
        <span className="ml-auto">Ctrl+Shift+T new tab · Ctrl+Shift+D split</span>
      </div>
    </div>
  )
}

/** `14m`, `2h 05m` — the uptime the design shows beside the key algorithm. */
function useUptime(startedAt: number | null): string {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (startedAt === null) return
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [startedAt])

  if (startedAt === null) return ''
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}
