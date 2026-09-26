import { useState, type ReactNode } from 'react'
import { Modal } from '../../components/ui/modal'
import { Button } from '../../components/ui/primitives'
import { t } from '../../i18n'
import { isAppError } from '../../lib/api'
import { withSudo } from '../../lib/commands'

export type ActionAsk = {
  title: string
  body: ReactNode
  /** Extra warning under the command (who else is affected, what stays). */
  note?: ReactNode
  /** The command without sudo; shown with sudo when the session uses it. */
  command: string
  confirm: string
  danger?: boolean
  run: () => Promise<unknown>
}

/** "Lệnh chính xác sẽ chạy": asks before a command that changes the server,
 *  showing where it runs, as whom, with or without sudo, and the exact line. */
export function ActionConfirm({
  ask,
  serverName,
  user,
  sudo,
  onClose,
  onDone,
}: {
  ask: ActionAsk
  serverName: string
  user: string
  /** The session runs privileged commands through sudo. */
  sudo: boolean
  onClose: () => void
  onDone: () => void
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const viaSudo = sudo && user !== 'root'
  const full = withSudo(ask.command, viaSudo)

  const go = async () => {
    setPending(true)
    setError(null)
    try {
      await ask.run()
      onDone()
    } catch (e) {
      setError(isAppError(e) ? (e.detail ?? e.code) : String(e))
    } finally {
      setPending(false)
    }
  }

  return (
    <Modal
      open
      onClose={() => !pending && onClose()}
      width={500}
      title={ask.title}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            {t('Huỷ')}
          </Button>
          <Button variant={ask.danger ? 'danger' : 'primary'} onClick={() => void go()} disabled={pending}>
            {pending ? t('Đang gửi lệnh…') : ask.confirm}
          </Button>
        </>
      }
    >
      <span className="leading-relaxed text-ink2">{ask.body}</span>
      <div className="grid gap-x-3 gap-y-1.5 rounded-lg bg-raised px-3 py-2.5" style={{ gridTemplateColumns: 'auto 1fr' }}>
        <span className="text-[11px] text-muted">Server</span>
        <span className="font-mono text-[12px]">{serverName}</span>
        <span className="text-[11px] text-muted">{t('Chạy bằng user')}</span>
        <span className="font-mono text-[12px]">{user}</span>
        <span className="text-[11px] text-muted">Sudo</span>
        <span className={viaSudo ? 'text-warn' : 'text-ink2'}>{viaSudo ? t('Có, lệnh chạy với sudo') : t('Không cần')}</span>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[11px] text-muted">{t('Lệnh chính xác sẽ chạy')}</span>
        <span className="rounded-md bg-sunken px-2.5 py-2 font-mono text-[11.5px] leading-[1.55] break-all whitespace-pre-wrap select-text">{full}</span>
      </div>
      {ask.note && <div className="rounded-lg bg-warn-soft px-3 py-2 text-[11.5px] leading-normal text-ink2">{ask.note}</div>}
      {error && <span className="rounded-md bg-danger-soft px-2 py-1.5 font-mono text-[11.5px] break-all whitespace-pre-wrap text-danger select-text">{error}</span>}
    </Modal>
  )
}
