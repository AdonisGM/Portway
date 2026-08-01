import { useEffect, useState } from 'react'
import { GROUP_NAMES } from '@/data/groups'
import type { Host } from '@/data/types'
import { hostLog, openSessionWindow, type LogEntry } from '@/lib/api'
import { ELSEWHERE_KEY, opensElsewhere, useOpensElsewhere } from '@/lib/platform'
import { hostCommand } from '@/lib/command'
import { relativeTime } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { Drawer } from '@/components/ui/Drawer'
import { CommandText, GroupDot, MetaRow, SectionLabel } from '@/components/ui/primitives'
import { useApp } from '@/store/appStore'

/**
 * The detail panel that slides over the Servers table. Transcribed from
 * SSH Client.dc.html:111-153 — header block, the SSH/SFTP pair, the secondary
 * action row, meta list, recent activity, tags, and the resolved command
 * pinned to the bottom.
 */
export function HostDrawer({ host }: { host: Host }) {
  const open = useApp((s) => s.drawer)
  const closeDrawer = useApp((s) => s.closeDrawer)
  const openSession = useApp((s) => s.openSession)
  const openEditForm = useApp((s) => s.openEditForm)
  const openDuplicateForm = useApp((s) => s.openDuplicateForm)
  const requestDelete = useApp((s) => s.requestDelete)
  const elsewhere = useOpensElsewhere()

  const isKey = host.auth === 'key'
  const authLabel =
    host.auth === 'key'
      ? `key · ${(host.keyPath ?? '').split('/').pop() || 'id_ed25519'}`
      : host.auth === 'agent'
        ? 'agent · ssh-agent'
        : 'password · keychain'

  return (
    <Drawer open={open} onClose={closeDrawer} label={`${host.name} details`}>
      <div className="flex-none border-b border-w06 px-4 pt-3.75 pb-3.5">
        <div className="flex items-center gap-2">
          <GroupDot group={host.group} />
          <span className="cell-ellipsis text-host font-semibold">{host.name}</span>
          <button
            type="button"
            aria-label="Close details"
            onClick={closeDrawer}
            className="ml-auto flex size-5.5 flex-none items-center justify-center rounded-nav bg-w05 text-muted transition-colors hover:bg-w12 hover:text-fg"
          >
            ×
          </button>
        </div>

        <div className="mt-1.5 font-mono text-cell text-muted">
          {host.user}@{host.address}:{host.port}
        </div>

        {/* The design puts SSH and SFTP side by side, but both panes ride one
            connection now, so a second button would open exactly the same
            session. The pair is kept for where the session lands instead: the
            wide half opens it here, the narrow one in a window of its own. */}
        <div className="mt-3.5 flex gap-1.5">
          <Button
            variant="accent"
            size="block"
            className="flex-1"
            onClick={(e) => {
              if (opensElsewhere(e)) return void openSessionWindow(host)
              openSession(host)
            }}
          >
            {/* Holding the modifier says so on the button rather than leaving
                the user to remember what it does — and the label is the only
                thing that changes, so the button does not resize under the
                pointer that is about to click it. */}
            {elsewhere ? 'New window' : 'SSH'}
          </Button>
          <Button
            size="block"
            className="w-auto flex-none px-3"
            aria-label="Open this session in a new window"
            title={`Open in a new window (${ELSEWHERE_KEY}-click SSH)`}
            onClick={() => void openSessionWindow(host)}
          >
            ↗
          </Button>
        </div>

        <div className="mt-2 flex gap-1.5">
          <Button size="row" className="flex-1" onClick={() => openEditForm(host)}>
            Edit
          </Button>
          <Button size="row" className="flex-1" onClick={() => openDuplicateForm(host)}>
            Duplicate
          </Button>
          {/* The design's third chip here was "Terminal…", and it is inert in
              the prototype too — the handoff draws it but never says what it
              does, and it is not in the list of things left undesigned either.
              Rather than invent a behaviour for it, it is dropped: a control
              that does nothing when pressed is worse than one that isn't
              there, and Edit and Duplicate get the width back. */}
          <Button
            variant="danger"
            size="row"
            className="flex-none"
            onClick={() => requestDelete(host)}
          >
            Del
          </Button>
        </div>
      </div>

      <div className="flex flex-none flex-col gap-2.25 border-b border-w06 px-4 py-3.5 text-cell">
        <MetaRow label="Auth">
          <span className="cell-ellipsis font-mono text-cell">{authLabel}</span>
        </MetaRow>
        <MetaRow label="Passphrase">
          <span className="font-mono text-cell">
            {isKey && host.unlockViaKeychain ? 'keychain' : '—'}
          </span>
        </MetaRow>
        <MetaRow label="Jump host">
          <span className="cell-ellipsis font-mono text-cell">{host.jumpHost ?? '—'}</span>
        </MetaRow>
        <MetaRow label="Agent forward">
          <span className="font-mono text-cell">{host.agentForwarding ? 'on' : 'off'}</span>
        </MetaRow>
        <MetaRow label="Group">
          <span>{GROUP_NAMES[host.group]}</span>
        </MetaRow>
        <MetaRow label="Last used">
          <span>{relativeTime(host.lastUsedAt)}</span>
        </MetaRow>
      </div>

      {host.runOnConnect ? (
        <div className="flex-none border-b border-w06 px-4 py-3.5">
          <SectionLabel className="mb-2">Run on connect</SectionLabel>
          <CommandText className="text-cell text-fg-2">{host.runOnConnect}</CommandText>
        </div>
      ) : null}

      <div className="flex-none border-b border-w06 px-4 py-3.5">
        <SectionLabel className="mb-2.25">Recent activity</SectionLabel>
        <RecentActivity hostId={host.id} open={open} />
      </div>

      <div className="flex-none px-4 py-3.5">
        <SectionLabel className="mb-2">Tags</SectionLabel>
        <div className="flex flex-wrap gap-1.5">
          <span className="rounded-chip bg-w06 px-2 py-0.75 font-mono text-mono text-fg-2">
            {host.group}
          </span>
        </div>
      </div>

      <CommandText className="mt-auto flex-none border-t border-w06 px-4 py-3 text-mono/code text-faint">
        $ {hostCommand(host)}
      </CommandText>
    </Drawer>
  )
}

/**
 * The last handful of audit entries for this host.
 *
 * The design draws this block with invented rows; these are the real ones, and
 * the `user`/`system` tint is the point — it shows at a glance which commands
 * the person ran and which Portway issued on their behalf. The full log needs
 * a screen of its own, which is not designed yet.
 */
function RecentActivity({ hostId, open }: { hostId: number; open: boolean }) {
  const [entries, setEntries] = useState<LogEntry[]>([])

  // Refetched each time the drawer opens, so it reflects the session that just
  // ran rather than whatever was true when the row was first rendered.
  useEffect(() => {
    if (!open) return
    let alive = true
    void hostLog(hostId, 6)
      .then((rows) => alive && setEntries(rows))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [hostId, open])

  if (entries.length === 0) {
    return <span className="font-mono text-cell text-faint">nothing recorded yet</span>
  }

  return (
    <div className="flex flex-col gap-1.75 text-cell">
      {entries.map((entry) => (
        <div key={entry.id} className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span
              className={`flex-none font-mono text-mono ${
                entry.origin === 'user' ? 'text-accent' : 'text-faint'
              }`}
              title={entry.origin === 'user' ? 'run by you' : 'run by Portway'}
            >
              {entry.origin === 'user' ? '›' : '⚙'}
            </span>
            <span className="cell-ellipsis font-mono text-fg-2">{entry.command}</span>
          </span>
          <span className="flex-none text-faint">{relativeTime(entry.createdAt)}</span>
        </div>
      ))}
    </div>
  )
}
