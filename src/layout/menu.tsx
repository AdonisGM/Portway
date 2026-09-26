import {
  Activity,
  ArrowLeftRight,
  Box,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  FileText,
  Folder,
  KeyRound,
  Layers,
  LayoutDashboard,
  List,
  Server,
  Shield,
  X,
  type LucideIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useNav, type DockerView, type ModuleId, type ServicesView } from '../app/nav'
import { useConnections } from '../app/connections'
import { useServers } from '../app/servers'
import { OsBadge } from '../components/os-badge'
import { MODULE_LABELS } from './meta'

/** Second column: the menu of whichever rail area is active. */
export function Menu() {
  const nav = useNav()

  return (
    <aside className="flex w-[224px] flex-none flex-col gap-0.5 overflow-auto border-r border-line bg-rail px-2 py-3">
      {nav.rail === 'conn' && <ConnMenu />}
      {nav.rail === 'server' && <ServerMenu />}
      {nav.rail === 'tunnels' && <TunnelMenu />}
    </aside>
  )
}

function MenuTitle({ children }: { children: ReactNode }) {
  return <span className="px-2.5 pt-1 pb-2.5 text-[15px] font-semibold">{children}</span>
}

function ConnMenu() {
  const nav = useNav()
  const { servers, keys } = useServers()
  return (
    <>
      <MenuTitle>Quản lý kết nối</MenuTitle>
      <MenuItem
        icon={Server}
        label="Danh sách server"
        count={servers.length}
        active={nav.screen.kind === 'servers'}
        onClick={() => nav.go({ kind: 'servers' })}
      />
      <MenuItem
        icon={KeyRound}
        label="Khoá SSH"
        count={keys.length}
        active={nav.screen.kind === 'keys'}
        onClick={() => nav.go({ kind: 'keys' })}
      />
    </>
  )
}

function TunnelMenu() {
  const nav = useNav()
  return (
    <>
      <MenuTitle>Tunnel</MenuTitle>
      <MenuItem
        icon={ArrowLeftRight}
        label="Tunnel"
        active={nav.screen.kind === 'tunnels'}
        onClick={() => nav.go({ kind: 'tunnels' })}
      />
    </>
  )
}

type Kid = { icon: LucideIcon; label: string; count?: number; active: boolean; onClick: () => void }

function ServerMenu() {
  const nav = useNav()
  const conns = useConnections()
  const s = nav.screen.kind === 'server' ? nav.screen : null
  // Docker shows only once the session is up and found the docker CLI.
  const conn = s ? conns.get(s.serverId, s.user) : undefined
  const hasDocker = (conn?.status === 'connected' || conn?.status === 'reconnecting') && conn.info.docker
  const inModule = (m: ModuleId) => s?.module === m
  // Sub-views only; counts appear once each module reads real data.
  const docker = (view: DockerView, icon: LucideIcon, label: string): Kid => ({
    icon,
    label,
    active: inModule('docker') && nav.dockerView === view,
    onClick: () => nav.openModule('docker', { docker: view }),
  })
  const services = (view: ServicesView, icon: LucideIcon, label: string): Kid => ({
    icon,
    label,
    active: inModule('services') && nav.servicesView === view,
    onClick: () => nav.openModule('services', { services: view }),
  })

  const modules: { id: ModuleId; icon: LucideIcon; count?: number; alert?: string; kids?: Kid[]; hidden?: boolean }[] = [
    { id: 'overview', icon: LayoutDashboard },
    { id: 'files', icon: Folder },
    {
      id: 'docker',
      hidden: !hasDocker,
      icon: Box,
      kids: [
        docker('containers', List, 'Container'),
        docker('compose', Layers, 'Compose'),
        docker('images', Layers, 'Images'),
        docker('volumes', Database, 'Volumes'),
      ],
    },
    {
      id: 'services',
      icon: Activity,
      kids: [services('services', List, 'Dịch vụ'), services('jobs', Clock, 'Tác vụ định kỳ')],
    },
    { id: 'firewall', icon: Shield },
    { id: 'logs', icon: FileText },
  ]

  return (
    <>
      <Sessions />
      {modules.filter((m) => !m.hidden).map((m) => {
        const open = !!m.kids && !!nav.expanded[m.id]
        return (
          <div key={m.id} className="flex flex-col gap-px">
            <MenuItem
              icon={m.icon}
              label={MODULE_LABELS[m.id]}
              count={m.alert ?? m.count}
              countTone={m.alert ? 'danger' : 'muted'}
              active={inModule(m.id)}
              chevron={m.kids ? (open ? 'down' : 'right') : undefined}
              onClick={() => {
                // A group opens its first child the first time; after that the
                // header only folds and unfolds the group.
                if (m.kids && inModule(m.id)) nav.toggleGroup(m.id)
                else nav.openModule(m.id)
              }}
            />
            {open && (
              <div className="mt-px mb-1 flex flex-col gap-px">
                {m.kids!.map((k) => (
                  <SubItem key={k.label} {...k} />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

/** Green when every session of the host is connected, amber while one is
 *  connecting or waiting for input, red when one failed. */
function hostDot(statuses: Array<string | undefined>) {
  if (statuses.some((s) => s === 'failed' || s === undefined)) return 'var(--danger)'
  if (statuses.some((s) => s === 'connecting' || s === 'prompt' || s === 'reconnecting')) return 'var(--warn)'
  return 'var(--success)'
}

/** Open sessions grouped by server, each user as its own row. */
function Sessions() {
  const nav = useNav()
  const { byId } = useServers()
  const conns = useConnections()
  const current = nav.screen.kind === 'server' ? nav.screen : null
  const hosts = [...new Set(nav.sessions.map((s) => s.serverId))]

  return (
    <div className="mb-2.5 flex flex-col gap-0.5 border-b border-line pb-2.5">
      <div className="flex items-center px-2.5 pb-1">
        <span className="flex-1 text-[11px] tracking-[.06em] text-muted uppercase">Đang kết nối</span>
        <span className="num text-[11px] text-muted">{nav.sessions.length}</span>
      </div>
      {hosts.map((id) => {
        const srv = byId(id)
        const users = nav.sessions.filter((s) => s.serverId === id)
        return (
          <div key={id} className="mb-1 flex flex-col gap-px">
            <button
              type="button"
              onClick={() => nav.go({ kind: 'server', serverId: id, user: users[0].user, module: current?.module ?? 'overview' })}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-accent-soft"
            >
              <OsBadge os={srv?.os} size={22} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-1.5 font-semibold">
                  <span className="size-1.5 flex-none rounded-full" style={{ background: hostDot(users.map((u) => conns.get(id, u.user)?.status)) }} />
                  <span className="truncate">{srv?.name ?? id}</span>
                </span>
                <span className="truncate font-mono text-[10.5px] text-muted">{srv?.host}</span>
              </span>
            </button>
            {users.map((u) => {
              const active = current?.serverId === id && current.user === u.user
              return (
                <div
                  key={u.user}
                  onClick={() => nav.go({ kind: 'server', serverId: id, user: u.user, module: current?.module ?? 'overview' })}
                  className={`ml-[19px] flex cursor-pointer items-center gap-2 rounded-r-[7px] border-l border-line py-1 pr-1 pl-3 hover:bg-accent-soft ${
                    active ? 'bg-surface' : ''
                  }`}
                >
                  <span className={`flex-1 font-mono text-[12px] ${active ? 'font-semibold text-ink' : 'text-ink2'}`}>{u.user}</span>
                  <button
                    type="button"
                    title={`Ngắt kết nối ${u.user}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      nav.closeSession(u)
                    }}
                    className="flex size-5 flex-none cursor-pointer items-center justify-center rounded-[5px] text-muted hover:bg-sunken"
                  >
                    <X size={12} />
                  </button>
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

function MenuItem(props: {
  icon: LucideIcon
  label: string
  count?: number | string
  countTone?: 'muted' | 'danger'
  active: boolean
  chevron?: 'down' | 'right'
  onClick: () => void
}) {
  const { icon: Icon, active } = props
  const Chevron = props.chevron === 'down' ? ChevronDown : ChevronRight
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={props.onClick}
      className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left text-[13px] hover:bg-accent-soft ${
        active ? 'bg-surface font-semibold text-ink' : 'text-ink2'
      }`}
    >
      <Icon size={16} strokeWidth={1.75} className="flex-none" />
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.count != null && (
        <span className={`num text-[11px] font-normal ${props.countTone === 'danger' ? 'text-danger' : 'text-muted'}`}>
          {props.count}
        </span>
      )}
      {props.chevron && <Chevron size={14} strokeWidth={1.75} className="flex-none text-muted" />}
    </button>
  )
}

function SubItem({ icon: Icon, label, count, active, onClick }: Kid) {
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={`flex cursor-pointer items-center gap-2 rounded-lg py-1.5 pr-2.5 pl-[34px] text-left text-[12.5px] hover:bg-accent-soft ${
        active ? 'bg-surface font-semibold text-ink' : 'text-ink2'
      }`}
    >
      <Icon size={14} strokeWidth={1.75} className="flex-none" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count != null && <span className="num text-[11px] font-normal text-muted">{count}</span>}
    </button>
  )
}
