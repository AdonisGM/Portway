import { useEffect, useState } from 'react'
import { TitleBar } from './components/chrome/TitleBar'
import { DebugShortcut } from './components/debug/DebugShortcut'
import { Badge, StatusDot } from './components/ui/primitives'
import { SessionPanes } from './screens/session/SessionPanes'
import { revealApp } from './lib/splash'
import { listHosts, message } from './lib/api'
import { isMac } from './lib/platform'
import type { Host } from './data/types'
import { useApp } from './store/appStore'

/**
 * One session, in a window of its own.
 *
 * This is a *second copy of the app* — a separate webview with its own module
 * instances and its own store — not a view inside the main window. What it
 * shares is the Rust process, which is where the connection actually lives, so
 * two windows talking to the same backend need no coordination between them.
 *
 * It connects for itself rather than being handed a live session, because
 * `ssh_connect` records the window that invoked it and routes that session's
 * output there. Connecting from the window that will display it is what makes
 * that true without a session-to-window map anywhere.
 *
 * There is no tab strip here, on purpose. This window *is* the session, so a
 * strip would be a row of chrome with one permanent tab in it, a close button
 * that duplicates the window's own, and a `‹ hosts` link to a screen this
 * window does not have. What that strip was actually telling you — which server
 * this is — moves up into the titlebar, where a window's identity belongs.
 */
export default function SessionWindow({ hostId }: { hostId: number }) {
  const openSession = useApp((s) => s.openSession)
  const sessions = useApp((s) => s.sessions)
  const accent = useApp((s) => s.settings.accent)
  const [host, setHost] = useState<Host | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    revealApp()
  }, [])

  useEffect(() => {
    document.documentElement.style.setProperty('--color-accent', accent)
  }, [accent])

  // Deliberately not `loadHosts` into the store: this window draws no host
  // list, and the one row it needs is fetched for the connection alone.
  useEffect(() => {
    let alive = true
    void listHosts()
      .then((hosts) => {
        if (!alive) return
        const match = hosts.find((h) => h.id === hostId)
        if (!match) return setError(`host ${hostId} no longer exists`)
        setHost(match)
        openSession(match)
      })
      .catch((e) => alive && setError(message(e)))
    return () => {
      alive = false
    }
  }, [hostId, openSession])

  const session = sessions[0] ?? null

  return (
    <div className="flex h-full flex-col bg-base text-fg">
      {/* Same titlebar as the main window — on macOS it carries the inset that
          keeps the traffic lights off the content — but carrying this window's
          subject, which is the one connection it holds. */}
      <TitleBar
        subject={
          host && (
            <>
              <StatusDot
                tone={
                  session?.status === 'open'
                    ? 'accent'
                    : session?.status === 'error'
                      ? 'warn'
                      : 'faint'
                }
                size="sm"
              />
              <span className="cell-ellipsis text-body font-semibold">{host.name}</span>
              <span className="cell-ellipsis font-mono text-cell text-muted">
                {host.user}@{host.address}:{host.port}
              </span>
              <Badge>SSH</Badge>
            </>
          )
        }
      />

      <main className="relative min-h-0 flex-1 overflow-hidden">
        {error ? (
          <div className="absolute inset-0 flex items-center justify-center font-mono text-mono text-warn">
            ! {error}
          </div>
        ) : !session ? (
          <div className="absolute inset-0 flex items-center justify-center font-mono text-mono text-faint">
            connecting…
          </div>
        ) : (
          <div className="absolute inset-0 flex flex-col">
            {/* ⌘W comes from Tauri's default macOS menu and closes this window,
                which is now the same thing as ending the session. Windows gets
                no equivalent on purpose: it has no such menu, and Ctrl-W is
                delete-word-backwards in every shell — binding it would break a
                keystroke people use constantly to advertise one they don't. */}
            <SessionPanes session={session} hint={isMac ? '⌘W close window' : undefined} />
          </div>
        )}
      </main>
      {/* The same chord as the main window. This is the window where most of
          what the console shows actually happens. */}
      <DebugShortcut />
    </div>
  )
}
