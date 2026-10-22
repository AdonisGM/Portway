import { ArrowLeft, ArrowRight, Check, Cpu, Download, Files, FolderUp, Info, Gauge, MemoryStick, Microchip, Network as NetworkIcon, Power, Send, TriangleAlert, X, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { useConnect, useConnectHistory, type Sample } from '../../app/connect'
import { useNav } from '../../app/nav'
import { useToast } from '../../components/toast'
import { ConfirmModal } from '../../components/ui/modal'
import { Button, Chip, TONES } from '../../components/ui/primitives'
import { RowMenu } from '../../components/ui/row-menu'
import { t } from '../../i18n'
import { api, type ConnectMachine, type ConnectPeer, type ConnectSpeed } from '../../lib/api'
import { formatBytes, formatUptime } from '../server/format'
import { commandError, hintFor, speedError } from './hints'
import { HintSteps } from './pairing-dialog'
import { AddAddressDialog, ipOf, OsIcon, PathLine, Switch, WakeTimeout, ms, osLabel } from './shared'
import { LiveChart, niceMax } from './charts'
import { pickAndSend, TransfersSection } from './transfers'

const FEATURE_SPEED = 'speed'

const mbit = (bps: number) => `${(bps / 1e6).toLocaleString(undefined, { maximumFractionDigits: bps < 1e7 ? 1 : 0 })} Mbit/s`
/** "94 MB/s · 750 Mbit/s" */
const speedText = (bps: number) => `${formatBytes(bps / 8)}/s · ${mbit(bps)}`
const cardSpeed = (mbps: number | null) => (mbps ? (mbps >= 1000 ? `${mbps / 1000} Gbit/s` : `${mbps} Mbit/s`) : null)

/** One machine's page: what it is, how well it is reachable, and what can be done with it. */
export function ConnectPeerScreen({ peerId }: { peerId: string }) {
  const view = useConnect()
  const nav = useNav()
  const toast = useToast()
  const [menu, setMenu] = useState(false)
  const [adding, setAdding] = useState<ConnectPeer | null>(null)
  const [unpairing, setUnpairing] = useState(false)
  const peer = view.peers.find((p) => p.id === peerId) ?? null
  const back = () => nav.go({ kind: 'connect' })
  const fail = (title: string) => (e: unknown) => toast({ title, detail: commandError(e) })

  if (!peer) {
    return (
      <div className="flex flex-col gap-3">
        <BackButton onClick={back} />
        <div className="rounded-xl border border-line bg-surface px-4 py-6 text-center text-muted">{t('Máy này không còn trong danh sách đã ghép đôi.')}</div>
      </div>
    )
  }

  const { link, linkError, pairing, wake } = view
  const mine = link?.peerId === peer.id ? link : null
  const up = mine?.stage === 'up'
  const otherBusy = !!link && !mine
  const waking = wake?.peerId === peer.id ? wake : null
  const error = linkError?.peerId === peer.id ? hintFor(linkError.code, peer.os) : null

  const status = peer.versionMismatch
    ? { tone: TONES.warn, text: t('Khác phiên bản Portway') }
    : waking?.stage === 'waiting'
      ? { tone: TONES.info, text: t('Đang đợi máy lên…') }
      : mine
        ? up
          ? { tone: TONES.success, text: mine.rttMs !== null ? t('Đang kết nối · {ms}', { ms: ms(mine.rttMs) }) : t('Đang kết nối') }
          : { tone: TONES.info, text: t('Đang kết nối…') }
        : peer.loginScreen
          ? { tone: TONES.info, text: t('Đã bật · chờ đăng nhập') }
          : peer.online
          ? { tone: TONES.neutral, text: t('Thấy trong mạng, chưa kết nối') }
          : { tone: TONES.neutral, text: t('Không thấy') }

  return (
    <div className="flex flex-col gap-3">
      <BackButton onClick={back} />

      <div className="flex flex-wrap items-center gap-3">
        <span className="flex size-10 flex-none items-center justify-center rounded-xl border border-line bg-surface">
          <OsIcon os={peer.os} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[21px] leading-tight font-semibold">{peer.name}</span>
          <span className="text-muted">{peer.info?.osVersion || osLabel(peer.os)}</span>
        </span>
        <Chip tone={status.tone}>{status.text}</Chip>
        <span className="flex items-center gap-1.5">
          {peer.canWake && !peer.online && !mine && (
            <Button size="md" disabled={waking?.stage === 'waiting'} onClick={() => void api.connectWake(peer.id).catch(fail(t('Không đánh thức được')))}>
              <Power size={14} strokeWidth={1.75} className="mr-1.5" />
              {t('Đánh thức')}
            </Button>
          )}
          {mine ? (
            <Button size="md" onClick={() => void api.connectUnlink()}>
              {up ? t('Ngắt kết nối') : t('Huỷ')}
            </Button>
          ) : (
            <Button size="md" variant="primary" disabled={otherBusy || !!pairing || peer.versionMismatch || peer.loginScreen} title={otherBusy ? t('Đang kết nối với một máy khác') : undefined} onClick={() => void api.connectLink(peer.id).catch(fail(t('Không kết nối được')))}>
              {error ? t('Kết nối lại') : t('Kết nối')}
            </Button>
          )}
          <RowMenu
            open={menu}
            setOpen={setMenu}
            items={[
              { label: t('Thêm địa chỉ IP…'), run: () => setAdding(peer) },
              { label: t('Bỏ ghép đôi'), run: () => setUnpairing(true), danger: true },
            ]}
          />
        </span>
      </div>

      {error && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-danger-soft px-3 py-2.5">
          <span className="flex items-center gap-2">
            <span className="mr-auto font-semibold text-danger">{error.title}</span>
            <button type="button" className="cursor-pointer text-[11.5px] text-muted hover:text-ink" onClick={() => void api.connectDismissLinkError()}>
              {t('Đóng')}
            </button>
          </span>
          <HintSteps steps={error.steps} command={error.command} />
        </div>
      )}
      {waking?.stage === 'timeout' && <WakeTimeout />}
      {peer.loginScreen && (
        <div className="flex items-center gap-2 rounded-lg border border-line bg-info-soft px-3 py-2.5 text-info">
          <Info size={15} strokeWidth={1.75} className="flex-none" />
          <span className="leading-normal">{t('Máy này đã bật nhưng đang ở màn hình đăng nhập Windows. Đăng nhập ở máy đó rồi bấm Kết nối.')}</span>
        </div>
      )}

      <div className="grid items-start gap-3 min-[1000px]:grid-cols-2">
        <Specs peer={peer} mine={view.machine} linked={up} />
        <Network peer={peer} />
      </div>

      <Performance peer={peer} linked={up} />

      <div className="grid items-start gap-3 min-[1000px]:grid-cols-2">
        <ClipboardPanel peer={peer} linked={up} onError={fail} />
        <Features peer={peer} onError={fail} />
      </div>

      <TransfersSection peerId={peer.id} />

      <AddAddressDialog peer={adding} onClose={() => setAdding(null)} />
      <ConfirmModal
        open={unpairing}
        onClose={() => setUnpairing(false)}
        title={t('Bỏ ghép đôi với {name}?', { name: peer.name })}
        confirm={t('Bỏ ghép đôi')}
        danger
        onConfirm={() => {
          setUnpairing(false)
          void api.connectUnpair(peer.id).then(back, fail(t('Không bỏ ghép đôi được')))
        }}
      >
        {t('Máy đó mất quyền kết nối tới máy này ngay. Muốn dùng lại phải ghép đôi và so mã lại. Máy kia vẫn còn nhớ máy này cho đến khi bạn bỏ ghép đôi ở đó.')}
      </ConfirmModal>
    </div>
  )
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex w-fit cursor-pointer items-center gap-1.5 text-[12px] text-muted hover:text-ink">
      <ArrowLeft size={14} strokeWidth={1.75} />
      {t('Connect')}
    </button>
  )
}

function Panel({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="flex items-baseline gap-2 px-1 text-[12px] font-semibold text-ink2">
        {title}
        {note && <span className="font-normal text-muted">{note}</span>}
      </span>
      <div className="rounded-xl border border-line bg-surface">{children}</div>
    </div>
  )
}

// -- specs --------------------------------------------------------------------

const cpuText = (m: ConnectMachine) => {
  const cores = m.cores > 0 ? t('{n} nhân', { n: m.cores }) : null
  const threads = m.threads > 0 ? t('{n} luồng', { n: m.threads }) : null
  return [m.cpu, [cores, threads].filter(Boolean).join(' · ')].filter(Boolean).join(' · ') || '—'
}
const diskText = (m: ConnectMachine) => (m.diskTotal > 0 ? t('{free} trống / {total}', { free: formatBytes(m.diskFree), total: formatBytes(m.diskTotal) }) : '—')
const cardsText = (m: ConnectMachine) =>
  m.cards.length ? m.cards.map((c) => [c.name, cardSpeed(c.mbps)].filter(Boolean).join(' ')).join(', ') : '—'
const gpuText = (m: ConnectMachine) =>
  m.gpus.length
    ? m.gpus.map((g) => [g.name, g.vram > 0 ? formatBytes(g.vram) : null, g.cores ? t('{n} nhân GPU', { n: g.cores }) : null].filter(Boolean).join(' · ')).join(', ')
    : '—'

type SpecRowDef = { label: () => string; value: (m: ConnectMachine) => string }

const SPEC_ROWS: SpecRowDef[] = [
  { label: () => t('Hệ điều hành'), value: (m) => [m.osVersion, m.arch].filter(Boolean).join(' · ') || '—' },
  { label: () => t('Mẫu máy'), value: (m) => m.model || '—' },
  { label: () => t('CPU'), value: cpuText },
  { label: () => t('RAM'), value: (m) => (m.ram > 0 ? formatBytes(m.ram) : '—') },
  { label: () => t('GPU'), value: gpuText },
  { label: () => t('Ổ đĩa'), value: diskText },
  { label: () => t('Card mạng'), value: cardsText },
  { label: () => t('Đã bật được'), value: (m) => (m.uptime > 0 ? formatUptime(m.uptime) : '—') },
  { label: () => t('Portway'), value: (m) => m.appVersion || '—' },
]

function Specs({ peer, mine, linked }: { peer: ConnectPeer; mine: ConnectMachine | null; linked: boolean }) {
  const theirs = peer.info
  const note = !theirs
    ? linked
      ? t('Portway ở máy kia chưa gửi thông tin máy. Cập nhật Portway ở máy đó.')
      : t('Chưa có thông tin: kết nối một lần để máy kia gửi sang')
    : linked
      ? undefined
      : t('Lần cuối lúc {time}', { time: new Date(peer.infoAt).toLocaleString() })
  return (
    <Panel title={t('Thông số máy')} note={note}>
      <div className="grid grid-cols-[110px_minmax(0,1fr)_minmax(0,1fr)] text-[12px]">
        <span />
        <span className="border-b border-line px-3 py-2 font-semibold text-ink2">{t('Máy này')}</span>
        <span className="truncate border-b border-line px-3 py-2 font-semibold text-ink2">{peer.name}</span>
        {SPEC_ROWS.map((row) => (
          <SpecRow key={row.label()} label={row.label()} mine={mine ? row.value(mine) : '—'} theirs={theirs ? row.value(theirs) : '—'} />
        ))}
      </div>
    </Panel>
  )
}

function SpecRow({ label, mine, theirs }: { label: string; mine: string; theirs: string }) {
  return (
    <>
      <span className="border-t border-line px-3 py-2 text-muted">{label}</span>
      <span className="border-t border-line px-3 py-2 break-words select-text">{mine}</span>
      <span className="border-t border-line px-3 py-2 break-words select-text">{theirs}</span>
    </>
  )
}

// -- network ------------------------------------------------------------------

/** Round-trip times of the live link, newest on the right. */
function RttGraph({ values }: { values: number[] }) {
  const W = 300
  const H = 44
  if (values.length < 2) return <div className="flex h-11 items-center text-[11.5px] text-muted">{t('Biểu đồ hiện khi đang kết nối')}</div>
  const max = Math.max(...values, 0.1) * 1.15
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * W).toFixed(1)},${(H - (v / max) * (H - 2) - 1).toFixed(1)}`)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-11 w-full overflow-visible" aria-hidden>
      <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} stroke="var(--line)" />
      <polyline points={pts.join(' ')} fill="none" stroke="var(--info)" strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-[10.5px] font-medium text-muted">{label}</span>
      <span className="num text-[16px] font-medium whitespace-nowrap">{value}</span>
    </span>
  )
}

function Network({ peer }: { peer: ConnectPeer }) {
  const { link, machine } = useConnect()
  const mine = link?.peerId === peer.id && link.stage === 'up' ? link : null
  const history = mine?.rttHistory ?? []
  const avg = history.length ? history.reduce((a, b) => a + b, 0) / history.length : null
  const jitter = history.length > 1 ? history.slice(1).reduce((a, v, i) => a + Math.abs(v - history[i]), 0) / (history.length - 1) : null
  const used = mine ? peer.paths.find((p) => ipOf(p.addr) === ipOf(mine.addr)) : (peer.paths.find((p) => p.rttMs !== null) ?? null)
  const cardMbps = used?.card ? (machine?.cards.find((c) => c.name === used.card)?.mbps ?? null) : null
  const through = used ? [used.card, used.network].filter(Boolean).join(' · ') : ''

  return (
    <Panel title={t('Mạng')} note={through ? t('qua {path}', { path: through }) : undefined}>
      <div className="flex flex-col gap-3 px-3.5 py-3">
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Stat label={t('Độ trễ hiện tại')} value={mine?.rttMs != null ? ms(mine.rttMs) : used?.rttMs != null ? ms(used.rttMs) : '—'} />
          <Stat label={t('Trung bình')} value={avg !== null ? ms(avg) : '—'} />
          <Stat label={t('Dao động')} value={jitter !== null ? ms(jitter) : '—'} />
          <Stat label={t('Tốc độ card')} value={cardSpeed(cardMbps) ?? '—'} />
        </div>
        <RttGraph values={history} />
        <SpeedTest peer={peer} linked={!!mine} />
      </div>
      {!!peer.paths.length && (
        <div className="flex flex-col gap-1 border-t border-line px-3.5 py-2.5">
          <span className="text-[10.5px] font-medium text-muted">{t('Các đường tới máy này')}</span>
          {peer.paths.map((path) => (
            <PathLine key={path.addr} path={path} inUse={!!mine && ipOf(mine.addr) === ipOf(path.addr)} peerId={peer.id} />
          ))}
        </div>
      )}
    </Panel>
  )
}

function SpeedTest({ peer, linked }: { peer: ConnectPeer; linked: boolean }) {
  const toast = useToast()
  const speed: ConnectSpeed | null = peer.speed
  const running = speed?.stage === 'up' || speed?.stage === 'down'
  const supported = !!peer.info?.features.includes(FEATURE_SPEED)
  const why = peer.versionMismatch
    ? t('Hai máy chạy khác phiên bản Portway.')
    : !peer.online
      ? t('Cần thấy máy này trong mạng.')
      : !peer.info
        ? linked
          ? t('Portway ở máy kia chưa hỗ trợ đo tốc độ. Cập nhật Portway ở máy đó.')
          : t('Kết nối một lần để biết máy kia có hỗ trợ không.')
        : !supported
          ? t('Portway ở máy kia chưa hỗ trợ đo tốc độ. Cập nhật Portway ở máy đó.')
          : null

  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" disabled={!!why || running} onClick={() => void api.connectSpeedTest(peer.id).catch((e) => toast({ title: t('Không đo được tốc độ'), detail: commandError(e) }))}>
          <Gauge size={13} strokeWidth={1.75} className="mr-1.5" />
          {running ? t('Đang đo…') : t('Đo tốc độ')}
        </Button>
        <span className="min-w-0 flex-1 text-[11.5px] leading-normal text-muted">
          {why ?? t('Gửi dữ liệu thử khoảng 1,5 giây mỗi chiều, đã mã hoá như khi truyền tệp.')}
        </span>
      </div>
      {speed && speed.stage !== 'failed' && (
        <div className="flex flex-wrap gap-x-6 gap-y-1.5">
          <Stat label={t('Gửi đi')} value={speed.upBps !== null ? speedText(speed.upBps) : speed.stage === 'up' ? t('Đang đo…') : '—'} />
          <Stat label={t('Nhận về')} value={speed.downBps !== null ? speedText(speed.downBps) : speed.stage === 'down' ? t('Đang đo…') : '—'} />
          {speed.stage === 'done' && (
            <span className="flex flex-col justify-end text-[11.5px] text-muted">
              {t('Đo lúc {time}', { time: new Date(speed.at).toLocaleTimeString() })}
              {speed.addr && <span className="num">{speed.addr.split(':')[0]}</span>}
            </span>
          )}
        </div>
      )}
      {speed?.stage === 'failed' && <span className="text-[11.5px] text-danger">{t('Đo không được: {why}', { why: speedError(speed.error ?? '') })}</span>}
    </div>
  )
}

// -- performance --------------------------------------------------------------

type Cell = { value: string; chart: React.ReactNode } | null

const rate = (bytesPerSec: number) => `${formatBytes(bytesPerSec)}/s`

/** CPU, memory and network use of both machines over the last few minutes. The
 *  other machine's side is only there while linked; GPU load is not measured. */
function Performance({ peer, linked }: { peer: ConnectPeer; linked: boolean }) {
  const view = useConnect()
  // Nothing to draw yet: this machine's first reading takes a few seconds; the
  // other one is not linked, or is too old to send its load.
  const empty = [t('Đang đo…'), linked ? t('Máy kia chưa gửi số liệu. Cập nhật Portway ở máy đó.') : t('Chỉ có khi đang kết nối')]
  const hist = useConnectHistory()
  const sides = [
    { info: view.machine, live: view.live, h: hist.self },
    { info: peer.info, live: linked ? peer.live : null, h: linked ? (hist.peers[peer.id] ?? []) : [] },
  ]
  const pick = (h: (Sample | null)[], f: (s: Sample) => number | null) => h.map((x) => (x ? f(x) : null))

  const cpu = sides.map((x): Cell => (x.live ? { value: `${Math.round(x.live.cpu)}%`, chart: <LiveChart max={100} series={[{ values: pick(x.h, (v) => v.cpu), color: 'var(--info)', fill: true }]} /> } : null))
  const ram = sides.map((x): Cell => {
    if (!x.live) return null
    const total = x.info?.ram || Math.max(x.live.ramUsed, ...x.h.map((v) => v?.ram ?? 0))
    return { value: `${formatBytes(x.live.ramUsed)} / ${formatBytes(total)}`, chart: <LiveChart max={total} series={[{ values: pick(x.h, (v) => v.ram), color: 'var(--success)', fill: true }]} /> }
  })
  const net = sides.map((x): Cell => {
    if (!x.live) return null
    const max = niceMax(Math.max(0, ...x.h.map((v) => Math.max(v?.rx ?? 0, v?.tx ?? 0))))
    return {
      value: `↓ ${rate(x.live.netRx)}  ↑ ${rate(x.live.netTx)}`,
      chart: (
        <LiveChart
          max={max}
          series={[
            { values: pick(x.h, (v) => v.rx), color: 'var(--info)', fill: true },
            { values: pick(x.h, (v) => v.tx), color: 'var(--warn)' },
          ]}
        />
      ),
    }
  })

  // Only a machine that reports its graphics load gets a chart; the name is shown either way.
  const gpu = sides.map((x): Cell => (x.live?.gpu != null ? { value: `${Math.round(x.live.gpu)}%`, chart: <LiveChart max={100} series={[{ values: pick(x.h, (v) => v.gpu), color: 'var(--warn)', fill: true }]} /> } : null))

  return (
    <Panel title={t('Hiệu năng')} note={linked ? undefined : t('Máy kia chỉ hiện khi đang kết nối')}>
      <div className="grid grid-cols-[84px_minmax(0,1fr)_minmax(0,1fr)] text-[12px]">
        <span />
        <span className="border-b border-line px-3 py-2 font-semibold text-ink2">{t('Máy này')}</span>
        <span className="truncate border-b border-line px-3 py-2 font-semibold text-ink2">{peer.name}</span>
        <MetricRow icon={Cpu} label={t('CPU')} cells={cpu} empty={empty} />
        <MetricRow icon={MemoryStick} label={t('RAM')} cells={ram} empty={empty} />
        <MetricRow icon={NetworkIcon} label={t('Mạng')} cells={net} empty={empty} />
        <MetricRow icon={Microchip} label={t('GPU')} cells={gpu} empty={empty} below={sides.map((x) => (x.info ? gpuText(x.info) : '—'))} />
      </div>
    </Panel>
  )
}

function MetricRow({ icon: Icon, label, cells, empty, below }: { icon: LucideIcon; label: string; cells: Cell[]; empty: string[]; below?: string[] }) {
  return (
    <>
      <span className="flex items-start gap-1.5 border-t border-line px-3 py-2.5 text-muted">
        <Icon size={14} strokeWidth={1.75} className="mt-0.5 flex-none" />
        {label}
      </span>
      {cells.map((c, i) => (
        <span key={i} className="flex min-w-0 flex-col gap-1.5 border-t border-line px-3 py-2.5">
          {c ? (
            <>
              <span className="num text-[13px] font-medium whitespace-nowrap">{c.value}</span>
              {c.chart}
            </>
          ) : below ? null : (
            <span className="flex h-full min-h-[66px] items-center leading-normal text-muted">{empty[i]}</span>
          )}
          {below && (
            <span className="flex flex-col gap-0.5">
              <span className="select-text">{below[i]}</span>
              {!c && <span className="text-[11px] text-muted">{t('Chưa đo được mức dùng GPU')}</span>}
            </span>
          )}
        </span>
      ))}
    </>
  )
}

// -- features -----------------------------------------------------------------

type FeatureProps = {
  icon: LucideIcon
  title: string
  desc: string
  /** Why it cannot be used right now; null when it can. */
  why: string | null
  children?: React.ReactNode
}

function Feature({ icon: Icon, title, desc, why, children }: FeatureProps) {
  return (
    <div className="grid items-center gap-3 border-t border-line px-3.5 py-3 first:border-t-0" style={{ gridTemplateColumns: '20px minmax(0,1fr) auto' }}>
      <Icon size={17} strokeWidth={1.75} className={why ? 'text-muted' : 'text-ink2'} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="font-medium">{title}</span>
          <Chip tone={why ? TONES.neutral : TONES.success}>{why ? t('Chưa dùng được') : t('Sẵn sàng')}</Chip>
        </span>
        <span className="leading-normal text-muted">{why ?? desc}</span>
      </span>
      <span className="flex flex-wrap items-center justify-end gap-2">{children}</span>
    </div>
  )
}

function Features({ peer, onError }: { peer: ConnectPeer; onError: (title: string) => (e: unknown) => void }) {
  const reach = peer.versionMismatch ? t('Hai máy chạy khác phiên bản Portway. Cập nhật Portway ở cả hai máy.') : !peer.online ? t('Cần thấy máy này trong mạng.') : null
  const wakeWhy = peer.online ? t('Máy này đang bật.') : !peer.canWake ? t('Chưa có địa chỉ MAC của máy này. Kết nối với nó một lần để Portway ghi lại.') : null

  return (
    <Panel title={t('Tính năng')}>
      <Feature icon={Send} title={t('Gửi tệp và thư mục')} desc={t('Máy kia được hỏi trước khi nhận. Tệp đi thẳng giữa hai máy, đã mã hoá.')} why={reach}>
        <Button size="sm" disabled={!!reach} onClick={() => void pickAndSend(peer.id, onError(t('Không gửi được tệp')))}>
          {t('Gửi tệp…')}
        </Button>
        <Button size="sm" disabled={!!reach} onClick={() => void pickAndSend(peer.id, onError(t('Không gửi được tệp')), true)}>
          <FolderUp size={13} strokeWidth={1.75} className="mr-1.5" />
          {t('Gửi thư mục…')}
        </Button>
      </Feature>
      <Feature icon={Power} title={t('Đánh thức máy này')} desc={t('Gửi gói Wake-on-LAN qua mọi card mạng, rồi đợi máy lên.')} why={wakeWhy}>
        <Button size="sm" disabled={!!wakeWhy} onClick={() => void api.connectWake(peer.id).catch(onError(t('Không đánh thức được')))}>
          {t('Đánh thức')}
        </Button>
      </Feature>
    </Panel>
  )
}

type FlowState = 'flow' | 'blocked' | 'off'

/** Clipboard text between the two machines. The picture is read-only and shows
 *  both sides (what the other machine does is not ours to change); the
 *  switches and the button are below it, apart, so the picture keeps its shape. */
function ClipboardPanel({ peer, linked, onError }: { peer: ConnectPeer; linked: boolean; onError: (title: string) => (e: unknown) => void }) {
  const { clip, device } = useConnect()
  const note = clip?.peerId === peer.id ? clip : null
  const remote = linked ? peer.remoteClip : null
  const setClip = (receive: boolean, send: boolean) => void api.connectSetClip(peer.id, receive, send).catch(onError(t('Không đổi được cài đặt')))
  const why = peer.versionMismatch ? t('Hai máy chạy khác phiên bản Portway.') : !linked ? t('Cần đang kết nối với máy này.') : null
  const when = (n: NonNullable<typeof note>) => [n.files > 0 ? t('{n} tệp hoặc thư mục', { n: n.files }) : t('{n} ký tự', { n: n.chars }), new Date(n.at).toLocaleTimeString()].join(' · ')

  // This machine to the other: needs our auto-send and, when it says, its Receive.
  const out: FlowState = !peer.clipSend ? 'off' : remote && !remote.receive ? 'blocked' : 'flow'
  // The other machine to this one: needs its auto-send and our Receive.
  const inn: FlowState = !remote?.send ? 'off' : !peer.clipReceive ? 'blocked' : 'flow'

  // What happened to the text last sent: the other machine says whether it took it.
  const sent = note?.direction === 'out' ? note : null
  const outLast = !sent ? null : sent.status === 'delivered' ? (
    <span className="num flex items-center gap-1 text-[11px] text-success">
      <Check size={12} strokeWidth={2.25} />
      {t('Máy kia đã nhận')} · {when(sent)}
    </span>
  ) : sent.status === 'sent' ? (
    <span className="num text-[11px] text-muted">
      {t('Đã gửi')} · {when(sent)}
    </span>
  ) : (
    <span className="flex items-center gap-1 text-[11px] text-warn">
      <TriangleAlert size={12} strokeWidth={2} />
      {sent.status === 'off' ? t('Máy kia chưa bật Nhận clipboard từ máy này') : sent.status === 'too_large' ? t('Văn bản quá dài cho máy kia') : t('Máy kia không ghi được vào clipboard')}
    </span>
  )
  const received = note?.direction === 'in' ? note : null
  // Files go over a connection of their own, which an older Portway would refuse.
  const filesWhy = why ?? (peer.info?.features.includes('clipfiles') ? null : t('Portway ở máy kia chưa hỗ trợ dán tệp. Cập nhật Portway ở máy đó.'))

  return (
    <Panel title={t('Clipboard')} note={t('chỉ văn bản')}>
      <div className="flex flex-col gap-3 px-3.5 py-3.5">
        <div className="grid items-start gap-3" style={{ gridTemplateColumns: 'minmax(96px,128px) minmax(0,1fr) minmax(96px,128px)' }}>
          <Endpoint os={device?.os ?? 'macos'} name={t('Máy này')} sends={peer.clipSend} takes={peer.clipReceive} />
          <div className="flex flex-col gap-4 pt-3">
            <ArrowLane dir="out" state={out} last={outLast} />
            <ArrowLane dir="in" state={inn} last={received ? <span className="num text-[11px] text-muted">{when(received)}</span> : null} />
          </div>
          <Endpoint os={peer.os} name={peer.name} sends={remote ? remote.send : null} takes={remote ? remote.receive : null} />
        </div>
        <div className="flex flex-col gap-2.5 border-t border-line pt-3">
          <SwitchLine label={t('Tự gửi sang máy kia')} tip={t('Mỗi lần bạn copy văn bản, nó được gửi sang máy kia (trừ mật khẩu từ trình quản lý mật khẩu). Chỉ chạy khi đang kết nối.')} on={peer.clipSend} onChange={(v) => setClip(peer.clipReceive, v)} />
          <SwitchLine label={t('Nhận từ máy kia')} tip={t('Văn bản máy kia gửi sẽ được ghi vào clipboard của máy này.')} on={peer.clipReceive} onChange={(v) => setClip(v, peer.clipSend)} />
          <div className="flex flex-wrap items-center gap-2.5">
            <Button size="sm" disabled={!!why} title={why ?? undefined} onClick={() => void api.connectClipSend(peer.id).catch(onError(t('Không gửi được clipboard')))}>
              <Send size={13} strokeWidth={1.75} className="mr-1.5" />
              {t('Gửi ngay')}
            </Button>
            <Button size="sm" disabled={!!filesWhy} title={filesWhy ?? undefined} onClick={() => void api.connectClipFilesSend(peer.id).catch(onError(t('Không gửi được tệp')))}>
              <Files size={13} strokeWidth={1.75} className="mr-1.5" />
              {t('Gửi tệp đang copy')}
            </Button>
            {why && <span className="text-[11.5px] text-muted">{why}</span>}
          </div>
          {peer.clipFiles && <IncomingFiles peer={peer} onError={onError} />}
        </div>
      </div>
    </Panel>
  )
}

/** A machine in the picture with what it does with clipboard text: sends as soon
 *  as it copies, takes what is sent. `null` is not known (not linked, or a
 *  machine too old to say). */
function Endpoint({ os, name, sends, takes }: { os: string; name: string; sends: boolean | null; takes: boolean | null }) {
  return (
    <span className="flex min-w-0 flex-col items-center gap-2 rounded-lg border border-line bg-sunken/40 px-2 py-2.5 text-center">
      <OsIcon os={os} />
      <span className="max-w-full truncate text-[11.5px] font-medium">{name}</span>
      <span className="flex flex-col gap-1 text-[10.5px]">
        <Pill label={t('Tự gửi')} on={sends} />
        <Pill label={t('Nhận#clipboard')} on={takes} />
      </span>
    </span>
  )
}

function Pill({ label, on }: { label: string; on: boolean | null }) {
  return (
    <span className="flex items-center justify-center gap-1.5" style={{ color: on ? 'var(--success)' : 'var(--muted)' }}>
      <span className="size-1.5 rounded-full" style={{ background: on ? 'var(--success)' : on === false ? 'var(--line2)' : 'transparent', border: on === null ? '1px dashed var(--line2)' : undefined }} />
      {label}
      {on === null && ' ?'}
    </span>
  )
}

/** One direction in the picture: solid when text can flow, amber when this side
 *  is on but the other side would not take it, dashed when it is off. */
function ArrowLane({ dir, state, last }: { dir: 'in' | 'out'; state: FlowState; last: React.ReactNode }) {
  const Arrow = dir === 'out' ? ArrowRight : ArrowLeft
  const color = state === 'flow' ? 'var(--accent)' : state === 'blocked' ? 'var(--warn)' : 'var(--line2)'
  const line = <span className="h-0 flex-1 border-t-2" style={{ borderColor: color, borderStyle: state === 'flow' ? 'solid' : 'dashed' }} />
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="flex w-full items-center" style={{ color }}>
        {dir === 'in' && <Arrow size={16} strokeWidth={2.25} className="-mr-1 flex-none" />}
        {line}
        {state === 'blocked' && <X size={14} strokeWidth={2.5} className="mx-1 flex-none" />}
        {state === 'blocked' && line}
        {dir === 'out' && <Arrow size={16} strokeWidth={2.25} className="-ml-1 flex-none" />}
      </span>
      {last}
    </div>
  )
}

/** What the other machine copied: the names, and a button that fetches it all. */
function IncomingFiles({ peer, onError }: { peer: ConnectPeer; onError: (title: string) => (e: unknown) => void }) {
  const files = peer.clipFiles
  if (!files) return null
  const total = files.items.reduce((n, i) => n + i.size, 0)
  const shown = files.items.slice(0, 3).map((i) => i.name)
  const more = files.items.length - shown.length
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-sunken/40 px-3 py-2.5">
      <span className="flex items-center gap-2 font-medium">
        <Files size={15} strokeWidth={1.75} className="text-ink2" />
        {t('{name} đã copy {n} mục · {size}', { name: peer.name, n: files.items.length, size: formatBytes(total) })}
      </span>
      <span className="truncate text-[11.5px] text-muted">{[...shown, more > 0 ? t('và {n} mục khác', { n: more }) : null].filter(Boolean).join(', ')}</span>
      <span className="flex flex-wrap items-center gap-2.5">
        <Button size="sm" variant="primary" onClick={() => void api.connectClipFilesSave(peer.id).catch(onError(t('Không lưu được tệp')))}>
          <Download size={13} strokeWidth={1.75} className="mr-1.5" />
          {t('Lưu vào Downloads')}
        </Button>
      </span>
    </div>
  )
}

function SwitchLine({ label, tip, on, onChange }: { label: string; tip: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-3" title={tip}>
      <span className="min-w-0 flex-1 text-[12.5px]">{label}</span>
      <Switch on={on} onChange={onChange} label={label} />
    </div>
  )
}
