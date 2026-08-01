import { useEffect, useState } from 'react'
import type { Tunnel } from '@/lib/api'
import { message } from '@/lib/api'
import { tunnelForward } from '@/lib/command'
import { Button } from '@/components/ui/Button'
import { Chip } from '@/components/ui/Chip'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
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

  const [editing, setEditing] = useState<{ tunnel: Tunnel | null } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Tunnel | null>(null)
  const [error, setError] = useState<string | null>(null)

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
        return (
          <>
            <StatusDot
              tone={state === 'active' ? 'accent' : state === 'error' ? 'warn' : 'faint'}
              size="sm"
            />
            {/* The reason lives in the title: a table cell cannot hold a
                sentence, and a state that only says "error" sends the user
                looking for it in a log the app does not show. */}
            <span
              title={failure ?? undefined}
              className={
                state === 'active'
                  ? 'flex-none text-accent'
                  : state === 'error'
                    ? 'cell-ellipsis text-warn'
                    : 'flex-none text-faint'
              }
            >
              {state === 'error' ? (failure ?? 'error') : state}
            </span>
            {/* Listening and refusing every connection looks exactly like
                working until something says why. */}
            {state === 'active' && failure ? (
              <span className="cell-ellipsis text-warn" title={failure}>
                {failure}
              </span>
            ) : null}
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
          <Button
            variant="accent"
            className="ml-auto"
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
        <DataTable
          rows={tunnels}
          columns={columns}
          gridTemplate="1.2fr 78px 2fr 1.1fr 88px 130px 150px"
          rowKey={(t) => String(t.id)}
          density="relaxed"
        />
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
