import { TUNNELS } from '@/data/mock'
import type { Tunnel } from '@/data/types'
import { Button } from '@/components/ui/Button'
import { StatusDot } from '@/components/ui/primitives'
import { DataTable, type Column } from '@/components/layout/DataTable'
import {
  FooterBar,
  ScreenHeader,
  ScreenShell,
  ScreenSubtitle,
  ScreenTitle,
} from '@/components/layout/ScreenShell'

const columns: Column<Tunnel>[] = [
  { key: 'label', header: 'Label', className: 'cell-ellipsis', render: (t) => t.label },
  { key: 'type', header: 'Type', className: 'font-mono text-mono text-fg-2', render: (t) => t.type },
  {
    key: 'forward',
    header: 'Forward',
    className: 'cell-ellipsis font-mono text-meta text-muted',
    render: (t) => t.forward,
  },
  {
    key: 'via',
    header: 'Via host',
    className: 'cell-ellipsis font-mono text-meta text-fg-2',
    render: (t) => t.via,
  },
  { key: 'auto', header: 'Autostart', className: 'text-cell text-muted', render: (t) => t.autostart },
  {
    key: 'state',
    header: 'State',
    className: 'flex items-center gap-2 font-mono text-meta',
    render: (t) => (
      <>
        <StatusDot tone={t.state === 'active' ? 'accent' : 'faint'} size="sm" />
        <span className={t.state === 'active' ? 'text-accent' : 'text-faint'}>{t.state}</span>
      </>
    ),
  },
]

export function TunnelsScreen() {
  const active = TUNNELS.filter((t) => t.state === 'active').length

  return (
    <ScreenShell
      header={
        <ScreenHeader>
          <ScreenTitle>Tunnels</ScreenTitle>
          <ScreenSubtitle>
            {active} active · {TUNNELS.length - active} idle
          </ScreenSubtitle>
          <Button variant="accent" className="ml-auto">
            New tunnel
          </Button>
        </ScreenHeader>
      }
      footer={
        <FooterBar>
          <span>tunnels reopen automatically when their session reconnects</span>
        </FooterBar>
      }
    >
      <DataTable
        rows={TUNNELS}
        columns={columns}
        gridTemplate="1.2fr 78px 2fr 1.1fr 88px 96px"
        rowKey={(t) => t.label}
        density="relaxed"
      />
    </ScreenShell>
  )
}
