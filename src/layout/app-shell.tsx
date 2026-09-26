import { useNav } from '../app/nav'
import { KeyListScreen } from '../screens/keys/key-list'
import { ServerScreen } from '../screens/server/server-screen'
import { ServerListScreen } from '../screens/servers/server-list'
import { SettingsScreen } from '../screens/settings/settings-screen'
import { TransferScreen } from '../screens/transfer/transfer-screen'
import { TunnelsScreen } from '../screens/tunnels/tunnels-screen'
import { Menu } from './menu'
import { Rail } from './rail'
import { Titlebar } from './titlebar'

/** App frame from the design: title bar on top, then rail | menu | content. */
export function AppShell() {
  const { screen } = useNav()
  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg text-[12.5px] text-ink">
      <Titlebar />
      <div className="flex min-h-0 flex-1">
        <Rail />
        <Menu />
        {/* Only the main content area has the grain background; the title bar,
            rail and menu stay flat. The grain sits behind the scrolling content. */}
        <div className="relative min-w-0 flex-1">
          <div className="grain pointer-events-none absolute inset-0" style={{ opacity: 'var(--grain)' }} />
          <main className="relative flex h-full flex-col gap-4 overflow-auto px-6 pt-5 pb-10">
            {screen.kind === 'servers' ? (
              <ServerListScreen />
            ) : screen.kind === 'keys' ? (
              <KeyListScreen />
            ) : screen.kind === 'server' ? (
              // One instance per session: switching user must not show the
              // previous user's numbers while the new ones load.
              <ServerScreen key={`${screen.serverId}|${screen.user}`} serverId={screen.serverId} user={screen.user} module={screen.module} />
            ) : screen.kind === 'transfer' ? (
              <TransferScreen />
            ) : screen.kind === 'settings' ? (
              <SettingsScreen />
            ) : (
              <TunnelsScreen />
            )}
          </main>
        </div>
      </div>
    </div>
  )
}
