import { useEffect, useRef, useState } from 'react'
import { Modal } from '../../components/ui/modal'
import { Button, cx } from '../../components/ui/primitives'
import { SearchInput } from '../../components/ui/search-input'
import { SegmentedControl } from '../../components/ui/segmented'
import { isAppError, type Container, type DockerLogLine } from '../../lib/api'
import type { DockerCtx } from './docker-screen'
import { logLevel } from './format'

const TAIL = 300
const FOLLOW_MS = 2000
const KEEP = 3000

type Level = 'all' | 'warn' | 'error'
const LEVELS: { id: Level; label: string }[] = [
  { id: 'all', label: 'Tất cả' },
  { id: 'warn', label: 'Cảnh báo + lỗi' },
  { id: 'error', label: 'Lỗi' },
]

const pad = (n: number) => String(n).padStart(2, '0')

/** Local "14:05:09" from Docker's RFC 3339 nanosecond timestamps. */
function clock(ts: string) {
  const d = new Date(ts.replace(/(\.\d{3})\d+/, '$1'))
  return Number.isNaN(d.getTime()) ? ts : `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function LogsDialog({ ctx, container, onClose }: { ctx: DockerCtx; container: Container; onClose: () => void }) {
  const [lines, setLines] = useState<DockerLogLine[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [level, setLevel] = useState<Level>('all')
  const [query, setQuery] = useState('')
  const [live, setLive] = useState(false)
  const last = useRef<string | undefined>(undefined)
  const box = useRef<HTMLDivElement>(null)
  // A container in a restart loop keeps writing logs between its restarts.
  const running = container.state === 'running' || container.state === 'restarting'
  const { server, user } = ctx

  // Last lines first, then whatever came after them while following.
  useEffect(() => {
    let stop = false
    const read = async (since?: string) => {
      try {
        const got = await ctx.api.dockerLogs(server.id, user, container.id, since ? KEEP : TAIL, since)
        if (stop) return
        if (got.length) last.current = got[got.length - 1].ts
        setLines((prev) => (since ? [...(prev ?? []), ...got].slice(-KEEP) : got))
        setError(null)
      } catch (e) {
        if (!stop) setError(isAppError(e) ? (e.detail ?? e.code) : String(e))
      }
    }
    if (!live) {
      void read()
      return () => {
        stop = true
      }
    }
    const t = setInterval(() => void read(last.current), FOLLOW_MS)
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [ctx.api, server.id, user, container.id, live])

  const q = query.trim().toLowerCase()
  const shown = (lines ?? [])
    .map((l) => ({ ...l, lv: logLevel(l.text) }))
    .filter((l) => (level === 'all' || (level === 'error' ? l.lv === 'ERROR' : l.lv != null)) && (!q || l.text.toLowerCase().includes(q)))

  // Keep the newest line in view while following, and on first load.
  const count = shown.length
  useEffect(() => {
    const el = box.current
    if (el && (live || count <= TAIL)) el.scrollTop = el.scrollHeight
  }, [count, live])

  const sudo = ctx.sudo && user !== 'root' ? 'sudo ' : ''
  const cmd = live ? `${sudo}docker logs -f --timestamps ${container.name}` : `${sudo}docker logs --tail ${TAIL} --timestamps ${container.name}`

  return (
    <Modal open onClose={onClose} width={860} title={`Log · ${container.name}`} subtitle={`${cmd} · ${server.name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl value={level} onChange={setLevel} options={LEVELS} />
        <SearchInput value={query} onChange={setQuery} placeholder="Lọc theo chữ" className="w-44 min-w-0" />
        <span className="flex-1" />
        <span className="flex items-center gap-1.5 text-[11.5px] text-muted">
          <span className="size-1.5 rounded-full" style={{ background: live ? 'var(--success)' : 'var(--muted)' }} />
          {lines ? `${shown.length} dòng` : 'Đang đọc…'}
          {live ? ' · đang theo dõi' : running ? '' : ' · container không chạy'}
        </span>
        <span title={running ? undefined : 'Container không chạy, chỉ có log cũ'}>
          <Button size="xs" onClick={() => setLive(!live)} disabled={!running}>
            {live ? 'Tạm dừng' : 'Theo dõi trực tiếp'}
          </Button>
        </span>
        <Button variant="ghost" size="xs" onClick={() => ctx.terminal('dockerLogs', container.name)}>
          Mở trong Terminal
        </Button>
      </div>
      <div ref={box} className="h-[56vh] overflow-auto overscroll-contain rounded-lg border border-line bg-sunken py-1 font-mono text-[11.5px] leading-[1.55]">
        {error && <div className="px-3 py-2 text-danger select-text">{error}</div>}
        {shown.map((l, i) => (
          <div
            key={`${l.ts}|${i}`}
            className={cx('grid gap-3 px-3 py-px', l.lv === 'ERROR' && 'bg-danger-soft')}
            style={{ gridTemplateColumns: '64px 44px minmax(0,1fr)' }}
          >
            <span className="text-muted" title={l.ts}>
              {clock(l.ts)}
            </span>
            <span className={l.lv === 'ERROR' ? 'text-danger' : l.lv === 'WARN' ? 'text-warn' : 'text-muted'}>{l.lv ?? (l.err ? 'stderr' : '')}</span>
            <span className="break-all whitespace-pre-wrap text-ink select-text">{l.text}</span>
          </div>
        ))}
        {lines && !shown.length && !error && (
          <div className="px-3 py-6 text-center font-sans text-muted">{q || level !== 'all' ? 'Không có dòng nào khớp bộ lọc' : 'Chưa có log'}</div>
        )}
      </div>
    </Modal>
  )
}
