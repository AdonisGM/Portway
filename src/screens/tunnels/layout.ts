import type { Tunnel, TunnelState } from '@/lib/api'
import type { TunnelRunState } from '@/data/types'

/**
 * Where everything on the map goes.
 *
 * The whole diagram is computed here and nowhere else knows a coordinate. The
 * handoff hand-places its four nodes and four curves, which is the right way to
 * draw a picture and the wrong way to draw someone's actual tunnels: the real
 * list is however many forwards through however many hosts, and it changes
 * whenever one is added. So the positions are derived instead, from one rule
 * per column, and the mock's proportions come out of the rule rather than being
 * copied off it.
 *
 * Two layers, not the mock's three. Its middle column is a bastion, and this
 * app stores `jumpHost` without ever connecting through one — a relay drawn
 * between two ends that talk directly would be a diagram of something that is
 * not happening.
 */

const LOCAL_X = 38
const LOCAL_W = 222
/** Enough for the heading, the address and the summary line. */
const LOCAL_MIN_H = 196

const HOST_X = 520
const HOST_W = 252
const HOST_MIN_H = 88
const HOST_GAP = 38
/** Vertical distance between two ports on a host card. */
const HOST_PITCH = 30

/** Vertical distance between two ports on the local card. */
const PORT_PITCH = 40
const MARGIN = 38

export interface MapNode {
  key: string
  x: number
  y: number
  w: number
  h: number
  active: boolean
}

export interface HostNode extends MapNode {
  /** The host's label, which is what `tunnel.via` carries. */
  name: string
  /** How many forwards ride this host, for the card's third line. */
  tunnels: number
  /** Set when every tunnel here agrees on one, so the dot can be coloured. */
  hostId: number
}

export interface PortChip {
  key: string
  tunnelId: number
  x: number
  y: number
  /** Which way it hangs off the card edge. */
  side: 'right' | 'left'
  label: string
  active: boolean
}

export interface MapEdge {
  tunnelId: number
  path: string
  active: boolean
  /** Where the halo breaks, on the receiving end. */
  endX: number
  endY: number
  /** Staggered so several active tunnels do not pulse in lockstep. */
  delay: number
}

export interface MapLayout {
  stage: { w: number; h: number }
  local: MapNode & { forwards: number; up: number }
  hosts: HostNode[]
  chips: PortChip[]
  edges: MapEdge[]
}

const stateOf = (t: Tunnel, states: Record<number, TunnelState>): TunnelRunState =>
  states[t.id]?.state ?? 'idle'

/**
 * Which port belongs at which end.
 *
 * The one place the map has to think, because the three kinds do not agree on
 * what "here" and "there" mean:
 *
 *   local    listen here on `bindPort`, the server connects to `targetPort`
 *   remote   the server listens on `bindPort`, we connect here to `targetPort`
 *   dynamic  listen here on `bindPort`, and there is no port on the far side —
 *            every client that connects names its own destination, so a chip
 *            there would have to invent one
 */
function ports(t: Tunnel): { here: string; there: string | null } {
  if (t.kind === 'dynamic') return { here: `:${t.bindPort}`, there: null }
  if (t.kind === 'remote') {
    return { here: `:${t.targetPort ?? '?'}`, there: `:${t.bindPort}` }
  }
  return { here: `:${t.bindPort}`, there: `:${t.targetPort ?? '?'}` }
}

export function mapLayout(
  tunnels: Tunnel[],
  states: Record<number, TunnelState>,
): MapLayout {
  const active = (t: Tunnel) => stateOf(t, states) === 'active'

  // One node per host that has a forward through it, in the order the tunnels
  // were created — the same order the list below is in, so the eye can move
  // between them.
  const byHost: { name: string; hostId: number; tunnels: Tunnel[] }[] = []
  for (const tunnel of tunnels) {
    const found = byHost.find((h) => h.name === tunnel.via)
    if (found) found.tunnels.push(tunnel)
    else byHost.push({ name: tunnel.via, hostId: tunnel.hostId, tunnels: [tunnel] })
  }

  // The local card grows with its ports rather than the ports spilling past it:
  // every chip is centred on a connection point, and a chip hanging off a card
  // it is taller than reads as belonging to nothing.
  const localH = Math.max(LOCAL_MIN_H, tunnels.length * PORT_PITCH + 72)
  // Each host card is as tall as its own ports need. Several forwards through
  // one server all arriving at its midpoint would draw as one line: the lines
  // would converge, the chips would stack, and a map whose whole job is showing
  // what goes where would hide exactly that.
  const hostHeights = byHost.map((h) => Math.max(HOST_MIN_H, h.tunnels.length * HOST_PITCH + 40))
  const hostsH =
    hostHeights.reduce((sum, h) => sum + h, 0) + Math.max(0, byHost.length - 1) * HOST_GAP

  const stageH = Math.max(localH, hostsH) + MARGIN * 2
  const stageW = HOST_X + HOST_W + MARGIN

  const localY = MARGIN + (stageH - MARGIN * 2 - localH) / 2
  const hostsTop = MARGIN + (stageH - MARGIN * 2 - hostsH) / 2

  const local = {
    key: 'local',
    x: LOCAL_X,
    y: localY,
    w: LOCAL_W,
    h: localH,
    active: tunnels.some(active),
    forwards: tunnels.length,
    up: tunnels.filter(active).length,
  }

  let stacked = hostsTop
  const hosts: HostNode[] = byHost.map((host, i) => {
    const node: HostNode = {
      key: `host-${host.name}`,
      name: host.name,
      hostId: host.hostId,
      tunnels: host.tunnels.length,
      x: HOST_X,
      y: stacked,
      w: HOST_W,
      h: hostHeights[i],
      active: host.tunnels.some(active),
    }
    stacked += hostHeights[i] + HOST_GAP
    return node
  })

  /** Where a given tunnel meets its host card, counted within that host. */
  const hostPort = (hostName: string, tunnelId: number): number => {
    const node = hosts.find((h) => h.name === hostName)
    const group = byHost.find((h) => h.name === hostName)
    if (!node || !group) return 0
    const index = group.tunnels.findIndex((t) => t.id === tunnelId)
    const centred = index - (group.tunnels.length - 1) / 2
    return node.y + node.h / 2 + centred * HOST_PITCH
  }

  // Ports on the local card are stacked in list order and centred as a block,
  // so a single forward sits on the card's midline rather than at its top.
  const portsTop = localY + (localH - tunnels.length * PORT_PITCH) / 2 + PORT_PITCH / 2

  const chips: PortChip[] = []
  const edges: MapEdge[] = []
  let pulsing = 0

  tunnels.forEach((tunnel, i) => {
    const isActive = active(tunnel)
    const { here, there } = ports(tunnel)
    const hereY = portsTop + i * PORT_PITCH
    const host = hosts.find((h) => h.name === tunnel.via)
    if (!host) return
    const thereY = hostPort(tunnel.via, tunnel.id)

    chips.push({
      key: `here-${tunnel.id}`,
      tunnelId: tunnel.id,
      x: local.x + local.w,
      y: hereY,
      side: 'right',
      label: here,
      active: isActive,
    })

    if (there !== null) {
      chips.push({
        key: `there-${tunnel.id}`,
        tunnelId: tunnel.id,
        x: host.x,
        y: thereY,
        side: 'left',
        label: there,
        active: isActive,
      })
    }

    // A horizontal ease between the two card edges. The handles are a fraction
    // of the span rather than a fixed distance, so the curve keeps its shape
    // whatever the columns end up being.
    const x1 = local.x + local.w
    const x2 = host.x
    const bend = (x2 - x1) * 0.38
    edges.push({
      tunnelId: tunnel.id,
      path: `M${x1} ${hereY} C ${x1 + bend} ${hereY}, ${x2 - bend} ${thereY}, ${x2} ${thereY}`,
      active: isActive,
      endX: x2,
      endY: thereY,
      delay: isActive ? (pulsing++ * 0.6) % 1.9 : 0,
    })
  })

  return { stage: { w: stageW, h: stageH }, local, hosts, chips, edges }
}
