import { FilePen, FileText, FolderOpen, Globe, Lock, RotateCw, ScrollText } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useConnections } from '../../app/connections'
import { useEdits } from '../../app/edits'
import { useNav } from '../../app/nav'
import { readCache, writeCache } from '../../app/session-cache'
import { useToast } from '../../components/toast'
import { Modal } from '../../components/ui/modal'
import { Button, Chip, cx, TONES } from '../../components/ui/primitives'
import { t } from '../../i18n'
import { api, isAppError, type AppError, type NginxAction, type NginxResult, type NginxSite, type NginxState, type Server } from '../../lib/api'
import { LogTail } from '../files/log-tail'
import { fullTime, q } from '../files/format'

/** Columns of the sites list: domain box, what nginx does, target box. */
const SITE_COLS = '220px minmax(0,1fr) 220px'

/** Certificates this close to the end are flagged. */
const SOON = 14

const asError = (e: unknown): AppError => (isAppError(e) ? e : { code: 'unknown', detail: String(e) })
/** A site's name: its first server_name; the catch-all `_` or no name shows where it listens. */
function nameOf(s: NginxSite) {
  const name = s.names.find((n) => n !== '_' && n !== '')
  if (name) return name
  const l = s.listens[0]
  const at = l ? `${l.addr === '*' ? '' : l.addr}:${l.port}` : s.file.split('/').pop()!
  return s.names.includes('_') ? t('Mặc định {at}', { at }) : at
}
const parentOf = (p: string) => p.replace(/\/[^/]+$/, '') || '/'

const typeLabel = (kind: NginxSite['target']['kind']) =>
  ({ proxy: 'Reverse proxy', static: t('Web tĩnh'), redirect: t('Chuyển hướng'), fixed: t('Trả lời cố định'), other: t('Khác') })[kind]

function targetText(s: NginxSite) {
  const tg = s.target
  return tg.kind === 'proxy'
    ? tg.url
    : tg.kind === 'static'
      ? tg.root
      : tg.kind === 'redirect'
        ? `${tg.code} → ${tg.to}`
        : tg.kind === 'fixed'
          ? t('return {code} (nginx tự trả lời)', { code: tg.code })
          : t('Không có proxy_pass, root hay return')
}

function certLine(s: NginxSite): { text: string; tone: 'ok' | 'warn' | 'bad' | 'none' } {
  if (!s.ssl) return { text: t('Không SSL'), tone: 'none' }
  if (!s.enabled) return { text: t('SSL · site đang tắt'), tone: 'none' }
  if (!s.cert) return { text: t('SSL · không đọc được chứng chỉ'), tone: 'warn' }
  const d = s.cert.daysLeft
  if (d < 0) return { text: t('SSL đã hết hạn {n} ngày', { n: -d }), tone: 'bad' }
  if (d < SOON) return { text: t('SSL hết hạn sau {n} ngày', { n: d }), tone: 'warn' }
  return { text: t('SSL còn {n} ngày', { n: d }), tone: 'ok' }
}

const TONE_FG = { ok: 'var(--muted)', warn: 'var(--warn)', bad: 'var(--danger)', none: 'var(--muted)' }

/** Enable or disable: only for sites managed through sites-available/sites-enabled. */
function toggleOf(s: NginxSite): NginxAction | null {
  if (!s.available) return null
  if (s.enabled) return s.file.startsWith('/etc/nginx/sites-enabled/') ? { op: 'disable', link: s.file } : null
  return { op: 'enable', file: s.available }
}

type Pending = { action: NginxAction; title: string; confirm: string; danger?: boolean; note: string }

/** The "Nginx" module: sites as nginx loads them, their certificates and targets. */
export function NginxScreen({ server, user }: { server: Server; user: string }) {
  const conns = useConnections()
  const nav = useNav()
  const toast = useToast()
  const edits = useEdits()
  const conn = conns.get(server.id, user)
  const sudo = conn?.status === 'connected' && conn.sudo && user !== 'root'
  const [state, setState] = useState<NginxState | null>(() => readCache<NginxState>(server.id, user, 'nginx')?.data ?? null)
  const [error, setError] = useState<AppError | null>(null)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [source, setSource] = useState<NginxSite | null>(null)
  const [tail, setTail] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const s = await api.nginxState(server.id, user)
      setState(s)
      setError(null)
      writeCache(server.id, user, 'nginx', s, new Date())
    } catch (e) {
      const err = asError(e)
      if (err.code === 'connection_lost' || err.code === 'not_connected') conns.markLost(server.id, user, err)
      else setError(err)
    } finally {
      setLoading(false)
    }
    // Re-read when sudo is turned on or off: what nginx -T can read changes.
  }, [server.id, user, conns.markLost, sudo])

  useEffect(() => {
    void load()
  }, [load])

  const ok = state?.kind === 'ok' ? state : null
  const sites = ok?.sites ?? []
  // Kept by name: enabling a site changes the file it is read from.
  const current = sites.find((s) => nameOf(s) === selected) ?? sites.find((s) => s.enabled) ?? sites[0]
  const soon = sites.filter((s) => s.enabled && s.cert && s.cert.daysLeft < SOON).length

  if (tail) return <LogTail server={server} user={user} path={tail} sudo={sudo} onClose={() => setTail(null)} />

  const openInFiles = (path: string) => {
    writeCache(server.id, user, 'files', { path: parentOf(path), listing: null }, new Date(0))
    nav.openModule('files')
  }

  const ask = (action: NginxAction) => {
    if (action.op === 'test') return setPending({ action, title: t('Kiểm tra cấu hình nginx'), confirm: t('Chạy nginx -t'), note: t('Chỉ đọc và kiểm tra cú pháp, không đổi gì.') })
    if (action.op === 'reload')
      return setPending({ action, title: 'Reload nginx', confirm: 'Reload', note: t('Kiểm tra cấu hình trước; nếu lỗi thì không reload. Kết nối đang mở không bị ngắt.') })
    const site = sites.find((s) => (action.op === 'enable' ? s.available === action.file : s.file === action.link))
    const label = site ? nameOf(site) : ''
    if (action.op === 'enable')
      return setPending({ action, title: t('Bật site {name}', { name: label }), confirm: t('Bật site'), note: t('Tạo link trong sites-enabled, kiểm tra cấu hình rồi reload. Nếu nginx -t lỗi, link được gỡ lại ngay.') })
    setPending({
      action,
      title: t('Tắt site {name}', { name: label }),
      confirm: t('Tắt site'),
      danger: true,
      note: t('Gỡ link trong sites-enabled (tệp trong sites-available vẫn giữ), kiểm tra cấu hình rồi reload. Nếu nginx -t lỗi, link được đặt lại.'),
    })
  }

  const sub =
    state?.kind === 'ok'
      ? [state.version, state.running ? t('đang chạy') : t('không chạy#nginx'), t('{n} site', { n: sites.length }), soon ? t('{n} chứng chỉ sắp hết hạn', { n: soon }) : ''].filter(Boolean).join(' · ')
      : state?.kind === 'broken'
        ? t('{version} · cấu hình đang lỗi', { version: state.version })
        : state?.kind === 'needsRoot'
          ? t('Cần quyền root để đọc cấu hình')
          : t('Đang đọc cấu hình…')

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-none flex-wrap items-center gap-2">
        <div className="flex min-w-[260px] flex-1 flex-col gap-0.5">
          <span className="text-[15px] font-semibold">Nginx</span>
          <span className={cx(soon ? 'text-warn' : 'text-muted')}>{sub}</span>
        </div>
        <button
          type="button"
          title={t('Đọc lại')}
          onClick={() => void load()}
          className="flex size-8 cursor-pointer items-center justify-center rounded-lg border border-line2 text-ink hover:border-muted"
        >
          <RotateCw size={14} strokeWidth={1.8} className={cx(loading && 'animate-spin')} />
        </button>
        <Button size="sm" onClick={() => ask({ op: 'test' })} disabled={!state || state.kind === 'absent' || state.kind === 'needsRoot'}>
          {t('Kiểm tra cấu hình')}
        </Button>
        <Button size="sm" onClick={() => ask({ op: 'reload' })} disabled={state?.kind !== 'ok'}>
          Reload
        </Button>
      </div>

      {error && <span className="font-mono text-[11.5px] text-danger select-text">{error.detail ?? error.code}</span>}

      {state?.kind === 'needsRoot' && (
        <Notice icon={Lock} title={t('Cần quyền root để đọc cấu hình nginx')}>
          {t('User {user} không đọc được tệp của nginx (nginx -T báo Permission denied). Bật sudo cho phiên này ở thanh phía trên, hoặc kết nối bằng root.', { user })}
          <pre className="mt-2 max-h-28 overflow-auto rounded-md bg-sunken p-2 font-mono text-[11px] whitespace-pre-wrap text-muted select-text">{state.detail}</pre>
        </Notice>
      )}

      {state?.kind === 'broken' && (
        <Notice icon={FileText} title={t('Cấu hình nginx đang lỗi')} tone="danger">
          {state.running
            ? t('nginx -t không qua, nên chưa đọc được các site. Sửa lỗi dưới đây rồi bấm đọc lại; nginx vẫn chạy bằng cấu hình cũ.')
            : t('nginx -t không qua, nên chưa đọc được các site. Sửa lỗi dưới đây rồi bấm đọc lại; nginx đang không chạy.')}
          <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-sunken p-2 font-mono text-[11px] whitespace-pre-wrap text-danger select-text">{state.output}</pre>
        </Notice>
      )}

      {state?.kind === 'absent' && <Notice icon={Globe} title={t('Server này không có nginx')}>{t('Portway không tìm thấy lệnh nginx.')}</Notice>}

      {ok && (
        <div className="grid min-h-0 flex-1 gap-3" style={{ gridTemplateColumns: 'minmax(0,1fr) 380px' }}>
          <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-surface">
            <div className="min-h-0 flex-1 overflow-auto overscroll-contain px-2.5 pb-2.5">
              {/* In the scrolling box, with the rows' padding, so it lines up with them
                  whether or not a scrollbar shows; labels sit where the boxes' text does. */}
              <div
                className="sticky top-0 z-[1] -mx-2.5 mb-1.5 grid bg-sunken px-2.5 py-2 text-[11px] tracking-[.06em] text-muted uppercase"
                style={{ gridTemplateColumns: SITE_COLS }}
              >
                <span className="px-3">{t('Tên miền')}</span>
                <span className="text-center">Nginx</span>
                <span className="px-3">{t('Đích')}</span>
              </div>
              {sites.length === 0 && <div className="p-7 text-center text-muted">{t('nginx chưa có khối server nào.')}</div>}
              {sites.map((s) => {
                const sel = s === current
                const cl = certLine(s)
                const badges = [
                  ...new Set(s.listens.map((l) => (l.ssl ? `:${l.port} SSL` : `:${l.port}`))),
                  s.httpsRedirect ? 'HTTP→HTTPS' : '',
                  s.gzip ? 'gzip' : '',
                  s.websocket ? 'websocket' : '',
                ].filter(Boolean)
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSelected(nameOf(s))}
                    className="grid w-full cursor-pointer items-center py-1 text-left"
                    style={{ gridTemplateColumns: SITE_COLS, opacity: s.enabled ? 1 : 0.55 }}
                  >
                    <span className={cx('flex min-w-0 flex-col gap-0.5 rounded-[10px] border bg-raised px-3 py-2.5', sel ? 'border-accent' : 'border-line')}>
                      <span className="truncate font-semibold">{nameOf(s)}</span>
                      <span className="truncate text-[11px]" style={{ color: TONE_FG[cl.tone] }}>
                        {s.enabled ? cl.text : t('Đang tắt')}
                      </span>
                    </span>
                    <span className="flex min-w-0 items-center gap-1.5 px-1.5">
                      <span className={cx('h-0 flex-1 border-t border-line2', !s.enabled && 'border-dashed')} />
                      {badges.map((b) => (
                        <span key={b} className="rounded-[5px] bg-sunken px-1.5 py-0.5 text-[10.5px] whitespace-nowrap text-ink2">
                          {b}
                        </span>
                      ))}
                      <span className={cx('h-0 flex-1 border-t border-line2', !s.enabled && 'border-dashed')} />
                      <span className="text-[11px] text-muted">▸</span>
                    </span>
                    <span className={cx('flex min-w-0 flex-col gap-0.5 rounded-[10px] border bg-sunken px-3 py-2.5', sel ? 'border-accent' : 'border-line')}>
                      <span className="flex items-center gap-1.5 text-[11px] text-muted">
                        {typeLabel(s.target.kind)}
                        {s.upstreamUp === false && <span className="text-danger">{t('· không phản hồi')}</span>}
                      </span>
                      <span className="truncate font-mono text-[11.5px]" title={targetText(s)}>
                        {targetText(s)}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {current ? (
            <Details
              site={current}
              user={user}
              onToggle={() => {
                const toggle = toggleOf(current)
                if (toggle) ask(toggle)
              }}
              onSource={() => setSource(current)}
              onFiles={openInFiles}
              onTail={setTail}
              onEdit={(path) => void edits.open(server.id, user, path)}
            />
          ) : (
            <div />
          )}
        </div>
      )}

      {pending && (
        <RunDialog
          server={server}
          user={user}
          sudo={sudo}
          pending={pending}
          onClose={() => setPending(null)}
          onDone={(r) => {
            if (pending.action.op !== 'test') {
              toast(
                r.ok
                  ? { title: pending.action.op === 'reload' ? t('Đã reload nginx') : pending.action.op === 'enable' ? t('Đã bật site') : t('Đã tắt site'), detail: 'nginx -t: ok' }
                  : { title: r.rolledBack ? t('Đã hoàn tác: nginx -t lỗi') : t('Không làm được'), detail: r.output.split('\n').slice(-2).join(' ') },
              )
              void load()
            }
          }}
        />
      )}

      {source && (
        <Modal open onClose={() => setSource(null)} width={760} title={t('Cấu hình {name}', { name: nameOf(source) })} subtitle={t('{file} · chỉ đọc, như nginx đọc được', { file: source.file })}>
          <pre className="max-h-[60vh] overflow-auto rounded-lg bg-sunken p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre text-ink2 select-text">{source.source}</pre>
        </Modal>
      )}
    </div>
  )
}

function Details({
  site: s,
  user,
  onToggle,
  onSource,
  onFiles,
  onTail,
  onEdit,
}: {
  site: NginxSite
  user: string
  onToggle: () => void
  onSource: () => void
  onFiles: (path: string) => void
  onTail: (path: string) => void
  onEdit: (path: string) => void
}) {
  const toggle = toggleOf(s)
  const cl = certLine(s)
  const c = s.cert
  return (
    <div className="flex min-h-0 flex-col gap-3.5 overflow-y-auto overscroll-contain rounded-xl border border-line bg-surface p-4 [&>*]:shrink-0">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[15px] font-semibold break-all">{nameOf(s)}</span>
          <span className="flex flex-wrap gap-1">
            <Chip tone={s.enabled ? TONES.success : TONES.neutral}>{s.enabled ? t('Đang bật') : t('Đang tắt')}</Chip>
            <Chip tone={TONES.neutral}>{typeLabel(s.target.kind)}</Chip>
          </span>
        </div>
        {toggle && (
          <Button size="xs" variant={s.enabled ? 'secondary' : 'primary'} onClick={onToggle}>
            {s.enabled ? t('Tắt site') : t('Bật site')}
          </Button>
        )}
      </div>

      {s.names.length > 1 && <Info label={t('Tên miền')} value={s.names.join(', ')} mono />}
      <Info label={t('Lắng nghe')} value={s.listens.map((l) => `${l.addr === '*' ? '' : `${l.addr}:`}${l.port}${l.ssl ? ' ssl' : ''}`).join(', ')} mono />
      <Info
        label={s.target.kind === 'proxy' ? t('Chuyển tới') : s.target.kind === 'static' ? t('Thư mục web') : s.target.kind === 'redirect' ? t('Chuyển hướng') : t('Đích')}
        value={targetText(s)}
        mono
        extra={
          s.upstreamUp === true ? (
            <span className="text-[11px] text-success">{t('Đang nhận kết nối')}</span>
          ) : s.upstreamUp === false ? (
            <span className="text-[11px] text-danger">{t('Không phản hồi: không có gì nghe ở cổng này, khách sẽ gặp 502')}</span>
          ) : s.target.kind === 'static' ? (
            <button type="button" className="w-fit cursor-pointer text-[11px] text-ink2 hover:underline" onClick={() => onFiles(`${(s.target as { root: string }).root}/x`)}>
              {t('Mở trong Tệp')}
            </button>
          ) : null
        }
      />

      <div className="flex flex-col gap-1.5 rounded-[9px] px-3 py-2.5" style={{ background: cl.tone === 'warn' || cl.tone === 'bad' ? 'var(--warn-soft)' : 'var(--raised)' }}>
        <span className="text-[11px] text-muted">{t('Chứng chỉ SSL')}</span>
        <span className="text-[13px] font-semibold" style={{ color: cl.tone === 'bad' ? 'var(--danger)' : cl.tone === 'warn' ? 'var(--warn)' : 'var(--ink)' }}>
          {cl.text}
        </span>
        {c && (
          <span className="flex flex-col gap-0.5 text-[11.5px] leading-normal text-ink2">
            <span>{t('Hết hạn {time} (giờ máy bạn)', { time: fullTime(c.notAfter) })}</span>
            <span className="break-all">{c.selfSigned ? t('Cấp bởi chính nó (tự ký)') : t('Cấp bởi {issuer}', { issuer: c.issuer })}</span>
            <span className="break-all">{t('Cho {names}', { names: c.names.join(', ') || c.subject })}</span>
            {c.selfSigned && <span className="text-warn">{t('Chứng chỉ tự ký: trình duyệt sẽ cảnh báo không an toàn.')}</span>}
            {c.nameMismatch && <span className="text-warn">{t('Chứng chỉ không có tên {name}: trình duyệt sẽ báo sai tên.', { name: nameOf(s) })}</span>}
          </span>
        )}
        {s.ssl && s.enabled && !c && <span className="text-[11.5px] text-ink2">{t('Không lấy được chứng chỉ nginx đang trả về (server thiếu openssl, hoặc cổng SSL không nghe trên máy này).')}</span>}
        {s.ssl && !s.enabled && <span className="text-[11.5px] text-ink2">{t('Site đang tắt nên nginx không trả chứng chỉ này.')}</span>}
        {s.sslCertificate && <span className="font-mono text-[11px] break-all text-muted">{s.sslCertificate}</span>}
        {s.ssl && !s.httpsRedirect && s.listens.some((l) => !l.ssl) && <span className="text-[11.5px] text-warn">{t('Cổng HTTP vẫn phục vụ nội dung, chưa chuyển sang HTTPS.')}</span>}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] tracking-[.06em] text-muted uppercase">{t('Log')}</span>
        {[
          [t('Truy cập'), s.accessLog],
          [t('Lỗi'), s.errorLog],
        ].map(([label, path]) => (
          <div key={label} className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-[11px] text-muted">{label}</span>
              <span className="truncate font-mono text-[11.5px]" title={path ?? ''}>
                {path ?? t('Tắt#log')}
              </span>
            </span>
            {path && (
              <Button size="xs" onClick={() => onTail(path)} title={user === 'root' ? `tail -F ${path}` : t('tail -F {path} (cần quyền đọc tệp log)', { path })}>
                <ScrollText size={12} strokeWidth={1.8} />
                {t('Theo dõi')}
              </Button>
            )}
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] tracking-[.06em] text-muted uppercase">{t('Tệp cấu hình')}</span>
        <span className="font-mono text-[11.5px] break-all text-ink2">{s.available && s.available !== s.file ? `${s.file} → ${s.available}` : s.file}</span>
        <div className="flex flex-wrap gap-1.5">
          <Button size="xs" onClick={onSource}>
            <FileText size={12} strokeWidth={1.8} />
            {t('Xem cấu hình')}
          </Button>
          <Button size="xs" onClick={() => onEdit(s.available ?? s.file)} title={t('Mở bằng editor trên máy; lưu là tải lên. Sau khi sửa, bấm Kiểm tra cấu hình rồi Reload.')}>
            <FilePen size={12} strokeWidth={1.8} />
            {t('Sửa trên máy')}
          </Button>
          <Button size="xs" onClick={() => onFiles(s.available ?? s.file)}>
            <FolderOpen size={12} strokeWidth={1.8} />
            {t('Mở thư mục trong Tệp')}
          </Button>
        </div>
        {!s.available && <span className="text-[11px] text-muted">{t('Tệp này không nằm trong sites-available nên Portway không bật/tắt nó được.')}</span>}
      </div>
    </div>
  )
}

function Info({ label, value, mono, extra }: { label: string; value: string; mono?: boolean; extra?: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] text-muted">{label}</span>
      <span className={cx('text-[12px] break-all select-text', mono && 'font-mono text-[11.5px]')}>{value}</span>
      {extra}
    </div>
  )
}

function Notice({ icon: Icon, title, tone, children }: { icon: typeof Lock; title: string; tone?: 'danger'; children: ReactNode }) {
  return (
    <div className={cx('flex gap-3 rounded-xl border border-line px-4 py-3.5', tone === 'danger' ? 'bg-danger-soft' : 'bg-surface')}>
      <Icon size={18} strokeWidth={1.8} className={cx('mt-0.5 flex-none', tone === 'danger' ? 'text-danger' : 'text-muted')} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="font-semibold">{title}</span>
        <div className="leading-normal text-ink2">{children}</div>
      </div>
    </div>
  )
}

/** Shows the exact commands, runs them, then shows what nginx printed. */
function RunDialog({
  server,
  user,
  sudo,
  pending,
  onClose,
  onDone,
}: {
  server: Server
  user: string
  sudo: boolean
  pending: Pending
  onClose: () => void
  onDone: (r: NginxResult) => void
}) {
  const [preview, setPreview] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<NginxResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void api.nginxPreview(pending.action).then(setPreview).catch(() => {})
  }, [pending.action])

  const run = async () => {
    setBusy(true)
    try {
      const r = await api.nginxAction(server.id, user, pending.action)
      setResult(r)
      onDone(r)
    } catch (e) {
      setError(isAppError(e) ? (e.detail ?? e.code) : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={620}
      title={pending.title}
      subtitle={`${user}@${server.name}`}
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>
            {t('Đóng')}
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>{t('Huỷ')}</Button>
            <Button variant={pending.danger ? 'danger' : 'primary'} onClick={() => void run()} disabled={busy}>
              {busy ? t('Đang chạy…') : pending.confirm}
            </Button>
          </>
        )
      }
    >
      <span className="leading-normal text-ink2">{pending.note}</span>
      <div className="flex flex-col gap-1">
        <span className="text-[11px] text-muted">{t('Lệnh sẽ chạy')}</span>
        <pre className="overflow-auto rounded-md bg-sunken px-2.5 py-2 font-mono text-[11.5px] whitespace-pre-wrap text-ink2 select-text">
          {preview ? (sudo ? `sudo sh -c ${q(preview)}` : preview) : '…'}
        </pre>
      </div>
      {error && <span className="font-mono text-[11.5px] text-danger">{error}</span>}
      {result && (
        <div className="flex flex-col gap-1">
          <span className={cx('text-[12px] font-semibold', result.ok ? 'text-success' : 'text-danger')}>
            {result.ok ? t('Xong') : result.rolledBack ? t('nginx -t lỗi, đã hoàn tác thay đổi') : t('Lỗi')}
          </span>
          <pre className="max-h-48 overflow-auto rounded-md bg-sunken px-2.5 py-2 font-mono text-[11px] whitespace-pre-wrap text-ink2 select-text">{result.output || t('(không in gì)')}</pre>
        </div>
      )}
    </Modal>
  )
}
