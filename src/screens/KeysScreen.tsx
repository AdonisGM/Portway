import { useState } from 'react'
import type { KeyFile } from '@/lib/api'
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
import { useApp } from '@/store/appStore'

/**
 * The keys actually in `~/.ssh`, not a list of them.
 *
 * Everything here is read from the public half or the directory entry — type,
 * fingerprint and age — plus two live facts: whether a running ssh-agent is
 * holding the key, and how many saved hosts point at it. The private key is
 * never opened, which is what lets the footer keep its promise.
 */

/** accent = loaded in agent · warn = weak · faint = neither. */
function dotTone(key: KeyFile): 'accent' | 'warn' | 'faint' {
  if (key.weak) return 'warn'
  return key.inAgent ? 'accent' : 'faint'
}

/** `Mar 2026` — the design's Added column. */
function added(epochMs: number | null): string {
  if (epochMs === null) return '—'
  const d = new Date(epochMs)
  return `${d.toLocaleString('en', { month: 'short' })} ${d.getFullYear()}`
}

const columns: Column<KeyFile>[] = [
  { key: 'dot', render: (k) => <StatusDot tone={dotTone(k)} /> },
  { key: 'name', header: 'Name', className: 'cell-ellipsis font-mono', render: (k) => k.name },
  {
    key: 'type',
    header: 'Type',
    className: 'font-mono text-meta text-fg-2',
    // A key with no readable `.pub` has no knowable type: the answer is in the
    // private half, which this screen does not open.
    render: (k) => k.kind ?? '—',
  },
  {
    key: 'fingerprint',
    header: 'Fingerprint',
    className: 'cell-ellipsis font-mono text-meta text-muted',
    render: (k) => k.fingerprint ?? '—',
  },
  {
    key: 'used',
    header: 'Used by',
    className: 'text-fg-2',
    render: (k) => (k.usedBy === 0 ? '—' : `${k.usedBy} host${k.usedBy === 1 ? '' : 's'}`),
  },
  {
    key: 'added',
    header: 'Added',
    className: 'text-cell text-muted',
    render: (k) => added(k.addedAt),
  },
  {
    key: 'actions',
    // Always visible: README only calls for hover-reveal on the Servers row.
    className: 'flex justify-end gap-1.25',
    render: (k) => <CopyPub keyFile={k} />,
  },
]

/**
 * Copies the public half to the clipboard — the one thing you reliably want a
 * key row to do, since it is what goes into a server's `authorized_keys`.
 *
 * Reads the `.pub` through the same scan the table came from rather than a new
 * command: the fingerprint is already proof the file parsed.
 */
function CopyPub({ keyFile }: { keyFile: KeyFile }) {
  const [copied, setCopied] = useState(false)
  const copyPublicKey = useApp((s) => s.copyPublicKey)

  // Nothing to copy when there is no readable public half.
  if (!keyFile.fingerprint) return <Chip tone="strong">—</Chip>

  return (
    <Chip
      tone="strong"
      onClick={() => {
        void copyPublicKey(keyFile).then((ok) => {
          if (!ok) return
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1400)
        })
      }}
    >
      {copied ? 'Copied' : 'Copy pub'}
    </Chip>
  )
}

export function KeysScreen() {
  const keys = useApp((s) => s.keys)
  const loadKeys = useApp((s) => s.loadKeys)

  // Counted from agent membership itself. The dot is a different question —
  // a weak key still shows amber whether or not the agent holds it — so
  // deriving this from the dot would make the header disagree with the truth.
  const loaded = keys.filter((k) => k.inAgent).length

  return (
    <ScreenShell
      header={
        <ScreenHeader>
          <ScreenTitle>SSH Keys</ScreenTitle>
          <ScreenSubtitle>
            {keys.length} {keys.length === 1 ? 'key' : 'keys'} · {loaded} loaded in agent
          </ScreenSubtitle>
          <span className="ml-auto flex gap-2">
            {/* A directory and an agent both change behind the app's back, so
                re-reading them is an action rather than something to guess at. */}
            <Button variant="outline" onClick={() => void loadKeys()}>
              Refresh
            </Button>
          </span>
        </ScreenHeader>
      }
      footer={
        <FooterBar>
          <span>private keys never leave this machine</span>
          <FooterRight>read from ~/.ssh</FooterRight>
        </FooterBar>
      }
    >
      {keys.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-cell text-muted">
          <span className="text-body text-fg-2">No keys in ~/.ssh</span>
          <span>
            Portway lists private keys found there. Generate one with{' '}
            <code className="font-mono text-meta text-fg-2">ssh-keygen -t ed25519</code>.
          </span>
        </div>
      ) : (
        <DataTable
          rows={keys}
          columns={columns}
          gridTemplate="12px 1.5fr 82px 1.6fr 90px 96px 118px"
          rowKey={(k) => k.path}
          density="relaxed"
        />
      )}
    </ScreenShell>
  )
}
