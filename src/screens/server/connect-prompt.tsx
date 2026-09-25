import { AlertTriangle, ShieldQuestion } from 'lucide-react'
import { useState } from 'react'
import { useConnections, type Prompt } from '../../app/connections'
import { useToast } from '../../components/toast'
import { Checkbox } from '../../components/ui/checkbox'
import { Field, TextInput } from '../../components/ui/form-controls'
import { Modal } from '../../components/ui/modal'
import { Button } from '../../components/ui/primitives'
import type { Server } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import { keyName } from '../servers/format'

/** Asks the user what the connection needs: trust a new host key, a password or
 *  a key passphrase. A changed host key is only explained, never accepted here. */
export function ConnectPrompt({ server, user, prompt, onCancel }: { server: Server; user: string; prompt: Prompt; onCancel: () => void }) {
  const conns = useConnections()
  const toast = useToast()
  const [secret, setSecret] = useState('')
  const [remember, setRemember] = useState(true)
  const target = `${server.host}${server.port !== 22 ? `:${server.port}` : ''}`
  const knownHostsName = server.port !== 22 ? `[${server.host}]:${server.port}` : server.host

  if (prompt.status === 'hostKey' && prompt.issue.kind === 'unknown') {
    const { fingerprint, algorithm } = prompt.issue
    return (
      <Modal
        open
        onClose={onCancel}
        width={500}
        title={`Lần đầu kết nối tới ${server.name}`}
        subtitle={`${user}@${target}`}
        footer={
          <>
            <Button onClick={onCancel}>Huỷ</Button>
            <Button variant="primary" onClick={() => conns.connect(server.id, user, { trustFingerprint: fingerprint })}>
              Tin tưởng và kết nối
            </Button>
          </>
        }
      >
        <div className="flex gap-2.5">
          <ShieldQuestion size={18} strokeWidth={1.75} className="mt-0.5 flex-none text-info" />
          <span className="leading-relaxed text-ink2">
            Máy này chưa từng kết nối tới {target}, nên chưa biết khoá của máy chủ. Nếu có thể, hãy đối chiếu vân tay dưới đây với khoá trên server trước khi tin tưởng.
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-muted">Vân tay khoá máy chủ ({algorithm})</span>
          <span className="rounded-md bg-sunken px-2 py-1.5 font-mono text-[12px] break-all text-ink select-text">{fingerprint}</span>
        </div>
        <span className="text-[11px] leading-relaxed text-muted">
          Xem trên server bằng <span className="font-mono">ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub</span>. Khi tin tưởng, khoá được lưu vào ~/.ssh/known_hosts giống lệnh ssh.
        </span>
      </Modal>
    )
  }

  if (prompt.status === 'hostKey' && prompt.issue.kind === 'changed') {
    const { fingerprint, algorithm, line } = prompt.issue
    const removeCmd = `ssh-keygen -R '${knownHostsName}'`
    return (
      <Modal open onClose={onCancel} width={520} title="Khoá của máy chủ đã thay đổi" subtitle={`${user}@${target}`} footer={<Button onClick={onCancel}>Đóng</Button>}>
        <div className="flex gap-2.5 rounded-lg bg-danger-soft px-3 py-2.5">
          <AlertTriangle size={16} strokeWidth={2} className="mt-0.5 flex-none text-danger" />
          <span className="leading-relaxed text-ink">
            Khoá {target} gửi về khác với khoá đã lưu ở dòng {line} của ~/.ssh/known_hosts. Có thể server vừa được cài lại, nhưng cũng có thể có người đang chặn giữa đường. Portway không kết nối.
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-muted">Vân tay mới ({algorithm})</span>
          <span className="rounded-md bg-sunken px-2 py-1.5 font-mono text-[12px] break-all text-ink select-text">{fingerprint}</span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-muted">Nếu chắc server đã được cài lại, xoá khoá cũ bằng lệnh này rồi kết nối lại</span>
          <div className="flex items-center gap-2">
            <span className="flex-1 rounded-md bg-sunken px-2 py-1.5 font-mono text-[12px] break-all text-ink2 select-text">{removeCmd}</span>
            <Button size="sm" onClick={() => copyText(removeCmd).then(() => toast({ title: 'Đã sao chép lệnh', detail: removeCmd }))}>
              Sao chép
            </Button>
          </div>
        </div>
      </Modal>
    )
  }

  const isPassword = prompt.status === 'needPassword'
  const retry = prompt.status === 'needPassword' || prompt.status === 'needPassphrase' ? prompt.retry : false
  const submit = () => {
    if (!secret) return
    void conns.connect(server.id, user, isPassword ? { password: secret, remember } : { passphrase: secret, remember })
  }
  return (
    <Modal
      open
      onClose={onCancel}
      width={420}
      title={isPassword ? `Mật khẩu cho ${user}@${server.name}` : `Passphrase của khoá ${prompt.status === 'needPassphrase' ? keyName(prompt.keyPath) : ''}`}
      subtitle={isPassword ? target : 'Khoá này được mã hoá bằng passphrase'}
      footer={
        <>
          <Button onClick={onCancel}>Huỷ</Button>
          <Button variant="primary" onClick={submit} disabled={!secret}>
            Kết nối
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <Field label={isPassword ? 'Mật khẩu' : 'Passphrase'} error={retry ? (isPassword ? 'Mật khẩu không đúng, nhập lại' : 'Passphrase không đúng, nhập lại') : undefined}>
          <TextInput type="password" value={secret} onChange={setSecret} invalid={retry} autoFocus />
        </Field>
        <Checkbox checked={remember} onChange={setRemember}>
          Lưu vào Keychain của máy để lần sau không phải nhập
        </Checkbox>
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
