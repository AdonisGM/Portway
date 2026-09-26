import { Check } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Field, TextInput } from '../../components/ui/form-controls'
import { Modal } from '../../components/ui/modal'
import { Button, cx } from '../../components/ui/primitives'
import { SearchInput } from '../../components/ui/search-input'
import { SegmentedControl } from '../../components/ui/segmented'
import { api, isAppError, type JournalLine, type Server, type UnitBrief } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import { t } from '../../i18n'
import { serviceCommand } from './format'
import { dayMonth, hms } from '../../i18n/dates'

const errText = (e: unknown) => (isAppError(e) ? (e.detail ?? e.code) : String(e))

/** "+ Theo dõi unit": every service unit on the server, tick the ones to show. */
export function PickUnits({
  server,
  user,
  watched,
  onChange,
  onClose,
}: {
  server: Server
  user: string
  watched: string[]
  onChange: (units: string[]) => void
  onClose: () => void
}) {
  const [all, setAll] = useState<UnitBrief[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  useEffect(() => {
    api.servicesAll(server.id, user).then(setAll, (e) => setError(errText(e)))
  }, [server.id, user])

  const q = query.trim().toLowerCase()
  const shown = (all ?? []).filter((u) => !q || `${u.name} ${u.description}`.toLowerCase().includes(q))
  const state = (u: UnitBrief) =>
    u.active === 'active'
      ? t('đang chạy')
      : u.active === 'failed'
        ? t('lỗi')
        : u.active === ''
          ? t('chưa nạp')
          : u.active === 'inactive'
            ? t('không chạy')
            : u.active

  return (
    <Modal open onClose={onClose} width={600} title={t('Theo dõi unit')}
      subtitle={t('systemctl list-units --type=service trên {server}', { server: server.name })}
    >
      <SearchInput value={query} onChange={setQuery} placeholder={t('Tìm unit, ví dụ postgres, redis')} className="w-full" />
      <div className="flex max-h-[52vh] flex-col overflow-auto overscroll-contain rounded-lg border border-line">
        {!all && !error && <span className="px-3 py-3 text-muted">{t('Đang đọc danh sách unit…')}</span>}
        {error && <span className="px-3 py-3 text-danger select-text">{error}</span>}
        {shown.map((u) => {
          const on = watched.includes(u.name)
          return (
            <button
              key={u.name}
              type="button"
              onClick={() => onChange(on ? watched.filter((x) => x !== u.name) : [...watched, u.name])}
              className="flex cursor-pointer items-center gap-2.5 border-t border-line px-3 py-2 text-left first:border-t-0 hover:bg-raised"
            >
              <span className={cx('flex size-4 flex-none items-center justify-center rounded-[4px] border', on ? 'border-accent bg-accent text-accent-fg' : 'border-line2')}>
                {on && <Check size={12} strokeWidth={3} />}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-mono text-[12px]">{u.name}</span>
                {u.description && <span className="truncate text-[11.5px] text-muted">{u.description}</span>}
              </span>
              <span className={cx('text-[11.5px] whitespace-nowrap', u.active === 'failed' ? 'text-danger' : 'text-muted')}>{state(u)}</span>
            </button>
          )
        })}
      </div>
      {all && (
        <span className="text-[11.5px] text-muted">
          {t('{n} unit đang theo dõi · {total} unit dịch vụ trên server', { n: watched.length, total: all.length })}
        </span>
      )}
    </Modal>
  )
}

/** `systemctl cat`: the unit file and its drop-ins. */
export function UnitFile({ server, user, unit, onClose }: { server: Server; user: string; unit: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api.servicesUnitFile(server.id, user, unit).then(setText, (e) => setError(errText(e)))
  }, [server.id, user, unit])
  return (
    <Modal
      open
      onClose={onClose}
      width={720}
      title={t('File unit · {unit}', { unit })}
      subtitle={`systemctl cat ${unit}`}
      footer={
        <>
          <Button onClick={() => text && void copyText(text)} disabled={!text}>
            {t('Sao chép')}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t('Đóng')}
          </Button>
        </>
      }
    >
      {error && <span className="text-danger select-text">{error}</span>}
      <pre className="m-0 max-h-[60vh] overflow-auto rounded-lg bg-sunken px-3 py-2.5 font-mono text-[11.5px] leading-[1.55] whitespace-pre-wrap text-ink2 select-text">
        {text ?? (error ? '' : t('Đang đọc…'))}
      </pre>
    </Modal>
  )
}

type Level = 'all' | 'warn' | 'error'
const levels = (): { id: Level; label: string }[] => [
  { id: 'all', label: t('Tất cả') },
  { id: 'warn', label: t('Cảnh báo + lỗi') },
  { id: 'error', label: t('Lỗi#level') },
]
const clock = (ms: number) => {
  const d = new Date(ms)
  return `${dayMonth(d)} ${hms(d)}`
}
const levelOf = (p: number | null) => (p == null ? null : p <= 3 ? 'ERROR' : p === 4 ? 'WARN' : null)

/** journalctl -u UNIT, with priority from the journal itself. */
export function JournalDialog({ server, user, sudo, unit, onClose }: { server: Server; user: string; sudo: boolean; unit: string; onClose: () => void }) {
  const [lines, setLines] = useState<JournalLine[] | null>(null)
  const [limited, setLimited] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [level, setLevel] = useState<Level>('all')
  const [query, setQuery] = useState('')
  const [live, setLive] = useState(false)
  const cursor = useRef<string | null>(null)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let stop = false
    const read = async (follow: boolean) => {
      try {
        const page = await api.servicesJournal(server.id, user, unit, follow ? 2000 : 300, follow ? cursor.current : null)
        if (stop) return
        cursor.current = page.cursor
        setLimited(page.limited)
        setLines((prev) => (follow ? [...(prev ?? []), ...page.lines].slice(-3000) : page.lines))
        setError(null)
      } catch (e) {
        if (!stop) setError(errText(e))
      }
    }
    if (!live) {
      void read(false)
      return () => {
        stop = true
      }
    }
    const timer = setInterval(() => void read(true), 2000)
    return () => {
      stop = true
      clearInterval(timer)
    }
  }, [server.id, user, unit, live])

  const q = query.trim().toLowerCase()
  const shown = (lines ?? [])
    .map((l) => ({ ...l, lv: levelOf(l.priority) }))
    .filter((l) => (level === 'all' || (level === 'error' ? l.lv === 'ERROR' : l.lv != null)) && (!q || l.message.toLowerCase().includes(q)))
  const count = shown.length
  useEffect(() => {
    const el = box.current
    if (el) el.scrollTop = el.scrollHeight
  }, [count])

  const cmd = `${sudo && user !== 'root' ? 'sudo ' : ''}journalctl -u ${unit} ${live ? '-f' : '-n 300'}`
  return (
    <Modal open onClose={onClose} width={860} title={`Log · ${unit}`} subtitle={`${cmd} · ${server.name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl value={level} onChange={setLevel} options={levels()} />
        <SearchInput value={query} onChange={setQuery} placeholder={t('Lọc theo chữ')} className="w-44 min-w-0" />
        <span className="flex-1" />
        <span className="flex items-center gap-1.5 text-[11.5px] text-muted">
          <span className="size-1.5 rounded-full" style={{ background: live ? 'var(--success)' : 'var(--muted)' }} />
          {lines ? t('{n} dòng', { n: shown.length }) : t('Đang đọc…')}
          {live ? ' · ' + t('đang theo dõi') : ''}
        </span>
        <Button size="xs" onClick={() => setLive(!live)}>
          {live ? t('Tạm dừng') : t('Theo dõi trực tiếp')}
        </Button>
        <Button variant="ghost" size="xs" onClick={() => void api.openTerminal(server.id, user, 'unitLog', undefined, unit)}>
          {t('Mở trong Terminal')}
        </Button>
      </div>
      {limited && (
        <span className="rounded-md bg-warn-soft px-2.5 py-1.5 text-[11.5px] text-ink2">
          {t(
            'User {user} không được đọc journal hệ thống (cần root hoặc thuộc group systemd-journal / adm), nên journalctl không trả về dòng nào của unit này. Bật sudo cho phiên này để xem.',
            { user },
          )}
        </span>
      )}
      <div ref={box} className="h-[56vh] overflow-auto overscroll-contain rounded-lg border border-line bg-sunken py-1 font-mono text-[11.5px] leading-[1.55]">
        {error && <div className="px-3 py-2 text-danger select-text">{error}</div>}
        {shown.map((l, i) => (
          <div key={`${l.at}|${i}`} className={cx('grid gap-3 px-3 py-px', l.lv === 'ERROR' && 'bg-danger-soft')} style={{ gridTemplateColumns: '112px 44px minmax(0,1fr)' }}>
            <span className="text-muted">{clock(l.at)}</span>
            <span className={l.lv === 'ERROR' ? 'text-danger' : l.lv === 'WARN' ? 'text-warn' : 'text-muted'}>{l.lv ?? ''}</span>
            <span className="break-all whitespace-pre-wrap text-ink select-text">{l.message}</span>
          </div>
        ))}
        {lines && !shown.length && !error && (
          <div className="px-3 py-6 text-center font-sans text-muted">
            {q || level !== 'all'
              ? t('Không có dòng nào khớp bộ lọc')
              : limited
                ? t('Không đọc được journal bằng user này')
                : t('Journal chưa có dòng nào của unit này')}
          </div>
        )}
      </div>
    </Modal>
  )
}

/** Stopping SSH needs the unit's name typed: it is how Portway reaches the server. */
export function StopSsh({
  server,
  user,
  sudo,
  unit,
  onClose,
  onDone,
}: {
  server: Server
  user: string
  sudo: boolean
  unit: string
  onClose: () => void
  onDone: () => void
}) {
  const [typed, setTyped] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cmd = `${sudo && user !== 'root' ? 'sudo ' : ''}${serviceCommand(unit, 'stop')}`
  const go = async () => {
    setPending(true)
    setError(null)
    try {
      await api.servicesAction(server.id, user, unit, 'stop')
      onDone()
    } catch (e) {
      setError(errText(e))
    } finally {
      setPending(false)
    }
  }
  return (
    <Modal
      open
      onClose={() => !pending && onClose()}
      width={480}
      title={t('Dừng {name}?', { name: unit })}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            {t('Huỷ')}
          </Button>
          <Button variant="danger" onClick={() => void go()} disabled={pending || typed !== unit}>
            {pending ? t('Đang dừng…') : t('Dừng SSH')}
          </Button>
        </>
      }
    >
      <div className="rounded-lg bg-danger-soft px-3 py-2.5 leading-normal text-ink">
        {t('Dừng SSH có thể khiến bạn mất quyền truy cập server. Portway đang dùng chính SSH để kết nối tới {server}.', { server: server.name })}
      </div>
      <span className="leading-relaxed text-ink2">{t('Chỉ làm khi bạn có cách khác để vào server (console của nhà cung cấp, KVM).')}</span>
      <Field label={t('Gõ lại tên unit để xác nhận')}>
        <TextInput value={typed} onChange={setTyped} placeholder={unit} autoFocus />
      </Field>
      <span className="rounded-md bg-sunken px-2.5 py-2 font-mono text-[11.5px] select-text">{cmd}</span>
      {error && <span className="rounded-md bg-danger-soft px-2 py-1.5 font-mono text-[11.5px] break-all text-danger select-text">{error}</span>}
    </Modal>
  )
}
