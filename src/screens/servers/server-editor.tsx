import { X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNav } from '../../app/nav'
import { useServers } from '../../app/servers'
import { OsBadge } from '../../components/os-badge'
import { Field, SelectField, TextInput, type Option } from '../../components/ui/form-controls'
import { ConfirmModal, Modal } from '../../components/ui/modal'
import { Button } from '../../components/ui/primitives'
import { useToast } from '../../components/toast'
import { t } from '../../i18n'
import { useLang } from '../../i18n/use-lang'
import { isAppError, type Account, type Auth, type Server, type ServerInput } from '../../lib/api'
import { errorMessage, keyName, parseTags, sshCommand } from './format'

/** Auth is edited as one select value: `key:<path>` or `password`. */
type FormAccount = { user: string; auth: string }
type Form = {
  name: string
  group: string
  host: string
  port: string
  accounts: FormAccount[]
  tagText: string
  note: string
  /** `serverId|user` of the jump host, '' for a direct connection. */
  jump: string
}

/** Select value for "no jump host" (the select treats '' as nothing chosen). */
const DIRECT = 'direct'

const encodeAuth = (a: Auth) => (a.kind === 'password' ? 'password' : `key:${a.path}`)
const decodeAuth = (v: string): Auth => (v === 'password' ? { kind: 'password' } : { kind: 'key', path: v.slice(4) })

function toForm(s: Server): Form {
  return {
    name: s.name,
    group: s.group,
    host: s.host,
    port: String(s.port),
    accounts: s.accounts.map((a) => ({ user: a.user, auth: encodeAuth(a.auth) })),
    tagText: s.tags.join(', '),
    note: s.note,
    jump: s.jump ? `${s.jump.serverId}|${s.jump.user}` : '',
  }
}

function toInput(f: Form, id?: string): ServerInput {
  return {
    id,
    name: f.name,
    group: f.group,
    host: f.host,
    port: Number(f.port),
    accounts: f.accounts.map((a): Account => ({ user: a.user, auth: decodeAuth(a.auth) })),
    tags: parseTags(f.tagText),
    note: f.note,
    jump: f.jump ? { serverId: f.jump.slice(0, f.jump.indexOf('|')), user: f.jump.slice(f.jump.indexOf('|') + 1) } : null,
  }
}

type Errors = Partial<Record<'name' | 'host' | 'port' | 'accounts' | 'jump' | 'form', string>>

/** Add or edit a server. `server` null means adding. Only changes the local list;
 *  nothing runs on the server. */
export function ServerEditor({
  server,
  onClose,
  onConnect,
}: {
  server: Server | null
  onClose: () => void
  onConnect: (server: Server, user: string) => void
}) {
  const { servers, keys, save, remove, byId } = useServers()
  const nav = useNav()
  const toast = useToast()
  const lang = useLang()
  const defaultAuth = keys[0] ? `key:${keys[0].path}` : 'password'
  // The editor is mounted per opening, so the starting form is taken once.
  const [initial] = useState<Form>(() =>
    server
      ? toForm(server)
      : { name: '', group: '', host: '', port: '22', accounts: [{ user: 'root', auth: defaultAuth }], tagText: '', note: '', jump: '' },
  )
  const [form, setForm] = useState<Form>(initial)
  const [errors, setErrors] = useState<Errors>({})
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const dirty = JSON.stringify(form) !== JSON.stringify(initial)
  const canAdd = !!form.name.trim() && !!form.host.trim() && form.accounts.some((a) => a.user.trim())

  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((f) => ({ ...f, [key]: value }))
    setErrors((e) => ({ ...e, [key]: undefined, form: undefined }))
  }
  const setAccount = (i: number, patch: Partial<FormAccount>) => {
    set(
      'accounts',
      form.accounts.map((a, j) => (j === i ? { ...a, ...patch } : a)),
    )
  }

  // Keys found in ~/.ssh, plus any key path already on the server that is not there.
  const authOptions = useMemo<Option[]>(() => {
    const opts: Option[] = keys.map((k) => ({ value: `key:${k.path}`, label: t('Khoá {name}', { name: k.name }) }))
    for (const a of form.accounts) {
      if (a.auth.startsWith('key:') && !opts.some((o) => o.value === a.auth)) {
        opts.push({ value: a.auth, label: t('Khoá {name} (không thấy)', { name: keyName(a.auth.slice(4)) }) })
      }
    }
    return [...opts, { value: 'password', label: t('Mật khẩu') }]
  }, [keys, form.accounts, lang])

  const submit = async (): Promise<Server | null> => {
    const port = Number(form.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setErrors({ port: t('Cổng phải từ 1 đến 65535') })
      return null
    }
    setBusy(true)
    try {
      const saved = await save(toInput(form, server?.id))
      toast(
        server
          ? { title: t('Đã lưu {name}', { name: saved.name }), detail: t('Chỉ lưu trên máy này, không thay đổi gì trên server') }
          : { title: t('Đã thêm {name}', { name: saved.name }), detail: t('Hệ điều hành sẽ được nhận khi kết nối lần đầu') },
      )
      return saved
    } catch (e) {
      if (isAppError(e)) {
        const field = (['name', 'host', 'port', 'accounts', 'jump'] as const).find((f) => f === e.field) ?? 'form'
        setErrors({ [field]: errorMessage(e) })
      } else {
        setErrors({ form: String(e) })
      }
      return null
    } finally {
      setBusy(false)
    }
  }

  const saveAndClose = async () => {
    if (await submit()) onClose()
  }

  const connect = async () => {
    const target = dirty ? await submit() : server
    if (!target) return
    onClose()
    onConnect(target, target.accounts[0].user)
  }

  const doDelete = async () => {
    if (!server) return
    setBusy(true)
    try {
      await remove(server.id)
      nav.closeServer(server.id)
      toast({ title: t('Đã xoá {name} khỏi Portway', { name: server.name }), detail: t('Không chạy lệnh nào trên server') })
      setConfirmDelete(false)
      onClose()
    } catch (e) {
      setErrors({ form: isAppError(e) ? errorMessage(e) : String(e) })
      setConfirmDelete(false)
    } finally {
      setBusy(false)
    }
  }

  const firstAccount = form.accounts.find((a) => a.user.trim())

  // Any other saved server and account can be the jump host.
  const jumpOptions: Option[] = [
    { value: DIRECT, label: t('Không, kết nối thẳng') },
    ...servers
      .filter((s) => s.id !== server?.id)
      .flatMap((s) => s.accounts.map((a) => ({ value: `${s.id}|${a.user}`, label: `${a.user}@${s.name}` }))),
  ]
  const jumpServer = form.jump ? byId(form.jump.slice(0, form.jump.indexOf('|'))) : undefined
  const jumpSpec = jumpServer && `${form.jump.slice(form.jump.indexOf('|') + 1)}@${jumpServer.host}${jumpServer.port !== 22 ? `:${jumpServer.port}` : ''}`

  return (
    <>
      <Modal
        open
        onClose={onClose}
        width={520}
        title={server ? t('Sửa kết nối · {name}', { name: server.name }) : t('Thêm server')}
        subtitle={server ? t('Chỉ lưu trên máy này, không thay đổi gì trên server') : t('Kết nối qua SSH, không cần cài gì lên server')}
        footer={
          server ? (
            <>
              <Button variant="ghost" onClick={() => setConfirmDelete(true)} disabled={busy}>
                {t('Xoá')}
              </Button>
              <span className="flex-1" />
              <Button onClick={onClose}>{t('Huỷ')}</Button>
              <Button onClick={saveAndClose} disabled={!dirty || busy}>
                {t('Lưu')}
              </Button>
              <Button variant="primary" onClick={connect} disabled={busy}>
                {t('Kết nối')}
              </Button>
            </>
          ) : (
            <>
              <Button onClick={onClose}>{t('Huỷ')}</Button>
              <Button variant="primary" onClick={saveAndClose} disabled={!canAdd || busy}>
                {t('Thêm server')}
              </Button>
            </>
          )
        }
      >
        <div className="grid grid-cols-2 gap-2.5">
          <Field label={t('Tên hiển thị')} error={errors.name}>
            <TextInput value={form.name} onChange={(v) => set('name', v)} invalid={!!errors.name} autoFocus={!server} />
          </Field>
          <Field label={t('Nhóm')}>
            <TextInput value={form.group} onChange={(v) => set('group', v)} placeholder="production" />
          </Field>
        </div>

        <div className="grid gap-2.5" style={{ gridTemplateColumns: '1fr 72px' }}>
          <Field label={t('Host hoặc IP')} error={errors.host}>
            <TextInput value={form.host} onChange={(v) => set('host', v)} invalid={!!errors.host} placeholder="103.21.44.10" />
          </Field>
          <Field label={t('Cổng')} error={errors.port}>
            <TextInput value={form.port} onChange={(v) => set('port', v.replace(/\D/g, '').slice(0, 5))} numeric invalid={!!errors.port} />
          </Field>
        </div>

        <Field
          label={t('Kết nối qua (jump host)')}
          error={errors.jump}
          help={
            form.jump
              ? t('Portway mở SSH tới {name} trước rồi đi tiếp tới host ở trên, như ssh -J. Host có thể là IP nội bộ chỉ jump host thấy được.', { name: jumpServer?.name ?? '?' })
              : t('Dùng khi server nằm sau bastion, không mở SSH ra ngoài.')
          }
        >
          <SelectField value={form.jump || DIRECT} onChange={(v) => set('jump', v === DIRECT ? '' : v)} options={jumpOptions} />
        </Field>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline">
            <span className="flex-1 text-[11px] text-muted">{t('Tài khoản đăng nhập')}</span>
            <span className="num text-[11px] text-muted">{t('{n} tài khoản', { n: form.accounts.length })}</span>
          </div>
          {form.accounts.map((a, i) => (
            <div key={i} className="grid items-center gap-1.5" style={{ gridTemplateColumns: 'minmax(0,1fr) 150px 20px' }}>
              <TextInput value={a.user} onChange={(v) => setAccount(i, { user: v })} placeholder="user" />
              <SelectField value={a.auth} onChange={(v) => setAccount(i, { auth: v })} options={authOptions} />
              <button
                type="button"
                title={t('Bỏ tài khoản này')}
                disabled={form.accounts.length < 2}
                onClick={() => set('accounts', form.accounts.filter((_, j) => j !== i))}
                className="flex cursor-pointer items-center justify-center text-muted hover:text-ink disabled:cursor-default disabled:opacity-30"
              >
                <X size={14} />
              </button>
            </div>
          ))}
          {errors.accounts && <span className="text-[11px] text-danger">{errors.accounts}</span>}
          <div className="flex items-center gap-2">
            <Button
              variant="dashed"
              size="xs"
              onClick={() => set('accounts', [...form.accounts, { user: '', auth: form.accounts[0]?.auth ?? defaultAuth }])}
            >
              {t('Thêm tài khoản')}
            </Button>
            <span className="text-[11px] text-muted">{t('Tài khoản đầu tiên là mặc định. Mật khẩu lưu trong Keychain của máy.')}</span>
          </div>
        </div>

        <Field label="Tag" help={t('Cách nhau bằng dấu phẩy')}>
          <TextInput value={form.tagText} onChange={(v) => set('tagText', v)} placeholder={t('docker, nginx, khách A')} />
        </Field>

        <Field label={t('Ghi chú')}>
          <TextInput value={form.note} onChange={(v) => set('note', v)} placeholder={t('VD: VPS Vultr Singapore, hết hạn 12/2026')} />
        </Field>

        {server && (
          <div className="flex items-center gap-2.5 rounded-lg bg-raised px-2.5 py-2">
            <OsBadge os={server.os} size={22} />
            <span className="flex flex-col gap-px">
              <span className="font-semibold">{server.os ?? t('Chưa rõ hệ điều hành')}</span>
              <span className="text-[11px] text-muted">{t('Tự nhận khi kết nối, không cần nhập')}</span>
            </span>
          </div>
        )}

        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-muted">{t('Lệnh SSH tương ứng')}</span>
          <span className="rounded-md bg-sunken px-2 py-1.5 font-mono text-[11.5px] leading-normal break-all text-ink2 select-text">
            {sshCommand(form.host.trim(), Number(form.port), firstAccount && { user: firstAccount.user.trim(), auth: decodeAuth(firstAccount.auth) }, jumpSpec)}
          </span>
        </div>

        {errors.form && <span className="text-[11px] text-danger">{errors.form}</span>}
      </Modal>

      {server && (
        <ConfirmModal
          open={confirmDelete}
          onClose={() => setConfirmDelete(false)}
          title={t('Xoá {name} khỏi Portway?', { name: server.name })}
          confirm={t('Xoá khỏi danh sách')}
          danger
          pending={busy}
          onConfirm={doDelete}
        >
          {t('Chỉ xoá thông tin kết nối lưu trên máy này. Server và dữ liệu trên đó không bị ảnh hưởng.')}
        </ConfirmModal>
      )}
    </>
  )
}
