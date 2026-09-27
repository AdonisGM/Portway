import { Activity, AlertTriangle, CircleDot, Clock, Layers, Pause, Play, Trash2, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ServersProvider, useServers } from '../app/servers'
import { SLOW_MS, TraceProvider, useTrace, type TraceFilter } from '../app/trace'
import { Button, Chip, cx, TONES } from '../components/ui/primitives'
import { SearchInput } from '../components/ui/search-input'
import type { TraceEntry, TraceKind } from '../lib/api'
import { locale, t } from '../i18n'
import { useLang } from '../i18n/use-lang'
import { isWindows } from '../lib/platform'

/** The separate "Nhật ký gỡ lỗi" window (opened from the rail). */
export function DebugWindow() {
  // Re-render everything below when the language changes.
  useLang()
  return (
    <ServersProvider>
      <TraceProvider>
        <div className="flex h-full flex-col overflow-hidden bg-bg text-[12.5px] text-ink">
          {/* Windows keeps its native title bar, which already says this. */}
          {!isWindows && (
            <header data-tauri-drag-region className="flex h-[38px] flex-none items-center gap-3.5 border-b border-line bg-rail pr-3.5 pl-[84px]">
              <span data-tauri-drag-region className="flex items-center gap-1.5 text-[13px] font-semibold tracking-[-0.01em]">
                AdonisGM <span data-tauri-drag-region className="font-normal text-muted">|</span> Portway
              </span>
              <span data-tauri-drag-region className="truncate text-[12px] text-muted">
                {t('Nhật ký gỡ lỗi')}
              </span>
              <span data-tauri-drag-region className="flex-1 self-stretch" />
            </header>
          )}
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

/** Name of a trace kind, in the current language. */
const kindLabel = (k: TraceKind) => ({ exec: t('Lệnh'), sftp: 'SFTP', connect: t('Kết nối#kind'), transfer: t('Chuyển tệp') })[k]

const isLive = (e: TraceEntry) => e.status === 'running' || e.status === 'waiting'
const isSlow = (e: TraceEntry) => (e.durationMs ?? 0) >= SLOW_MS
const sessionKey = (e: TraceEntry) => `${e.serverId}|${e.user}`

function matches(e: TraceEntry, f: TraceFilter) {
  if (f.session && sessionKey(e) !== f.session) return false
  if (f.status === 'running') return isLive(e)
  if (f.status === 'error') return e.status === 'error'
  if (f.status === 'slow') return isSlow(e)
  return true
}

/** Left column: what to show. */
function Filters() {
  const { list, filter, setFilter } = useTrace()
  const { byId } = useServers()
  const sessions = useMemo(() => [...new Set(list.map(sessionKey))], [list])
  const count = (status: TraceFilter['status']) => list.filter((e) => matches(e, { status, session: filter.session })).length

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
      <span className="px-2.5 pt-1 pb-2.5 text-[15px] font-semibold">{t('Nhật ký gỡ lỗi')}</span>
      {item(Layers, t('Tất cả'), filter.status === 'all', () => setFilter({ ...filter, status: 'all' }), count('all'))}
      {item(Activity, t('Đang chạy'), filter.status === 'running', () => setFilter({ ...filter, status: 'running' }), count('running'))}
      {item(AlertTriangle, t('Lỗi'), filter.status === 'error', () => setFilter({ ...filter, status: 'error' }), count('error'), 'danger')}
      {item(Clock, t('Chậm (≥ {s} giây)', { s: SLOW_MS / 1000 }), filter.status === 'slow', () => setFilter({ ...filter, status: 'slow' }), count('slow'), 'warn')}

      <span className="mt-3 px-2.5 pb-1 text-[11px] tracking-[.06em] text-muted uppercase">{t('Phiên')}</span>
      {item(CircleDot, t('Tất cả phiên'), !filter.session, () => setFilter({ ...filter, session: null }))}
      {sessions.map((k) => {
        const [id, user] = k.split('|')
        return <span key={k}>{item(CircleDot, `${byId(id)?.name ?? id} · ${user}`, filter.session === k, () => setFilter({ ...filter, session: k }))}</span>
      })}

      <span className="mt-auto px-2.5 pt-4 text-[11px] leading-relaxed text-muted">
        {t('Giữ 2000 mục gần nhất, chỉ trong bộ nhớ, mất khi tắt app. Mật khẩu sudo đi qua stdin nên không bao giờ nằm trong nhật ký.')}
      </span>
    </aside>
  )
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')
const clock = (ms: number) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}
/** A number with `d` decimals, in the current locale ("1,5" in Vietnamese, "1.5" in English). */
const dec = (n: number, d: number) => n.toLocaleString(locale(), { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: false })
const span = (ms: number) => (ms < 1000 ? `${ms} ms` : `${dec(ms / 1000, ms < 10_000 ? 2 : 1)} s`)
const bytes = (n: number | null) => (n == null ? '—' : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${dec(n / 1024, 1)} KB` : `${dec(n / 1048576, 1)} MB`)
const firstLine = (s: string) => s.split('\n').map((l) => l.trim()).find(Boolean) ?? ''

/** Re-render every `ms` while something is running, for live elapsed times. */
function useTick(on: boolean, ms = 250) {
  const [, set] = useState(0)
  useEffect(() => {
    if (!on) return
    const id = setInterval(() => set((n) => n + 1), ms)
    return () => clearInterval(id)
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
  const shown = source.filter((e) => matches(e, filter) && (!q || e.label.toLowerCase().includes(q) || e.command.toLowerCase().includes(q))).reverse()
  const live = list.filter(isLive)
  const who = (e: TraceEntry) => `${byId(e.serverId)?.name ?? e.serverId} · ${e.user}`
  const newer = frozen ? list.length - frozen.length : 0

  return (
    <>
      <div className="flex flex-none flex-wrap items-center gap-2">
        <div className="flex min-w-[220px] flex-1 flex-col gap-0.5">
          <span className="text-[15px] font-semibold">{t('Portway đang làm gì trên server')}</span>
          <span className="text-muted">
            {t('{n} mục#entry', { n: list.length })} · {running ? t('{n} đang chạy', { n: running }) : t('không có gì đang chạy')}
            {frozen && <> · {newer > 0 ? t('đã tạm dừng, {n} mục mới chưa hiện', { n: newer }) : t('đã tạm dừng')}</>}
          </span>
        </div>
        <SearchInput value={query} onChange={setQuery} placeholder={t('Tìm theo việc hoặc lệnh')} className="w-64 min-w-0" />
        <Button size="sm" onClick={() => setFrozen(frozen ? null : list)}>
          <span className="flex items-center gap-1.5">
            {frozen ? <Play size={13} strokeWidth={1.8} /> : <Pause size={13} strokeWidth={1.8} />}
            {frozen ? t('Tiếp tục#resume') : t('Tạm dừng#pause')}
          </span>
        </Button>
        <Button size="sm" onClick={clear} title={t('Xoá các mục đã xong')}>
          <span className="flex items-center gap-1.5">
            <Trash2 size={13} strokeWidth={1.8} />
            {t('Xoá#clear')}
          </span>
        </Button>
      </div>

      {live.length > 0 && (
        <div className="flex max-h-[30%] flex-none flex-col overflow-hidden rounded-xl border border-line2 bg-surface">
          <div className="flex-none border-b border-line px-3.5 py-2 font-semibold">{t('Đang chạy ({n})', { n: live.length })}</div>
          <div className="min-h-0 overflow-auto overscroll-contain">
            {[...live].reverse().map((e) => (
              <div key={e.id} className="grid items-center gap-3 border-t border-line px-3.5 py-1.5 first:border-t-0" style={{ gridTemplateColumns: '160px minmax(0,1fr) 150px' }}>
                <span className="truncate text-ink2">{who(e)}</span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{e.label}</span>
                  <span className="truncate font-mono text-[11px] text-muted">{firstLine(e.command)}</span>
                </span>
                <span className={cx('num text-right text-[12px]', e.status === 'waiting' ? 'text-warn' : 'text-ink2')}>
                  {e.status === 'waiting' ? t('đợi kênh SSH') : t('đang chạy')} {span(Math.max(0, now - e.at))}
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
              <span>{t('Thời điểm')}</span>
              <span>{t('Phiên')}</span>
              <span>{t('Loại')}</span>
              <span>{t('Việc · lệnh')}</span>
              <span className="text-right" title={t('Thời gian đợi kênh SSH trống')}>
                {t('Đợi')}
              </span>
              <span className="text-right">{t('Thời gian#duration')}</span>
              <span>{t('Kết quả')}</span>
            </div>
            {shown.map((e) => (
              <Row key={e.id} e={e} who={who(e)} now={now} open={open === e.id} onToggle={() => setOpen(open === e.id ? null : e.id)} />
            ))}
            {!shown.length && <div className="p-8 text-center text-muted">{list.length ? t('Không có mục nào khớp bộ lọc.') : t('Chưa có gì. Kết nối một server để thấy các lệnh Portway gửi lên.')}</div>}
          </div>
        </div>
      </div>
    </>
  )
}

function result(e: TraceEntry): { tone: (typeof TONES)[keyof typeof TONES]; label: string } {
  if (e.status === 'waiting') return { tone: TONES.warn, label: t('Đợi kênh') }
  if (e.status === 'running') return { tone: TONES.info, label: t('Đang chạy') }
  if (e.status === 'ok') return { tone: TONES.success, label: e.exitCode != null ? `OK · exit ${e.exitCode}` : 'OK' }
  return { tone: TONES.danger, label: e.error ?? t('Lỗi') }
}

function Row({ e, who, now, open, onToggle }: { e: TraceEntry; who: string; now: number; open: boolean; onToggle: () => void }) {
  const r = result(e)
  const elapsed = e.durationMs ?? (isLive(e) ? Math.max(0, now - e.at) : null)
  return (
    <div className={cx('border-t border-line', open && 'bg-raised')}>
      <button type="button" onClick={onToggle} className="grid w-full cursor-pointer items-center gap-3 px-3.5 py-[7px] text-left hover:bg-raised" style={{ gridTemplateColumns: COLS }}>
        <span className="num font-mono text-[11.5px] text-muted">{clock(e.at)}</span>
        <span className="truncate text-ink2">{who}</span>
        <span className="text-[11.5px] text-ink2">{kindLabel(e.kind)}</span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{e.label}</span>
          <span className="truncate font-mono text-[11px] text-muted">{firstLine(e.command)}</span>
        </span>
        <span className={cx('num text-right text-[11.5px]', (e.waitMs ?? 0) >= 500 ? 'text-warn' : 'text-muted')}>{e.waitMs ? span(e.waitMs) : '—'}</span>
        <span className={cx('num text-right text-[12px]', elapsed != null && elapsed >= SLOW_MS ? 'text-warn' : 'text-ink')}>{elapsed == null ? '—' : span(elapsed)}</span>
        <span className="min-w-0">
          <Chip tone={r.tone} className="max-w-full truncate">
            {r.label}
          </Chip>
        </span>
      </button>
      {open && <Details e={e} />}
    </div>
  )
}

function Details({ e }: { e: TraceEntry }) {
  const rows: [string, ReactNode][] = [
    [t('Bắt đầu#time'), new Date(e.at).toLocaleString(locale())],
    [t('Đợi kênh SSH'), e.waitMs != null ? span(e.waitMs) : '—'],
    [t('Thời gian chạy'), e.durationMs != null ? span(e.durationMs) : t('đang chạy')],
    [t('Mã thoát'), e.exitCode ?? '—'],
    [t('Dữ liệu ra'), e.kind === 'transfer' ? bytes(e.outBytes) : `stdout ${bytes(e.outBytes)} · stderr ${bytes(e.errBytes)}`],
  ]
  return (
    <div className="flex flex-col gap-2.5 px-3.5 pt-1 pb-3.5">
      <Block title={t('Lệnh')}>{e.command}</Block>
      <div className="grid gap-x-4 gap-y-1 text-[12px]" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
        {rows.map(([k, v]) => (
          <span key={k}>
            <span className="text-muted">{k}: </span>
            <span className="num">{v}</span>
          </span>
        ))}
      </div>
      {e.error && <Block title={t('Lỗi')} danger>{e.error}</Block>}
      {e.stderr && <Block title={t('stderr (phần đầu)')}>{e.stderr}</Block>}
      {e.stdout && <Block title={t('stdout (phần đầu)')}>{e.stdout}</Block>}
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
