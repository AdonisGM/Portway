import { Laptop, Monitor, Server } from 'lucide-react'
import { useState } from 'react'
import { useToast } from '../../components/toast'
import { TextInput } from '../../components/ui/form-controls'
import { Modal } from '../../components/ui/modal'
import { Button, Chip, TONES } from '../../components/ui/primitives'
import { t } from '../../i18n'
import { api, type ConnectFail, type ConnectPath, type ConnectPeer } from '../../lib/api'
import { commandError, hintFor } from './hints'
import { HintSteps } from './pairing-dialog'

export const osLabel = (os: string) => (os === 'macos' ? 'macOS' : os === 'windows' ? 'Windows' : os === 'linux' ? 'Linux' : os)

export function OsIcon({ os }: { os: string }) {
  const Icon = os === 'macos' ? Laptop : os === 'windows' ? Monitor : Server
  return <Icon size={18} strokeWidth={1.75} className="text-ink2" />
}

export const failText = (f: ConnectFail | null) =>
  f === 'timeout' ? t('không trả lời') : f === 'noRoute' ? t('không có đường tới') : f === 'refused' ? t('bị từ chối') : t('lỗi')

export const ms = (n: number) => `${n.toFixed(1)} ms`
export const ipOf = (addr: string) => addr.split(':')[0]

export function Switch({ on, disabled, onChange, label }: { on: boolean; disabled?: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-[22px] w-[38px] flex-none cursor-pointer rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${on ? 'border-accent bg-accent' : 'border-line2 bg-sunken'}`}
    >
      <span className={`absolute top-[2px] size-4 rounded-full bg-white shadow transition-all ${on ? 'left-[18px]' : 'left-[2px]'}`} />
    </button>
  )
}

export function WakeTimeout() {
  const hint = hintFor('wake_timeout', null)
  return (
    <div className="mx-3.5 mb-3 flex flex-col gap-1.5 rounded-lg border border-line bg-warn-soft px-3 py-2.5">
      <span className="flex items-center gap-2">
        <span className="mr-auto font-semibold text-warn">{hint.title}</span>
        <button type="button" className="cursor-pointer text-[11.5px] text-muted hover:text-ink" onClick={() => void api.connectDismissWake()}>
          {t('Đóng')}
        </button>
      </span>
      <HintSteps steps={hint.steps} />
    </div>
  )
}

export function PathLine({ path, inUse, peerId }: { path: ConnectPath; inUse: boolean; peerId: string }) {
  const where = [path.card, path.network].filter(Boolean).join(' · ')
  return (
    <span className="flex flex-wrap items-center gap-x-2 text-[11.5px] text-muted">
      <span className="num text-ink2">{ipOf(path.addr)}</span>
      {where && <span>{where}</span>}
      <span className={path.rttMs === null ? 'text-danger' : 'num'}>{path.rttMs !== null ? ms(path.rttMs) : failText(path.fail)}</span>
      {inUse && <Chip tone={TONES.success}>{t('đang dùng')}</Chip>}
      {path.manual && (
        <>
          <span>{t('nhập tay')}</span>
          <button type="button" className="cursor-pointer text-muted underline hover:text-ink" onClick={() => void api.connectRemoveAddress(peerId, path.addr)}>
            {t('Xoá')}
          </button>
        </>
      )}
    </span>
  )
}

export function AddAddressDialog({ peer, onClose }: { peer: ConnectPeer | null; onClose: () => void }) {
  const toast = useToast()
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const submit = async () => {
    if (!peer) return
    try {
      await api.connectAddAddress(peer.id, text.trim())
      setText('')
      setError('')
      onClose()
    } catch (e) {
      setError(commandError(e))
      toast({ title: t('Không thêm được địa chỉ'), detail: commandError(e) })
    }
  }
  return (
    <Modal
      open={!!peer}
      onClose={onClose}
      width={440}
      title={t('Thêm địa chỉ IP của {name}', { name: peer?.name ?? '' })}
      subtitle={t('Dùng khi mDNS không tìm thấy máy đó. Có thể thêm cổng: 10.10.10.2:47615')}
      footer={
        <>
          <Button size="lg" onClick={onClose}>
            {t('Huỷ')}
          </Button>
          <Button size="lg" variant="primary" disabled={!text.trim()} onClick={() => void submit()}>
            {t('Thêm')}
          </Button>
        </>
      }
    >
      <TextInput value={text} onChange={setText} placeholder="10.10.10.2" numeric autoFocus invalid={!!error} />
      {error && <span className="text-[11.5px] text-danger">{error}</span>}
    </Modal>
  )
}
