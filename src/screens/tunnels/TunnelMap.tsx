import { useRef } from 'react'
import type { Tunnel, TunnelState } from '@/lib/api'
import { GroupDot } from '@/components/ui/primitives'
import type { Host } from '@/data/types'
import { mapLayout, type DestNode, type HostNode, type PortChip } from './layout'
import { useMapView } from './useMapView'

/**
 * What is forwarded where, drawn.
 *
 * The table below says the same things in words; this says them in one glance —
 * which of your machines are being reached, through which ports, and which of
 * those lines are carrying anything right now. The motion is the point: a
 * dashed line marching toward the far end is the difference between a diagram
 * of what *could* be forwarded and a picture of what is up.
 *
 * The diagram is laid out at its natural size by `layout.ts` and then moved and
 * scaled as a single stage. The toolbar and the legend sit outside that stage
 * on purpose — controls that shrink when you zoom out are controls you cannot
 * use to zoom back in.
 */

/** The dot grid's spacing at 100%. */
const GRID = 26

export function TunnelMap({
  tunnels,
  states,
  hosts,
  selected,
  onSelect,
}: {
  tunnels: Tunnel[]
  states: Record<number, TunnelState>
  hosts: Host[]
  selected: number | null
  onSelect: (id: number) => void
}) {
  const canvasRef = useRef<HTMLDivElement>(null)
  const layout = mapLayout(tunnels, states)
  const view = useMapView(canvasRef, layout.stage)

  return (
    <div
      ref={canvasRef}
      onMouseDown={view.onPointerDown}
      onWheel={view.onWheel}
      className={`relative min-h-map flex-1 overflow-hidden bg-map ${
        view.panning ? 'cursor-grabbing' : 'cursor-grab'
      }`}
    >
      {/* The grid scales and moves with the diagram rather than staying still
          behind it, which is what makes a zoom read as coming closer to
          something rather than the something growing. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-50"
        style={{
          backgroundImage: 'radial-gradient(var(--color-w09) 1px, transparent 1px)',
          backgroundSize: `${GRID * view.zoom}px ${GRID * view.zoom}px`,
          backgroundPosition: `${view.pan.x}px ${view.pan.y}px`,
        }}
      />

      <div
        className="pointer-events-none absolute top-0 left-0"
        style={{
          width: layout.stage.w,
          height: layout.stage.h,
          transform: `translate(${view.pan.x}px, ${view.pan.y}px) scale(${view.zoom})`,
          transformOrigin: '0 0',
        }}
      >
        <svg
          width={layout.stage.w}
          height={layout.stage.h}
          viewBox={`0 0 ${layout.stage.w} ${layout.stage.h}`}
          fill="none"
          className="absolute top-0 left-0"
        >
          {layout.edges.map((edge) => {
            const isSelected = edge.tunnelId === selected
            return (
              <g key={edge.key}>
                {/* Three paths on one geometry: a track so an idle line still
                    reads as a route, the line itself, and a fat transparent
                    one to click — a 2px stroke is not a target. */}
                <path d={edge.path} stroke="var(--color-w17)" strokeWidth={2} />
                <path
                  d={edge.path}
                  stroke={
                    // Red first, and on its own leg only. A forward whose SSH
                    // connection is perfect and whose destination refuses is
                    // one good hop and one bad one, and drawing the whole
                    // route as broken would send you looking in the wrong
                    // place.
                    edge.refused
                      ? 'var(--color-danger-bright)'
                      : edge.active
                        ? 'var(--color-accent)'
                        : isSelected
                          ? 'var(--color-fg-2)'
                          : 'var(--color-w24)'
                  }
                  strokeWidth={isSelected ? 3.4 : edge.refused || edge.active ? 2.4 : 2}
                  strokeLinecap="round"
                  strokeDasharray={edge.active ? '9 11' : edge.refused ? '3 5' : '6 7'}
                  className={edge.active ? 'tun-flow' : undefined}
                  style={
                    edge.active
                      ? { animation: `tun-flow ${1.15 + edge.delay * 0.2}s linear infinite` }
                      : undefined
                  }
                />
                <path
                  d={edge.path}
                  stroke="transparent"
                  strokeWidth={16}
                  style={{ pointerEvents: 'stroke' }}
                  className="cursor-pointer"
                  onClick={() => onSelect(edge.tunnelId)}
                />
              </g>
            )
          })}

          {/* The receiving end, breaking. Only on live lines — a halo on an
              idle port would say something is arriving there. */}
          {layout.edges
            .filter((e) => e.active)
            .map((edge) => (
              <circle
                key={`halo-${edge.key}`}
                cx={edge.endX}
                cy={edge.endY}
                r={6}
                fill="var(--color-accent)"
                className="tun-halo"
                style={{
                  transformOrigin: `${edge.endX}px ${edge.endY}px`,
                  animation: `tun-halo 1.9s ease-out ${edge.delay}s infinite`,
                }}
              />
            ))}

          {/* A refused hop is cut, in the middle of the leg that failed.
              Colour alone does not survive being glanced at, and neither end
              is free — both already carry a port chip. */}
          {layout.edges
            .filter((e) => e.refused)
            .map((edge) => (
              <g key={`x-${edge.key}`}>
                <circle cx={edge.midX} cy={edge.midY} r={9} fill="var(--color-map)" />
                <g
                  stroke="var(--color-danger-bright)"
                  strokeWidth={2}
                  strokeLinecap="round"
                >
                  <path d={`M${edge.midX - 4.5} ${edge.midY - 4.5} l 9 9`} />
                  <path d={`M${edge.midX + 4.5} ${edge.midY - 4.5} l -9 9`} />
                </g>
              </g>
            ))}
        </svg>

        <LocalNode layout={layout} />

        {layout.hosts.map((host) => (
          <HostCard key={host.key} host={host} hosts={hosts} />
        ))}

        {layout.dests.map((dest) => (
          <DestCard key={dest.key} dest={dest} />
        ))}

        {layout.chips.map((chip) => (
          <Chip key={chip.key} chip={chip} onSelect={onSelect} />
        ))}
      </div>

      <Toolbar view={view} />
      <Legend />
    </div>
  )
}

function LocalNode({ layout }: { layout: ReturnType<typeof mapLayout> }) {
  const { local } = layout
  return (
    <div
      style={{
        left: local.x,
        top: local.y,
        width: local.w,
        height: local.h,
        boxShadow: 'var(--shadow-node)',
      }}
      className="pointer-events-auto absolute box-border rounded-node border border-accent-27 bg-drawer px-4 py-3.75"
    >
      <div className="flex items-center gap-2.25">
        {/* A monitor, drawn here rather than fetched — the map is already
            carrying an SVG and one more shape costs nothing. */}
        <svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden>
          <rect
            x="2"
            y="3"
            width="12"
            height="8"
            rx="1.4"
            stroke="var(--color-accent)"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
          <path d="M5 13.4h6" stroke="var(--color-accent)" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
        <span className="text-body font-semibold">This machine</span>
      </div>

      <div className="mt-1.75 font-mono text-cell text-muted">localhost</div>

      <div className="mt-3.5 text-label tracking-label text-faint uppercase">Local ports</div>

      <div
        className={`mt-4 flex items-center gap-1.75 font-mono text-mono ${
          local.up > 0 ? 'text-accent' : 'text-faint'
        }`}
      >
        <span
          className={`size-1.5 flex-none rounded-chip ${
            local.up > 0 ? 'tun-pulse bg-accent' : 'bg-faint'
          }`}
          style={local.up > 0 ? { animation: 'tun-pulse 1.6s ease-in-out infinite' } : undefined}
        />
        {local.up} of {local.forwards} {local.forwards === 1 ? 'forward' : 'forwards'} up
      </div>
    </div>
  )
}

function HostCard({ host, hosts }: { host: HostNode; hosts: Host[] }) {
  const record = hosts.find((h) => h.id === host.hostId) ?? null

  return (
    <div
      style={{ left: host.x, top: host.y, width: host.w, height: host.h }}
      className={`pointer-events-auto absolute box-border rounded-node px-4 py-3.25 ${
        host.active
          ? 'border border-accent-27 bg-drawer'
          : 'border border-w24 border-dashed bg-panel'
      }`}
    >
      <div className="flex items-center gap-2.25">
        {record ? <GroupDot group={record.group} size="sm" /> : null}
        <span
          className={`cell-ellipsis text-body ${
            host.active ? 'font-semibold' : 'font-medium text-fg-2'
          }`}
        >
          {host.name}
        </span>
        <span
          className={`ml-auto flex-none font-mono text-mono ${
            host.active ? 'text-accent' : 'text-faint'
          }`}
        >
          {host.active ? 'active' : 'idle'}
        </span>
      </div>

      <div className="mt-1.75 cell-ellipsis font-mono text-cell text-muted">
        {record ? `${record.address} · ${record.user}` : '—'}
      </div>

      <div className="mt-2.25 font-mono text-mono text-faint">
        {host.tunnels === 1 ? '1 tunnel' : `${host.tunnels} tunnels`}
        {/* Says out loud what the middle column means: this box is not where
            the traffic stops, it is what carries it the rest of the way. */}
        {host.relaying ? ' · relaying' : ''}
      </div>
    </div>
  )
}

/**
 * A machine on the far side of a via host.
 *
 * Not a saved host and deliberately not drawn like one — there is no group, no
 * user, and nothing here has ever connected to it directly. All that is known
 * is the address, and whose eyes it was resolved through.
 */
function DestCard({ dest }: { dest: DestNode }) {
  return (
    <div
      style={{ left: dest.x, top: dest.y, width: dest.w, height: dest.h }}
      className={`pointer-events-auto absolute box-border rounded-node px-4 py-3.25 ${
        dest.refused
          ? 'border border-danger bg-panel'
          : dest.active
            ? 'border border-accent-27 bg-drawer'
            : 'border border-w24 border-dashed bg-panel'
      }`}
    >
      <div className="flex items-center gap-2.25">
        <span
          className={`size-1.75 flex-none rounded-chip ${
            dest.refused ? 'bg-danger-bright' : dest.active ? 'bg-accent' : 'bg-faint'
          }`}
        />
        <span
          className={`cell-ellipsis font-mono text-cell ${
            dest.active ? 'text-fg font-medium' : 'text-fg-2'
          }`}
        >
          {dest.address}
        </span>
        <span
          className={`ml-auto flex-none font-mono text-mono ${
            dest.refused ? 'text-danger-bright' : dest.active ? 'text-accent' : 'text-faint'
          }`}
        >
          {/* Four states, not three. "not tried" on a forward that is not even
              running would be a claim about a hop nothing has been in a
              position to attempt. */}
          {dest.refused ? 'refused' : dest.active ? 'reached' : dest.untried ? 'not tried' : 'idle'}
        </span>
      </div>

      <div className="mt-1.75 cell-ellipsis font-mono text-cell text-muted">via {dest.via}</div>

      <div className="mt-2.25 font-mono text-mono text-faint">
        {dest.tunnels === 1 ? '1 tunnel' : `${dest.tunnels} tunnels`}
      </div>
    </div>
  )
}

/**
 * A port, parked outside the card it belongs to.
 *
 * Never straddling the border: a chip half over the card sits on top of its
 * copy at some zoom levels and looks like a rendering fault at all of them.
 */
function Chip({ chip, onSelect }: { chip: PortChip; onSelect: (id: number) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(chip.tunnelId)}
      style={{
        left: chip.side === 'right' ? chip.x + 6 : chip.x - 6,
        top: chip.y,
        transform: chip.side === 'right' ? 'translate(0,-50%)' : 'translate(-100%,-50%)',
      }}
      className={`pointer-events-auto absolute z-10 flex items-center gap-1.25 rounded-chip border px-2 py-0.75 font-mono text-mono whitespace-nowrap ${
        chip.refused
          ? 'border-danger bg-drawer text-danger-bright'
          : chip.active
            ? 'border-accent-50 bg-drawer text-accent'
            : 'border-w14 bg-drawer text-muted'
      }`}
    >
      <span
        className={`size-1.25 flex-none rounded-chip ${
          chip.refused ? 'bg-danger-bright' : chip.active ? 'tun-pulse bg-accent' : 'bg-faint'
        }`}
        style={
          chip.active && !chip.refused
            ? { animation: 'tun-pulse 1.6s ease-in-out infinite' }
            : undefined
        }
      />
      {chip.label}
    </button>
  )
}

function Toolbar({ view }: { view: ReturnType<typeof useMapView> }) {
  return (
    <div className="absolute top-4 right-4 flex items-center gap-0.5 rounded-nav border border-w17 bg-base/90 p-1.25 shadow-drawer">
      <ToolButton label="Zoom out" onClick={view.zoomOut}>
        <path d="M3.5 7h7" />
      </ToolButton>
      {/* The percentage is also the reset: the one number on screen that says
          where you are is the obvious thing to press to go back. */}
      <button
        type="button"
        onClick={view.reset}
        title="Reset view"
        className="rounded-nav px-1.5 py-1 font-mono text-mono text-fg-2 transition-colors hover:bg-w13"
      >
        {Math.round(view.zoom * 100)}%
      </button>
      <ToolButton label="Zoom in" onClick={view.zoomIn}>
        <path d="M7 3.5v7M3.5 7h7" />
      </ToolButton>
      <span className="mx-0.5 h-4 w-px flex-none bg-w13" />
      <ToolButton label="Fit to screen" onClick={view.fit}>
        <path d="M2.5 5V2.5H5M9 2.5h2.5V5M11.5 9v2.5H9M5 11.5H2.5V9" />
      </ToolButton>
      <ToolButton label="Reset view" onClick={view.reset}>
        <path d="M11 7a4 4 0 1 1-1.2-2.9M11 2.4V5H8.4" />
      </ToolButton>
    </div>
  )
}

function ToolButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex size-7 flex-none items-center justify-center rounded-nav text-fg-2 transition-colors hover:bg-w13"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 14 14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        {children}
      </svg>
    </button>
  )
}

function Legend() {
  return (
    <div className="pointer-events-none absolute bottom-4 left-4 flex items-center gap-3.5 font-mono text-mono text-faint">
      <span className="flex items-center gap-1.75">
        <span className="h-0.5 w-4 flex-none rounded-bar bg-accent" />
        active
      </span>
      <span className="flex items-center gap-1.75">
        <span
          className="h-0.5 w-4 flex-none"
          style={{
            backgroundImage:
              'repeating-linear-gradient(to right, var(--color-w24) 0 4px, transparent 4px 7px)',
          }}
        />
        idle / not tried
      </span>
      <span className="flex items-center gap-1.75">
        <span
          className="h-0.5 w-4 flex-none"
          style={{
            backgroundImage:
              'repeating-linear-gradient(to right, var(--color-danger-bright) 0 3px, transparent 3px 6px)',
          }}
        />
        refused
      </span>
      <span>drag to move · scroll to zoom · click a line for its tunnel</span>
    </div>
  )
}
