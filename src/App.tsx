import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { TitleBar } from './components/chrome/TitleBar'
import { DebugShortcut } from './components/debug/DebugShortcut'
import { Sidebar } from './components/layout/Sidebar'
import { ConfirmConnectDialog } from './screens/servers/ConfirmConnectDialog'
import { ServersScreen } from './screens/servers/ServersScreen'
import { SessionScreen } from './screens/session/SessionScreen'
import { ServerFormScreen } from './screens/form/ServerFormScreen'
import { KeysScreen } from './screens/KeysScreen'
import { TunnelsScreen } from './screens/TunnelsScreen'
import { KnownHostsScreen } from './screens/KnownHostsScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { revealApp } from './lib/splash'
import type { TunnelState } from './lib/api'
import { useApp } from './store/appStore'
import { useSettingsSync } from './store/useSettingsSync'

const SCREENS = {
  servers: ServersScreen,
  session: SessionScreen,
  form: ServerFormScreen,
  keys: KeysScreen,
  tunnels: TunnelsScreen,
  known: KnownHostsScreen,
  settings: SettingsScreen,
} as const

export default function App() {
  // Reveal the window once the preferences are in. Deliberately not waiting on
  // loadHosts: the table has its own "loading hosts…" state, and holding the
  // window back for the database would make a fast start feel slower than it
  // is. Settings are the exception, because they decide what the shell *looks*
  // like — revealed first, the window would appear in the default accent and
  // change colour a frame later. The read swallows its own failures, so this
  // cannot leave the window hidden; the 5s backstop in lib.rs is the second
  // guarantee it does not.
  useSettingsSync(revealApp)

  const screen = useApp((s) => s.screen)
  const loadHosts = useApp((s) => s.loadHosts)
  const loadKeys = useApp((s) => s.loadKeys)
  const loadKnownHosts = useApp((s) => s.loadKnownHosts)
  const loadTunnels = useApp((s) => s.loadTunnels)
  const setTunnelState = useApp((s) => s.setTunnelState)

  /**
   * No native context menu anywhere. A desktop app that pops up the webview's
   * "Reload / Inspect Element" menu on right-click reads as a web page in a
   * frame, and this app now has real menus of its own to put there instead.
   *
   * The terminal is the one place a right-click could have meant something —
   * some terminals paste on it — but xterm does not bind it, ours pastes with
   * the platform shortcut, and leaving one pane with the browser menu would be
   * stranger than having none.
   */
  useEffect(() => {
    const block = (e: MouseEvent) => e.preventDefault()
    document.addEventListener('contextmenu', block)
    return () => document.removeEventListener('contextmenu', block)
  }, [])

  // One read of the database on boot; every mutation afterwards patches the
  // store from the row the command returns, so there is no refetch loop.
  useEffect(() => {
    void loadHosts()
  }, [loadHosts])

  // Keys are read once too, but they are a directory and an agent rather than a
  // database — both can change while the app is open, so the Keys screen offers
  // a refresh rather than pretending this snapshot stays true.
  useEffect(() => {
    void loadKeys()
  }, [loadKeys])

  // Known hosts, for the same reason the tunnels are: the rail carries the
  // count, and a count that only becomes true once you visit the screen it
  // describes is worse than no count. `ssh` writes to this file too, so the
  // screen re-reads it on open and offers a Refresh.
  useEffect(() => {
    void loadKnownHosts()
  }, [loadKnownHosts])

  /**
   * Tunnels are read at boot rather than when the screen opens, because the
   * rail counts the running ones — a badge that only becomes true after you
   * visit the screen it is describing is worse than no badge.
   *
   * The listener is what keeps that count honest afterwards: a tunnel can come
   * up from autostart, or go down on its own, with nobody looking at it.
   */
  useEffect(() => {
    void loadTunnels()
    const pending = listen<TunnelState>('tunnel://state', (event) => setTunnelState(event.payload))
    return () => {
      void pending.then((un) => un())
    }
  }, [loadTunnels, setTunnelState])

  const Screen = SCREENS[screen]

  return (
    <div className="flex h-full flex-col bg-base text-fg">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        {/* Screens are absolutely positioned in here, so switching between
            them never reflows the shell (README line 32). */}
        <main className="relative min-w-0 flex-1 overflow-hidden">
          <Screen />
        </main>
      </div>
      {/* Here rather than on Servers, because a session can be opened from the
          session screen's `+` too — a confirmation that only exists on one
          screen would silently swallow the connection asked for on the other. */}
      <ConfirmConnectDialog />
      {/* ⌘⇧L, from anywhere, opens the log console in a window of its own —
          mounted here rather than added to the rail because it is a tool for
          when something is wrong, not a seventh screen. */}
      <DebugShortcut />
    </div>
  )
}
