import { Lock } from 'lucide-react'
import { api, type Disks, type DockerDisk, type DockerUsage, type Server } from '../../lib/api'
import { formatBytes, formatPercent, inUnit, unitName, unitOf } from './format'
import { ErrorLine, RefreshControl, useRefreshed } from './refresh'
import { UseSudoButton } from './sudo'

const loadDisks = (s: string, u: string) => api.disks(s, u)
const loadDockerDisk = (s: string, u: string) => api.dockerDisk(s, u)
const DOCKER_EVERY_MS = 5 * 60_000

const barColor = (pct: number) => (pct >= 85 ? 'var(--danger)' : pct >= 70 ? 'var(--warn)' : 'var(--ink2)')

const DOCKER_LABELS: Record<string, string> = {
  Images: 'Images',
  Containers: 'Containers',
  'Local Volumes': 'Volumes',
  'Build Cache': 'Build cache',
}

/** What could be freed, in the words of the design. */
function reclaimText(r: DockerUsage) {
  const idle = r.total - r.active
  switch (r.kind) {
    case 'Images':
      return r.reclaimable > 0 ? `thu hồi được ${formatBytes(r.reclaimable)} (${idle} image không dùng)` : `${r.total} image, đều đang dùng`
    case 'Containers':
      return idle > 0 ? `${idle} container đã dừng` : `${r.total} container, đều đang chạy`
    case 'Local Volumes':
      return idle > 0 ? `${idle} volume không gắn container` : `${r.total} volume, đều đang dùng`
    case 'Build Cache':
      return r.reclaimable > 0 ? `thu hồi được ${formatBytes(r.reclaimable)}` : 'không có gì để dọn'
    default:
      return r.reclaimable > 0 ? `thu hồi được ${formatBytes(r.reclaimable)}` : ''
  }
}

/** "Ổ đĩa": mounted filesystems and Docker's share of the disk. */
export function DisksCard({ server, user }: { server: Server; user: string }) {
  const { data, error, at, busy, refresh: refreshMounts, live } = useRefreshed<Disks>(server.id, user, 'disks', loadDisks)
  const docker = useRefreshed<DockerDisk>(server.id, user, 'dockerDisk', loadDockerDisk, DOCKER_EVERY_MS)
  const refresh = () => {
    void refreshMounts()
    void docker.refresh()
  }
  const dd = docker.data

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
      <div className="flex items-start gap-2">
        <span className="flex-1 text-[15px] font-semibold">Ổ đĩa</span>
        <RefreshControl at={at} busy={busy || docker.busy} error={error} onRefresh={refresh} live={live} />
      </div>
      <ErrorLine error={error} />

      {data
        ? data.mounts.map((m) => {
            const pct = m.used + m.avail ? (100 * m.used) / (m.used + m.avail) : 0
            const u = unitOf(m.total)
            return (
              <div key={m.path} className="flex flex-col gap-[5px]" title={`${m.device}${m.fsType ? ` · ${m.fsType}` : ''} · còn ${formatBytes(m.avail)}`}>
                <div className="flex items-baseline gap-2">
                  <span className="flex-1 truncate font-mono text-[12px] font-semibold select-text">{m.path}</span>
                  <span className="num text-[11.5px] text-muted">
                    {inUnit(m.used, u)} / {inUnit(m.total, u)} {unitName(u)}
                  </span>
                  <span className="num w-9 text-right text-[12px]">{formatPercent(pct)}</span>
                </div>
                <span className="block h-1.5 overflow-hidden rounded-[3px] bg-sunken">
                  <span className="block h-full" style={{ width: `${Math.min(100, pct)}%`, background: barColor(pct) }} />
                </span>
              </div>
            )
          })
        : [0, 1].map((i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <span className="block h-2.5 w-1/3 rounded-md bg-sunken" />
              <span className="block h-1.5 w-full rounded-md bg-sunken" />
            </div>
          ))}

      {dd?.kind !== 'notInstalled' && (
        <div className="flex flex-col gap-1.5 border-t border-line pt-3">
          <span className="font-semibold">Docker</span>
          {docker.busy && !docker.error && (
            <span className="text-[11.5px] text-muted">
              {dd ? 'Đang tính lại dung lượng Docker…' : 'Đang tính dung lượng Docker, có thể mất vài chục giây…'}
            </span>
          )}
          <ErrorLine error={docker.error} />
          {dd?.kind === 'ok' &&
            dd.rows.map((r) => (
              <div key={r.kind} className="grid items-center gap-2.5 py-1" style={{ gridTemplateColumns: '100px 76px minmax(0,1fr)' }}>
                <span>{DOCKER_LABELS[r.kind] ?? r.kind}</span>
                <span className="num text-right">{formatBytes(r.size)}</span>
                <span className="truncate text-[11.5px] text-muted">{reclaimText(r)}</span>
              </div>
            ))}
          {dd?.kind === 'noAccess' && (
            <div className="flex items-center gap-2.5 rounded-lg border border-dashed border-line2 bg-raised px-3 py-2.5">
              <Lock size={16} strokeWidth={1.9} className="flex-none text-muted" />
              <div className="flex min-w-0 flex-1 flex-col gap-px">
                <span className="text-[12px] font-semibold">Cần quyền Docker</span>
                <span className="text-[11px] leading-snug text-muted">
                  User này không thuộc nhóm docker nên không đọc được dung lượng image, container, volume.
                </span>
              </div>
              <UseSudoButton server={server} user={user} />
            </div>
          )}
          {dd?.kind === 'daemonDown' && (
            <span className="text-[12px] text-danger" title={dd.detail}>
              Docker daemon không chạy
            </span>
          )}
        </div>
      )}
    </div>
  )
}
