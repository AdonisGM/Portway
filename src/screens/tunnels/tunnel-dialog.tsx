import { ChevronDown, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useConnections } from '../../app/connections'
import { useServers } from '../../app/servers'
import { useTunnels } from '../../app/tunnels'
import { Checkbox } from '../../components/ui/checkbox'
import { Field, SelectField, TextInput } from '../../components/ui/form-controls'
import { Modal } from '../../components/ui/modal'
import { Button } from '../../components/ui/primitives'
import { SegmentedControl } from '../../components/ui/segmented'
import { t } from '../../i18n'
import { api, isAppError, type Listen, type Tunnel, type TunnelSpec } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import { commandFor, saveError, targetArgs, templateFor } from './format'

type Suggestion = { dest: string; label: string }

/** Ports on the server a local tunnel can reach: what listens on loopback or
 *  a private address, from a connected session of that server. */
function useSuggestions(serverId: string, user: string, on: boolean) {
  const conns = useConnections()
  const connected = conns.get(serverId, user)?.status === 'connected'
  const [list, setList] = useState<Suggestion[] | null>(null)
  useEffect(() => {
    setList(null)
    if (!on || !serverId || !connected) return
    let stop = false
    api.ports(serverId, user).then(
      (p) => {
        if (stop) return
        const seen = new Set<number>()
        const out: Suggestion[] = []
        const add = (l: Listen) => {
          if (l.proto !== 'tcp' || seen.has(l.port) || l.port === 22) return
          seen.add(l.port)
          out.push({ dest: `127.0.0.1:${l.port}`, label: l.container ? `docker · ${l.container}` : (l.process ?? t('không rõ tiến trình')) })
        }
        p.listening.filter((l) => l.scope !== 'public').forEach(add)
        p.listening.filter((l) => l.scope === 'public').forEach(add)
        setList(out.slice(0, 12))
      },
      () => !stop && setList([]),
    )
    return () => {
      stop = true
    }
  }, [serverId, user, on, connected])
  return { list, connected }
}

export function TunnelDialog({ editing, initial, onClose }: { editing: Tunnel | null; initial?: Partial<TunnelSpec>; onClose: () => void }) {
  const { servers, byId } = useServers()
  const { save, start } = useTunnels()
  const vias = useMemo(() => servers.flatMap((s) => s.accounts.map((a) => ({ value: `${s.id}|${a.user}`, label: `${a.user}@${s.name}` }))), [servers])
  const base: TunnelSpec = editing ?? {
    id: '',
    name: '',
    kind: 'local',
    serverId: vias[0]?.value.split('|')[0] ?? '',
    user: vias[0]?.value.split('|')[1] ?? '',
    port: 15000,
    bind: '127.0.0.1',
    dest: '',
    openKind: 'none',
    openTemplate: '',
    autoStart: false,
    autoReconnect: true,
    ...initial,
  }
  const [form, setForm] = useState<TunnelSpec>(base)
  const [portText, setPortText] = useState(String(base.port))
  const [advanced, setAdvanced] = useState(base.kind === 'remote')
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState(false)
  const [fail, setFail] = useState<string | null>(null)
  const set = (p: Partial<TunnelSpec>) => setForm((x) => ({ ...x, ...p }))
  const server = byId(form.serverId)
  const { list: sugg, connected } = useSuggestions(form.serverId, form.user, form.kind === 'local')

  // A new tunnel starts on a free port.
  useEffect(() => {
    if (editing || initial?.port) return
    void api.freePort(15000).then((p) => {
      set({ port: p })
      setPortText(String(p))
    })
  }, [editing, initial?.port])

  const port = Number(portText)
  const portErr =
    !/^\d+$/.test(portText) || port < 1 || port > 65535
      ? t('Cổng không hợp lệ')
      : form.kind !== 'remote' && port < 1024
        ? t('Cổng dưới 1024 cần quyền quản trị trên máy bạn')
        : busy
          ? t('Cổng {port} đang bị chiếm trên máy bạn', { port })
          : undefined
  useEffect(() => {
    if (form.kind === 'remote' || !(port >= 1024 && port <= 65535)) return setBusy(false)
    const timer = setTimeout(() => void api.portFree(port, form.bind, editing?.id).then((free) => setBusy(!free)), 250)
    return () => clearTimeout(timer)
  }, [port, form.bind, form.kind, editing?.id])

  const destOk = form.kind === 'socks' || /^[\w.:[\]-]+:\d{1,5}$/.test(form.dest.trim())
  const ready = !!form.name.trim() && !portErr && destOk && !!form.serverId
  const spec: TunnelSpec = { ...form, port, dest: form.kind === 'socks' ? '' : form.dest.trim(), name: form.name.trim() }
  const cmd = commandFor({ ...spec, dest: spec.dest || '…' }, targetArgs(server, form.user))

  const submit = async () => {
    setPending(true)
    setFail(null)
    try {
      const saved = await save(spec)
      if (!editing) await start(saved.id)
      onClose()
    } catch (e) {
      setFail(isAppError(e) ? saveError(e) : String(e))
    } finally {
      setPending(false)
    }
  }

  const pickOpen = (kind: TunnelSpec['openKind']) => set({ openKind: kind, openTemplate: kind === 'none' ? '' : templateFor(kind, form.dest, form.user) })

  return (
    <Modal
      open
      onClose={() => !pending && onClose()}
      width={620}
      title={editing ? t('Sửa tunnel') : t('Tunnel mới')}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            {t('Huỷ')}
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={pending || !ready}>
            {pending ? t('Đang lưu…') : editing ? t('Lưu') : t('Tạo và bật')}
          </Button>
        </>
      }
    >
      <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <Field label={t('Tên')}>
          <TextInput value={form.name} onChange={(v) => set({ name: v })} placeholder="Postgres shop" autoFocus />
        </Field>
        <Field label={t('Loại#tunnel')}>
          <SegmentedControl
            full
            value={form.kind}
            onChange={(v) => set({ kind: v })}
            options={[
              { id: 'local', label: 'Local' },
              { id: 'socks', label: 'SOCKS' },
              ...(advanced ? [{ id: 'remote' as const, label: 'Remote' }] : []),
            ]}
          />
        </Field>
      </div>
      <button
        type="button"
        onClick={() => {
          setAdvanced(!advanced)
          if (advanced && form.kind === 'remote') set({ kind: 'local' })
        }}
        className="-mt-1 flex cursor-pointer items-center gap-1 self-start text-[11.5px] text-ink2"
      >
        {advanced ? <ChevronDown size={12} strokeWidth={1.8} /> : <ChevronRight size={12} strokeWidth={1.8} />}
        {t('Nâng cao (Remote forward)')}
      </button>
      <span className="-mt-1.5 text-[11.5px] leading-normal text-muted">
        {form.kind === 'local'
          ? t('Mở một cổng trên máy bạn, kết nối vào đó được chuyển tới host:port nhìn từ server (ssh -L).')
          : form.kind === 'socks'
            ? t('Một proxy SOCKS5 trên máy bạn; mọi kết nối qua proxy đi ra từ server (ssh -D).')
            : t('Server mở một cổng (chỉ trên localhost của server), kết nối vào đó được chuyển về host:port trên máy bạn (ssh -R).')}
      </span>

      <Field label={t('Đi qua (server + user)')}>
        <SelectField
          value={`${form.serverId}|${form.user}`}
          onChange={(v) => {
            const [serverId, user] = v.split('|')
            set({ serverId, user })
          }}
          options={vias}
        />
      </Field>

      <div className="grid items-start gap-3" style={{ gridTemplateColumns: form.kind === 'remote' ? '1fr' : '1fr 1fr' }}>
        <Field label={form.kind === 'remote' ? t('Cổng trên server') : t('Cổng trên máy bạn')} error={portErr}>
          <div className="flex gap-1.5">
            <TextInput value={portText} onChange={(v) => setPortText(v.replace(/\D/g, '').slice(0, 5))} numeric invalid={!!portErr} />
            {form.kind !== 'remote' && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void api.freePort(form.kind === 'socks' ? 1080 : 15000, editing?.id).then((p) => {
                    setPortText(String(p))
                    set({ port: p })
                  })
                }
              >
                {t('Tự chọn')}
              </Button>
            )}
          </div>
        </Field>
        {form.kind !== 'remote' && (
          <Field label={t('Bind trên máy bạn')}>
            <SegmentedControl
              full
              value={form.bind}
              onChange={(v) => set({ bind: v })}
              options={[
                { id: '127.0.0.1', label: '127.0.0.1' },
                { id: '0.0.0.0', label: '0.0.0.0 (LAN)' },
              ]}
            />
          </Field>
        )}
      </div>
      {form.bind === '0.0.0.0' && form.kind !== 'remote' && (
        <span className="rounded-lg bg-warn-soft px-3 py-2 text-[11.5px] text-ink2">{t('Mọi máy trong cùng mạng (LAN) với máy bạn đều dùng được tunnel này.')}</span>
      )}

      {form.kind !== 'socks' && (
        <Field
          label={form.kind === 'remote' ? t('Đích trên máy bạn (host:port)') : t('Đích (host:port nhìn từ {server})', { server: server?.name ?? 'server' })}
          error={form.dest.trim() && !destOk ? t('Cần dạng host:port, ví dụ 127.0.0.1:5432') : undefined}
        >
          <TextInput value={form.dest} onChange={(v) => set({ dest: v })} placeholder={form.kind === 'remote' ? 'localhost:3000' : '127.0.0.1:5432'} />
          {form.kind === 'local' && (
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              <span className="text-[11px] text-muted">
                {!connected
                  ? t('Kết nối server này để thấy gợi ý cổng đang lắng nghe.')
                  : sugg == null
                    ? t('Đang đọc cổng trên server…')
                    : sugg.length
                      ? t('Gợi ý từ server:')
                      : t('Không thấy cổng nào khác 22.')}
              </span>
              {sugg?.map((s) => (
                <button
                  key={s.dest}
                  type="button"
                  onClick={() => set({ dest: s.dest, name: form.name || s.label.replace(/^docker · /, '') })}
                  className="cursor-pointer rounded-md border border-line2 px-2 py-0.5 text-[11px] hover:border-muted"
                >
                  <span className="font-mono">{s.dest}</span> · {s.label}
                </button>
              ))}
            </div>
          )}
        </Field>
      )}

      {form.kind !== 'socks' && (
        <div className="grid items-start gap-3" style={{ gridTemplateColumns: '1fr 1.4fr' }}>
          <Field label={t('Nút Mở')}>
            <SegmentedControl
              full
              value={form.openKind}
              onChange={pickOpen}
              options={[
                { id: 'none', label: t('Không#open') },
                { id: 'url', label: t('Mở URL') },
                { id: 'conn', label: t('Copy chuỗi') },
              ]}
            />
          </Field>
          {form.openKind !== 'none' && (
            <Field label={form.openKind === 'url' ? 'URL' : t('Chuỗi kết nối')} help={t('{port} là cổng trên máy bạn')}>
              <TextInput value={form.openTemplate} onChange={(v) => set({ openTemplate: v })} />
            </Field>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-4">
        <Checkbox checked={form.autoStart} onChange={(v) => set({ autoStart: v })}>
          {t('Tự bật khi mở Portway')}
        </Checkbox>
        <Checkbox checked={form.autoReconnect} onChange={(v) => set({ autoReconnect: v })}>
          {t('Tự kết nối lại khi rớt mạng')}
        </Checkbox>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[11px] text-muted">{t('Tương đương lệnh (Portway tự chạy, không cần Terminal)')}</span>
        <div className="flex items-start gap-2 rounded-md bg-sunken px-2.5 py-2">
          <span className="flex-1 font-mono text-[11.5px] leading-[1.55] break-all select-text">{cmd}</span>
          <Button size="xs" variant="ghost" onClick={() => void copyText(cmd)}>
            {t('Sao chép')}
          </Button>
        </div>
      </div>
      {fail && <span className="rounded-md bg-danger-soft px-2 py-1.5 text-[11.5px] text-danger">{fail}</span>}
    </Modal>
  )
}
