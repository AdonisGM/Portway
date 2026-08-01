import { useEffect, useRef, useState } from 'react'
import { Badge, StatusDot } from '@/components/ui/primitives'
import { useApp } from '@/store/appStore'
import { SessionPanes } from './SessionPanes'
import { NewTabPicker } from './NewTabPicker'
import { isMac } from '@/lib/platform'

/** The tabbed session view: one strip of tabs over the active session's panes. */
export function SessionScreen() {
  const plusRef = useRef<HTMLButtonElement>(null)
  const [picking, setPicking] = useState(false)

  /**
   * The shortcut the status bar has always advertised, finally bound. Captured
   * rather than bubbled: the terminal has focus most of the time this screen is
   * open, and xterm would otherwise be first to see the key.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const wanted = isMac ? e.metaKey && !e.shiftKey : e.ctrlKey && e.shiftKey
      if (!wanted || e.key.toLowerCase() !== 't') return
      e.preventDefault()
      setPicking(true)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  const sessions = useApp((s) => s.sessions)
  const hosts = useApp((s) => s.hosts)
  const tab = useApp((s) => s.tab)
  const goScreen = useApp((s) => s.goScreen)
  const activateTab = useApp((s) => s.activateTab)
  const closeTab = useApp((s) => s.closeTab)

  const active = sessions[tab]
  const host = hosts.find((h) => h.id === active?.hostId) ?? null

  // The host behind this tab was deleted while it was open.
  if (!host || !active) {
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

        {/* The handoff draws this button and lists its picker among the things
            it never designed, so the panel's shape is ours. */}
        <button
          ref={plusRef}
          type="button"
          aria-label="New session"
          aria-haspopup="listbox"
          aria-expanded={picking}
          onClick={() => setPicking((p) => !p)}
          className={`flex items-center px-3 text-title transition-colors ${
            picking ? 'text-fg' : 'text-faint hover:text-fg'
          }`}
        >
          +
        </button>
        <NewTabPicker open={picking} onClose={() => setPicking(false)} anchorRef={plusRef} />
      </div>

      <SessionPanes session={active} hint={`${isMac ? '⌘T' : 'Ctrl+Shift+T'} new tab`} />
    </div>
  )
}
