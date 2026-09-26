import { createContext, useContext, useState, type ReactNode } from 'react'
import { useConnections } from './connections'

export type RailId = 'conn' | 'server' | 'tunnels'
export type ModuleId = 'overview' | 'files' | 'docker' | 'services' | 'firewall'
export type DockerView = 'containers' | 'compose' | 'images' | 'volumes'
export type ServicesView = 'services' | 'jobs'

export type Screen =
  | { kind: 'servers' }
  | { kind: 'keys' }
  | { kind: 'tunnels' }
  | { kind: 'server'; serverId: string; user: string; module: ModuleId }

export type Session = { serverId: string; user: string }

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
  closeSession: (s: Session) => void
  /** Close every session of a server, e.g. when it is deleted. */
  closeServer: (serverId: string) => void
}

const NavContext = createContext<Nav | null>(null)

export const railOf = (s: Screen): RailId =>
  s.kind === 'server' ? 'server' : s.kind === 'tunnels' ? 'tunnels' : 'conn'

export function NavProvider({ children }: { children: ReactNode }) {
  const conns = useConnections()
  const [screen, setScreen] = useState<Screen>({ kind: 'servers' })
  const [sessions, setSessions] = useState<Session[]>([])
  // The server session to return to when switching back to the server rail.
  const [lastServer, setLastServer] = useState<Extract<Screen, { kind: 'server' }> | null>(null)
  const [dockerView, setDockerView] = useState<DockerView>('containers')
  const [servicesView, setServicesView] = useState<ServicesView>('services')
  const [expanded, setExpanded] = useState<Nav['expanded']>({})

  const go = (next: Screen) => {
    if (next.kind === 'server') setLastServer(next)
    setScreen(next)
  }

  const goRail = (rail: RailId) => {
    if (rail === 'conn') return go({ kind: 'servers' })
    if (rail === 'tunnels') return go({ kind: 'tunnels' })
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

  const connect = (serverId: string, user: string) => {
    setSessions((list) => (list.some((s) => s.serverId === serverId && s.user === user) ? list : [...list, { serverId, user }]))
    go({ kind: 'server', serverId, user, module: 'overview' })
    const current = conns.get(serverId, user)
    if (!current || current.status === 'failed') void conns.connect(serverId, user)
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
        closeSession,
        closeServer,
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
