import { open } from '@tauri-apps/plugin-dialog'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { useConnect } from '../../app/connect'
import { useToast } from '../../components/toast'
import { Modal } from '../../components/ui/modal'
import { Button, Chip, TONES } from '../../components/ui/primitives'
import { t } from '../../i18n'
import { api, type ConnectTransfer } from '../../lib/api'
import { formatBytes } from '../server/format'
import { commandError, hintFor, transferError } from './hints'
import { HintSteps } from './pairing-dialog'

/** Pick files on this machine and offer them to a paired one. */
export async function pickAndSend(peerId: string, onError: (e: unknown) => void) {
  const picked = await open({ multiple: true, directory: false })
  if (!picked) return
  const paths = Array.isArray(picked) ? picked : [picked]
  if (!paths.length) return
  try {
    await api.connectSend(peerId, paths)
  } catch (e) {
    onError(e)
  }
}

const isOver = (x: ConnectTransfer) => ['done', 'failed', 'declined', 'canceled'].includes(x.stage)

const title = (x: ConnectTransfer) => (x.fileCount > 1 ? t('{name} và {n} tệp khác', { name: x.files[0]?.name ?? '', n: x.fileCount - 1 }) : (x.files[0]?.name ?? ''))

function status(x: ConnectTransfer): { tone: { fg: string; bg: string }; text: string } {
  switch (x.stage) {
    case 'offering':
      return { tone: TONES.warn, text: t('Chờ bạn trả lời') }
    case 'waiting':
      return { tone: TONES.info, text: t('Chờ máy kia nhận') }
    case 'active':
      return { tone: TONES.info, text: x.direction === 'send' ? t('Đang gửi') : t('Đang nhận') }
    case 'done':
      return { tone: TONES.success, text: x.direction === 'send' ? t('Đã gửi') : t('Đã nhận') }
    case 'declined':
      return { tone: TONES.warn, text: x.direction === 'send' ? t('Máy kia từ chối') : t('Đã từ chối') }
    case 'canceled':
      return { tone: TONES.neutral, text: t('Đã huỷ') }
    default:
      return { tone: TONES.danger, text: t('Lỗi') }
  }
}

/** "Truyền tệp": what is being sent or received, and what was. */
export function TransfersSection() {
  const { transfers } = useConnect()
  const toast = useToast()
  if (!transfers.length) return null
  const list = [...transfers].sort((a, b) => b.since - a.since)
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center gap-2 px-1 text-[12px] font-semibold text-ink2">
        {t('Truyền tệp')}
        <span className="num font-normal text-muted">{list.length}</span>
        {list.some(isOver) && (
          <button type="button" className="ml-auto cursor-pointer text-[11.5px] font-normal text-muted hover:text-ink" onClick={() => void api.connectTransfersClear()}>
            {t('Xoá những việc đã xong')}
          </button>
        )}
      </span>
      <div className="rounded-xl border border-line bg-surface">
        {list.map((x) => (
          <Row key={x.id} x={x} onError={(e) => toast({ title: t('Không làm được'), detail: commandError(e) })} />
        ))}
      </div>
    </div>
  )
}

function Row({ x, onError }: { x: ConnectTransfer; onError: (e: unknown) => void }) {
  const st = status(x)
  const Icon = x.direction === 'send' ? ArrowUp : ArrowDown
  const pct = x.total > 0 ? Math.min(100, (x.done / x.total) * 100) : x.stage === 'done' ? 100 : 0
  const live = x.stage === 'active'
  const hint = x.error?.startsWith('connect_') ? hintFor(x.error, null) : null
  return (
    <div className="flex flex-col gap-1.5 border-t border-line px-3.5 py-2.5 first:border-t-0">
      <div className="flex items-center gap-3">
        <Icon size={16} strokeWidth={1.75} className="flex-none text-ink2" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium">{title(x)}</span>
          <span className="text-[11.5px] text-muted">
            {x.direction === 'send' ? t('Gửi tới {name}', { name: x.peerName }) : t('Nhận từ {name}', { name: x.peerName })} · {formatBytes(x.total)}
          </span>
        </span>
        <Chip tone={st.tone}>{st.text}</Chip>
        {x.stage === 'offering' && (
          <>
            <Button size="sm" onClick={() => void api.connectTransferDecide(x.id, false).catch(onError)}>
              {t('Từ chối')}
            </Button>
            <Button size="sm" variant="primary" onClick={() => void api.connectTransferDecide(x.id, true).catch(onError)}>
              {t('Nhận')}
            </Button>
          </>
        )}
        {!isOver(x) && x.stage !== 'offering' && (
          <Button size="sm" onClick={() => void api.connectTransferCancel(x.id)}>
            {t('Huỷ')}
          </Button>
        )}
        {x.stage === 'done' && x.direction === 'receive' && x.savedTo && (
          <Button size="sm" onClick={() => void revealItemInDir(x.savedTo!).catch(onError)}>
            {t('Hiện trong thư mục')}
          </Button>
        )}
      </div>
      {(live || (x.stage === 'done' && x.total > 0)) && (
        <div className="flex items-center gap-3 pl-7">
          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-sunken">
            <div className={`h-full rounded-full ${x.stage === 'done' ? 'bg-success' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
          </div>
          <span className="num flex-none text-[11.5px] text-muted">
            {live ? `${formatBytes(x.done)} / ${formatBytes(x.total)}${x.rate > 0 ? ` · ${formatBytes(x.rate)}/s` : ''}` : formatBytes(x.total)}
          </span>
        </div>
      )}
      {x.stage === 'active' && x.fileCount > 1 && <span className="pl-7 text-[11.5px] text-muted">{t('Tệp {i} trên {n}', { i: x.current + 1, n: x.fileCount })}</span>}
      {x.stage === 'failed' && x.error && (
        <div className="flex flex-col gap-1 pl-7">
          <span className="text-danger">{transferError(x.error)}</span>
          {hint && <HintSteps steps={hint.steps} command={hint.command} />}
        </div>
      )}
    </div>
  )
}

/** The question that has to show up wherever the user is: someone wants to send files. */
export function IncomingTransferDialog() {
  const { transfers } = useConnect()
  const toast = useToast()
  const offer = transfers.find((x) => x.direction === 'receive' && x.stage === 'offering')
  const answer = (accept: boolean) => {
    if (offer) void api.connectTransferDecide(offer.id, accept).catch((e) => toast({ title: t('Không làm được'), detail: commandError(e) }))
  }
  return (
    <Modal
      open={!!offer}
      onClose={() => answer(false)}
      width={460}
      title={t('{name} muốn gửi tệp cho bạn', { name: offer?.peerName ?? '' })}
      subtitle={offer ? t('{n} tệp · {size}', { n: offer.fileCount, size: formatBytes(offer.total) }) : undefined}
      footer={
        <>
          <Button size="lg" onClick={() => answer(false)}>
            {t('Từ chối')}
          </Button>
          <Button size="lg" variant="primary" onClick={() => answer(true)}>
            {t('Nhận')}
          </Button>
        </>
      }
    >
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {offer?.files.slice(0, 8).map((f) => (
          <li key={f.name} className="flex items-baseline gap-3">
            <span className="min-w-0 flex-1 truncate">{f.name}</span>
            <span className="num flex-none text-muted">{formatBytes(f.size)}</span>
          </li>
        ))}
        {offer && offer.fileCount > 8 && <li className="text-muted">{t('và {n} tệp khác', { n: offer.fileCount - 8 })}</li>}
      </ul>
      <span className="leading-relaxed text-muted">{t('Tệp được lưu vào thư mục tải xuống. Chỉ nhận khi bạn đang chờ tệp từ máy này.')}</span>
    </Modal>
  )
}
