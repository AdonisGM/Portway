import { useMemo } from 'react'
import { groupCounts } from '@/data/groups'
import { AGENT_STATUS, KNOWN_HOSTS_TOTAL, SSH_KEYS, TUNNELS } from '@/data/mock'
import { GroupDot, SectionLabel, StatusDot } from '@/components/ui/primitives'
import { useApp, type Screen } from '@/store/appStore'

/**
 * Fixed 194px rail. Four blocks: nav list, Groups, the Sessions list pinned to
 * the bottom, and the agent footer. The brand row the mock draws at the top
 * (SSH Client.dc.html:35-38) now lives in the titlebar, so the nav list starts
 * here with a little air where the brand used to be.
 */
export function Sidebar() {
  const screen = useApp((s) => s.screen)
  const hosts = useApp((s) => s.hosts)
  const groupFilter = useApp((s) => s.groupFilter)
  const sessions = useApp((s) => s.sessions)
  const goScreen = useApp((s) => s.goScreen)
  const toggleGroup = useApp((s) => s.toggleGroup)
  const activateTab = useApp((s) => s.activateTab)

  // Counts follow the database, so creating or deleting a host moves them.
  const groups = useMemo(() => groupCounts(hosts), [hosts])

  const nav: { id: Screen; label: string; count: number | null }[] = [
    { id: 'servers', label: 'Servers', count: hosts.length },
    { id: 'keys', label: 'SSH Keys', count: SSH_KEYS.length },
    { id: 'tunnels', label: 'Tunnels', count: TUNNELS.filter((t) => t.state === 'active').length },
    { id: 'known', label: 'Known hosts', count: KNOWN_HOSTS_TOTAL },
    { id: 'settings', label: 'Settings', count: null },
  ]

  return (
    <nav className="flex w-nav flex-none flex-col border-r border-w06 bg-nav">
      <div className="flex flex-col gap-px px-2 pt-3">
        {nav.map((item) => {
          // Servers reads as active on the session and form screens too
          // (README line 120), since both are reached from it.
          const active =
            screen === item.id ||
            (item.id === 'servers' && (screen === 'session' || screen === 'form'))
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => goScreen(item.id)}
              className={`flex items-center justify-between rounded-nav px-2.25 py-1.75 text-body transition-colors ${
                active ? 'bg-w06 text-fg' : 'text-fg-2 hover:bg-w05'
              }`}
            >
              {item.label}
              {item.count !== null ? (
                <span className="font-mono text-mono text-faint">{item.count}</span>
              ) : null}
            </button>
          )
        })}
      </div>

      <SectionLabel className="px-4 pt-4.5 pb-1.5">Groups</SectionLabel>
      <div className="flex flex-col gap-px px-2">
        {groups.map((group) => (
          <button
            key={group.id}
            type="button"
            onClick={() => {
              toggleGroup(group.id)
              goScreen('servers')
            }}
            className={`flex items-center gap-2 rounded-nav px-2.25 py-1.5 text-cell transition-colors ${
              groupFilter === group.id ? 'bg-w06 text-fg' : 'text-fg-2 hover:bg-w05'
            }`}
          >
            <GroupDot group={group.id} size="sm" />
            {group.name}
            <span className="ml-auto font-mono text-mono text-faint">{group.count}</span>
          </button>
        ))}
      </div>

      <div className="mt-auto px-2 pb-2">
        {sessions.length > 0 ? (
          <SectionLabel className="px-2 pb-1.5">Sessions</SectionLabel>
        ) : null}
        {sessions.map((session, i) => (
          <button
            key={session.id}
            type="button"
            onClick={() => activateTab(i)}
            className="flex w-full items-center gap-1.75 rounded-nav px-2.25 py-1.25 font-mono text-meta text-fg-2 transition-colors hover:bg-w05 hover:text-fg"
          >
            <StatusDot tone="accent" size="xs" />
            <span className="cell-ellipsis">{session.name}</span>
            <span className="ml-auto flex-none text-label text-faint">SSH</span>
          </button>
        ))}
      </div>

      <div className="flex-none border-t border-w06 px-4 py-2.75 font-mono text-mono text-faint">
        {AGENT_STATUS}
      </div>
    </nav>
  )
}
