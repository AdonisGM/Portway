import { createContext, useContext, useState, type ReactNode } from 'react'
import { useConnections } from './connections'

export type RailId = 'conn' | 'server' | 'transfer' | 'tunnels'
export type ModuleId = 'overview' | 'files' | 'docker' | 'services' | 'firewall'
export type DockerView = 'containers' | 'compose' | 'images' | 'volumes'
export type ServicesView = 'services' | 'jobs'

export type Screen =
  | { kind: 'servers' }
  | { kind: 'keys' }
  | { kind: 'tunnels' }
  | { kind: 'transfer' }
  | { kind: 'server'; serverId: string; user: string; module: ModuleId }

export type Session = { serverId: string; user: string }

/** Where a pane of "Chuyển tệp" looks: this Mac or a server session, and the
 *  folder ('' = home). Kept here so the panes survive leaving the screen. */
export type PaneSource = { kind: 'local' } | { kind: 'remote'; serverId: string; user: string }
export type PaneSpot = { src: PaneSource; path: string }
export type PaneSide = 'L' | 'R'

type Nav = {
  screen: Screen
  rail: RailId
  sessions: Session[]
  /** Sub-view of the modules that have children in the menu. */
  dockerView: DockerView
  servicesView: ServicesView
  /** Menu groups (docker, services) that are expanded. */
  expanded: Partial<Record<ModuleId, boolean>>
  go: (screen: Screen) => void
  goRail: (rail: RailId) => void
  openModule: (module: ModuleId, sub?: { docker?: DockerView; services?: ServicesView }) => void
  toggleGroup: (module: ModuleId) => void
  /** Open (or switch to) a session for this server and user and connect it
   *  over SSH if it is not connected yet. */
  connect: (serverId: string, user: string) => void
  /** Open a session without leaving the current screen. */
  openSession: (serverId: string, user: string) => void
  closeSession: (s: Session) => void
  /** Close every session of a server, e.g. when it is deleted. */
  closeServer: (serverId: string) => void
  panes: Record<PaneSide, PaneSpot>
  setPane: (side: PaneSide, spot: PaneSpot) => void
  swapPanes: () => void
  /** Go to "Chuyển tệp" with the left pane on this spot. */
  openTransfer: (left: PaneSpot) => void
}

const NavContext = createContext<Nav | null>(null)

export const railOf = (s: Screen): RailId =>
  s.kind === 'server' ? 'server' : s.kind === 'tunnels' ? 'tunnels' : s.kind === 'transfer' ? 'transfer' : 'conn'

const LOCAL_DOWNLOADS: PaneSpot = { src: { kind: 'local' }, path: '~/Downloads' }
const sameSource = (a: PaneSource, b: PaneSource) =>
  a.kind === 'local' ? b.kind === 'local' : b.kind === 'remote' && a.serverId === b.serverId && a.user === b.user

export function NavProvider({ children }: { children: ReactNode }) {
  const conns = useConnections()
  const [screen, setScreen] = useState<Screen>({ kind: 'servers' })
  const [sessions, setSessions] = useState<Session[]>([])
  // The server session to return to when switching back to the server rail.
  const [lastServer, setLastServer] = useState<Extract<Screen, { kind: 'server' }> | null>(null)
  const [dockerView, setDockerView] = useState<DockerView>('containers')
  const [servicesView, setServicesView] = useState<ServicesView>('services')
  const [expanded, setExpanded] = useState<Nav['expanded']>({})
  const [panes, setPanes] = useState<Record<PaneSide, PaneSpot>>({ L: LOCAL_DOWNLOADS, R: LOCAL_DOWNLOADS })

  const go = (next: Screen) => {
    if (next.kind === 'server') setLastServer(next)
    setScreen(next)
  }

  const goRail = (rail: RailId) => {
    if (rail === 'conn') return go({ kind: 'servers' })
    if (rail === 'tunnels') return go({ kind: 'tunnels' })
    if (rail === 'transfer') return go({ kind: 'transfer' })
    // Server rail: back to the last session if it is still open, else the first one.
    const alive = lastServer && sessions.some((s) => s.serverId === lastServer.serverId && s.user === lastServer.user)
    if (alive) return go(lastServer)
    if (sessions[0]) return go({ kind: 'server', ...sessions[0], module: 'overview' })
    go({ kind: 'servers' })
  }

  const openModule: Nav['openModule'] = (module, sub) => {
    const base = screen.kind === 'server' ? screen : lastServer
    if (!base) return
    if (sub?.docker) setDockerView(sub.docker)
    if (sub?.services) setServicesView(sub.services)
    if (module === 'docker' || module === 'services') {
      setExpanded((e) => ({ ...e, [module]: true }))
    }
    go({ ...base, module })
  }

  const toggleGroup = (module: ModuleId) => setExpanded((e) => ({ ...e, [module]: !e[module] }))

  const openSession = (serverId: string, user: string) => {
    setSessions((list) => (list.some((s) => s.serverId === serverId && s.user === user) ? list : [...list, { serverId, user }]))
    const current = conns.get(serverId, user)
    if (!current || current.status === 'failed') void conns.connect(serverId, user)
  }

  const connect = (serverId: string, user: string) => {
    openSession(serverId, user)
    go({ kind: 'server', serverId, user, module: 'overview' })
  }

  const openTransfer = (left: PaneSpot) => {
    setPanes((p) => ({ L: left, R: sameSource(p.R.src, left.src) ? (sameSource(p.L.src, left.src) ? LOCAL_DOWNLOADS : p.L) : p.R }))
    go({ kind: 'transfer' })
  }

  const closeWhere = (drop: (s: Session) => boolean) => {
    for (const s of sessions.filter(drop)) void conns.disconnect(s.serverId, s.user)
    const rest = sessions.filter((s) => !drop(s))
    setSessions(rest)
    if (screen.kind !== 'server' || !drop(screen)) return
    const next = rest[rest.length - 1]
    if (next) go({ kind: 'server', ...next, module: screen.module })
    else go({ kind: 'servers' })
  }

  const closeSession = (target: Session) =>
    closeWhere((s) => s.serverId === target.serverId && s.user === target.user)

  const closeServer = (serverId: string) => closeWhere((s) => s.serverId === serverId)

  return (
    <NavContext.Provider
      value={{
        screen,
        rail: railOf(screen),
        sessions,
        dockerView,
        servicesView,
        expanded,
        go,
        goRail,
        openModule,
        toggleGroup,
        connect,
        openSession,
        closeSession,
        closeServer,
        panes,
        setPane: (side, spot) => setPanes((p) => ({ ...p, [side]: spot })),
        swapPanes: () => setPanes((p) => ({ L: p.R, R: p.L })),
        openTransfer,
      }}
    >
      {children}
    </NavContext.Provider>
  )
}

export function useNav() {
  const nav = useContext(NavContext)
  if (!nav) throw new Error('useNav must be used inside <NavProvider>')
  return nav
}
