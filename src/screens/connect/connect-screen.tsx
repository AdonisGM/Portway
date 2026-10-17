import { ChevronRight, MonitorSmartphone } from 'lucide-react'
import { useState } from 'react'
import { useConnect } from '../../app/connect'
import { useNav } from '../../app/nav'
import { useToast } from '../../components/toast'
import { TextInput } from '../../components/ui/form-controls'
import { ConfirmModal } from '../../components/ui/modal'
import { Button, Chip, TONES } from '../../components/ui/primitives'
import { RowMenu } from '../../components/ui/row-menu'
import { t } from '../../i18n'
import { api, type ConnectPeer } from '../../lib/api'
import { commandError, hintFor } from './hints'
import { HintSteps } from './pairing-dialog'
import { ms, OsIcon, osLabel, Switch } from './shared'
import { TransfersSection } from './transfers'

/** Same grid on every row, so the columns line up whatever a row holds. */
const ROW_COLS = '28px minmax(0,1fr) auto auto'

/** "Màn hình Connect": turn it on, see the machines around, pair, link. */
export function ConnectScreen() {
  const view = useConnect()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState<string | null>(null)
  const [address, setAddress] = useState('')
  const [unpairing, setUnpairing] = useState<ConnectPeer | null>(null)

  const fail = (title: string) => (e: unknown) => toast({ title, detail: commandError(e) })
  const toggle = (on: boolean) => {
    setBusy(true)
    api
      .connectSetEnabled(on)
      .catch(fail(on ? t('Không bật được Connect') : t('Không tắt được Connect')))
      .finally(() => setBusy(false))
  }
  const pair = (id: string | null, addr: string | null) => api.connectPair(id, addr).catch(fail(t('Không ghép đôi được')))

  const device = view.device
  const mdnsWorks = view.selfSeen
  const error = view.error ? hintFor(view.error, null) : null

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-[23px] font-semibold">Connect</span>
        <span className="text-muted">{t('Nhận ra các máy chạy Portway trong cùng mạng và ghép đôi một lần, không cần bật SSH ở máy kia.')}</span>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
        <div className="flex items-center gap-3">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[13.5px] font-semibold">{t('Cho phép các Portway trong mạng thấy nhau')}</span>
            <span className="leading-normal text-muted">
              {t('Tắt mặc định. Khi bật, Portway mở một cổng nhận kết nối và thông báo một ID ngẫu nhiên lên mạng. Tên máy và các thông tin khác chỉ gửi cho máy đã ghép đôi.')}
            </span>
          </span>
          <Switch on={view.enabled} disabled={busy} onChange={toggle} label={t('Cho phép các Portway trong mạng thấy nhau')} />
        </div>

        {error && (
          <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-danger-soft px-3 py-2.5">
            <span className="font-semibold text-danger">{error.title}</span>
            <HintSteps steps={error.steps} command={error.command} />
          </div>
        )}

        {view.enabled && device && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line pt-3 text-[12px]">
            <span className="flex items-center gap-1.5 font-medium">
              <OsIcon os={device.os} />
              {device.name}
            </span>
            <span className="text-muted">
              ID <span className="num text-ink2 select-text">{device.id}</span>
            </span>
            {device.port && (
              <span className="text-muted">
                {t('Cổng')} <span className="num text-ink2">{device.port}</span>
              </span>
            )}
            <span className="text-muted">
              {t('Khoá')} <span className="num text-ink2 select-text">{device.fingerprint}</span>
            </span>
            <Chip tone={mdnsWorks ? TONES.success : TONES.warn} className="ml-auto">
              {mdnsWorks ? t('Đang tìm máy trong mạng') : t('Chưa thấy chính mình trong mạng')}
            </Chip>
          </div>
        )}
        {view.enabled && !mdnsWorks && !error && (
          <span className="text-[11.5px] leading-normal text-muted">
            {t('Nếu vài giây sau vẫn chưa thấy, mạng có thể chặn multicast hoặc máy này chưa được cấp quyền mạng nội bộ. Vẫn ghép đôi được bằng địa chỉ IP.')}
          </span>
        )}
      </div>

      {view.enabled && (
        <>
          <Section title={t('Máy đã ghép đôi')} count={view.peers.length}>
            {!view.peers.length && <Empty>{t('Chưa ghép đôi với máy nào. Mở Portway ở máy kia, bật Connect, rồi chọn máy đó ở danh sách bên dưới.')}</Empty>}
            {view.peers.map((p) => (
              <PeerRow
                key={p.id}
                peer={p}
                menuOpen={menu === p.id}
                setMenuOpen={(v) => setMenu(v ? p.id : null)}
                onUnpair={() => setUnpairing(p)}
                onError={fail}
              />
            ))}
          </Section>

          <TransfersSection />

          <Section title={t('Máy chưa ghép đôi')} count={view.nearby.length}>
            {!view.nearby.length && <Empty>{t('Chưa thấy máy nào khác. Cần bật Connect ở máy kia, và hai máy cùng một mạng.')}</Empty>}
            {view.nearby.map((n) => (
              <div key={n.id} className="grid items-center gap-3 border-t border-line px-3.5 py-2.5 first:border-t-0" style={{ gridTemplateColumns: ROW_COLS }}>
                <MonitorSmartphone size={18} strokeWidth={1.75} className="text-muted" />
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">
                    Portway <span className="num text-muted">{n.id}</span>
                  </span>
                  <span className="num truncate text-[11.5px] text-muted">{n.addrs.join(' · ') || '…'}</span>
                </span>
                {n.versionMismatch ? <Chip tone={TONES.warn}>{t('Khác phiên bản Portway')}</Chip> : <span />}
                <Button size="sm" variant="primary" disabled={n.versionMismatch || (!!view.pairing && view.pairing.outcome === null)} title={n.versionMismatch ? t('Cập nhật Portway ở cả hai máy') : undefined} onClick={() => void pair(n.id, null)}>
                  {t('Ghép đôi')}
                </Button>
              </div>
            ))}
            <div className="flex items-center gap-2 border-t border-line px-3.5 py-2.5">
              <span className="text-muted">{t('Hoặc theo địa chỉ IP')}</span>
              <TextInput value={address} onChange={setAddress} placeholder="10.10.10.2" numeric className="max-w-[200px]" />
              <Button
                size="sm"
                disabled={!address.trim()}
                onClick={() => {
                  void pair(null, address.trim())
                  setAddress('')
                }}
              >
                {t('Ghép đôi')}
              </Button>
            </div>
          </Section>
        </>
      )}

      <ConfirmModal
        open={!!unpairing}
        onClose={() => setUnpairing(null)}
        title={t('Bỏ ghép đôi với {name}?', { name: unpairing?.name ?? '' })}
        confirm={t('Bỏ ghép đôi')}
        danger
        onConfirm={() => {
          const p = unpairing
          setUnpairing(null)
          if (p) void api.connectUnpair(p.id).catch(fail(t('Không bỏ ghép đôi được')))
        }}
      >
        {t('Máy đó mất quyền kết nối tới máy này ngay. Muốn dùng lại phải ghép đôi và so mã lại. Máy kia vẫn còn nhớ máy này cho đến khi bạn bỏ ghép đôi ở đó.')}
      </ConfirmModal>
    </div>
  )
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center gap-2 px-1 text-[12px] font-semibold text-ink2">
        {title}
        <span className="num font-normal text-muted">{count}</span>
      </span>
      <div className="rounded-xl border border-line bg-surface">{children}</div>
    </div>
  )
}

const Empty = ({ children }: { children: React.ReactNode }) => <div className="px-4 py-5 text-center leading-relaxed text-muted">{children}</div>

function PeerRow({ peer, menuOpen, setMenuOpen, onUnpair, onError }: { peer: ConnectPeer; menuOpen: boolean; setMenuOpen: (v: boolean) => void; onUnpair: () => void; onError: (title: string) => (e: unknown) => void }) {
  const { link, linkError, pairing, wake } = useConnect()
  const nav = useNav()
  const waking = wake?.peerId === peer.id ? wake : null
  const mine = link?.peerId === peer.id ? link : null
  const otherBusy = !!link && !mine
  const open = () => nav.go({ kind: 'connectPeer', peerId: peer.id })

  const status = peer.versionMismatch
    ? { tone: TONES.warn, text: t('Khác phiên bản Portway') }
    : linkError?.peerId === peer.id
      ? { tone: TONES.danger, text: t('Không kết nối được') }
      : waking?.stage === 'waiting'
        ? { tone: TONES.info, text: t('Đang đợi máy lên…') }
        : waking?.stage === 'up'
          ? { tone: TONES.success, text: t('Máy đã lên') }
          : waking?.stage === 'timeout'
            ? { tone: TONES.warn, text: t('Máy chưa lên') }
            : mine
              ? mine.stage === 'up'
                ? { tone: TONES.success, text: mine.rttMs !== null ? t('Đang kết nối · {ms}', { ms: ms(mine.rttMs) }) : t('Đang kết nối') }
                : { tone: TONES.info, text: t('Đang kết nối…') }
              : peer.loginScreen
                ? { tone: TONES.info, text: t('Đã bật · chờ đăng nhập') }
                : peer.online
                ? { tone: TONES.neutral, text: t('Thấy trong mạng') }
                : { tone: TONES.neutral, text: t('Không thấy') }

  return (
    <div
      className="grid cursor-pointer items-center gap-3 border-t border-line px-3.5 py-2.5 first:border-t-0 hover:bg-sunken/60"
      style={{ gridTemplateColumns: ROW_COLS }}
      onClick={open}
    >
      <OsIcon os={peer.os} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{peer.name}</span>
        <span className="text-[11.5px] text-muted">{osLabel(peer.os)}</span>
      </span>
      <Chip tone={status.tone}>{status.text}</Chip>
      <span className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        {mine ? (
          <Button size="sm" onClick={() => void api.connectUnlink()}>
            {mine.stage === 'up' ? t('Ngắt') : t('Huỷ')}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            disabled={otherBusy || !!pairing || peer.versionMismatch || peer.loginScreen}
            onClick={() => {
              open()
              void api.connectLink(peer.id).catch(onError(t('Không kết nối được')))
            }}
          >
            {t('Kết nối')}
          </Button>
        )}
        <RowMenu
          open={menuOpen}
          setOpen={setMenuOpen}
          items={[
            { label: t('Xem chi tiết'), run: open },
            { label: t('Bỏ ghép đôi'), run: onUnpair, danger: true },
          ]}
        />
        <ChevronRight size={16} strokeWidth={1.75} className="text-muted" />
      </span>
    </div>
  )
}
