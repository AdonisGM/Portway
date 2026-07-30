import { Badge, StatusDot } from '@/components/ui/primitives'
import { useApp } from '@/store/appStore'
import { TerminalPane } from './TerminalPane'
import { SftpPane } from './SftpPane'

/** Terminal on the left, SFTP browser on the right, one tab per session. */
export function SessionScreen() {
  const sessions = useApp((s) => s.sessions)
  const hosts = useApp((s) => s.hosts)
  const tab = useApp((s) => s.tab)
  const goScreen = useApp((s) => s.goScreen)
  const activateTab = useApp((s) => s.activateTab)
  const closeTab = useApp((s) => s.closeTab)

  const active = sessions[tab]
  const host = hosts.find((h) => h.id === active?.hostId) ?? null

  // The host behind this tab was deleted while it was open.
  if (!host) {
    return (
      <div className="absolute inset-0 flex items-center justify-center font-mono text-mono text-faint">
        no session
      </div>
    )
  }

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex flex-none items-stretch border-b border-w06 bg-nav">
        <button
          type="button"
          onClick={() => goScreen('servers')}
          className="flex flex-none items-center border-r border-w06 px-3.25 font-mono text-cell text-muted transition-colors hover:text-fg"
        >
          ‹ hosts
        </button>

        {sessions.map((session, i) => (
          <div
            key={session.id}
            onClick={() => activateTab(i)}
            className={`flex cursor-pointer items-center gap-2 border-r border-w06 px-3.25 py-2.25 text-cell transition-colors ${
              i === tab ? 'bg-tab-active text-fg' : 'text-muted hover:text-fg-2'
            }`}
          >
            <StatusDot tone="accent" size="sm" />
            <span className="font-mono">{session.name}</span>
            {/* Always SSH now — SFTP shares the connection rather than being a
                session of its own. */}
            <Badge>SSH</Badge>
            <button
              type="button"
              aria-label={`Close ${session.name}`}
              onClick={(e) => {
                e.stopPropagation()
                closeTab(i)
              }}
              className="text-faint transition-colors hover:text-fg"
            >
              ×
            </button>
          </div>
        ))}

        {/* The new-session picker isn't designed yet — the button is present
            because the design has it, but it deliberately does nothing. */}
        <button
          type="button"
          aria-label="New session"
          className="flex items-center px-3 text-title text-faint transition-colors hover:text-fg"
        >
          +
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Keyed on the session so switching tabs gives each its own terminal
            instance rather than replaying one pane's scrollback into another. */}
        <TerminalPane key={active.id} session={active} />
        <SftpPane key={`${active.id}-sftp`} session={active} />
      </div>
    </div>
  )
}
