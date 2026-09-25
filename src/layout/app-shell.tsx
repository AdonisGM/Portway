import { PlaceholderScreen } from '../screens/placeholder'
import { Menu } from './menu'
import { Rail } from './rail'
import { Titlebar } from './titlebar'

/** App frame from the design: title bar on top, then rail | menu | content. */
export function AppShell() {
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
            <PlaceholderScreen />
          </main>
        </div>
      </div>
    </div>
  )
}
