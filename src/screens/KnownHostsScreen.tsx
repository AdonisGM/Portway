import { useMemo, useState } from 'react'
import { KNOWN_HOSTS, KNOWN_HOSTS_TOTAL } from '@/data/mock'
import type { KnownHost } from '@/data/types'
import { Chip } from '@/components/ui/Chip'
import { StatusDot } from '@/components/ui/primitives'
import { DataTable, type Column } from '@/components/layout/DataTable'
import {
  FooterBar,
  ScreenHeader,
  ScreenShell,
  ScreenTitle,
} from '@/components/layout/ScreenShell'

const columns: Column<KnownHost>[] = [
  { key: 'dot', render: (h) => <StatusDot tone={h.status === 'verified' ? 'accent' : 'warn'} /> },
  { key: 'host', header: 'Host', className: 'cell-ellipsis font-mono text-cell', render: (h) => h.host },
  { key: 'type', header: 'Key type', className: 'font-mono text-meta text-fg-2', render: (h) => h.type },
  {
    key: 'fingerprint',
    header: 'Fingerprint',
    className: 'cell-ellipsis font-mono text-meta text-muted',
    render: (h) => h.fingerprint,
  },
  { key: 'seen', header: 'First seen', className: 'text-cell text-muted', render: (h) => h.firstSeen },
  {
    key: 'actions',
    // Always visible — `Verified` / `Trust new` reads as status, not just an
    // action, so hiding it until hover would lose information.
    className: 'flex justify-end gap-1.25',
    render: (h) => (
      <>
        <Chip>{h.status === 'verified' ? 'Verified' : 'Trust new'}</Chip>
        <Chip tone="danger">Remove</Chip>
      </>
    ),
  },
]

export function KnownHostsScreen() {
  const [filter, setFilter] = useState('')

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return KNOWN_HOSTS
    return KNOWN_HOSTS.filter(
      (h) => h.host.includes(needle) || h.type.toLowerCase().includes(needle),
    )
  }, [filter])

  const changed = KNOWN_HOSTS.filter((h) => h.status === 'changed').length

  return (
    <ScreenShell
      header={
        <ScreenHeader>
          <ScreenTitle>Known hosts</ScreenTitle>
          <div className="flex max-w-70 flex-1 items-center gap-2 rounded-field border border-w07 bg-field px-2.5 py-1.25">
            <span aria-hidden className="font-mono text-cell text-faint">
              /
            </span>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter ~/.ssh/known_hosts"
              aria-label="Filter known hosts"
              className="min-w-0 flex-1 text-body placeholder:text-muted"
            />
          </div>
          {changed > 0 ? (
            <span className="ml-auto font-mono text-meta text-warn">
              {changed} host key changed
            </span>
          ) : null}
        </ScreenHeader>
      }
      footer={
        <FooterBar>
          <span>{KNOWN_HOSTS_TOTAL} entries · read directly from ~/.ssh/known_hosts</span>
        </FooterBar>
      }
    >
      <DataTable
        rows={rows}
        columns={columns}
        gridTemplate="12px 1.6fr 90px 2fr 100px 118px"
        rowKey={(h) => h.host}
        emptyMessage="No entries match this filter."
      />
    </ScreenShell>
  )
}
