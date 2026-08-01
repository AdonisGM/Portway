import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

import type { Session } from '@/data/types'
import { sshResize, sshWrite } from '@/lib/api'
import { encodeText } from '@/lib/bytes'
import { subscribe } from '@/lib/sshBus'
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

/**
 * `hint` is the keystroke the status bar advertises. It is passed in rather
 * than written here because it depends on what kind of window this is: a tab in
 * the main window can be joined by another, a session window cannot.
 */
export function TerminalPane({ session, hint }: { session: Session; hint?: string }) {
  const mountRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [size, setSize] = useState({ cols: 80, rows: 24 })
  const setSessionStatus = useApp((s) => s.setSessionStatus)

  // Selected one at a time rather than as one `settings` object: the store
  // hands back a new object on every change, so a single selector would
  // re-render this pane when an unrelated preference moved.
  const fontSize = useApp((s) => s.settings.fontSize)
  const cursorStyle = useApp((s) => s.settings.cursorStyle)
  const cursorBlink = useApp((s) => s.settings.cursorBlink)
  const scrollback = useApp((s) => s.settings.scrollback)
  const bell = useApp((s) => s.settings.bell)

  // The terminal is built once and then adjusted, so these are read through a
  // ref: putting them in the effect's dependencies would tear down the
  // terminal — and with it the scrollback and the shell's screen — every time
  // somebody nudged the font size.
  const initial = useRef({ fontSize, cursorStyle, cursorBlink, scrollback })

  // The bell is different: it is read at the moment one rings, not at build
  // time, so it stays current rather than fixed.
  const bellRef = useRef(bell)
  bellRef.current = bell

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const term = new Terminal({
      fontFamily: token('--font-mono', 'ui-monospace, monospace'),
      fontSize: initial.current.fontSize,
      // The handoff asks for two things a real terminal cannot both honour:
      // body text at 12px/1.75 *and* a 7×14px block cursor. A block cursor
      // fills its cell, so at 1.75 the cell is 21px and the cursor towers over
      // the text. 1.3 puts the cell at ~16px — near the 14px the design draws,
      // and still comfortably spaced.
      lineHeight: 1.3,
      cursorBlink: initial.current.cursorBlink,
      // `bar` would be the obvious choice, but the design draws a solid block —
      // which is the default, not the only option Settings offers.
      cursorStyle: initial.current.cursorStyle,
      scrollback: initial.current.scrollback,
      theme: {
        background: token('--color-term', '#121417'),
        foreground: token('--color-term-fg', '#ced4ce'),
        cursor: token('--color-accent', '#5ec8b0'),
        cursorAccent: token('--color-term', '#121417'),
        selectionBackground: token('--color-w15', '#ffffff26'),
        // The palette has to be given explicitly. Left out, every colour a
        // program emits renders as the plain foreground — `ls` loses its
        // directories, `git diff` loses its sides, and the pane looks like it
        // does not support colour at all.
        black: token('--color-ansi-black', '#484f58'),
        red: token('--color-ansi-red', '#e5534b'),
        green: token('--color-ansi-green', '#3fb950'),
        yellow: token('--color-ansi-yellow', '#d29922'),
        blue: token('--color-ansi-blue', '#58a6ff'),
        magenta: token('--color-ansi-magenta', '#bc8cff'),
        cyan: token('--color-ansi-cyan', '#39c5cf'),
        white: token('--color-ansi-white', '#ced4ce'),
        brightBlack: token('--color-ansi-bright-black', '#6e7681'),
        brightRed: token('--color-ansi-bright-red', '#ff7b72'),
        brightGreen: token('--color-ansi-bright-green', '#56d364'),
        brightYellow: token('--color-ansi-bright-yellow', '#e3b341'),
        brightBlue: token('--color-ansi-bright-blue', '#79c0ff'),
        brightMagenta: token('--color-ansi-bright-magenta', '#d2a8ff'),
        brightCyan: token('--color-ansi-bright-cyan', '#56d4dd'),
        brightWhite: token('--color-ansi-bright-white', '#f1f2f4'),
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(mount)
    termRef.current = term
    fitRef.current = fit

    // Keystrokes out.
    const typed = term.onData((data) => {
      void sshWrite(session.id, encodeText(data)).catch(() => {})
    })

    // Output in. Through the bus rather than a listener of its own, so the
    // greeting and prompt that arrive while this pane is still mounting are
    // waiting for it rather than lost — see lib/sshBus.ts.
    const unsubscribe = subscribe(session.id, {
      onData: (bytes) => term.write(bytes),
      onClosed: (reason) => {
        setSessionStatus(session.id, 'closed')
        term.write(`\r\n\x1b[38;5;245m— ${reason} —\x1b[0m\r\n`)
      },
    })

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

    // A bell is `\a` in the output stream. xterm has no sound of its own — the
    // audible bell went with v5 — so this is the visual one: the pane flashes
    // once. Reading the setting through the ref means turning it off takes
    // effect on the next bell rather than the next session.
    const rang = term.onBell(() => {
      if (!bellRef.current) return
      mount.classList.remove('term-bell')
      // Reading a layout property between the two is what makes a second bell
      // during the first one restart the animation instead of being swallowed.
      void mount.offsetWidth
      mount.classList.add('term-bell')
    })

    return () => {
      typed.dispose()
      rang.dispose()
      observer.disconnect()
      unsubscribe()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [session.id, setSessionStatus])

  /**
   * Preferences, applied to the terminal that is already running.
   *
   * A font size changes the cell size, which changes how many columns fit —
   * so the PTY has to be told, or a full-screen program keeps drawing to the
   * old width.
   */
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontSize = fontSize
    term.options.cursorStyle = cursorStyle
    term.options.cursorBlink = cursorBlink
    term.options.scrollback = scrollback
    try {
      fitRef.current?.fit()
    } catch {
      return
    }
    setSize({ cols: term.cols, rows: term.rows })
    void sshResize(session.id, term.cols, term.rows).catch(() => {})
  }, [fontSize, cursorStyle, cursorBlink, scrollback, session.id])

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

      {/* `relative` so the visual bell's overlay has something to fill. */}
      <div ref={mountRef} className="relative min-h-0 flex-1 overflow-hidden px-3.5 py-3" />

      <div className="flex flex-none gap-4.5 border-t border-w06 px-3.5 py-1.75 font-mono text-status text-term-dim">
        <span>utf-8</span>
        <span>
          {size.cols}×{size.rows}
        </span>
        {/* Only what is actually bound, spelled the way this platform spells
            it. It previously advertised a Windows chord on a Mac and a split
            that does not exist — a status bar promising keys that do nothing
            teaches the user their keyboard is broken. */}
        {hint ? <span className="ml-auto">{hint}</span> : null}
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
