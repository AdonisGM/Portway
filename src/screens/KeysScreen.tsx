import { SSH_KEYS } from '@/data/mock'
import type { KeyStatus, SshKey } from '@/data/types'
import { Button } from '@/components/ui/Button'
import { Chip } from '@/components/ui/Chip'
import { StatusDot } from '@/components/ui/primitives'
import { DataTable, type Column } from '@/components/layout/DataTable'
import {
  FooterBar,
  FooterRight,
  ScreenHeader,
  ScreenShell,
  ScreenSubtitle,
  ScreenTitle,
} from '@/components/layout/ScreenShell'

/** accent = loaded in agent · warn = legacy/weak · faint = not loaded. */
const DOT: Record<KeyStatus, 'accent' | 'warn' | 'faint'> = {
  loaded: 'accent',
  legacy: 'warn',
  unloaded: 'faint',
}

const columns: Column<SshKey>[] = [
  { key: 'dot', render: (k) => <StatusDot tone={DOT[k.status]} /> },
  { key: 'name', header: 'Name', className: 'cell-ellipsis font-mono', render: (k) => k.name },
  { key: 'type', header: 'Type', className: 'font-mono text-meta text-fg-2', render: (k) => k.type },
  {
    key: 'fingerprint',
    header: 'Fingerprint',
    className: 'cell-ellipsis font-mono text-meta text-muted',
    render: (k) => k.fingerprint,
  },
  { key: 'used', header: 'Used by', className: 'text-fg-2', render: (k) => k.usedBy },
  { key: 'added', header: 'Added', className: 'text-cell text-muted', render: (k) => k.added },
  {
    key: 'actions',
    // Always visible: README only calls for hover-reveal on the Servers row.
    className: 'flex justify-end gap-1.25',
    render: () => (
      <>
        <Chip tone="strong">Copy pub</Chip>
        <Chip aria-label="More actions">···</Chip>
      </>
    ),
  },
]

export function KeysScreen() {
  // "3 loaded in agent" in the design counts the legacy key too — its amber dot
  // marks it as weak, not as missing from the agent. Only `unloaded` is out.
  const loaded = SSH_KEYS.filter((k) => k.status !== 'unloaded').length

  return (
    <ScreenShell
      header={
        <ScreenHeader>
          <ScreenTitle>SSH Keys</ScreenTitle>
          <ScreenSubtitle>
            {SSH_KEYS.length} keys · {loaded} loaded in agent
          </ScreenSubtitle>
          <span className="ml-auto flex gap-2">
            <Button variant="outline">Import…</Button>
            <Button variant="accent">Generate key</Button>
          </span>
        </ScreenHeader>
      }
      footer={
        <FooterBar>
          <span>private keys never leave this machine</span>
          <FooterRight>passphrases stored in the OS keychain</FooterRight>
        </FooterBar>
      }
    >
      <DataTable
        rows={SSH_KEYS}
        columns={columns}
        gridTemplate="12px 1.5fr 82px 1.6fr 90px 96px 118px"
        rowKey={(k) => k.name}
        density="relaxed"
      />
    </ScreenShell>
  )
}
