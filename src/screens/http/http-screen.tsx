import { Bookmark, Copy, History, Loader2, Plus, Send, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useConnections } from '../../app/connections'
import { readCache, writeCache } from '../../app/session-cache'
import { useToast } from '../../components/toast'
import { Checkbox } from '../../components/ui/checkbox'
import { Field, SelectField, TextInput } from '../../components/ui/form-controls'
import { Modal } from '../../components/ui/modal'
import { Button, cx } from '../../components/ui/primitives'
import { SegmentedControl } from '../../components/ui/segmented'
import {
  api,
  isAppError,
  type HttpBody,
  type HttpHistoryItem,
  type HttpPair,
  type HttpRequest,
  type HttpResponse,
  type HttpSaved,
  type Listen,
  type Server,
} from '../../lib/api'
import { locale, t } from '../../i18n'
import { copyText } from '../../lib/clipboard'
import { formatBytes } from '../server/format'
import { METHOD_COLOR, METHODS, ms, newRequest, paramsOf, prettyJson, reasonOf, shortUrl, statusColor, withParams } from './format'

type ReqTab = 'params' | 'headers' | 'body' | 'auth' | 'options'
type ResTab = 'body' | 'headers' | 'timing' | 'command'
/** Kept per session so leaving the module keeps the request and its answer. */
type Cached = { request: HttpRequest; response: HttpResponse | null; savedId: string | null }

function errorText(e: unknown) {
  if (!isAppError(e)) return String(e)
  switch (e.code) {
    case 'no_curl':
      return t('Server chưa có curl. Cài bằng: apt install curl (Debian/Ubuntu), dnf install curl (RHEL), apk add curl (Alpine).')
    case 'invalid_url':
      return t('URL phải bắt đầu bằng http:// hoặc https:// (bỏ trống thì hiểu là http://).')
    case 'invalid_header':
      return t('Header {name} không hợp lệ (tên có dấu hai chấm, hoặc xuống dòng).', { name: e.detail ?? '' })
    case 'invalid_method':
      return t('Method chỉ gồm chữ in hoa, ví dụ GET, POST.')
    default:
      return e.detail ?? e.code
  }
}

/** "HTTP (curl)": build a request like in Postman and send it with curl from the server. */
export function HttpScreen({ server, user }: { server: Server; user: string }) {
  const conns = useConnections()
  const toast = useToast()
  const [init] = useState(() => readCache<Cached>(server.id, user, 'http')?.data)
  const [req, setReq] = useState<HttpRequest>(init?.request ?? newRequest())
  const [res, setRes] = useState<HttpResponse | null>(init?.response ?? null)
  const [savedId, setSavedId] = useState<string | null>(init?.savedId ?? null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reqTab, setReqTab] = useState<ReqTab>('params')
  const [resTab, setResTab] = useState<ResTab>('body')
  const [saved, setSaved] = useState<HttpSaved[]>([])
  const [history, setHistory] = useState<HttpHistoryItem[]>([])
  const [listening, setListening] = useState<Listen[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    writeCache(server.id, user, 'http', { request: req, response: res, savedId } satisfies Cached, new Date())
  }, [server.id, user, req, res, savedId])

  const loadLists = useCallback(() => {
    void api.httpSaved(server.id).then(setSaved)
    void api.httpHistory(server.id).then(setHistory)
  }, [server.id])
  useEffect(() => {
    loadLists()
    // Ports on the server, offered as quick targets.
    void api
      .ports(server.id, user)
      .then((p) => setListening(p.listening))
      .catch(() => {})
  }, [loadLists, server.id, user])

  const send = async () => {
    if (!req.url.trim() || sending) return
    setSending(true)
    setError(null)
    try {
      const r = await api.httpSend(server.id, user, req)
      setRes(r)
      if (r.error && r.status === 0) setResTab('body')
      loadLists()
    } catch (e) {
      if (isAppError(e) && (e.code === 'connection_lost' || e.code === 'not_connected')) conns.markLost(server.id, user, e)
      setError(errorText(e))
    } finally {
      setSending(false)
    }
  }
  const sendRef = useRef(send)
  sendRef.current = send
  // ⌘↵ sends from anywhere on the screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        void sendRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const set = (patch: Partial<HttpRequest>) => setReq((r) => ({ ...r, ...patch }))
  const open = (r: HttpRequest, id: string | null) => {
    setReq(structuredClone(r))
    setSavedId(id)
    setRes(null)
    setError(null)
  }

  const quick = useMemo(() => {
    const seen = new Set<number>()
    return listening
      .filter((l) => l.proto === 'tcp' && l.port !== 22 && l.process !== 'sshd' && !seen.has(l.port) && seen.add(l.port))
      .sort((a, b) => a.port - b.port)
      .slice(0, 10)
  }, [listening])

  const params = paramsOf(req.url)
  const counts: Partial<Record<ReqTab, number>> = {
    params: params.length,
    headers: req.headers.filter((h) => h.enabled && h.name).length,
    body: req.body.kind === 'none' ? 0 : 1,
    auth: req.auth.kind === 'none' ? 0 : 1,
  }
  const current = saved.find((s) => s.id === savedId)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-none flex-wrap items-end gap-2">
        <div className="flex min-w-[260px] flex-1 flex-col gap-0.5">
          <span className="text-[15px] font-semibold">HTTP (curl)</span>
          <span className="text-muted">
            {t('Request chạy bằng curl ngay trên {name}, nên gọi được cả dịch vụ chỉ nghe ở localhost, trong container hay mạng nội bộ. ⌘↵ để gửi.', { name: server.name })}
          </span>
        </div>
        <Button size="sm" onClick={() => open(newRequest(), null)}>
          <Plus size={14} strokeWidth={1.8} />
          {t('Request mới')}
        </Button>
      </div>

      <div className="grid min-h-0 flex-1 gap-3" style={{ gridTemplateColumns: '230px minmax(0,1fr)' }}>
        {/* Saved and history */}
        <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-surface">
          <div className="min-h-0 flex-1 overflow-auto overscroll-contain p-1.5">
            <ListTitle icon={Bookmark} title={t('Đã lưu')} />
            {saved.length === 0 && <span className="block px-2 pb-2 text-[11px] text-muted">{t('Bấm Lưu để giữ request hay dùng.')}</span>}
            {saved.map((s) => (
              <ListRow key={s.id} active={s.id === savedId} method={s.request.method} title={s.name} sub={shortUrl(s.request.url)} onClick={() => open(s.request, s.id)}>
                <button
                  type="button"
                  title={t('Xoá request đã lưu')}
                  onClick={(e) => {
                    e.stopPropagation()
                    void api.httpDelete(s.id).then(() => {
                      if (savedId === s.id) setSavedId(null)
                      loadLists()
                    })
                  }}
                  className="hidden size-5 flex-none cursor-pointer items-center justify-center rounded text-muted group-hover:flex hover:bg-sunken"
                >
                  <X size={12} />
                </button>
              </ListRow>
            ))}
            <div className="mt-2 flex items-center">
              <ListTitle icon={History} title={t('Lịch sử')} />
              <span className="flex-1" />
              {history.length > 0 && (
                <button type="button" title={t('Xoá lịch sử')} onClick={() => void api.httpHistoryClear(server.id).then(loadLists)} className="mr-1 cursor-pointer rounded p-1 text-muted hover:bg-sunken">
                  <Trash2 size={12} />
                </button>
              )}
            </div>
            {history.length === 0 && <span className="block px-2 text-[11px] text-muted">{t('Chưa gửi request nào tới server này.')}</span>}
            {history.map((h) => (
              <ListRow
                key={h.id}
                active={false}
                method={h.request.method}
                title={shortUrl(h.request.url)}
                sub={`${new Date(h.at).toLocaleTimeString(locale())} · ${ms(h.ms)}` + (h.redacted ? ' · ' + t('không lưu token') : '')}
                onClick={() => open(h.request, null)}
              >
                <span className="num flex-none text-[11px] font-semibold" style={{ color: h.error ? 'var(--danger)' : statusColor(h.status) }}>
                  {h.status || t('Lỗi')}
                </span>
              </ListRow>
            ))}
          </div>
        </div>

        {/* Request and response */}
        <div className="flex min-h-0 flex-col gap-2.5">
          <div className="flex flex-none items-center gap-2">
            <SelectField value={req.method} onChange={(m) => set({ method: m })} options={METHODS.map((m) => ({ value: m, label: m }))} className="w-[108px] font-semibold" />
            <input
              value={req.url}
              onChange={(e) => set({ url: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && void send()}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              placeholder="http://127.0.0.1:3000/api/health"
              className="box-border h-[34px] min-w-0 flex-1 rounded-lg border border-line2 bg-sunken px-3 font-mono text-[12.5px] leading-[32px] text-ink outline-none select-text focus:border-accent"
            />
            <Button variant="primary" onClick={() => void send()} disabled={!req.url.trim() || sending} className="!h-[34px]">
              {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} strokeWidth={1.8} />}
              {t('Gửi')}
            </Button>
            <Button onClick={() => setSaving(true)} title={current ? t('Lưu vào "{name}"', { name: current.name }) : t('Lưu request này')} className="!h-[34px]">
              <Bookmark size={14} strokeWidth={1.8} />
              {t('Lưu')}
            </Button>
          </div>

          {quick.length > 0 && (
            <div className="flex flex-none flex-wrap items-center gap-1.5 text-[11px] text-muted">
              <span>{t('Đang nghe trên server:')}</span>
              {quick.map((l) => {
                const host = l.bind === '::' || l.bind === '0.0.0.0' || l.bind === '*' ? '127.0.0.1' : l.bind.includes(':') ? `[${l.bind}]` : l.bind
                const url = `${l.port === 443 ? 'https' : 'http'}://${host}:${l.port}/`
                return (
                  <button
                    key={l.port}
                    type="button"
                    title={url}
                    onClick={() => set({ url: url + (req.url.replace(/^[a-z]+:\/\/[^/]+\/?/i, '') || '') })}
                    className="flex cursor-pointer items-baseline gap-1.5 rounded-md border border-line2 px-1.5 py-0.5 hover:border-muted"
                  >
                    <span className="font-mono text-ink2">:{l.port}</span>
                    {(l.container ?? l.process) && <span className="text-muted">{l.container ?? l.process}</span>}
                  </button>
                )
              })}
            </div>
          )}

          <div className="flex max-h-[42%] min-h-[150px] flex-none flex-col overflow-hidden rounded-xl border border-line bg-surface">
            <Tabs
              value={reqTab}
              onChange={setReqTab}
              tabs={[
                ['params', 'Params'],
                ['headers', 'Headers'],
                ['body', 'Body'],
                ['auth', 'Auth'],
                ['options', t('Tuỳ chọn')],
              ]}
              counts={counts}
            />
            <div className="min-h-0 flex-1 overflow-auto overscroll-contain p-3">
              {reqTab === 'params' && <Pairs rows={params} onChange={(rows) => set({ url: withParams(req.url, rows) })} hint={t('Sửa ở đây hoặc ngay trong URL, hai bên luôn khớp nhau.')} />}
              {reqTab === 'headers' && <Pairs rows={req.headers} onChange={(headers) => set({ headers })} hint={t('Content-Type được thêm theo kiểu body nếu bạn không tự đặt.')} />}
              {reqTab === 'body' && <BodyEditor body={req.body} onChange={(body) => set({ body })} method={req.method} />}
              {reqTab === 'auth' && <AuthEditor req={req} set={set} />}
              {reqTab === 'options' && <OptionsEditor req={req} set={set} />}
            </div>
          </div>

          <ResponsePanel res={res} error={error} sending={sending} tab={resTab} setTab={setResTab} toast={toast} />
        </div>
      </div>

      {saving && (
        <SaveDialog
          current={current ?? null}
          serverId={server.id}
          request={req}
          onClose={() => setSaving(false)}
          onSaved={(s) => {
            setSaving(false)
            setSavedId(s.id)
            loadLists()
            toast({ title: t('Đã lưu "{name}"', { name: s.name }), detail: s.serverId ? t('Chỉ hiện ở {server}', { server: server.name }) : t('Hiện ở mọi server') })
          }}
        />
      )}
    </div>
  )
}

function ListTitle({ icon: Icon, title }: { icon: typeof Bookmark; title: string }) {
  return (
    <span className="flex items-center gap-1.5 px-2 pt-1.5 pb-1 text-[11px] tracking-[.06em] text-muted uppercase">
      <Icon size={12} strokeWidth={1.8} />
      {title}
    </span>
  )
}

function ListRow({ active, method, title, sub, onClick, children }: { active: boolean; method: string; title: string; sub: string; onClick: () => void; children?: ReactNode }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      className={cx('group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5', active ? 'bg-accent-soft' : 'hover:bg-raised')}
    >
      <span className="w-11 flex-none font-mono text-[10px] font-semibold" style={{ color: METHOD_COLOR[method] ?? 'var(--ink2)' }}>
        {method}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[12px]" title={title}>
          {title}
        </span>
        <span className="truncate font-mono text-[10.5px] text-muted" title={sub}>
          {sub}
        </span>
      </span>
      {children}
    </div>
  )
}

function Tabs<T extends string>({ value, onChange, tabs, counts, right }: { value: T; onChange: (t: T) => void; tabs: [T, string][]; counts?: Partial<Record<T, number>>; right?: ReactNode }) {
  return (
    <div className="flex flex-none items-center gap-1 border-b border-line px-2">
      {tabs.map(([id, label]) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          className={cx('-mb-px cursor-pointer border-b-2 px-2.5 py-2 text-[12px]', value === id ? 'border-accent font-semibold text-ink' : 'border-transparent text-ink2 hover:text-ink')}
        >
          {label}
          {counts?.[id] ? <span className="num ml-1 text-[10.5px] text-muted">{counts[id]}</span> : null}
        </button>
      ))}
      <span className="flex-1" />
      {right}
    </div>
  )
}

/** Name/value rows with an empty one at the end to type into. */
function Pairs({ rows, onChange, hint, namePlaceholder = t('Tên'), valuePlaceholder = t('Giá trị') }: { rows: HttpPair[]; onChange: (rows: HttpPair[]) => void; hint?: string; namePlaceholder?: string; valuePlaceholder?: string }) {
  const all = [...rows, { name: '', value: '', enabled: true }]
  const update = (i: number, patch: Partial<HttpPair>) => {
    const next = all.map((r, j) => (j === i ? { ...r, ...patch } : r))
    onChange(next.filter((r, j) => j < next.length - 1 || r.name || r.value))
  }
  return (
    <div className="flex flex-col gap-1.5">
      {all.map((r, i) => {
        const last = i === all.length - 1
        return (
          <div key={i} className="grid items-center gap-1.5" style={{ gridTemplateColumns: '18px minmax(0,1fr) minmax(0,1.6fr) 22px' }}>
            {last ? <span /> : <input type="checkbox" checked={r.enabled} onChange={(e) => update(i, { enabled: e.target.checked })} className="accent-[var(--accent)]" />}
            <input
              value={r.name}
              placeholder={namePlaceholder}
              spellCheck={false}
              onChange={(e) => update(i, { name: e.target.value })}
              className={cx('h-7 rounded-md border border-line2 bg-sunken px-2 font-mono text-[11.5px] outline-none select-text focus:border-accent', !r.enabled && 'opacity-50')}
            />
            <input
              value={r.value}
              placeholder={valuePlaceholder}
              spellCheck={false}
              onChange={(e) => update(i, { value: e.target.value })}
              className={cx('h-7 rounded-md border border-line2 bg-sunken px-2 font-mono text-[11.5px] outline-none select-text focus:border-accent', !r.enabled && 'opacity-50')}
            />
            {last ? (
              <span />
            ) : (
              <button type="button" title={t('Bỏ dòng này')} onClick={() => onChange(rows.filter((_, j) => j !== i))} className="flex cursor-pointer justify-center text-muted hover:text-ink">
                <X size={13} />
              </button>
            )}
          </div>
        )
      })}
      {hint && <span className="text-[11px] text-muted">{hint}</span>}
    </div>
  )
}

function BodyEditor({ body, onChange, method }: { body: HttpBody; onChange: (b: HttpBody) => void; method: string }) {
  const text = body.kind === 'json' || body.kind === 'text' ? body.text : ''
  const jsonOk = body.kind !== 'json' || !body.text.trim() || prettyJson(body.text) !== null
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          value={body.kind}
          onChange={(k) =>
            onChange(
              k === 'none' ? { kind: 'none' } : k === 'json' ? { kind: 'json', text } : k === 'form' ? { kind: 'form', fields: [] } : { kind: 'text', text, contentType: 'text/plain' },
            )
          }
          options={[
            { id: 'none', label: t('Không có') },
            { id: 'json', label: 'JSON' },
            { id: 'form', label: 'Form' },
            { id: 'text', label: 'Text' },
          ]}
        />
        {body.kind === 'json' && (
          <>
            <Button size="xs" onClick={() => onChange({ kind: 'json', text: prettyJson(body.text) ?? body.text })} disabled={!jsonOk}>
              {t('Định dạng')}
            </Button>
            {!jsonOk && <span className="text-[11px] text-danger">{t('JSON chưa hợp lệ')}</span>}
          </>
        )}
        {body.kind === 'text' && (
          <input
            value={body.contentType}
            onChange={(e) => onChange({ ...body, contentType: e.target.value })}
            placeholder="Content-Type"
            className="h-7 w-52 rounded-md border border-line2 bg-sunken px-2 font-mono text-[11.5px] outline-none select-text focus:border-accent"
          />
        )}
        {(method === 'GET' || method === 'HEAD') && body.kind !== 'none' && <span className="text-[11px] text-warn">{t('{method} kèm body: nhiều server bỏ qua phần này.', { method })}</span>}
      </div>
      {body.kind === 'none' && <span className="text-[11.5px] text-muted">{t('Request không gửi body.')}</span>}
      {(body.kind === 'json' || body.kind === 'text') && (
        <textarea
          value={body.text}
          onChange={(e) => onChange({ ...body, text: e.target.value })}
          spellCheck={false}
          rows={7}
          placeholder={body.kind === 'json' ? '{\n  "name": "portway"\n}' : ''}
          className={cx('w-full resize-y rounded-lg border bg-sunken p-2.5 font-mono text-[12px] leading-relaxed outline-none select-text focus:border-accent', jsonOk ? 'border-line2' : 'border-danger')}
        />
      )}
      {body.kind === 'form' && <Pairs rows={body.fields} onChange={(fields) => onChange({ kind: 'form', fields })} hint={t('Gửi dạng application/x-www-form-urlencoded.')} />}
    </div>
  )
}

function AuthEditor({ req, set }: { req: HttpRequest; set: (p: Partial<HttpRequest>) => void }) {
  const a = req.auth
  return (
    <div className="flex max-w-[520px] flex-col gap-2.5">
      <SegmentedControl
        value={a.kind}
        onChange={(k) => set({ auth: k === 'none' ? { kind: 'none' } : k === 'bearer' ? { kind: 'bearer', token: '' } : { kind: 'basic', user: '', password: '' } })}
        options={[
          { id: 'none', label: t('Không có') },
          { id: 'bearer', label: 'Bearer token' },
          { id: 'basic', label: 'Basic' },
        ]}
      />
      {a.kind === 'bearer' && (
        <Field label="Token">
          <TextInput value={a.token} onChange={(token) => set({ auth: { kind: 'bearer', token } })} placeholder="eyJhbGciOi…" />
        </Field>
      )}
      {a.kind === 'basic' && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="User">
            <TextInput value={a.user} onChange={(user) => set({ auth: { ...a, user } })} />
          </Field>
          <Field label={t('Mật khẩu')}>
            <TextInput type="password" value={a.password} onChange={(password) => set({ auth: { ...a, password } })} />
          </Field>
        </div>
      )}
      <span className="text-[11px] text-muted">
        {t('Token, mật khẩu và header được đưa cho curl qua tệp cấu hình tạm (chmod 600, xoá ngay sau đó), không nằm trên dòng lệnh nên user khác trên server không thấy qua ps.')}
      </span>
    </div>
  )
}

function OptionsEditor({ req, set }: { req: HttpRequest; set: (p: Partial<HttpRequest>) => void }) {
  const o = req.options
  const opt = (patch: Partial<HttpRequest['options']>) => set({ options: { ...o, ...patch } })
  return (
    <div className="flex max-w-[560px] flex-col gap-2.5">
      <Checkbox checked={o.followRedirects} onChange={(v) => opt({ followRedirects: v })}>
        {t('Theo redirect (tối đa 10 lần)')}
      </Checkbox>
      <Checkbox checked={o.insecure} onChange={(v) => opt({ insecure: v })}>
        {t('Bỏ qua kiểm tra chứng chỉ SSL (tự ký, gọi bằng IP)')}
      </Checkbox>
      <Checkbox checked={o.compressed} onChange={(v) => opt({ compressed: v })}>
        {t('Nhận nội dung nén (gzip, br) và tự giải nén')}
      </Checkbox>
      <div className="grid gap-2.5" style={{ gridTemplateColumns: '120px minmax(0,1fr)' }}>
        <Field label={t('Timeout (giây)')}>
          <TextInput value={String(o.timeoutSecs)} onChange={(v) => opt({ timeoutSecs: Math.min(600, Number(v.replace(/\D/g, '')) || 1) })} numeric />
        </Field>
        <Field
          label={t('Gửi tới IP (tuỳ chọn)')}
          help={t('Giữ tên miền trong URL nhưng kết nối tới IP này (curl --resolve), ví dụ 127.0.0.1 để thử một site nginx ngay trên server.')}
        >
          <TextInput value={o.connectTo} onChange={(v) => opt({ connectTo: v.trim() })} placeholder="127.0.0.1" />
        </Field>
      </div>
    </div>
  )
}

function ResponsePanel({
  res,
  error,
  sending,
  tab,
  setTab,
  toast,
}: {
  res: HttpResponse | null
  error: string | null
  sending: boolean
  tab: ResTab
  setTab: (t: ResTab) => void
  toast: ReturnType<typeof useToast>
}) {
  const [raw, setRaw] = useState(false)
  const pretty = res?.text != null ? prettyJson(res.text) : null
  const body = res?.text == null ? null : raw || !pretty ? res.text : pretty
  const copy = (text: string, title: string) => void copyText(text).then(() => toast({ title }))

  return (
    <div className="relative flex min-h-[180px] flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface">
      {res && (
        <div className="flex flex-none flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-3.5 py-2">
          <span className="font-semibold" style={{ color: statusColor(res.status) }}>
            {res.status ? `${res.status} ${reasonOf(res.status, res.reason)}` : t('Không có phản hồi')}
          </span>
          <Stat label={t('Thời gian')} value={ms(res.timings.total)} />
          <Stat label={t('Kích thước')} value={formatBytes(res.size)} />
          {res.remote && <Stat label={t('Tới')} value={res.remote} mono />}
          {res.httpVersion && res.httpVersion !== '0' && <Stat label="HTTP" value={res.httpVersion} />}
          {res.redirects > 0 && <Stat label="Redirect" value={t('{n} lần', { n: res.redirects })} />}
        </div>
      )}
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          ['body', 'Body'],
          ['headers', 'Headers'],
          ['timing', t('Thời gian')],
          ['command', t('Lệnh curl')],
        ]}
        counts={{ headers: res?.headers.length }}
        right={
          res && tab === 'body' && res.text != null ? (
            <span className="flex items-center gap-1.5 py-1">
              {pretty && (
                <Button size="xs" variant="ghost" onClick={() => setRaw(!raw)}>
                  {raw ? t('Định dạng JSON') : t('Xem gốc')}
                </Button>
              )}
              <Button size="xs" variant="ghost" onClick={() => copy(res.text!, t('Đã sao chép body'))}>
                <Copy size={12} strokeWidth={1.8} />
                {t('Sao chép')}
              </Button>
            </span>
          ) : null
        }
      />
      <div className={cx('min-h-0 flex-1 overflow-auto overscroll-contain transition-opacity', sending && 'opacity-50')}>
        {error ? (
          <div className="p-4 text-danger select-text">{error}</div>
        ) : !res ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 p-6 text-center text-muted">
            <Send size={20} strokeWidth={1.6} />
            <span>{sending ? t('Đang gửi…') : t('Nhập URL rồi bấm Gửi. Phản hồi hiện ở đây.')}</span>
          </div>
        ) : tab === 'body' ? (
          <>
            {res.error && <div className="border-b border-line bg-danger-soft px-3.5 py-2 font-mono text-[11.5px] text-danger select-text">{res.error}</div>}
            {res.truncated && <div className="border-b border-line px-3.5 py-1.5 text-[11px] text-warn">{t('Body dài {size}; chỉ hiện 2 MB đầu.', { size: formatBytes(res.size) })}</div>}
            {body != null ? (
              <pre className="p-3.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-ink2 select-text [overflow-wrap:anywhere]">{body || <span className="text-muted">{t('(body rỗng)')}</span>}</pre>
            ) : res.binary ? (
              <div className="p-4 text-muted">
                {t('Nội dung nhị phân ({type}, {size}), không hiện dạng chữ.', { type: res.contentType || t('không rõ kiểu'), size: formatBytes(res.size) })}
              </div>
            ) : null}
          </>
        ) : tab === 'headers' ? (
          <div className="flex flex-col p-1.5">
            {res.headers.length === 0 && <span className="p-3 text-muted">{t('Không có header.')}</span>}
            {res.headers.map(([k, v], i) => (
              <div key={i} className="grid gap-3 rounded-md px-2 py-1 hover:bg-raised" style={{ gridTemplateColumns: 'minmax(140px,220px) minmax(0,1fr)' }}>
                <span className="font-mono text-[11.5px] text-muted">{k}</span>
                <span className="font-mono text-[11.5px] break-all text-ink select-text">{v}</span>
              </div>
            ))}
          </div>
        ) : tab === 'timing' ? (
          <Timing res={res} />
        ) : (
          <div className="flex flex-col gap-2 p-3.5">
            <pre className="rounded-lg bg-sunken p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-ink2 select-text [overflow-wrap:anywhere]">{res.command}</pre>
            <div className="flex gap-2">
              <Button size="xs" onClick={() => copy(res.command, t('Đã sao chép lệnh curl'))}>
                <Copy size={12} strokeWidth={1.8} />
                {t('Sao chép lệnh')}
              </Button>
              <span className="text-[11px] text-muted">{t('Chạy được y hệt trong Terminal của server. Lệnh này có chứa token và mật khẩu nếu request có dùng.')}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <span className="flex items-baseline gap-1.5 text-[11.5px]">
      <span className="text-muted">{label}</span>
      <span className={cx('num text-ink', mono && 'font-mono')}>{value}</span>
    </span>
  )
}

function Timing({ res }: { res: HttpResponse }) {
  const tm = res.timings
  const download = Math.max(0, tm.total - tm.dns - tm.connect - tm.tls - tm.firstByte)
  const parts: [string, number, string][] = [
    [t('Phân giải tên (DNS)'), tm.dns, 'var(--info)'],
    [t('Kết nối TCP'), tm.connect, 'var(--success)'],
    [t('Bắt tay TLS'), tm.tls, 'var(--accent)'],
    [t('Chờ phản hồi (xử lý ở server)'), tm.firstByte, 'var(--warn)'],
    [t('Tải nội dung'), download, 'var(--ink2)'],
  ]
  const total = Math.max(tm.total, 0.001)
  let offset = 0
  return (
    <div className="flex flex-col gap-2 p-4">
      {parts.map(([label, v, color]) => {
        const left = (offset / total) * 100
        offset += v
        return (
          <div key={label} className="grid items-center gap-3" style={{ gridTemplateColumns: '260px minmax(0,1fr) 72px' }}>
            <span className="text-[12px] text-ink2">{label}</span>
            <span className="relative h-2.5 rounded-sm bg-sunken">
              <span className="absolute top-0 h-full rounded-sm" style={{ left: `${left}%`, width: `${Math.max((v / total) * 100, v > 0 ? 0.6 : 0)}%`, background: color }} />
            </span>
            <span className="num text-right text-[12px]">{ms(v)}</span>
          </div>
        )
      })}
      <div className="grid gap-3 border-t border-line pt-2" style={{ gridTemplateColumns: '260px minmax(0,1fr) 72px' }}>
        <span className="text-[12px] font-semibold">{t('Tổng')}</span>
        <span />
        <span className="num text-right text-[12px] font-semibold">{ms(tm.total)}</span>
      </div>
      <span className="text-[11px] text-muted">{t('Đo bởi curl trên server, nên đây là thời gian từ server tới đích, không tính đường từ máy bạn.')}</span>
    </div>
  )
}

function SaveDialog({ current, serverId, request, onClose, onSaved }: { current: HttpSaved | null; serverId: string; request: HttpRequest; onClose: () => void; onSaved: (s: HttpSaved) => void }) {
  const toast = useToast()
  const [name, setName] = useState(current?.name ?? (shortUrl(request.url) || 'Request'))
  const [everywhere, setEverywhere] = useState(current ? current.serverId === null : false)
  const save = async (asNew: boolean) => {
    try {
      const s = await api.httpSave({ id: asNew || !current ? '' : current.id, serverId: everywhere ? null : serverId, name, request })
      onSaved(s)
    } catch (e) {
      toast({ title: t('Không lưu được'), detail: isAppError(e) ? (e.detail ?? e.code) : String(e) })
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      width={440}
      title={current ? t('Lưu request · {name}', { name: current.name }) : t('Lưu request')}
      footer={
        <>
          <Button onClick={onClose}>{t('Huỷ')}</Button>
          {current && <Button onClick={() => void save(true)}>{t('Lưu thành bản mới')}</Button>}
          <Button variant="primary" disabled={!name.trim()} onClick={() => void save(false)}>
            {current ? t('Cập nhật') : t('Lưu')}
          </Button>
        </>
      }
    >
      <Field label={t('Tên')}>
        <TextInput value={name} onChange={setName} autoFocus />
      </Field>
      <Checkbox checked={everywhere} onChange={setEverywhere}>
        {t('Dùng cho mọi server (không chỉ server này)')}
      </Checkbox>
      <span className="text-[11px] text-muted">{t('Token, mật khẩu và header bí mật được cất trong Keychain của máy; phần còn lại lưu trên máy này.')}</span>
    </Modal>
  )
}
