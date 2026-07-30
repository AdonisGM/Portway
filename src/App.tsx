import { useEffect } from 'react'
import { TitleBar } from './components/chrome/TitleBar'
import { Sidebar } from './components/layout/Sidebar'
import { ServersScreen } from './screens/servers/ServersScreen'
import { SessionScreen } from './screens/session/SessionScreen'
import { ServerFormScreen } from './screens/form/ServerFormScreen'
import { KeysScreen } from './screens/KeysScreen'
import { TunnelsScreen } from './screens/TunnelsScreen'
import { KnownHostsScreen } from './screens/KnownHostsScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { revealApp } from './lib/splash'
import { useApp } from './store/appStore'

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
  const screen = useApp((s) => s.screen)
  const accent = useApp((s) => s.settings.accent)
  const loadHosts = useApp((s) => s.loadHosts)
  const loadKeys = useApp((s) => s.loadKeys)

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

  // Reveal the window as soon as the shell is painted. Deliberately not
  // waiting on loadHosts: the table has its own "loading hosts…" state, and
  // holding the window back for the database would make a fast start feel
  // slower than it is.
  useEffect(() => {
    revealApp()
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

  // One variable write repaints every accent surface in the app, because each
  // Tailwind utility compiles down to var(--color-accent).
  useEffect(() => {
    document.documentElement.style.setProperty('--color-accent', accent)
  }, [accent])

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
    </div>
  )
}
