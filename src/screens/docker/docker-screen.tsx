import { Lock, PackageX, Power } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useConnections } from '../../app/connections'
import { useNav } from '../../app/nav'
import { readCache, writeCache } from '../../app/session-cache'
import { useToast } from '../../components/toast'
import { Button } from '../../components/ui/primitives'
import { SearchInput } from '../../components/ui/search-input'
import { api, isAppError, type AppError, type Container, type DockerState, type DockerStats, type Server, type TerminalTool } from '../../lib/api'
import { ActionConfirm, type ActionAsk } from '../server/action-confirm'
import { useLive } from '../server/refresh'
import { UseSudoButton } from '../server/sudo'
import { ComposeView } from './compose'
import { ContainersView } from './containers'
import { projectsOf } from './format'
import { ImagesView, PruneDialog } from './images'
import { LogsDialog } from './logs-dialog'
import { VolumesView } from './volumes'
import { withSudo } from '../../lib/commands'

const OVERVIEW_MS = 15_000
const STATS_MS = 10_000

/** What the Docker views need to act on the server. */
export type DockerCtx = {
  server: Server
  user: string
  /** Privileged commands of this session go through sudo. */
  sudo: boolean
  api: typeof api
  /** Ask before a command (the confirm dialog shows the exact line). */
  confirm: (ask: ActionAsk) => void
  /** Run a confirmed change, then read Docker again. */
  act: (work: () => Promise<unknown>) => Promise<void>
  /** Run a harmless change at once (start a container), toast, read again. */
  runNow: (title: string, command: string, work: () => Promise<unknown>) => Promise<void>
  openLogs: (c: Container) => void
  terminal: (tool: TerminalTool, container?: string) => void
  toast: ReturnType<typeof useToast>
  reload: () => Promise<void>
  /** Bump to make the image and volume views read again. */
  version: number
}

const asError = (e: unknown): AppError => (isAppError(e) ? e : { code: 'unknown', detail: String(e) })

/** Container list and daemon state, every 15 s while the session is up. */
function useDocker(serverId: string, user: string) {
  const { markLost } = useConnections()
  const { live, sudo } = useLive(serverId, user)
  const [state, setState] = useState<DockerState | null>(() => readCache<DockerState>(serverId, user, 'docker')?.data ?? null)
  const [error, setError] = useState<AppError | null>(null)

  const load = useCallback(async () => {
    try {
      const s = await api.dockerOverview(serverId, user)
      setState(s)
      setError(null)
      writeCache(serverId, user, 'docker', s, new Date())
    } catch (e) {
      const err = asError(e)
      if (err.code === 'connection_lost' || err.code === 'not_connected') markLost(serverId, user, err)
      else setError(err)
    }
  }, [serverId, user, markLost])

  useEffect(() => {
    if (!live) return
    void load()
    const t = setInterval(load, OVERVIEW_MS)
    return () => clearInterval(t)
    // Sudo changes what Docker lets this session see.
  }, [live, sudo, load])

  return { state, error, load }
}

/** CPU/RAM of running containers; only while the container list is on screen. */
function useStats(serverId: string, user: string, on: boolean) {
  const { live } = useLive(serverId, user)
  const [stats, setStats] = useState<DockerStats | null>(() => readCache<DockerStats>(serverId, user, 'docker.stats')?.data ?? null)
  useEffect(() => {
    if (!live || !on) return
    let stop = false
    const read = async () => {
      try {
        const s = await api.dockerStats(serverId, user)
        if (stop) return
        setStats(s)
        writeCache(serverId, user, 'docker.stats', s, new Date())
      } catch {
        // The numbers just stay as they were; the list shows the real errors.
      }
    }
    void read()
    const t = setInterval(read, STATS_MS)
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [serverId, user, live, on])
  return stats
}

const TITLES = { containers: 'Container', compose: 'Compose', images: 'Images', volumes: 'Volumes' } as const

export function DockerScreen({ server, user }: { server: Server; user: string }) {
  const nav = useNav()
  const toast = useToast()
  const view = nav.dockerView
  const { sudo } = useLive(server.id, user)
  const { state, error, load } = useDocker(server.id, user)
  const ok = state?.kind === 'ok' ? state : null
  const stats = useStats(server.id, user, !!ok && view === 'containers' && ok.containers.some((c) => c.state === 'running'))

  const [ask, setAsk] = useState<ActionAsk | null>(null)
  const [logsOf, setLogsOf] = useState<Container | null>(null)
  const [prune, setPrune] = useState(false)
  const [query, setQuery] = useState('')
  const [version, setVersion] = useState(0)

  const reload = useCallback(async () => {
    setVersion((v) => v + 1)
    await load()
  }, [load])

  const ctx: DockerCtx = {
    server,
    user,
    sudo,
    api,
    confirm: setAsk,
    act: async (work) => {
      await work()
      await reload()
    },
    runNow: async (title, command, work) => {
      try {
        await work()
        toast({ title, detail: withSudo(command, sudo && user !== 'root') })
      } catch (e) {
        const err = asError(e)
        toast({ title: 'Không chạy được lệnh', detail: err.detail ?? err.code })
      }
      await reload()
    },
    openLogs: setLogsOf,
    terminal: (tool, container) => {
      void api
        .openTerminal(server.id, user, tool, undefined, container)
        .then(() => toast({ title: 'Đã mở Terminal', detail: container ? `${tool === 'dockerLogs' ? 'docker logs -f' : 'docker exec -it'} ${container}` : undefined }))
        .catch((e) => toast({ title: 'Không mở được Terminal', detail: asError(e).detail ?? asError(e).code }))
    },
    toast,
    reload,
    version,
  }

  const running = ok ? ok.containers.filter((c) => c.state === 'running').length : 0
  const sub = !state
    ? 'Đang đọc…'
    : state.kind !== 'ok'
      ? ''
      : view === 'containers'
        ? `${running}/${state.containers.length} container đang chạy · Docker ${state.version}${state.compose ? ` · compose v${state.compose}` : ''}`
        : view === 'compose'
          ? `${projectsOf(state.containers).length} project compose`
          : null

  const rootAccount = user !== 'root' && server.accounts.some((a) => a.user === 'root')
  const openAsRoot = () => {
    if (!nav.sessions.some((s) => s.serverId === server.id && s.user === 'root')) nav.connect(server.id, 'root')
    nav.go({ kind: 'server', serverId: server.id, user: 'root', module: 'docker' })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {(!ok || view === 'containers' || view === 'compose') && (
        <Header title={`Docker · ${TITLES[view]}`} sub={sub}>
          {ok && view === 'containers' && <SearchInput value={query} onChange={setQuery} placeholder="Tìm container, image" className="w-60 min-w-0" />}
          {ok && view === 'containers' && (
            <Button size="sm" onClick={() => setPrune(true)}>
              Dọn image thừa
            </Button>
          )}
        </Header>
      )}

      {error && !state && <Blank icon={PackageX} title="Không đọc được Docker" text={error.detail ?? error.code} />}
      {!state && !error && <Loading />}

      {state?.kind === 'notInstalled' && (
        <Blank icon={PackageX} title={`Docker chưa được cài trên ${server.name}`} text="Không tìm thấy lệnh docker. Có thể cài bằng script chính thức của Docker:">
          <span className="rounded-md bg-sunken px-2.5 py-1.5 font-mono text-[11.5px] select-text">curl -fsSL https://get.docker.com | sudo sh</span>
        </Blank>
      )}

      {state?.kind === 'noAccess' && (
        <Blank
          icon={Lock}
          title="Cần quyền root hoặc thuộc group docker"
          text={`User ${user} không thuộc group docker nên không đọc được /var/run/docker.sock.`}
        >
          <div className="flex flex-wrap justify-center gap-1.5">
            <UseSudoButton server={server} user={user} />
            {rootAccount && (
              <Button size="xs" variant="primary" onClick={openAsRoot}>
                Mở bằng kết nối root
              </Button>
            )}
          </div>
          <span className="max-w-[520px] font-mono text-[11px] break-all text-muted">{state.detail}</span>
        </Blank>
      )}

      {state?.kind === 'daemonDown' && (
        <Blank icon={Power} title="Docker daemon không chạy" text="Docker đã được cài nhưng daemon không trả lời, nên không đọc được container, image, volume.">
          <span className="max-w-[560px] rounded-md bg-sunken px-2.5 py-1.5 font-mono text-[11.5px] break-all select-text">{state.detail}</span>
          {state.systemd && (
            <div className="flex flex-wrap justify-center gap-1.5">
              {user === 'root' || sudo ? (
                <Button
                  size="xs"
                  variant="primary"
                  onClick={() =>
                    setAsk({
                      title: 'Khởi động Docker?',
                      body: 'Chạy lại docker.service. Container có restart policy "always" hoặc "unless-stopped" sẽ tự chạy theo.',
                      command: 'systemctl start docker',
                      confirm: 'Khởi động',
                      run: () => ctx.act(() => api.dockerStartDaemon(server.id, user)),
                    })
                  }
                >
                  Khởi động Docker
                </Button>
              ) : (
                <UseSudoButton server={server} user={user} />
              )}
              <Button size="xs" onClick={() => ctx.terminal('dockerDaemonLog')}>
                Xem log trong Terminal
              </Button>
            </div>
          )}
        </Blank>
      )}

      {ok && view === 'containers' && <ContainersView ctx={ctx} containers={ok.containers} stats={stats} query={query} />}
      {ok && view === 'compose' && <ComposeView ctx={ctx} containers={ok.containers} />}
      {ok && view === 'images' && <ImagesView ctx={ctx} onPrune={() => setPrune(true)} />}
      {ok && view === 'volumes' && <VolumesView ctx={ctx} />}

      {ask && (
        <ActionConfirm
          ask={ask}
          serverName={server.name}
          user={user}
          sudo={sudo}
          onClose={() => setAsk(null)}
          onDone={() => {
            toast({ title: 'Đã chạy lệnh', detail: withSudo(ask.command, sudo && user !== 'root') })
            setAsk(null)
          }}
        />
      )}
      {logsOf && <LogsDialog ctx={ctx} container={logsOf} onClose={() => setLogsOf(null)} />}
      {prune && <PruneDialog ctx={ctx} onClose={() => setPrune(false)} />}
    </div>
  )
}

export function Header({ title, sub, children }: { title: string; sub: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-none flex-wrap items-center gap-2">
      <div className="flex min-w-[220px] flex-1 flex-col gap-0.5">
        <span className="text-[15px] font-semibold">{title}</span>
        {sub && <span className="text-muted">{sub}</span>}
      </div>
      {children}
    </div>
  )
}

function Blank({ icon: Icon, title, text, children }: { icon: typeof Lock; title: string; text: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2.5 rounded-xl border border-line bg-surface px-6 py-10 text-center">
      <Icon size={22} strokeWidth={1.8} className="text-muted" />
      <span className="text-[14px] font-semibold">{title}</span>
      <span className="max-w-[460px] leading-normal text-muted">{text}</span>
      {children}
    </div>
  )
}

function Loading() {
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-line bg-surface" aria-busy="true">
      <div className="h-8 bg-sunken" />
      {['55%', '40%', '65%', '45%', '60%', '35%'].map((w, i) => (
        <div key={i} className="flex items-center gap-4 border-t border-line px-3.5 py-3">
          <span className="h-3 rounded-[5px] bg-sunken" style={{ width: w }} />
          <span className="h-2.5 w-24 rounded-[5px] bg-sunken" />
          <span className="h-2.5 w-16 rounded-[5px] bg-sunken" />
        </div>
      ))}
    </div>
  )
}
