import { isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { ArrowDown, ArrowLeft, Copy, Eraser, Pause, Play, RotateCw, WrapText } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useConnections } from '../../app/connections'
import { locale, t } from '../../i18n'
import { useToast } from '../../components/toast'
import { Button, cx } from '../../components/ui/primitives'
import { SearchInput } from '../../components/ui/search-input'
import { SegmentedControl } from '../../components/ui/segmented'
import { api, isAppError, type LogBatch, type Server } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import { fileError } from './format'

/** Lines kept on screen; older ones scroll away. */
const KEEP = 5000
/** Lines read back when following starts. */
const BACKLOG = 500

type Level = 'error' | 'warn' | 'info'
type Line = { n: number; text: string; level: Level }
type Status = { kind: 'starting' } | { kind: 'live' } | { kind: 'ended'; error: string | null }

// Words and HTTP statuses that mark a line; nginx access logs have the status after the request.
const ERROR_RE = /\b(error|err|fatal|crit(ical)?|panic|emerg|alert|exception|traceback|failed|failure|denied|refused)\b|"\s5\d\d\s|\s5\d\d\s\d+\s"/i
const WARN_RE = /\b(warn(ing)?|deprecated|timeout|timed out|retry(ing)?)\b|"\s4\d\d\s|\s4\d\d\s\d+\s"/i

export function levelOf(text: string): Level {
  if (ERROR_RE.test(text)) return 'error'
  if (WARN_RE.test(text)) return 'warn'
  return 'info'
}

/** `/regex/` as a regular expression, anything else as plain text; case-insensitive. */
function compileFilter(q: string): RegExp | null | 'bad' {
  const s = q.trim()
  if (!s) return null
  const m = /^\/(.+)\/$/.exec(s)
  try {
    return new RegExp(m ? m[1] : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
  } catch {
    return 'bad'
  }
}

function highlight(text: string, re: RegExp | null): ReactNode {
  if (!re) return text
  const out: ReactNode[] = []
  let last = 0
  re.lastIndex = 0
  for (const m of text.matchAll(re)) {
    if (!m[0]) break
    out.push(text.slice(last, m.index), <mark key={m.index} className="rounded-[2px] bg-[color-mix(in_srgb,var(--warn)_35%,transparent)] text-ink">{m[0]}</mark>)
    last = m.index! + m[0].length
  }
  out.push(text.slice(last))
  return out
}

/** "Theo dõi log": `tail -F` of one file, streamed, with filter and levels. */
export function LogTail({ server, user, path, sudo, onClose }: { server: Server; user: string; path: string; sudo: boolean; onClose: () => void }) {
  const { markLost } = useConnections()
  const toast = useToast()
  const [lines, setLines] = useState<Line[]>([])
  const [status, setStatus] = useState<Status>({ kind: 'starting' })
  const [notes, setNotes] = useState<string[]>([])
  const [dropped, setDropped] = useState(0)
  const [run, setRun] = useState(0)
  const counter = useRef(0)

  // Frozen view: new lines wait here until "Tiếp tục".
  const [paused, setPaused] = useState(false)
  const held = useRef<Line[]>([])
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const [heldCount, setHeldCount] = useState(0)

  useEffect(() => {
    let id: string | null = null
    let alive = true
    const pending: LogBatch[] = []
    const take = (b: LogBatch) => {
      const fresh = b.lines.map((text) => ({ n: ++counter.current, text, level: levelOf(text) }))
      if (pausedRef.current) {
        held.current = [...held.current, ...fresh].slice(-KEEP)
        setHeldCount(held.current.length)
      } else if (fresh.length) setLines((l) => [...l, ...fresh].slice(-KEEP))
      if (b.dropped) setDropped((d) => d + b.dropped)
      if (b.notes.length) setNotes((n) => [...n, ...b.notes].slice(-5))
      if (b.ended) setStatus({ kind: 'ended', error: b.error })
    }
    const off = isTauri()
      ? listen<LogBatch>('logtail', (e) => {
          if (id === null) pending.push(e.payload)
          else if (e.payload.id === id) take(e.payload)
        })
      : null
    api
      .logTailStart(server.id, user, path, BACKLOG, sudo)
      .then((got) => {
        if (!alive) return void api.logTailStop(got)
        id = got
        setStatus({ kind: 'live' })
        pending.filter((b) => b.id === got).forEach(take)
      })
      .catch((e) => {
        const err = isAppError(e) ? e : { code: 'unknown', detail: String(e) }
        if (err.code === 'connection_lost' || err.code === 'not_connected') markLost(server.id, user, err)
        setStatus({ kind: 'ended', error: err.code === 'too_many_tails' ? t('Đang theo dõi quá {n} tệp trên phiên này', { n: err.detail ?? '' }) : fileError(err) })
      })
    return () => {
      alive = false
      if (id) void api.logTailStop(id)
      void off?.then((f) => f())
    }
    // A new run (Theo dõi lại) restarts it.
  }, [server.id, user, path, sudo, run, markLost])

  const restart = () => {
    setLines([])
    setNotes([])
    setDropped(0)
    held.current = []
    setHeldCount(0)
    setPaused(false)
    setStatus({ kind: 'starting' })
    setRun((r) => r + 1)
  }

  const resume = () => {
    setLines((l) => [...l, ...held.current].slice(-KEEP))
    held.current = []
    setHeldCount(0)
    setPaused(false)
  }

  // Filter and level.
  const [query, setQuery] = useState('')
  const [level, setLevel] = useState<'all' | 'error' | 'warn'>('all')
  const [wrap, setWrap] = useState(false)
  const re = compileFilter(query)
  const bad = re === 'bad'
  const rx = bad ? null : re
  const shown = useMemo(
    () =>
      lines.filter((l) => {
        if (level === 'error' && l.level !== 'error') return false
        if (level === 'warn' && l.level === 'info') return false
        if (!rx) return true
        rx.lastIndex = 0
        return rx.test(l.text)
      }),
    [lines, level, rx],
  )
  const errors = lines.filter((l) => l.level === 'error').length
  const warns = lines.filter((l) => l.level === 'warn').length

  // Stick to the bottom unless the user scrolled up to read.
  const box = useRef<HTMLDivElement>(null)
  const [stick, setStick] = useState(true)
  useEffect(() => {
    if (stick && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [shown, stick, wrap])
  const onScroll = () => {
    const el = box.current
    if (el) setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
  }

  const copyShown = () => {
    const text = shown.map((l) => l.text).join('\n')
    void copyText(text).then(() => toast({ title: t('Đã sao chép {n} dòng', { n: shown.length }), detail: path }))
  }

  const live = status.kind === 'live'
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onClose}>
          <ArrowLeft size={14} strokeWidth={1.8} />
          {t('Danh sách tệp')}
        </Button>
        <div className="flex min-w-[220px] flex-1 flex-col">
          <span className="truncate font-mono text-[12.5px] font-semibold" title={path}>
            {path}
          </span>
          <span className="flex items-center gap-1.5 text-[11px] text-muted">
            <span
              className={cx('size-1.5 rounded-full', live && !paused && 'animate-pulse')}
              style={{ background: live ? (paused ? 'var(--warn)' : 'var(--success)') : status.kind === 'starting' ? 'var(--muted)' : 'var(--danger)' }}
            />
            {status.kind === 'starting'
              ? t('Đang mở…')
              : status.kind === 'ended'
                ? (status.error ?? t('Đã dừng'))
                : paused
                  ? heldCount
                    ? t('Tạm dừng · {n} dòng mới đang chờ', { n: heldCount })
                    : t('Tạm dừng#status')
                  : sudo
                    ? t('Đang theo dõi · tail -F qua sudo')
                    : t('Đang theo dõi · tail -F')}
            {dropped > 0 && t(' · bỏ qua {n} dòng vì ghi quá nhanh', { n: dropped.toLocaleString(locale()) })}
          </span>
        </div>
        {status.kind === 'ended' ? (
          <Button size="sm" onClick={restart}>
            <RotateCw size={14} strokeWidth={1.8} />
            {t('Theo dõi lại')}
          </Button>
        ) : (
          <Button size="sm" disabled={!live} onClick={() => (paused ? resume() : setPaused(true))}>
            {paused ? <Play size={14} strokeWidth={1.8} /> : <Pause size={14} strokeWidth={1.8} />}
            {paused ? t('Tiếp tục') : t('Tạm dừng')}
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={query} onChange={setQuery} placeholder={t('Lọc dòng (chữ, hoặc /regex/)')} className={cx('w-72 min-w-0', bad && '[&_input]:text-danger')} />
        <SegmentedControl
          value={level}
          onChange={setLevel}
          options={[
            { id: 'all', label: t('Tất cả {n}', { n: lines.length }) },
            { id: 'error', label: t('Lỗi {n}', { n: errors }) },
            { id: 'warn', label: t('Lỗi + cảnh báo {n}', { n: errors + warns }) },
          ]}
        />
        <span className="flex-1" />
        {(query || level !== 'all') && <span className="num text-[11px] text-muted">{t('{n} dòng khớp', { n: shown.length })}</span>}
        <IconButton title={wrap ? t('Không ngắt dòng') : t('Ngắt dòng dài')} on={wrap} onClick={() => setWrap(!wrap)}>
          <WrapText size={14} strokeWidth={1.8} />
        </IconButton>
        <IconButton title={t('Sao chép các dòng đang hiện')} onClick={copyShown}>
          <Copy size={14} strokeWidth={1.8} />
        </IconButton>
        <IconButton
          title={t('Xoá màn hình (không đụng tới tệp)')}
          onClick={() => {
            setLines([])
            held.current = []
            setHeldCount(0)
          }}
        >
          <Eraser size={14} strokeWidth={1.8} />
        </IconButton>
      </div>

      {notes.length > 0 && (
        <div className="flex flex-col gap-0.5 rounded-lg px-3 py-2 font-mono text-[11.5px] text-warn" style={{ background: 'var(--warn-soft)' }}>
          {notes.map((n, i) => (
            <span key={i}>{n}</span>
          ))}
        </div>
      )}

      <div className="relative flex min-h-[240px] flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface">
        <div ref={box} onScroll={onScroll} className="min-h-0 flex-1 overflow-auto overscroll-contain py-1.5 font-mono text-[11.5px] leading-[1.55]">
          {shown.length === 0 ? (
            <div className="p-7 text-center font-sans text-muted">
              {status.kind === 'starting' ? t('Đang đọc…') : lines.length ? t('Không có dòng nào khớp bộ lọc.') : t('Tệp chưa có dòng nào. Dòng mới sẽ hiện ở đây ngay khi được ghi.')}
            </div>
          ) : (
            shown.map((l) => (
              <div
                key={l.n}
                className={cx('flex gap-3 px-3 hover:bg-raised', l.level === 'error' ? 'text-danger' : l.level === 'warn' ? 'text-warn' : 'text-ink2')}
                style={l.level === 'error' ? { background: 'color-mix(in srgb, var(--danger) 7%, transparent)' } : undefined}
              >
                <span className="num w-12 flex-none text-right text-muted select-none">{l.n}</span>
                <span className={cx('min-w-0 select-text', wrap ? 'break-all whitespace-pre-wrap' : 'whitespace-pre')}>{highlight(l.text, rx)}</span>
              </div>
            ))
          )}
        </div>
        {!stick && shown.length > 0 && (
          <button
            type="button"
            onClick={() => setStick(true)}
            className="absolute right-4 bottom-3 flex cursor-pointer items-center gap-1.5 rounded-full border border-line2 bg-surface px-3 py-1.5 text-[11.5px] shadow-pop"
          >
            <ArrowDown size={13} strokeWidth={1.8} />
            {t('Xuống dòng mới nhất')}
          </button>
        )}
      </div>
    </div>
  )
}

function IconButton({ title, onClick, on, children }: { title: string; onClick: () => void; on?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cx(
        'flex size-8 cursor-pointer items-center justify-center rounded-lg border hover:border-muted',
        on ? 'border-ink2 bg-raised text-ink' : 'border-line2 text-ink',
      )}
    >
      {children}
    </button>
  )
}
