import { useEffect, useState } from 'react'
import { useConnections } from '../../app/connections'
import { StatStrip, StatStripSkeleton, type StatItem } from '../../components/ui/stat-strip'
import { api, isAppError, type AppError, type Server, type Stats } from '../../lib/api'
import { formatBytes, formatDecimal, formatPercent, inUnit, unitName, unitOf } from './format'

const POLL_MS = 5000

/** Resource numbers polled from the server while the overview is open. */
function useStats(serverId: string, user: string) {
  const { markLost } = useConnections()
  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [at, setAt] = useState<Date | null>(null)

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const s = await api.stats(serverId, user)
        if (!alive) return
        setStats(s)
        setError(null)
        setAt(new Date())
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
  }, [serverId, user, markLost])

  return { stats, error, at }
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

/** "Tổng quan" of a connected server. Sections are added one at a time, each
 *  backed by real data read over SSH. */
export function Overview({ server, user }: { server: Server; user: string }) {
  const { stats, error, at } = useStats(server.id, user)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="flex-1 text-[13px] font-semibold">Tài nguyên</span>
          <span className="inline-flex items-center gap-[5px] text-[11px] whitespace-nowrap text-muted" title={at ? `Cập nhật lúc ${at.toLocaleTimeString('vi-VN')}` : undefined}>
            <span className={`size-1.5 rounded-full ${error ? 'bg-warn' : stats ? 'bg-success' : 'bg-muted'}`} />
            {error ? 'không đọc được, đang thử lại' : stats ? 'trực tiếp · 5 giây' : 'đang đọc…'}
          </span>
        </div>
        {stats ? <StatStrip items={resourceItems(stats)} /> : <StatStripSkeleton />}
        {error && (
          <span className="font-mono text-[11px] text-danger select-text">
            {error.code}
            {error.detail ? `: ${error.detail}` : ''}
          </span>
        )}
      </div>
    </div>
  )
}
