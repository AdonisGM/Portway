import { useConnect } from '../../app/connect'
import { Modal } from '../../components/ui/modal'
import { Button } from '../../components/ui/primitives'
import { t } from '../../i18n'
import { api } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import { hintFor } from './hints'

/** The pairing dialog. It lives in the app frame, not in the Connect screen:
 *  a machine that is asked to pair has to show the code wherever the user is. */
export function PairingDialog() {
  const { pairing } = useConnect()
  // A machine that is being asked shows nothing until it has a code to compare.
  const open = !!pairing && (pairing.role === 'initiator' || pairing.stage !== 'connecting')
  const close = () => void api.connectPairClose()
  const name = pairing?.peerName || t('máy kia')

  if (!pairing || !open) return <Modal open={false} onClose={close} title="">{null}</Modal>

  if (pairing.stage === 'connecting') {
    return (
      <Modal open onClose={close} width={440} title={t('Đang hỏi ghép đôi')} footer={<Button size="lg" onClick={close}>{t('Huỷ')}</Button>}>
        <span className="text-ink2">{t('Đang kết nối tới máy kia…')}</span>
      </Modal>
    )
  }

  if (pairing.stage === 'done') {
    const ok = pairing.outcome === 'paired'
    const hint = ok ? null : hintFor(pairing.outcome ?? 'aborted', null)
    return (
      <Modal
        open
        onClose={close}
        width={460}
        title={ok ? t('Đã ghép đôi với {name}', { name }) : (hint?.title ?? '')}
        footer={<Button size="lg" variant="primary" onClick={close}>{t('Xong')}</Button>}
      >
        {ok ? (
          <span className="leading-relaxed text-ink2">{t('Hai máy đã tin nhau. Từ giờ có thể kết nối mà không cần so mã lại.')}</span>
        ) : (
          <HintSteps steps={hint?.steps ?? []} command={hint?.command} />
        )}
      </Modal>
    )
  }

  const answered = pairing.localOk !== null
  return (
    <Modal
      open
      onClose={close}
      width={460}
      title={t('Ghép đôi với {name}', { name })}
      subtitle={pairing.role === 'responder' ? t('{name} muốn ghép đôi với máy này', { name }) : t('Bạn đã yêu cầu ghép đôi')}
      footer={
        <>
          <Button size="lg" disabled={answered} onClick={() => void api.connectPairDecide(false)}>
            {t('Không khớp')}
          </Button>
          <Button size="lg" variant="primary" disabled={answered} onClick={() => void api.connectPairDecide(true)}>
            {t('Khớp')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col items-center gap-3 rounded-xl border border-line bg-sunken px-4 py-5">
        <span className="num text-[34px] font-semibold tracking-[0.12em]" aria-label={t('Mã ghép đôi')}>
          {pairing.code}
        </span>
        <button type="button" className="cursor-pointer text-[11.5px] text-muted hover:text-ink" onClick={() => void copyText(pairing.code.replace(' ', ''))}>
          {t('Sao chép mã')}
        </button>
      </div>
      <span className="leading-relaxed text-ink2">
        {t('Máy kia phải hiện đúng mã này. Chỉ bấm Khớp khi hai mã giống nhau và chính bạn vừa yêu cầu ghép đôi.')}
      </span>
      {answered && pairing.remoteOk === null && <span className="text-muted">{t('Đang chờ máy kia xác nhận…')}</span>}
      {!answered && pairing.remoteOk === true && <span className="text-success">{t('Máy kia đã bấm Khớp. Đến lượt bạn.')}</span>}
    </Modal>
  )
}

export function HintSteps({ steps, command }: { steps: string[]; command?: { text: string; where: string } }) {
  return (
    <div className="flex flex-col gap-2">
      <ol className="m-0 flex list-decimal flex-col gap-1.5 pl-5 leading-relaxed text-ink2">
        {steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      {command && (
        <div className="flex flex-col gap-1 rounded-lg border border-line bg-sunken px-3 py-2">
          <span className="text-[11px] text-muted">{command.where}</span>
          <div className="flex items-start gap-2">
            <code className="min-w-0 flex-1 font-mono text-[11.5px] [overflow-wrap:anywhere] select-text">{command.text}</code>
            <button type="button" className="cursor-pointer text-[11.5px] text-accent" onClick={() => void copyText(command.text)}>
              {t('Sao chép')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
