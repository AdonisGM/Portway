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
 * **Two layers or three, per tunnel.** A forward whose destination is the via
 * host itself — `127.0.0.1:5432` on that server, the commonest kind there is —
 * is two nodes and one hop, and drawing a third would invent a machine. A
 * forward to somewhere else is genuinely three: the via host *relays*, in code
 * you can point at (`channel_open_direct_tcpip` runs on the server), and the
 * two hops can fail independently. Those get a middle column and two lines.
 *
 * Not to be confused with the bastion column the handoff draws. That one is
 * still absent and still should be: `hosts.jump_host` is stored but `ssh.rs`
 * never implements ProxyJump, so a relay drawn *before* the via host would be a
 * hop that does not happen. The middle column here is the via host itself,
 * which is a different claim entirely — and a true one.
 *
 * Only `local` forwards get three columns. A remote forward's far end is this
 * machine, and the local card already carries its port; a node for it on the
 * right would be drawing the same machine twice. A dynamic forward has no fixed
 * destination at all.
 */

const LOCAL_X = 38
const LOCAL_W = 222
/** Enough for the heading, the address and the summary line. */
const LOCAL_MIN_H = 196

/**
 * Where the via column sits with and without a third column after it.
 *
 * The gaps are set by the *chips*, not the cards. Every column edge carries port
 * labels that hang outside it, so two columns 70px apart end up with the local
 * card's right-hand chips sitting on top of the via card's left-hand ones —
 * which is not a tight layout, it is two labels in the same place. Each gap
 * leaves room for a chip on both sides plus a length of curve between them.
 */
const VIA_X_TWO = 520
const VIA_X_THREE = 470
const HOST_W = 252

const DEST_X = 860
const DEST_W = 236

/**
 * A card's own height, before its ports are counted.
 *
 * Measured against what it actually holds — heading 17, gap 7, address 18, gap
 * 9, footer line 16, and 13 of padding at each end — because the previous 88
 * was five short of that and the bottom line sat on the border. A box whose
 * content does not fit inside its own padding reads as a rendering fault, and
 * that is the one thing a diagram of your infrastructure must not look like.
 */
const HOST_MIN_H = 96
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
  /** True when at least one forward through it carries on to somewhere else. */
  relaying: boolean
}

/** A machine that is only ever reached *through* a via host. */
export interface DestNode extends MapNode {
  /** The address as the via host resolves it — this is not a saved host. */
  address: string
  /** Which host relays to it. The useful second line: with two via hosts on
   *  screen, "reached through the server" does not say which server. */
  via: string
  tunnels: number
  /** Red when the hop to it has been refused. */
  refused: boolean
  /** Live, but nothing has been through yet — different from plain idle. */
  untried: boolean
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
  /** Drawn in danger when the leg it belongs to has been refused. */
  refused: boolean
}

/** One hop. A three-column tunnel has two of these; a two-column one, one. */
export interface MapEdge {
  key: string
  tunnelId: number
  path: string
  active: boolean
  /**
   * The far leg, refused. Only ever set on the hop that was actually refused —
   * which is the point of splitting the line in two: a forward whose SSH
   * connection is perfect and whose destination is unreachable should not draw
   * as one uniformly broken thing.
   */
  refused: boolean
  /** Live, but nothing has used this hop yet, so there is nothing to claim. */
  untried: boolean
  /** Where the halo breaks, on the receiving end. */
  endX: number
  endY: number
  /** The middle of the curve — where a break is marked, because both ends are
   *  already occupied by a port chip. */
  midX: number
  midY: number
  /** Staggered so several active tunnels do not pulse in lockstep. */
  delay: number
}

export interface MapLayout {
  stage: { w: number; h: number }
  local: MapNode & { forwards: number; up: number }
  hosts: HostNode[]
  dests: DestNode[]
  chips: PortChip[]
  edges: MapEdge[]
}

const stateOf = (t: Tunnel, states: Record<number, TunnelState>): TunnelRunState =>
  states[t.id]?.state ?? 'idle'

/** What a machine calls itself — so a forward to it is not a second machine. */
const LOOPBACK = ['127.0.0.1', 'localhost', '::1', '0.0.0.0', '']

/**
 * Whether this tunnel needs a third column.
 *
 * Only a local forward can: a remote one's far end is this machine, and a
 * dynamic one is told its destination per connection.
 */
export function relayed(t: Tunnel): boolean {
  return t.kind === 'local' && !LOOPBACK.includes((t.targetHost ?? '').trim())
}

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
 *
 * `there` hangs off the via card in a two-column tunnel and off the destination
 * card in a three-column one. Same port either way; it belongs to whichever
 * machine actually listens on it.
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
  const reach = (t: Tunnel) => states[t.id]?.reachable ?? null
  const anyRelay = tunnels.some(relayed)

  const VIA_X = anyRelay ? VIA_X_THREE : VIA_X_TWO

  // One node per host that has a forward through it, in the order the tunnels
  // were created — the same order the list below is in, so the eye can move
  // between them.
  const byHost: { name: string; hostId: number; tunnels: Tunnel[] }[] = []
  for (const tunnel of tunnels) {
    const found = byHost.find((h) => h.name === tunnel.via)
    if (found) found.tunnels.push(tunnel)
    else byHost.push({ name: tunnel.via, hostId: tunnel.hostId, tunnels: [tunnel] })
  }

  // And one per destination that is a machine of its own. Grouped by address,
  // so two forwards to the same box are two lines into one node rather than
  // two nodes with the same name.
  const byDest: { address: string; tunnels: Tunnel[] }[] = []
  for (const tunnel of tunnels.filter(relayed)) {
    const address = (tunnel.targetHost ?? '').trim()
    const found = byDest.find((d) => d.address === address)
    if (found) found.tunnels.push(tunnel)
    else byDest.push({ address, tunnels: [tunnel] })
  }

  /** The distinct via hosts that relay to one destination, as one phrase. */
  const relayedBy = (group: Tunnel[]) =>
    [...new Set(group.map((t) => t.via))].join(', ')

  // The local card grows with its ports rather than the ports spilling past it:
  // every chip is centred on a connection point, and a chip hanging off a card
  // it is taller than reads as belonging to nothing.
  const localH = Math.max(LOCAL_MIN_H, tunnels.length * PORT_PITCH + 72)

  // Each card is as tall as its own ports need. Several forwards through one
  // server all arriving at its midpoint would draw as one line: the lines would
  // converge, the chips would stack, and a map whose whole job is showing what
  // goes where would hide exactly that.
  const cardH = (n: number) => Math.max(HOST_MIN_H, n * HOST_PITCH + 44)
  const columnH = (counts: number[]) =>
    counts.reduce((sum, n) => sum + cardH(n), 0) + Math.max(0, counts.length - 1) * HOST_GAP

  const hostHeights = byHost.map((h) => cardH(h.tunnels.length))
  const destHeights = byDest.map((d) => cardH(d.tunnels.length))
  const hostsH = columnH(byHost.map((h) => h.tunnels.length))
  const destsH = columnH(byDest.map((d) => d.tunnels.length))

  const stageH = Math.max(localH, hostsH, destsH) + MARGIN * 2
  const stageW = (anyRelay ? DEST_X + DEST_W : VIA_X + HOST_W) + MARGIN

  const middle = (height: number) => MARGIN + (stageH - MARGIN * 2 - height) / 2

  const localY = middle(localH)
  const hostsTop = middle(hostsH)
  const destsTop = middle(destsH)

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
      x: VIA_X,
      y: stacked,
      w: HOST_W,
      h: hostHeights[i],
      active: host.tunnels.some(active),
      relaying: host.tunnels.some(relayed),
    }
    stacked += hostHeights[i] + HOST_GAP
    return node
  })

  let dstacked = destsTop
  const dests: DestNode[] = byDest.map((dest, i) => {
    const node: DestNode = {
      key: `dest-${dest.address}`,
      address: dest.address,
      via: relayedBy(dest.tunnels),
      tunnels: dest.tunnels.length,
      x: DEST_X,
      y: dstacked,
      w: DEST_W,
      h: destHeights[i],
      active: dest.tunnels.some((t) => active(t) && reach(t) === true),
      refused: dest.tunnels.some((t) => reach(t) === false),
      untried: dest.tunnels.some((t) => active(t) && reach(t) === null),
    }
    dstacked += destHeights[i] + HOST_GAP
    return node
  })

  /** Where a given tunnel meets a card, counted within that card's own group. */
  const rowOn = (node: MapNode | undefined, group: Tunnel[] | undefined, tunnelId: number) => {
    if (!node || !group) return 0
    const index = group.findIndex((t) => t.id === tunnelId)
    const centred = index - (group.length - 1) / 2
    return node.y + node.h / 2 + centred * HOST_PITCH
  }

  // Ports on the local card are stacked in list order and centred as a block,
  // so a single forward sits on the card's midline rather than at its top.
  const portsTop = localY + (localH - tunnels.length * PORT_PITCH) / 2 + PORT_PITCH / 2

  const chips: PortChip[] = []
  const edges: MapEdge[] = []
  let pulsing = 0

  /** A horizontal ease between two card edges, its handles a share of the span
   *  so the curve keeps its shape whatever the columns end up being. */
  const curve = (x1: number, y1: number, x2: number, y2: number) => {
    const bend = (x2 - x1) * 0.38
    return `M${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`
  }

  tunnels.forEach((tunnel, i) => {
    const isActive = active(tunnel)
    const { here, there } = ports(tunnel)
    const hereY = portsTop + i * PORT_PITCH
    const hostIndex = byHost.findIndex((h) => h.name === tunnel.via)
    const host = hosts[hostIndex]
    if (!host) return
    const viaY = rowOn(host, byHost[hostIndex]?.tunnels, tunnel.id)
    const stagger = isActive ? (pulsing++ * 0.6) % 1.9 : 0

    chips.push({
      key: `here-${tunnel.id}`,
      tunnelId: tunnel.id,
      x: local.x + local.w,
      y: hereY,
      side: 'right',
      label: here,
      active: isActive,
      refused: false,
    })

    const via = relayed(tunnel)
    const failed = reach(tunnel) === false
    const untried = isActive && reach(tunnel) === null

    // Leg one: this machine to the via host. Up whenever the tunnel is up —
    // the SSH connection is what `active` means.
    edges.push({
      key: `a-${tunnel.id}`,
      tunnelId: tunnel.id,
      path: curve(local.x + local.w, hereY, host.x, viaY),
      active: isActive,
      refused: false,
      untried: false,
      endX: host.x,
      endY: viaY,
      midX: (local.x + local.w + host.x) / 2,
      midY: (hereY + viaY) / 2,
      delay: stagger,
    })

    if (!via) {
      // Two columns: the destination port belongs to the via host, so its chip
      // hangs off that card and the line ends there.
      if (there !== null) {
        chips.push({
          key: `there-${tunnel.id}`,
          tunnelId: tunnel.id,
          x: host.x,
          y: viaY,
          side: 'left',
          label: there,
          active: isActive && !failed,
          refused: failed,
        })
      }
      return
    }

    // Three columns: leg two, the hop the server makes on our behalf. This is
    // the one that can be refused while everything else is fine.
    const destIndex = byDest.findIndex((d) => d.address === (tunnel.targetHost ?? '').trim())
    const dest = dests[destIndex]
    if (!dest) return
    const destY = rowOn(dest, byDest[destIndex]?.tunnels, tunnel.id)

    edges.push({
      key: `b-${tunnel.id}`,
      tunnelId: tunnel.id,
      path: curve(host.x + host.w, viaY, dest.x, destY),
      active: isActive && !failed && !untried,
      refused: failed,
      untried,
      endX: dest.x,
      endY: destY,
      midX: (host.x + host.w + dest.x) / 2,
      midY: (viaY + destY) / 2,
      delay: stagger,
    })

    if (there !== null) {
      chips.push({
        key: `there-${tunnel.id}`,
        tunnelId: tunnel.id,
        x: dest.x,
        y: destY,
        side: 'left',
        label: there,
        active: isActive && !failed && !untried,
        refused: failed,
      })
    }
  })

  return { stage: { w: stageW, h: stageH }, local, hosts, dests, chips, edges }
}
