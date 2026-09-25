import { Lock, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useConnections } from '../../app/connections'
import { useNav, type ModuleId } from '../../app/nav'
import { Chip, TONES, cx } from '../../components/ui/primitives'
import { api, isAppError, type AppError, type Health, type Server } from '../../lib/api'

const REFRESH_MS = 60_000

type ChipSpec = { text: string; tone: { fg: string; bg: string }; title?: string }
type Row = { label: string; value: string; dim?: boolean; chips?: ChipSpec[]; note?: ReactNode; locked?: string; module?: ModuleId }

function agoLabel(at: Date | null, now: number) {
  if (!at) return 'đang đọc…'
  const mins = Math.floor((now - at.getTime()) / 60_000)
  return mins < 1 ? 'cập nhật vừa xong' : `cập nhật ${mins} phút trước`
}

function when(ms: number) {
  const d = new Date(ms)
  const time = d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
  const today = new Date().toDateString() === d.toDateString()
  return today ? `${time} hôm nay` : `${time} ngày ${d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })}`
}

function rows(h: Health): Row[] {
  const out: Row[] = []

  const d = h.docker
  if (d.kind === 'notInstalled') out.push({ label: 'Docker', value: 'Chưa cài trên server này', dim: true, chips: [{ text: 'Chưa cài', tone: TONES.neutral }] })
  else if (d.kind === 'noAccess')
    out.push({ label: 'Docker', value: 'User này không có quyền dùng Docker', dim: true, locked: 'Cần quyền docker', note: 'Thêm user vào nhóm docker, hoặc kết nối bằng root.' })
  else if (d.kind === 'daemonDown')
    out.push({ label: 'Docker', value: 'Docker daemon không chạy', chips: [{ text: 'Không chạy', tone: TONES.danger, title: d.detail }], module: 'docker' })
  else
    out.push({
      label: 'Docker',
      value: `${d.running} đang chạy / ${d.total} container`,
      module: 'docker',
      chips: [
        ...(d.failed.length ? [{ text: `${d.failed.length} lỗi`, tone: TONES.danger, title: d.failed.map((c) => `${c.name} · ${c.status}`).join('\n') }] : []),
        ...(d.finished.length ? [{ text: `${d.finished.length} đã chạy xong`, tone: TONES.neutral, title: d.finished.map((c) => `${c.name} · ${c.status}`).join('\n') }] : []),
        ...(!d.failed.length && !d.finished.length ? [{ text: 'Ổn', tone: TONES.success }] : []),
      ],
    })

  const s = h.systemd
  if (s.kind === 'notSystemd') out.push({ label: 'Dịch vụ', value: 'Server không dùng systemd', dim: true, note: 'Portway đọc trạng thái dịch vụ qua systemd.' })
  else
    out.push({
      label: 'Dịch vụ',
      value: `${s.services} unit dịch vụ`,
      module: 'services',
      chips: s.failed.length ? [{ text: `${s.failed.length} lỗi`, tone: TONES.danger, title: s.failed.join('\n') }] : [{ text: 'Ổn', tone: TONES.success }],
      note: 'Đếm các unit systemd đang ở trạng thái failed.',
    })

  const u = h.updates
  const cmd = (m: string) => (m === 'apk' ? 'apk update' : 'apt update')
  if (u.kind === 'unsupported')
    out.push({ label: 'Bản cập nhật', value: 'Chưa hỗ trợ trên distro này', dim: true, note: 'Portway hiện đọc được apt (Debian, Ubuntu) và apk (Alpine).' })
  else if (u.kind === 'noIndex')
    out.push({
      label: 'Bản cập nhật',
      value: 'Chưa có danh sách gói',
      dim: true,
      note: (
        <>
          Server chưa từng chạy <span className="font-mono">{cmd(u.manager)}</span>, nên chưa biết gói nào có bản mới.
        </>
      ),
    })
  else {
    const security = u.upgrades.filter((p) => p.security)
    const list = (ps: typeof u.upgrades) => ps.map((p) => `${p.name} ${p.version}`).join('\n')
    out.push({
      label: 'Bản cập nhật',
      value: u.upgrades.length ? `${u.upgrades.length} gói có bản mới` : 'Không có gói nào cần cập nhật',
      chips: security.length
        ? [{ text: `${security.length} bảo mật`, tone: TONES.info, title: list(security) }]
        : u.upgrades.length
          ? [{ text: 'Có bản mới', tone: TONES.neutral, title: list(u.upgrades) }]
          : [{ text: 'Ổn', tone: TONES.success }],
      note: u.indexAt ? `Tính đến lần cập nhật danh sách gói (${cmd(u.manager)}) lúc ${when(u.indexAt)}.` : undefined,
    })
  }
  return out
}

/** "Tình trạng": Docker, systemd and pending package updates. Heavier than the
 *  live numbers, so it reads once, then every minute or on demand. */
export function HealthCard({ server, user }: { server: Server; user: string }) {
  const { markLost } = useConnections()
  const nav = useNav()
  const [health, setHealth] = useState<Health | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [at, setAt] = useState<Date | null>(null)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now())

  const load = useCallback(async () => {
    setBusy(true)
    try {
      setHealth(await api.health(server.id, user))
      setError(null)
      setAt(new Date())
    } catch (e) {
      const err = isAppError(e) ? e : { code: 'unknown', detail: String(e) }
      if (err.code === 'connection_lost' || err.code === 'not_connected') markLost(server.id, user, err)
      else setError(err)
    } finally {
      setBusy(false)
    }
  }, [server.id, user, markLost])

  useEffect(() => {
    void load()
    const refresh = setInterval(load, REFRESH_MS)
    const tick = setInterval(() => setNow(Date.now()), 30_000)
    return () => {
      clearInterval(refresh)
      clearInterval(tick)
    }
  }, [load])

  return (
    <div className="flex flex-col gap-1 rounded-xl border border-line bg-surface p-4">
      <div className="mb-1.5 flex items-start gap-2">
        <span className="flex-1 text-[15px] font-semibold">Tình trạng</span>
        <span className="inline-flex items-center gap-1.5 text-[11px] whitespace-nowrap text-muted">
          {error ? 'không đọc được' : agoLabel(at, now)}
          <button
            type="button"
            title="Làm mới"
            onClick={load}
            disabled={busy}
            className="flex size-5 cursor-pointer items-center justify-center rounded-[5px] border border-line2 text-ink2 hover:border-muted disabled:cursor-default"
          >
            <RefreshCw size={12} strokeWidth={1.9} className={busy ? 'animate-spin' : undefined} />
          </button>
        </span>
      </div>

      {error && (
        <span className="font-mono text-[11px] text-danger select-text">
          {error.code}
          {error.detail ? `: ${error.detail}` : ''}
        </span>
      )}

      {health
        ? rows(health).map((r) => (
            <div key={r.label} className="flex flex-col border-t border-line">
              <div className="flex items-center gap-2.5 px-1 py-[9px]">
                <button
                  type="button"
                  disabled={!r.module}
                  onClick={() => r.module && nav.openModule(r.module)}
                  className={cx('flex min-w-0 flex-1 items-baseline gap-2.5 text-left enabled:cursor-pointer enabled:hover:underline', r.dim && 'opacity-60')}
                >
                  <span className="w-24 flex-none font-semibold">{r.label}</span>
                  <span className="truncate text-[12px] text-ink2">{r.value}</span>
                </button>
                {r.chips?.map((c) => (
                  <span key={c.text} title={c.title}>
                    <Chip tone={c.tone}>{c.text}</Chip>
                  </span>
                ))}
                {r.locked && (
                  <span className="flex items-center gap-[5px] text-[11px] text-muted">
                    <Lock size={12} strokeWidth={1.9} />
                    {r.locked}
                  </span>
                )}
              </div>
              {r.note && <span className="-mt-1 pr-1 pb-[9px] pl-[106px] text-[11px] leading-snug text-muted">{r.note}</span>}
            </div>
          ))
        : [0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-2.5 border-t border-line px-1 py-3">
              <span className="block h-2.5 w-24 rounded-md bg-sunken" />
              <span className="block h-2.5 w-1/3 rounded-md bg-sunken" />
            </div>
          ))}
    </div>
  )
}
