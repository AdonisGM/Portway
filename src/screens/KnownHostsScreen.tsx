import { useEffect, useMemo, useState } from 'react'
import { message, type KnownHost } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Chip } from '@/components/ui/Chip'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { StatusDot } from '@/components/ui/primitives'
import { DataTable, type Column } from '@/components/layout/DataTable'
import {
  FooterBar,
  FooterRight,
  ScreenHeader,
  ScreenShell,
  ScreenTitle,
} from '@/components/layout/ScreenShell'
import { useApp } from '@/store/appStore'

/**
 * `~/.ssh/known_hosts`, as it is on disk.
 *
 * The design drew this screen with a `Verified` / `Trust new` pair, which the
 * file cannot support: it holds no timestamps and no notion of a key having
 * changed — every line in it is, by definition, a key that was trusted once.
 * What is real is shown instead, and the one thing the file cannot say is
 * answered from the audit trail: a server whose last connection was *refused*
 * is a server whose key no longer matches the line written here.
 *
 * That is also the only reason this screen can do anything. `ssh.rs` refuses a
 * changed key and tells the user to remove the old entry; until now there was
 * nowhere in the app to do that.
 */

/**
 * A row is a **line**, not a host. `web-01,10.20.4.11 ssh-ed25519 …` is one key
 * that two names answer to, and removing "one of them" would mean rewriting the
 * line — so both names are shown and Remove takes the pair.
 */
const names = (h: KnownHost) => (h.hashed ? 'hashed' : h.patterns.join(', '))

/**
 * danger — refused, or revoked by whoever issued it: do not connect
 * warn   — an algorithm or size not to be trusting new work to
 * accent — a saved server answers to this line
 * faint  — in the file, and nothing more to say about it
 */
function tone(h: KnownHost): 'danger' | 'warn' | 'accent' | 'faint' {
  if (h.changed || h.marker === '@revoked') return 'danger'
  if (h.weak) return 'warn'
  return h.usedBy > 0 ? 'accent' : 'faint'
}

export function KnownHostsScreen() {
  const knownHosts = useApp((s) => s.knownHosts)
  const loadKnownHosts = useApp((s) => s.loadKnownHosts)
  const removeKnownHost = useApp((s) => s.removeKnownHost)

  const [filter, setFilter] = useState('')
  const [pending, setPending] = useState<KnownHost | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // `ssh` on the command line appends to this file, so what was read at boot
  // may already be out of date by the time the screen is opened.
  useEffect(() => {
    void loadKnownHosts()
  }, [loadKnownHosts])

  const columns: Column<KnownHost>[] = useMemo(
    () => [
      { key: 'dot', render: (h) => <StatusDot tone={tone(h)} /> },
      {
        key: 'host',
        header: 'Host',
        className: 'flex min-w-0 items-baseline gap-1.75',
        render: (h) => (
          <>
            <span
              className={`cell-ellipsis font-mono text-cell ${h.hashed ? 'text-muted' : ''}`}
              title={h.hashed ? 'stored as an HMAC — the name cannot be read back' : names(h)}
            >
              {names(h)}
            </span>
            {/* `@cert-authority` means the line is not a host key at all but the
                authority that signs them — worth saying, since removing it
                invalidates every certificate it vouches for. */}
            {h.marker ? (
              <span className="flex-none font-mono text-label text-warn">{h.marker}</span>
            ) : null}
          </>
        ),
      },
      {
        key: 'type',
        header: 'Key type',
        // `ecdsa nistp256` is the longest of these and has to stay on one
        // line: wrapped, it makes its row taller than every other row, and a
        // table where the row height means nothing is harder to scan.
        className: 'font-mono text-meta whitespace-nowrap text-fg-2',
        render: (h) => h.kind ?? '—',
      },
      {
        key: 'fingerprint',
        header: 'Fingerprint',
        className: 'cell-ellipsis font-mono text-meta text-muted',
        render: (h) => h.fingerprint ?? 'will not parse',
      },
      {
        key: 'used',
        header: 'Used by',
        className: 'text-cell text-muted',
        render: (h) => (h.usedBy === 0 ? '—' : `${h.usedBy} ${h.usedBy === 1 ? 'server' : 'servers'}`),
      },
      {
        key: 'actions',
        className: 'flex items-center justify-end gap-2',
        render: (h) => (
          <>
            {h.changed ? (
              <span className="font-mono text-mono text-danger">key changed</span>
            ) : null}
            <Chip tone="danger" onClick={() => setPending(h)}>
              Remove
            </Chip>
          </>
        ),
      },
    ],
    [],
  )

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return knownHosts
    return knownHosts.filter((h) =>
      [names(h), h.kind ?? '', h.fingerprint ?? '', h.comment ?? '']
        .join(' ')
        .toLowerCase()
        .includes(needle),
    )
  }, [knownHosts, filter])

  const changed = knownHosts.filter((h) => h.changed).length

  const confirm = async () => {
    if (!pending) return
    setBusy(true)
    setError(null)
    try {
      await removeKnownHost(pending)
      setPending(null)
    } catch (e) {
      // The file moved underneath us. Say so, and re-read it — the line
      // numbers this screen aims with are all suspect now.
      setError(message(e))
      await loadKnownHosts()
    } finally {
      setBusy(false)
    }
  }

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
          <span className="ml-auto flex flex-none items-center gap-3">
            {changed > 0 ? (
              <span className="font-mono text-meta text-danger">
                {changed} host {changed === 1 ? 'key has' : 'keys have'} changed
              </span>
            ) : null}
            <Button variant="outline" onClick={() => void loadKnownHosts()}>
              Refresh
            </Button>
          </span>
        </ScreenHeader>
      }
      footer={
        <FooterBar>
          <span>
            {knownHosts.length} {knownHosts.length === 1 ? 'entry' : 'entries'}
            {rows.length !== knownHosts.length ? ` · ${rows.length} shown` : ''}
          </span>
          <FooterRight>~/.ssh/known_hosts</FooterRight>
        </FooterBar>
      }
      overlay={
        <ConfirmDialog
          open={pending !== null}
          title="Remove host key"
          confirmLabel={busy ? 'Removing…' : 'Remove'}
          onConfirm={() => void confirm()}
          onCancel={() => {
            setError(null)
            setPending(null)
          }}
          busy={busy}
        >
          <span className="font-mono text-fg">{pending ? names(pending) : ''}</span> will be
          removed from ~/.ssh/known_hosts.{' '}
          {pending?.changed
            ? 'The next connection records whatever key the server offers now, with nothing left to check it against — so confirm that key with whoever runs the server first.'
            : 'The next connection to it is a first sight again, and its key is recorded fresh.'}
          {pending && pending.patterns.length > 1 ? (
            <div className="mt-2 text-fg-2">
              One line, {pending.patterns.length} names — all of them go together.
            </div>
          ) : null}
          {error ? <div className="mt-2 font-mono text-mono text-warn">! {error}</div> : null}
        </ConfirmDialog>
      }
    >
      {knownHosts.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-cell text-muted">
          <span className="text-body text-fg-2">Nothing in ~/.ssh/known_hosts</span>
          <span>A server's key is written here the first time you connect to it.</span>
        </div>
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          gridTemplate="12px 1.6fr 108px 2fr 88px 168px"
          rowKey={(h) => `${h.line}`}
          emptyMessage="No entries match this filter."
        />
      )}
    </ScreenShell>
  )
}
