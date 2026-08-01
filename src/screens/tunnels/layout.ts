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

/**
 * Card heights are what the card *says*, and nothing else.
 *
 * They used to grow with the port count, so nine forwards produced a box five
 * hundred pixels tall with a hundred pixels of text at the top and four hundred
 * of nothing under it. The ports need that vertical room; the card does not.
 * They are separated now: the card states what the machine is, and a rail
 * beside it carries the ports.
 */
const LOCAL_H = 150
const CARD_H = 96

/** How far the rail stands off the card, and how far past the end ports it runs. */
const RAIL_GAP = 26
const RAIL_CAP = 12

/**
 * Where the columns sit.
 *
 * Set by the *chips*, not the cards. Every line begins and ends on a port
 * label that hangs outside the card it belongs to, so the space a column needs
 * is a chip on each side plus enough curve between them to be followed by eye.
 * Columns placed by card width alone put one column's labels on top of the
 * next one's, which is not a tight layout — it is two labels in the same place.
 *
 * One position for the via column whether or not a third follows it, so adding
 * a forward to some other machine does not slide everything already on screen.
 */
const VIA_X = 620
const HOST_W = 252

const DEST_X = 1160
const DEST_W = 236

/** How far a chip floats off the edge it belongs to. */
const CHIP_GAP = 8

/**
 * A chip's width, from its label.
 *
 * The map has to know this because the lines start and end at the chip's outer
 * edge — not at the card's, which would run the line underneath its own label
 * for sixty pixels and make it look as though the line came out of the box and
 * the chip were sitting on top of it.
 *
 * Monospace, so the width is arithmetic rather than a measurement: 12.5px type
 * advances 6.6px a character, plus 8 of padding each side, a 5px dot, a 5px
 * gap, and the border. Two pixels of slack, because erring wide leaves an
 * invisible gap and erring narrow puts the line back under the label.
 */
const chipWidth = (label: string) => 30 + label.length * 6.6

/**
 * A card's own height, before its ports are counted.
 *
 * Measured against what it actually holds — heading 17, gap 7, address 18, gap
 * 9, footer line 16, and 13 of padding at each end — because the previous 88
 * was five short of that and the bottom line sat on the border. A box whose
 * content does not fit inside its own padding reads as a rendering fault, and
 * that is the one thing a diagram of your infrastructure must not look like.
 */
const HOST_GAP = 44

/**
 * Vertical distance between two ports on a card.
 *
 * A chip is 24px tall, so 30 left six pixels between one label and the next —
 * legible with three forwards and a wall of text with ten. These are set from
 * the chip rather than from the card: the card can always grow, and what makes
 * a busy map unreadable is labels touching, not boxes being large.
 */
const HOST_PITCH = 38

/** Same, on the local card, which has more room to spend. */
const PORT_PITCH = 46
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
  /** The card edge it hangs off. The chip itself is `CHIP_GAP` beyond it. */
  x: number
  y: number
  /** Which way it hangs off that edge. */
  side: 'right' | 'left'
  label: string
  /** Computed, so the lines can start where the chip stops. */
  w: number
  /** Shown on hover, for a label that is a word rather than a number. */
  hint?: string
  active: boolean
  /** Drawn in danger when the leg it belongs to has been refused. */
  refused: boolean
}

/**
 * Where a line meets a card that has no port to name there.
 *
 * A forward on its way *through* a via host arrives on one edge and leaves by
 * the other, and neither is a port anybody could write down — the outbound
 * socket the server opens is ephemeral. A small dot on the edge terminates the
 * line honestly: something arrives here, something leaves there. Without it the
 * line drives into the side of the box, which reads as the box being the
 * destination when it is the thing in the middle.
 */
export interface Connector {
  key: string
  tunnelId: number
  x: number
  y: number
  active: boolean
  refused: boolean
}

/**
 * The vertical bar the ports hang off, and the stub that joins it to its card.
 *
 * What it buys is a card that can stay the size of its own text while nine
 * forwards still get nine separate places to attach. It also says something
 * true that a tall empty box did not: these ports are all on *this* machine,
 * and they are one bus rather than nine independent things that happen to be
 * near each other.
 *
 * Only drawn when there are at least two ports. One port needs no bus, and a
 * rail through a single chip is a decoration.
 */
export interface Rail {
  key: string
  x: number
  /** The span the ports occupy, plus a cap at each end. */
  y1: number
  y2: number
  /** Where the stub meets the card, and which way it runs. */
  stubY: number
  stubFrom: number
  active: boolean
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
  dots: Connector[]
  rails: Rail[]
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
function ports(t: Tunnel): { here: string; there: string } {
  // A dynamic forward has no port on the far side and never will — each client
  // that connects names its own destination. It gets a label rather than
  // nothing, because a line ending in mid-air is not "there is no port here",
  // it is an unfinished drawing. `anywhere` is what is actually true.
  if (t.kind === 'dynamic') return { here: `:${t.bindPort}`, there: 'anywhere' }
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

  /**
   * The vertical room one card needs — its own height, or the room its ports
   * need, whichever is greater. The **card** is then drawn at its own fixed
   * height in the middle of that: several forwards through one server all
   * arriving at its midpoint would draw as one line, so the room has to exist,
   * but the box does not have to be the thing that provides it.
   */
  const slotH = (n: number, card: number, pitch: number) =>
    Math.max(card, (n - 1) * pitch + RAIL_CAP * 2 + 24)

  const localSlot = slotH(tunnels.length, LOCAL_H, PORT_PITCH)
  const hostSlots = byHost.map((h) => slotH(h.tunnels.length, CARD_H, HOST_PITCH))
  const destSlots = byDest.map((d) => slotH(d.tunnels.length, CARD_H, HOST_PITCH))

  const columnH = (slots: number[]) =>
    slots.reduce((sum, h) => sum + h, 0) + Math.max(0, slots.length - 1) * HOST_GAP

  const hostsH = columnH(hostSlots)
  const destsH = columnH(destSlots)

  const stageH = Math.max(localSlot, hostsH, destsH) + MARGIN * 2
  const stageW = (anyRelay ? DEST_X + DEST_W : VIA_X + HOST_W) + MARGIN

  const middle = (height: number) => MARGIN + (stageH - MARGIN * 2 - height) / 2

  const localSlotTop = middle(localSlot)
  const hostsTop = middle(hostsH)
  const destsTop = middle(destsH)

  const rails: Rail[] = []

  /**
   * Where a card's connections attach on one side.
   *
   * With a rail that is the rail; with one port it is the card edge itself,
   * because a bus for a single thing is a decoration.
   */
  const attach = (edge: number, count: number, out: boolean) =>
    count >= 2 ? edge + (out ? RAIL_GAP : -RAIL_GAP) : edge

  /** The rows a group of ports occupies on a card, centred as a block. */
  const rowsAround = (centre: number, count: number, pitch: number) =>
    Array.from({ length: count }, (_, i) => centre + (i - (count - 1) / 2) * pitch)

  /**
   * A rail spanning the rows given, joined to its card at `stubY`.
   *
   * Takes the actual rows rather than a count, because the ports on one side of
   * a card are not always all of them: the outgoing side of a relaying host
   * carries only the forwards that carry on, and those sit at *their* rows
   * among all the others.
   */
  const railFor = (
    key: string,
    edge: number,
    rows: number[],
    stubY: number,
    out: boolean,
    live: boolean,
  ) => {
    if (rows.length < 2) return
    rails.push({
      key,
      x: attach(edge, rows.length, out),
      y1: Math.min(...rows) - RAIL_CAP,
      y2: Math.max(...rows) + RAIL_CAP,
      stubY,
      stubFrom: edge,
      active: live,
    })
  }

  const localY = localSlotTop + (localSlot - LOCAL_H) / 2

  const local = {
    key: 'local',
    x: LOCAL_X,
    y: localY,
    w: LOCAL_W,
    h: LOCAL_H,
    active: tunnels.some(active),
    forwards: tunnels.length,
    up: tunnels.filter(active).length,
  }

  const localCentre = localSlotTop + localSlot / 2
  railFor(
    'rail-local',
    LOCAL_X + LOCAL_W,
    rowsAround(localCentre, tunnels.length, PORT_PITCH),
    localCentre,
    true,
    local.active,
  )
  const localAttach = attach(LOCAL_X + LOCAL_W, tunnels.length, true)

  /** Each card's slot centre, which is also the card's centre. */
  const hostCentres: number[] = []
  let stacked = hostsTop
  const hosts: HostNode[] = byHost.map((host, i) => {
    const centre = stacked + hostSlots[i] / 2
    hostCentres.push(centre)
    const node: HostNode = {
      key: `host-${host.name}`,
      name: host.name,
      hostId: host.hostId,
      tunnels: host.tunnels.length,
      x: VIA_X,
      y: centre - CARD_H / 2,
      w: HOST_W,
      h: CARD_H,
      active: host.tunnels.some(active),
      relaying: host.tunnels.some(relayed),
    }
    const rows = rowsAround(centre, host.tunnels.length, HOST_PITCH)
    railFor(`rail-in-${host.name}`, VIA_X, rows, centre, false, node.active)
    // The outgoing side carries only the forwards that carry on, at the rows
    // they already occupy among all the rest.
    railFor(
      `rail-out-${host.name}`,
      VIA_X + HOST_W,
      rows.filter((_, idx) => relayed(host.tunnels[idx])),
      centre,
      true,
      node.active,
    )
    stacked += hostSlots[i] + HOST_GAP
    return node
  })

  const destCentres: number[] = []
  let dstacked = destsTop
  const dests: DestNode[] = byDest.map((dest, i) => {
    const centre = dstacked + destSlots[i] / 2
    destCentres.push(centre)
    const node: DestNode = {
      key: `dest-${dest.address}`,
      address: dest.address,
      via: relayedBy(dest.tunnels),
      tunnels: dest.tunnels.length,
      x: DEST_X,
      y: centre - CARD_H / 2,
      w: DEST_W,
      h: CARD_H,
      active: dest.tunnels.some((t) => active(t) && reach(t) === true),
      refused: dest.tunnels.some((t) => reach(t) === false),
      untried: dest.tunnels.some((t) => active(t) && reach(t) === null),
    }
    railFor(
      `rail-dest-${dest.address}`,
      DEST_X,
      rowsAround(centre, dest.tunnels.length, HOST_PITCH),
      centre,
      false,
      node.active,
    )
    dstacked += destSlots[i] + HOST_GAP
    return node
  })

  /** Where a given tunnel attaches, counted within that card's own group. */
  const rowAt = (centre: number, group: Tunnel[] | undefined, tunnelId: number) => {
    if (!group) return centre
    const index = group.findIndex((t) => t.id === tunnelId)
    const offset = index - (group.length - 1) / 2
    return centre + offset * HOST_PITCH
  }

  // Ports are stacked in list order and centred as a block on the rail, so a
  // single forward sits on the card's midline rather than at its top.
  const portsTop =
    localSlotTop + localSlot / 2 - ((tunnels.length - 1) * PORT_PITCH) / 2

  const chips: PortChip[] = []
  const dots: Connector[] = []
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
    const viaGroup = byHost[hostIndex]?.tunnels
    const viaY = rowAt(hostCentres[hostIndex], viaGroup, tunnel.id)
    const viaIn = attach(host.x, viaGroup?.length ?? 1, false)
    const viaOut = attach(host.x + host.w, viaGroup?.filter(relayed).length ?? 0, true)
    const stagger = isActive ? (pulsing++ * 0.6) % 1.9 : 0

    const via = relayed(tunnel)
    const failed = reach(tunnel) === false
    const untried = isActive && reach(tunnel) === null

    chips.push({
      key: `here-${tunnel.id}`,
      tunnelId: tunnel.id,
      x: localAttach,
      y: hereY,
      side: 'right',
      label: here,
      w: chipWidth(here),
      active: isActive,
      refused: false,
    })
    /** Leg one leaves the label, not the card. */
    const fromX = localAttach + CHIP_GAP + chipWidth(here)

    // Where the far port is named: on the via card when the destination is
    // that server, on the destination card when it is a machine of its own.
    const farW = chipWidth(there)

    if (!via) {
      // Two columns: one hop, ending on the port it is aimed at.
      chips.push({
        key: `there-${tunnel.id}`,
        tunnelId: tunnel.id,
        x: viaIn,
        y: viaY,
        side: 'left',
        label: there,
        w: farW,
        hint:
          tunnel.kind === 'dynamic'
            ? 'A dynamic forward has no one destination — each client that connects names its own, and the server dials it.'
            : undefined,
        active: isActive && !failed,
        refused: failed,
      })
      const toX = viaIn - CHIP_GAP - farW
      edges.push({
        key: `a-${tunnel.id}`,
        tunnelId: tunnel.id,
        path: curve(fromX, hereY, toX, viaY),
        active: isActive,
        refused: false,
        untried: false,
        endX: toX,
        endY: viaY,
        midX: (fromX + toX) / 2,
        midY: (hereY + viaY) / 2,
        delay: stagger,
      })
      return
    }

    // Three columns. The via card is passed *through*, so both its edges get a
    // connector: the line arrives on one and leaves from the other rather than
    // disappearing into the box.
    const destIndex = byDest.findIndex((d) => d.address === (tunnel.targetHost ?? '').trim())
    const dest = dests[destIndex]
    if (!dest) return
    const destGroup = byDest[destIndex]?.tunnels
    const destY = rowAt(destCentres[destIndex], destGroup, tunnel.id)
    const destIn = attach(dest.x, destGroup?.length ?? 1, false)

    dots.push(
      {
        key: `in-${tunnel.id}`,
        tunnelId: tunnel.id,
        x: viaIn,
        y: viaY,
        active: isActive,
        refused: false,
      },
      {
        key: `out-${tunnel.id}`,
        tunnelId: tunnel.id,
        x: viaOut,
        y: viaY,
        active: isActive && !failed && !untried,
        refused: failed,
      },
    )

    edges.push({
      key: `a-${tunnel.id}`,
      tunnelId: tunnel.id,
      path: curve(fromX, hereY, viaIn, viaY),
      active: isActive,
      refused: false,
      untried: false,
      endX: viaIn,
      endY: viaY,
      midX: (fromX + viaIn) / 2,
      midY: (hereY + viaY) / 2,
      delay: stagger,
    })

    // Leg two: the hop the server makes on our behalf, and the one that can be
    // refused while everything else is fine.
    const toX = destIn - CHIP_GAP - farW
    edges.push({
      key: `b-${tunnel.id}`,
      tunnelId: tunnel.id,
      path: curve(viaOut, viaY, toX, destY),
      active: isActive && !failed && !untried,
      refused: failed,
      untried,
      endX: toX,
      endY: destY,
      midX: (viaOut + toX) / 2,
      midY: (viaY + destY) / 2,
      delay: stagger,
    })

    chips.push({
      key: `there-${tunnel.id}`,
      tunnelId: tunnel.id,
      x: destIn,
      y: destY,
      side: 'left',
      label: there,
      w: farW,
      active: isActive && !failed && !untried,
      refused: failed,
    })
  })

  return { stage: { w: stageW, h: stageH }, local, hosts, dests, chips, dots, rails, edges }
}
