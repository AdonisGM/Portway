import { Activity, AlertTriangle, CircleDot, Clock, Layers, Pause, Play, Trash2, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ServersProvider, useServers } from '../app/servers'
import { SLOW_MS, TraceProvider, useTrace, type TraceFilter } from '../app/trace'
import { Button, Chip, cx, TONES } from '../components/ui/primitives'
import { SearchInput } from '../components/ui/search-input'
import type { TraceEntry, TraceKind } from '../lib/api'

/** The separate "Nhật ký gỡ lỗi" window (opened from the rail). */
export function DebugWindow() {
  return (
    <ServersProvider>
      <TraceProvider>
        <div className="flex h-full flex-col overflow-hidden bg-bg text-[12.5px] text-ink">
          <header data-tauri-drag-region className="flex h-[38px] flex-none items-center gap-3.5 border-b border-line bg-rail pr-3.5 pl-[84px]">
            <span data-tauri-drag-region className="flex items-center gap-1.5 text-[13px] font-semibold tracking-[-0.01em]">
              AdonisGM <span data-tauri-drag-region className="font-normal text-muted">|</span> Portway
            </span>
            <span data-tauri-drag-region className="truncate text-[12px] text-muted">
              Nhật ký gỡ lỗi
            </span>
            <span data-tauri-drag-region className="flex-1 self-stretch" />
          </header>
          <div className="flex min-h-0 flex-1">
            <Filters />
            <div className="relative min-w-0 flex-1">
              <div className="grain pointer-events-none absolute inset-0" style={{ opacity: 'var(--grain)' }} />
              <main className="relative flex h-full flex-col gap-3 px-6 pt-5 pb-6">
                <Trace />
              </main>
            </div>
          </div>
        </div>
      </TraceProvider>
    </ServersProvider>
  )
}

const KIND_LABELS: Record<TraceKind, string> = { exec: 'Lệnh', sftp: 'SFTP', connect: 'Kết nối', transfer: 'Chuyển tệp' }

const isLive = (t: TraceEntry) => t.status === 'running' || t.status === 'waiting'
const isSlow = (t: TraceEntry) => (t.durationMs ?? 0) >= SLOW_MS
const sessionKey = (t: TraceEntry) => `${t.serverId}|${t.user}`

function matches(t: TraceEntry, f: TraceFilter) {
  if (f.session && sessionKey(t) !== f.session) return false
  if (f.status === 'running') return isLive(t)
  if (f.status === 'error') return t.status === 'error'
  if (f.status === 'slow') return isSlow(t)
  return true
}

/** Left column: what to show. */
function Filters() {
  const { list, filter, setFilter } = useTrace()
  const { byId } = useServers()
  const sessions = useMemo(() => [...new Set(list.map(sessionKey))], [list])
  const count = (status: TraceFilter['status']) => list.filter((t) => matches(t, { status, session: filter.session })).length

  const item = (icon: LucideIcon, label: string, active: boolean, onClick: () => void, n?: number, tone?: 'danger' | 'warn') => {
    const Icon = icon
    return (
      <button
        type="button"
        onClick={onClick}
        className={cx(
          'flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left',
          active ? 'bg-accent-soft font-semibold text-ink' : 'text-ink2 hover:bg-accent-soft',
        )}
      >
        <Icon size={15} strokeWidth={1.75} className="flex-none" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {n != null && <span className={cx('num text-[11px]', n && tone === 'danger' ? 'text-danger' : n && tone === 'warn' ? 'text-warn' : 'text-muted')}>{n}</span>}
      </button>
    )
  }

  return (
    <aside className="flex w-[224px] flex-none flex-col gap-0.5 overflow-auto border-r border-line bg-rail px-2 py-3">
      <span className="px-2.5 pt-1 pb-2.5 text-[15px] font-semibold">Nhật ký gỡ lỗi</span>
      {item(Layers, 'Tất cả', filter.status === 'all', () => setFilter({ ...filter, status: 'all' }), count('all'))}
      {item(Activity, 'Đang chạy', filter.status === 'running', () => setFilter({ ...filter, status: 'running' }), count('running'))}
      {item(AlertTriangle, 'Lỗi', filter.status === 'error', () => setFilter({ ...filter, status: 'error' }), count('error'), 'danger')}
      {item(Clock, `Chậm (≥ ${SLOW_MS / 1000} giây)`, filter.status === 'slow', () => setFilter({ ...filter, status: 'slow' }), count('slow'), 'warn')}

      <span className="mt-3 px-2.5 pb-1 text-[11px] tracking-[.06em] text-muted uppercase">Phiên</span>
      {item(CircleDot, 'Tất cả phiên', !filter.session, () => setFilter({ ...filter, session: null }))}
      {sessions.map((k) => {
        const [id, user] = k.split('|')
        return <span key={k}>{item(CircleDot, `${byId(id)?.name ?? id} · ${user}`, filter.session === k, () => setFilter({ ...filter, session: k }))}</span>
      })}

      <span className="mt-auto px-2.5 pt-4 text-[11px] leading-relaxed text-muted">
        Giữ 2000 mục gần nhất, chỉ trong bộ nhớ, mất khi tắt app. Mật khẩu sudo đi qua stdin nên không bao giờ nằm trong nhật ký.
      </span>
    </aside>
  )
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')
const clock = (ms: number) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}
const span = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1).replace('.', ',')} s`)
const bytes = (n: number | null) => (n == null ? '—' : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1).replace('.', ',')} KB` : `${(n / 1048576).toFixed(1).replace('.', ',')} MB`)
const firstLine = (s: string) => s.split('\n').map((l) => l.trim()).find(Boolean) ?? ''

/** Re-render every `ms` while something is running, for live elapsed times. */
function useTick(on: boolean, ms = 250) {
  const [, set] = useState(0)
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => set((n) => n + 1), ms)
    return () => clearInterval(t)
  }, [on, ms])
  return Date.now()
}

const COLS = '100px 160px 78px minmax(0,1fr) 64px 76px 150px'

function Trace() {
  const { list, filter, clear, running } = useTrace()
  const { byId } = useServers()
  const [query, setQuery] = useState('')
  const [frozen, setFrozen] = useState<TraceEntry[] | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  const now = useTick(running > 0)

  const source = frozen ?? list
  const q = query.trim().toLowerCase()
  const shown = source.filter((t) => matches(t, filter) && (!q || t.label.toLowerCase().includes(q) || t.command.toLowerCase().includes(q))).reverse()
  const live = list.filter(isLive)
  const who = (t: TraceEntry) => `${byId(t.serverId)?.name ?? t.serverId} · ${t.user}`
  const newer = frozen ? list.length - frozen.length : 0

  return (
    <>
      <div className="flex flex-none flex-wrap items-center gap-2">
        <div className="flex min-w-[220px] flex-1 flex-col gap-0.5">
          <span className="text-[15px] font-semibold">Portway đang làm gì trên server</span>
          <span className="text-muted">
            {list.length} mục · {running ? `${running} đang chạy` : 'không có gì đang chạy'}
            {frozen ? ` · đã tạm dừng${newer > 0 ? `, ${newer} mục mới chưa hiện` : ''}` : ''}
          </span>
        </div>
        <SearchInput value={query} onChange={setQuery} placeholder="Tìm theo việc hoặc lệnh" className="w-64 min-w-0" />
        <Button size="sm" onClick={() => setFrozen(frozen ? null : list)}>
          <span className="flex items-center gap-1.5">
            {frozen ? <Play size={13} strokeWidth={1.8} /> : <Pause size={13} strokeWidth={1.8} />}
            {frozen ? 'Tiếp tục' : 'Tạm dừng'}
          </span>
        </Button>
        <Button size="sm" onClick={clear} title="Xoá các mục đã xong">
          <span className="flex items-center gap-1.5">
            <Trash2 size={13} strokeWidth={1.8} />
            Xoá
          </span>
        </Button>
      </div>

      {live.length > 0 && (
        <div className="flex max-h-[30%] flex-none flex-col overflow-hidden rounded-xl border border-line2 bg-surface">
          <div className="flex-none border-b border-line px-3.5 py-2 font-semibold">Đang chạy ({live.length})</div>
          <div className="min-h-0 overflow-auto overscroll-contain">
            {[...live].reverse().map((t) => (
              <div key={t.id} className="grid items-center gap-3 border-t border-line px-3.5 py-1.5 first:border-t-0" style={{ gridTemplateColumns: '160px minmax(0,1fr) 150px' }}>
                <span className="truncate text-ink2">{who(t)}</span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{t.label}</span>
                  <span className="truncate font-mono text-[11px] text-muted">{firstLine(t.command)}</span>
                </span>
                <span className={cx('num text-right text-[12px]', t.status === 'waiting' ? 'text-warn' : 'text-ink2')}>
                  {t.status === 'waiting' ? 'đợi kênh SSH' : 'đang chạy'} {span(Math.max(0, now - t.at))}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex min-h-[200px] flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface">
        <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
          <div className="min-w-[860px]">
            <div className="sticky top-0 z-[1] grid items-center gap-3 bg-sunken px-3.5 py-2 text-[11px] text-muted" style={{ gridTemplateColumns: COLS }}>
              <span>Thời điểm</span>
              <span>Phiên</span>
              <span>Loại</span>
              <span>Việc · lệnh</span>
              <span className="text-right" title="Thời gian đợi kênh SSH trống">
                Đợi
              </span>
              <span className="text-right">Thời gian</span>
              <span>Kết quả</span>
            </div>
            {shown.map((t) => (
              <Row key={t.id} t={t} who={who(t)} now={now} open={open === t.id} onToggle={() => setOpen(open === t.id ? null : t.id)} />
            ))}
            {!shown.length && <div className="p-8 text-center text-muted">{list.length ? 'Không có mục nào khớp bộ lọc.' : 'Chưa có gì. Kết nối một server để thấy các lệnh Portway gửi lên.'}</div>}
          </div>
        </div>
      </div>
    </>
  )
}

function result(t: TraceEntry): { tone: (typeof TONES)[keyof typeof TONES]; label: string } {
  if (t.status === 'waiting') return { tone: TONES.warn, label: 'Đợi kênh' }
  if (t.status === 'running') return { tone: TONES.info, label: 'Đang chạy' }
  if (t.status === 'ok') return { tone: TONES.success, label: t.exitCode != null ? `OK · exit ${t.exitCode}` : 'OK' }
  return { tone: TONES.danger, label: t.error ?? 'Lỗi' }
}

function Row({ t, who, now, open, onToggle }: { t: TraceEntry; who: string; now: number; open: boolean; onToggle: () => void }) {
  const r = result(t)
  const elapsed = t.durationMs ?? (isLive(t) ? Math.max(0, now - t.at) : null)
  return (
    <div className={cx('border-t border-line', open && 'bg-raised')}>
      <button type="button" onClick={onToggle} className="grid w-full cursor-pointer items-center gap-3 px-3.5 py-[7px] text-left hover:bg-raised" style={{ gridTemplateColumns: COLS }}>
        <span className="num font-mono text-[11.5px] text-muted">{clock(t.at)}</span>
        <span className="truncate text-ink2">{who}</span>
        <span className="text-[11.5px] text-ink2">{KIND_LABELS[t.kind]}</span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{t.label}</span>
          <span className="truncate font-mono text-[11px] text-muted">{firstLine(t.command)}</span>
        </span>
        <span className={cx('num text-right text-[11.5px]', (t.waitMs ?? 0) >= 500 ? 'text-warn' : 'text-muted')}>{t.waitMs ? span(t.waitMs) : '—'}</span>
        <span className={cx('num text-right text-[12px]', elapsed != null && elapsed >= SLOW_MS ? 'text-warn' : 'text-ink')}>{elapsed == null ? '—' : span(elapsed)}</span>
        <span className="min-w-0">
          <Chip tone={r.tone} className="max-w-full truncate">
            {r.label}
          </Chip>
        </span>
      </button>
      {open && <Details t={t} />}
    </div>
  )
}

function Details({ t }: { t: TraceEntry }) {
  const rows: [string, ReactNode][] = [
    ['Bắt đầu', new Date(t.at).toLocaleString('vi-VN')],
    ['Đợi kênh SSH', t.waitMs != null ? span(t.waitMs) : '—'],
    ['Thời gian chạy', t.durationMs != null ? span(t.durationMs) : 'đang chạy'],
    ['Mã thoát', t.exitCode ?? '—'],
    ['Dữ liệu ra', t.kind === 'transfer' ? bytes(t.outBytes) : `stdout ${bytes(t.outBytes)} · stderr ${bytes(t.errBytes)}`],
  ]
  return (
    <div className="flex flex-col gap-2.5 px-3.5 pt-1 pb-3.5">
      <Block title="Lệnh">{t.command}</Block>
      <div className="grid gap-x-4 gap-y-1 text-[12px]" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
        {rows.map(([k, v]) => (
          <span key={k}>
            <span className="text-muted">{k}: </span>
            <span className="num">{v}</span>
          </span>
        ))}
      </div>
      {t.error && <Block title="Lỗi" danger>{t.error}</Block>}
      {t.stderr && <Block title="stderr (phần đầu)">{t.stderr}</Block>}
      {t.stdout && <Block title="stdout (phần đầu)">{t.stdout}</Block>}
    </div>
  )
}

function Block({ title, danger, children }: { title: string; danger?: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-muted">{title}</span>
      <pre
        className={cx(
          'm-0 max-h-60 overflow-auto rounded-md px-2.5 py-2 font-mono text-[11.5px] leading-[1.5] break-all whitespace-pre-wrap select-text',
          danger ? 'bg-danger-soft text-danger' : 'bg-sunken text-ink2',
        )}
      >
        {children}
      </pre>
    </div>
  )
}
