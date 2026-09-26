import { useState } from 'react'
import { useServers } from '../../app/servers'
import { t } from '../../i18n'
import { Field, TextInput } from '../../components/ui/form-controls'
import { Modal } from '../../components/ui/modal'
import { Button } from '../../components/ui/primitives'
import { SegmentedControl } from '../../components/ui/segmented'
import { isAppError, type GenerateKeyInput, type SshKey } from '../../lib/api'
import { keyErrorMessage } from './format'

type Kind = GenerateKeyInput['kind']

/** First free file name for the kind: id_ed25519, then id_ed25519_2, … */
function freeName(kind: Kind, taken: string[]) {
  const base = kind === 'rsa' ? 'id_rsa' : 'id_ed25519'
  if (!taken.includes(base)) return base
  for (let i = 2; ; i++) if (!taken.includes(`${base}_${i}`)) return `${base}_${i}`
}

/** Create a key pair in ~/.ssh, like `ssh-keygen -t ed25519 -f … -C …`. */
export function KeyGenerator({ onClose, onCreated }: { onClose: () => void; onCreated: (key: SshKey) => void }) {
  const { keys, generateKey } = useServers()
  const taken = keys.map((k) => k.name)
  const [kind, setKind] = useState<Kind>('ed25519')
  const [name, setName] = useState(() => freeName('ed25519', taken))
  const [nameTouched, setNameTouched] = useState(false)
  const [comment, setComment] = useState('')
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [error, setError] = useState<{ name?: string; pass?: string; form?: string }>({})
  const [busy, setBusy] = useState(false)

  const changeKind = (k: Kind) => {
    setKind(k)
    // Follow the kind with the suggested name until the user types their own.
    if (!nameTouched) setName(freeName(k, taken))
  }

  const mismatch = pass !== pass2
  const canCreate = !!name.trim() && !mismatch && !busy

  const create = async () => {
    if (mismatch) return setError({ pass: t('Hai lần nhập passphrase không khớp') })
    setBusy(true)
    setError({})
    try {
      const key = await generateKey({ name: name.trim(), kind, comment: comment.trim(), passphrase: pass })
      onCreated(key)
      onClose()
    } catch (e) {
      if (isAppError(e) && e.field === 'name') setError({ name: keyErrorMessage(e) })
      else setError({ form: isAppError(e) ? keyErrorMessage(e) : String(e) })
    } finally {
      setBusy(false)
    }
  }

  const command = `ssh-keygen -t ${kind === 'rsa' ? 'rsa -b 4096' : 'ed25519'} -f ~/.ssh/${name.trim() || '…'}${comment.trim() ? ` -C "${comment.trim()}"` : ''}`

  return (
    <Modal
      open
      onClose={onClose}
      width={480}
      title={t('Tạo khoá mới')}
      subtitle={t('Tạo cặp khoá trong ~/.ssh trên máy này')}
      footer={
        <>
          <Button onClick={onClose}>{t('Huỷ')}</Button>
          <Button variant="primary" onClick={create} disabled={!canCreate}>
            {busy ? t('Đang tạo…') : t('Tạo khoá')}
          </Button>
        </>
      }
    >
      <Field
        label={t('Loại khoá')}
        help={kind === 'rsa' ? t('Chỉ dùng cho server cũ không nhận ED25519.') : t('Nên dùng: ngắn, nhanh, mọi server OpenSSH hiện nay đều nhận.')}
      >
        <SegmentedControl
          value={kind}
          onChange={changeKind}
          full
          options={[
            { id: 'ed25519', label: 'ED25519' },
            { id: 'rsa', label: 'RSA 4096' },
          ]}
        />
      </Field>

      <Field label={t('Tên tệp')} error={error.name} help={t('Lưu thành ~/.ssh/<tên> và ~/.ssh/<tên>.pub')}>
        <TextInput
          value={name}
          onChange={(v) => {
            setName(v)
            setNameTouched(true)
            setError({})
          }}
          invalid={!!error.name}
          autoFocus
        />
      </Field>

      <Field label={t('Ghi chú trong khoá')} help={t('Để trống thì dùng user@tên-máy, giống ssh-keygen.')}>
        <TextInput value={comment} onChange={setComment} placeholder={t('VD: adonis@macbook')} />
      </Field>

      <div className="grid grid-cols-2 gap-2.5">
        <Field label="Passphrase" help={t('Để trống nếu không cần.')}>
          <TextInput type="password" value={pass} onChange={(v) => { setPass(v); setError({}) }} />
        </Field>
        <Field label={t('Nhập lại passphrase')} error={error.pass ?? (pass2 && mismatch ? t('Chưa khớp') : undefined)}>
          <TextInput type="password" value={pass2} onChange={(v) => { setPass2(v); setError({}) }} invalid={!!pass2 && mismatch} />
        </Field>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[11px] text-muted">{t('Lệnh tương ứng')}</span>
        <span className="rounded-md bg-sunken px-2 py-1.5 font-mono text-[11.5px] leading-normal break-all text-ink2 select-text">{command}</span>
      </div>

      {error.form && <span className="text-[11px] text-danger">{error.form}</span>}
    </Modal>
  )
}
