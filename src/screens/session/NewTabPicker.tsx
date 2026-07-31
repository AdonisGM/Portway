import { useCallback, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Host } from '@/data/types'
import { GroupDot } from '@/components/ui/primitives'
import { useAnchoredPanel } from '@/components/ui/useAnchoredPanel'
import { useApp } from '@/store/appStore'

/**
 * The `+` beside the tabs: pick a host, get a tab.
 *
 * The handoff draws this button and then lists the picker among the things it
 * never designed, so the shape is ours. It is the same anchored panel the rest
 * of the app uses for popovers, with a filter box because the list is the whole
 * host table and typing is faster than scrolling once there are more than a
 * handful.
 *
 * Picking a host that already has a tab opens a *second* one rather than
 * switching to the first. That differs from the SSH button on purpose: that
 * button means "get me to this server", where reusing a live tab is the helpful
 * answer, while this one means "another tab", and a button labelled `+` that
 * sometimes adds nothing is a button that looks broken.
 */
const ROW_HEIGHT = 32

export function NewTabPicker({
  open,
  onClose,
  anchorRef,
}: {
  open: boolean
  onClose: () => void
  anchorRef: React.RefObject<HTMLButtonElement | null>
}) {
  const hosts = useApp((s) => s.hosts)
  const openSessionTab = useApp((s) => s.openSessionTab)
  const [query, setQuery] = useState('')

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return hosts
    return hosts.filter(
      (h) =>
        h.name.toLowerCase().includes(q) ||
        h.address.toLowerCase().includes(q) ||
        h.user.toLowerCase().includes(q),
    )
  }, [hosts, query])

  const dismiss = useCallback(() => {
    setQuery('')
    onClose()
  }, [onClose])

  const { panelRef, style } = useAnchoredPanel(
    open,
    anchorRef,
    {
      align: 'left',
      estimatedHeight: Math.min(matches.length * ROW_HEIGHT + 52, 300),
      onDismiss: dismiss,
    },
    [matches.length],
  )

  const pick = (host: Host) => {
    openSessionTab(host)
    dismiss()
  }

  if (!open) return null

  return createPortal(
    <div
      ref={panelRef}
      role="listbox"
      aria-label="Open a session"
      style={{ ...style, minWidth: 240 }}
      onKeyDown={(e) => e.key === 'Escape' && dismiss()}
      className="z-60 flex flex-col overflow-hidden rounded-field border border-w10 bg-drawer shadow-drawer"
    >
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search hosts…"
        aria-label="Search hosts"
        onKeyDown={(e) => {
          // Enter takes the first match, so a session is two keystrokes away
          // once you know the name.
          if (e.key === 'Enter' && matches[0]) pick(matches[0])
        }}
        className="flex-none border-b border-w06 bg-transparent px-2.5 py-2 text-body text-fg-2 placeholder:text-faint"
      />

      <div className="max-h-60 overflow-y-auto py-1">
        {matches.length === 0 ? (
          <div className="px-2.5 py-1.5 text-body text-muted">no host matches</div>
        ) : (
          matches.map((host) => (
            <button
              key={host.id}
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => pick(host)}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-body text-fg-2 transition-colors hover:bg-w07 hover:text-fg"
            >
              <GroupDot group={host.group} size="sm" />
              <span className="cell-ellipsis">{host.name}</span>
              <span className="ml-auto flex-none font-mono text-mono text-faint">
                {host.user}@{host.address}
              </span>
            </button>
          ))
        )}
      </div>
    </div>,
    document.body,
  )
}
