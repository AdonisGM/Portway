import { useEffect, useState } from 'react'
import type { Tunnel } from '@/lib/api'
import { message } from '@/lib/api'
import { tunnelForward } from '@/lib/command'
import { Button } from '@/components/ui/Button'
import { Chip } from '@/components/ui/Chip'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Segmented } from '@/components/ui/Segmented'
import { StatusDot } from '@/components/ui/primitives'
import { DataTable, type Column } from '@/components/layout/DataTable'
import {
  FooterBar,
  ScreenHeader,
  ScreenShell,
  ScreenSubtitle,
  ScreenTitle,
} from '@/components/layout/ScreenShell'
import { useApp } from '@/store/appStore'
import { TunnelForm } from './tunnels/TunnelForm'
import { TunnelMap } from './tunnels/TunnelMap'
import { useTunnelView } from './tunnels/useTunnelView'

/** What the design's `on session` / `on launch` / `manual` say in the table. */
const AUTOSTART_LABEL: Record<string, string> = {
  manual: 'manual',
  session: 'on session',
  launch: 'on launch',
}

export function TunnelsScreen() {
  const tunnels = useApp((s) => s.tunnels)
  const states = useApp((s) => s.tunnelStates)
  const hosts = useApp((s) => s.hosts)
  const loadTunnels = useApp((s) => s.loadTunnels)
  const create = useApp((s) => s.createTunnel)
  const update = useApp((s) => s.updateTunnel)
  const remove = useApp((s) => s.deleteTunnel)
  const start = useApp((s) => s.startTunnel)
  const stop = useApp((s) => s.stopTunnel)
  const check = useApp((s) => s.checkTunnel)

  const [editing, setEditing] = useState<{ tunnel: Tunnel | null } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Tunnel | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useTunnelView()
  /** One selection for both halves: a line and its row are the same tunnel. */
  const [selected, setSelected] = useState<number | null>(null)
  /** Which tunnel's far leg is being tested right now, so the chip can say so. */
  const [testing, setTesting] = useState<number | null>(null)

  useEffect(() => {
    void loadTunnels()
  }, [loadTunnels])

  const stateOf = (t: Tunnel) => states[t.id]?.state ?? 'idle'
  const active = tunnels.filter((t) => stateOf(t) === 'active').length

  // Whatever went wrong most recently, named by the tunnel it happened to. The
  // row can only hold a few words; the footer has the line for a sentence.
  const reported = (() => {
    const unhappy = tunnels.find((t) => states[t.id]?.error)
    return unhappy ? `${unhappy.label}: ${states[unhappy.id]?.error}` : null
  })()

  const columns: Column<Tunnel>[] = [
    { key: 'label', header: 'Label', className: 'cell-ellipsis', render: (t) => t.label },
    {
      key: 'kind',
      header: 'Type',
      className: 'font-mono text-mono text-fg-2',
      render: (t) => t.kind,
    },
    {
      key: 'forward',
      header: 'Forward',
      className: 'cell-ellipsis font-mono text-meta text-muted',
      render: (t) => tunnelForward(t),
    },
    {
      key: 'via',
      header: 'Via host',
      className: 'cell-ellipsis font-mono text-meta text-fg-2',
      render: (t) => t.via,
    },
    {
      key: 'auto',
      header: 'Autostart',
      className: 'text-cell text-muted',
      render: (t) => AUTOSTART_LABEL[t.autostart] ?? t.autostart,
    },
    {
      key: 'state',
      header: 'State',
      className: 'flex items-center gap-2 font-mono text-meta',
      render: (t) => {
        const state = stateOf(t)
        const failure = states[t.id]?.error ?? null
        // Red means one thing here and it is the thing you care about: it
        // cannot connect. Amber used to carry both that and "up but the far
        // leg refused", which are the same problem wearing two colours.
        const broken = state === 'error' || Boolean(failure)
        return (
          <>
            <StatusDot
              tone={broken ? 'danger' : state === 'active' ? 'accent' : 'faint'}
              size="sm"
            />
            {/* The reason lives in the title: a table cell cannot hold a
                sentence, and a state that only says "error" sends the user
                looking for it in a log the app does not show. */}
            <span
              title={failure ?? undefined}
              className={
                broken
                  ? 'cell-ellipsis text-danger-bright'
                  : state === 'active'
                    ? 'flex-none text-accent'
                    : 'flex-none text-faint'
              }
            >
              {/* Listening and refusing every connection looks exactly like
                  working until something says why. */}
              {broken ? (failure ?? 'error') : state}
            </span>
          </>
        )
      },
    },
    {
      key: 'actions',
      className:
        'flex justify-end gap-1.25 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100',
      render: (t) => {
        const state = stateOf(t)
        const running = state === 'active' || state === 'starting'
        return (
          <>
            <Chip
              tone="strong"
              onClick={(e) => {
                e.stopPropagation()
                setError(null)
                const action = running ? stop(t.id) : start(t.id)
                void action.catch((err) => setError(message(err)))
              }}
            >
              {running ? 'Stop' : 'Start'}
            </Chip>
            {/* Only while it is up, and only when there is one destination to
                test — a dynamic forward is told where to go per connection. */}
            {running && t.kind !== 'dynamic' ? (
              <Chip
                onClick={(e) => {
                  e.stopPropagation()
                  setError(null)
                  setTesting(t.id)
                  void check(t.id)
                    .catch((err) => setError(message(err)))
                    .finally(() => setTesting(null))
                }}
              >
                {testing === t.id ? 'Testing…' : 'Test'}
              </Chip>
            ) : null}
            <Chip
              onClick={(e) => {
                e.stopPropagation()
                setEditing({ tunnel: t })
              }}
            >
              Edit
            </Chip>
            <Chip
              tone="danger"
              onClick={(e) => {
                e.stopPropagation()
                setPendingDelete(t)
              }}
            >
              Del
            </Chip>
          </>
        )
      },
    },
  ]

  return (
    <ScreenShell
      header={
        <ScreenHeader>
          <ScreenTitle>Tunnels</ScreenTitle>
          <ScreenSubtitle>
            {active} active · {tunnels.length - active} idle
          </ScreenSubtitle>
          <Segmented
            className="ml-auto"
            aria-label="How to show the tunnels"
            options={[
              { value: 'map', label: 'Map' },
              { value: 'list', label: 'List' },
            ]}
            value={view}
            onChange={setView}
          />
          <Button
            variant="accent"
            disabled={hosts.length === 0}
            title={hosts.length === 0 ? 'Add a server first — a tunnel goes through one' : undefined}
            onClick={() => setEditing({ tunnel: null })}
          >
            New tunnel
          </Button>
        </ScreenHeader>
      }
      footer={
        <FooterBar>
          <span className="cell-ellipsis">
            {error ?? reported
              ? `! ${error ?? reported}`
              : 'a tunnel holds its own connection, so it keeps running with no session open'}
          </span>
        </FooterBar>
      }
    >
      {tunnels.length === 0 ? (
        <div className="flex flex-1 items-center justify-center font-mono text-mono text-faint">
          no tunnels yet
        </div>
      ) : (
        <>
          {view === 'map' ? (
            <TunnelMap
              tunnels={tunnels}
              states={states}
              hosts={hosts}
              selected={selected}
              onSelect={setSelected}
            />
          ) : null}

          {/* A sibling of the map, never inside it: the table has its own
              scrolling and its own selection, and a table that panned with the
              diagram would be unusable. In map view it is the shorter half. */}
          <div className={view === 'map' ? 'flex max-h-64 flex-none flex-col border-t border-w06' : 'flex flex-1 flex-col'}>
            <DataTable
              rows={tunnels}
              columns={columns}
              gridTemplate="1.2fr 78px 2fr 1.1fr 88px 130px 150px"
              rowKey={(t) => String(t.id)}
              density="relaxed"
              onRowClick={(t) => setSelected(t.id)}
              // Heavier than the table's shared `selected`, and with the accent
              // edge the design puts on it — this row is answering for a line
              // in the diagram above, so the two have to read as one thing.
              rowClassName={(t) =>
                t.id === selected ? 'bg-w10 shadow-[inset_3px_0_0_var(--color-accent)]' : ''
              }
            />
          </div>
        </>
      )}

      {editing ? (
        <TunnelForm
          tunnel={editing.tunnel}
          hosts={hosts}
          onCancel={() => setEditing(null)}
          onSave={async (input) => {
            if (editing.tunnel) await update(editing.tunnel.id, input)
            else await create(input)
            setEditing(null)
          }}
        />
      ) : null}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete tunnel"
        confirmLabel="Delete"
        confirmVariant="dangerSolid"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const target = pendingDelete
          setPendingDelete(null)
          if (target) void remove(target.id).catch((e) => setError(message(e)))
        }}
      >
        <span className="font-mono text-cell text-fg-2">{pendingDelete?.label}</span> and its
        forward are removed. Anything connected through it right now is dropped.
      </ConfirmDialog>
    </ScreenShell>
  )
}
