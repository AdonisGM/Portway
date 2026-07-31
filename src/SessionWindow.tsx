import { useEffect, useState } from 'react'
import { TitleBar } from './components/chrome/TitleBar'
import { SessionScreen } from './screens/session/SessionScreen'
import { revealApp } from './lib/splash'
import { listHosts, message } from './lib/api'
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
 */
export default function SessionWindow({ hostId }: { hostId: number }) {
  const openSession = useApp((s) => s.openSession)
  const sessions = useApp((s) => s.sessions)
  const accent = useApp((s) => s.settings.accent)
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
        const host = hosts.find((h) => h.id === hostId)
        if (!host) return setError(`host ${hostId} no longer exists`)
        openSession(host)
      })
      .catch((e) => alive && setError(message(e)))
    return () => {
      alive = false
    }
  }, [hostId, openSession])

  return (
    <div className="flex h-full flex-col bg-base text-fg">
      {/* Same titlebar as the main window — on macOS it carries the inset that
          keeps the traffic lights off the content. */}
      <TitleBar />
      <main className="relative min-h-0 flex-1 overflow-hidden">
        {error ? (
          <div className="absolute inset-0 flex items-center justify-center font-mono text-mono text-warn">
            ! {error}
          </div>
        ) : sessions.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center font-mono text-mono text-faint">
            connecting…
          </div>
        ) : (
          <SessionScreen />
        )}
      </main>
    </div>
  )
}
