import { useEffect, useState } from 'react'
import { useConnections } from '../../app/connections'
import { readCache, writeCache } from '../../app/session-cache'
import { useToast } from '../../components/toast'
import { Button, cx } from '../../components/ui/primitives'
import { StatStrip, StatStripSkeleton, type StatItem } from '../../components/ui/stat-strip'
import { api, isAppError, type AppError, type Processes, type Server, type Stats } from '../../lib/api'
import { formatBytes, formatDecimal, formatPercent, inUnit, unitName, unitOf } from './format'
import { AuditCard } from './audit'
import { HealthCard } from './health'
import { useLive } from './refresh'
import { PortsCard } from './ports'
import { DisksCard } from './disks'

const POLL_MS = 5000

/** Poll `load` every 5 s while mounted. The last result is kept per session
 *  (`name`), so coming back to a session shows it at once. A closed session
 *  marks the connection lost; other errors are shown and retried next tick. */
function usePoll<T>(serverId: string, user: string, name: string, load: (serverId: string, user: string) => Promise<T>) {
  const { markLost } = useConnections()
  const { live } = useLive(serverId, user)
  const [initial] = useState(() => readCache<T>(serverId, user, name))
  const [data, setData] = useState<T | null>(initial?.data ?? null)
  const [error, setError] = useState<AppError | null>(null)
  const [at, setAt] = useState<Date | null>(initial?.at ?? null)

  useEffect(() => {
    if (!live) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const d = await load(serverId, user)
        if (!alive) return
        const now = new Date()
        setData(d)
        setError(null)
        setAt(now)
        writeCache(serverId, user, name, d, now)
      } catch (e) {
        if (!alive) return
        const err = isAppError(e) ? e : { code: 'unknown', detail: String(e) }
        if (err.code === 'connection_lost' || err.code === 'not_connected') {
          markLost(serverId, user, err)
          return
        }
        setError(err)
      }
      timer = setTimeout(poll, POLL_MS)
    }
    void poll()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [serverId, user, name, markLost, load, live])

  return { data, error, at, live }
}

function Live({ ok, error, at, live }: { ok: boolean; error: AppError | null; at: Date | null; live: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-[5px] text-[11px] whitespace-nowrap text-muted"
      title={at ? `Cập nhật lúc ${at.toLocaleTimeString('vi-VN')}` : undefined}
    >
      <span className={cx('size-1.5 rounded-full', !live ? 'bg-muted' : error ? 'bg-warn' : ok ? 'bg-success' : 'bg-muted')} />
      {!live ? 'tạm dừng' : error ? 'không đọc được, đang thử lại' : ok ? 'trực tiếp · 5 giây' : 'đang đọc…'}
    </span>
  )
}

function ErrorLine({ error }: { error: AppError | null }) {
  if (!error) return null
  return (
    <span className="font-mono text-[11px] text-danger select-text">
      {error.code}
      {error.detail ? `: ${error.detail}` : ''}
    </span>
  )
}

function resourceItems(s: Stats): StatItem[] {
  const memPct = s.memTotal ? (100 * s.memUsed) / s.memTotal : 0
  const diskPct = s.diskTotal ? (100 * s.diskUsed) / (s.diskUsed + s.diskAvail || 1) : 0
  const memUnit = unitOf(s.memTotal)
  const net = s.netRxRate != null && s.netTxRate != null ? s.netRxRate + s.netTxRate : null
  const netUnit = unitOf(Math.max(s.netRxRate ?? 0, s.netTxRate ?? 0, 1))
  return [
    {
      label: 'CPU (% hiện tại)',
      value: s.cpuPercent != null ? formatPercent(s.cpuPercent) : '—',
      hint: `load ${formatDecimal(s.load[0])} · ${s.cores} nhân`,
    },
    {
      label: 'RAM',
      value: formatPercent(memPct),
      hint: `${inUnit(s.memUsed, memUnit)} / ${inUnit(s.memTotal, memUnit)} ${unitName(memUnit)}`,
      hintTone: memPct >= 85 ? 'var(--danger)' : undefined,
    },
    {
      label: 'Disk /',
      value: formatPercent(diskPct),
      hint: `còn ${formatBytes(s.diskAvail)}`,
      hintTone: diskPct >= 85 ? 'var(--warn)' : undefined,
    },
    {
      label: 'Mạng',
      value: net != null ? `${formatBytes(net)}/s` : '—',
      hint:
        s.netTxRate != null && s.netRxRate != null
          ? `ra ${inUnit(s.netTxRate, netUnit)} · vào ${inUnit(s.netRxRate, netUnit)} ${unitName(netUnit)}/s`
          : undefined,
    },
  ]
}

const loadStats = (s: string, u: string) => api.stats(s, u)
const loadProcesses = (s: string, u: string) => api.processes(s, u)

function Resources({ server, user }: { server: Server; user: string }) {
  const { data, error, at, live } = usePoll<Stats>(server.id, user, 'stats', loadStats)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[13px] font-semibold">Tài nguyên</span>
        <Live ok={!!data} error={error} at={at} live={live} />
      </div>
      {data ? <StatStrip items={resourceItems(data)} /> : <StatStripSkeleton />}
      <ErrorLine error={error} />
    </div>
  )
}

const PROC_COLS = 'minmax(140px,1.5fr) 96px 96px minmax(70px,1fr) 64px'

const barColor = (v: number) => (v >= 85 ? 'var(--danger)' : v >= 70 ? 'var(--warn)' : 'var(--ink2)')

function TopProcesses({ server, user }: { server: Server; user: string }) {
  const { data, error, at, live } = usePoll<Processes>(server.id, user, 'processes', loadProcesses)
  const toast = useToast()
  const snapAt = data ? new Date(data.at).toLocaleTimeString('vi-VN') : null

  const openTop = () =>
    api.openTerminal(server.id, user, 'htop').catch((e) => toast({ title: 'Không mở được Terminal', detail: isAppError(e) ? (e.detail ?? e.code) : String(e) }))

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface p-4">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[15px] font-semibold">Tiến trình dùng nhiều nhất</span>
          <span className="text-[11px] text-muted">{snapAt ? `Ảnh chụp lúc ${snapAt}` : 'Đang đọc danh sách tiến trình…'}</span>
        </div>
        <Live ok={!!data} error={error} at={at} live={live} />
      </div>

      <div className="grid gap-3 px-0.5 text-[11px] text-muted" style={{ gridTemplateColumns: PROC_COLS }}>
        <span>Tiến trình</span>
        <span>User</span>
        <span>Container</span>
        <span>CPU (% hiện tại)</span>
        <span className="text-right">RAM</span>
      </div>

      {data
        ? data.rows.map((p) => (
            <div key={p.pid} className="grid items-center gap-3 border-t border-line px-0.5 py-[5px]" style={{ gridTemplateColumns: PROC_COLS }}>
              <span className="truncate font-mono text-[11.5px] select-text" title={`PID ${p.pid} · ${p.command}`}>
                {p.command}
              </span>
              <span className="flex min-w-0 flex-col leading-tight">
                <span className="truncate font-mono text-[11.5px] text-ink2">{p.user ?? p.uid ?? '—'}</span>
                {!p.user && p.uid != null && <span className="text-[10.5px] text-muted">(container)</span>}
              </span>
              <span className="truncate text-[12px] text-ink2">{p.container ?? '—'}</span>
              <span className="flex items-center gap-2">
                <span className="block h-[5px] flex-1 overflow-hidden rounded-[3px] bg-sunken">
                  <span
                    className="block h-full transition-[width] duration-500"
                    style={{ width: `${Math.min(100, p.cpuPercent)}%`, background: barColor(p.cpuPercent) }}
                  />
                </span>
                <span className="num w-12 text-right">{formatDecimal(p.cpuPercent, 1)}%</span>
              </span>
              <span className="num text-right text-ink2">{formatBytes(p.rss)}</span>
            </div>
          ))
        : Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="grid items-center gap-3 border-t border-line px-0.5 py-2" style={{ gridTemplateColumns: PROC_COLS }}>
              {[70, 50, 40, 60, 40].map((w, j) => (
                <span key={j} className="block h-2.5 rounded-md bg-sunken" style={{ width: `${w}%` }} />
              ))}
            </div>
          ))}

      <ErrorLine error={error} />
      <div className="flex justify-end">
        <Button variant="ghost" size="xs" onClick={openTop}>
          htop trong Terminal
        </Button>
      </div>
    </div>
  )
}

/** "Tổng quan" of a connected server. Sections are added one at a time, each
 *  backed by real data read over SSH. */
export function Overview({ server, user }: { server: Server; user: string }) {
  return (
    <div className="flex flex-col gap-4">
      <Resources server={server} user={user} />
      <div className="grid items-start gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))' }}>
        <TopProcesses server={server} user={user} />
        <HealthCard server={server} user={user} />
      </div>
      <div className="grid items-start gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))' }}>
        <PortsCard server={server} user={user} />
        <DisksCard server={server} user={user} />
      </div>
      <AuditCard server={server} user={user} />
    </div>
  )
}
