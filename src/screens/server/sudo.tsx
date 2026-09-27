import { Lock } from 'lucide-react'
import { useState } from 'react'
import { useConnections } from '../../app/connections'
import { t } from '../../i18n'
import { useToast } from '../../components/toast'
import { Field, TextInput } from '../../components/ui/form-controls'
import { Modal } from '../../components/ui/modal'
import { Button, Chip, TONES } from '../../components/ui/primitives'
import { api, isAppError, type Server } from '../../lib/api'

/** Asks for the sudo password of the session's user. The password is checked
 *  on the server (sudo -S -k true) and kept in Rust memory for this session only. */
export function SudoPrompt({ server, user }: { server: Server; user: string }) {
  const conns = useConnections()
  const toast = useToast()
  const [pw, setPw] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [refused, setRefused] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const close = () => conns.askSudo(server.id, user, false)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.sudo(server.id, user, pw || undefined)
      if (r.status === 'enabled') {
        conns.setSudo(server.id, user, true)
        toast({
          title: t('Đã bật sudo cho {user}@{server}', { user, server: server.name }),
          detail: t('Mật khẩu chỉ giữ trong bộ nhớ, hết khi ngắt kết nối'),
        })
        close()
      } else if (r.status === 'needPassword') {
        if (r.retry) setError(t('Mật khẩu không đúng, nhập lại'))
        setPw('')
      } else {
        setRefused(r.detail)
      }
    } catch (e) {
      setError(isAppError(e) ? (e.detail ?? e.code) : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={close}
      width={420}
      title={t('Dùng sudo cho {user}@{server}', { user, server: server.name })}
      subtitle={t('Để đọc firewall, Docker, tiến trình của user khác và thao tác tệp bằng root')}
      footer={
        refused ? (
          <Button onClick={close}>{t('Đóng')}</Button>
        ) : (
          <>
            <Button onClick={close}>{t('Huỷ')}</Button>
            <Button variant="primary" onClick={submit} disabled={busy}>
              {busy ? t('Đang kiểm tra…') : t('Bật sudo')}
            </Button>
          </>
        )
      }
    >
      {refused ? (
        <div className="flex flex-col gap-2">
          <span className="leading-relaxed text-ink2">{t('User {user} không dùng được sudo trên server này.', { user })}</span>
          <span className="rounded-md bg-danger-soft px-2 py-1 font-mono text-[11.5px] break-all text-danger select-text">{refused}</span>
        </div>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <Field label={t('Mật khẩu sudo của {user}', { user })}
            error={error ?? undefined}
            help={t('Để trống nếu sudo không cần mật khẩu (NOPASSWD).')}
          >
            <TextInput type="password" value={pw} onChange={setPw} invalid={!!error} autoFocus />
          </Field>
          <span className="text-[11px] leading-relaxed text-muted">
            {t('Mật khẩu chỉ giữ trong bộ nhớ của Portway cho phiên này, không lưu xuống máy. Lệnh thay đổi server chỉ chạy bằng sudo khi bạn chọn làm thao tác đó.')}
          </span>
          <button type="submit" hidden />
        </form>
      )}
    </Modal>
  )
}

/** Banner under the header: offer sudo to a non-root user, or show it is on. */
export function SudoBanner({ server, user, sudo }: { server: Server; user: string; sudo: boolean }) {
  const conns = useConnections()
  const toast = useToast()
  if (user === 'root') return null

  if (sudo) {
    const off = async () => {
      await api.sudoOff(server.id, user).catch(() => {})
      conns.setSudo(server.id, user, false)
      toast({ title: t('Đã tắt sudo'), detail: `${user}@${server.name}` })
    }
    return (
      <div className="flex items-center gap-2.5 rounded-[10px] border border-line px-3 py-[7px]">
        <Chip tone={TONES.warn}>sudo</Chip>
        <span className="flex-1 text-ink2">
          {t('Phiên {user}@{server} đang dùng sudo: firewall, Docker và tiến trình của user khác được đọc qua sudo.', { user, server: server.name })}
        </span>
        <Button variant="ghost" size="xs" onClick={off}>
          {t('Tắt sudo')}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2.5 rounded-[10px] bg-info-soft px-3 py-[9px]">
      <Lock size={15} strokeWidth={1.9} className="flex-none text-info" />
      <span className="flex-1 leading-snug text-ink">
        {t('Đang xem bằng')} <span className="font-mono text-[12px]">{user}</span>
        {t('. Firewall, Docker và tiến trình của user khác có thể cần quyền root nên đang bị giới hạn.')}
      </span>
      <Button size="xs" onClick={() => conns.askSudo(server.id, user, true)}>
        {t('Dùng sudo cho phiên này')}
      </Button>
    </div>
  )
}

/** Small "Dùng sudo" button for cards that hit a permission wall. */
export function UseSudoButton({ server, user }: { server: Server; user: string }) {
  const conns = useConnections()
  if (user === 'root') return null
  return (
    <Button size="xs" onClick={() => conns.askSudo(server.id, user, true)}>
      {t('Dùng sudo')}
    </Button>
  )
}
