import { Dialog } from '@ark-ui/react/dialog'
import { Portal } from '@ark-ui/react/portal'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useServers } from '../../app/servers'
import { Button, cx } from '../../components/ui/primitives'
import { SearchInput } from '../../components/ui/search-input'
import { SegmentedControl } from '../../components/ui/segmented'
import { StatStrip } from '../../components/ui/stat-strip'
import { t } from '../../i18n'
import { hms } from '../../i18n/dates'
import { api, type Tunnel, type TunnelLink, type TunnelMonitor, type TunnelSample } from '../../lib/api'
import { spanText } from '../docker/format'
import { formatBytes } from '../server/format'
import { describe, KIND_LABELS, status } from './format'
import { latency, rate, RX, TrafficChart, TX } from './traffic-chart'

type Tab = 'open' | 'apps' | 'recent'
type SortKey = 'rate' | 'total' | 'opened'

/** Per-row grids: fixed tracks or minmax(0,…) only, header in the same box. */
const OPEN_COLS = 'minmax(0,1.1fr) minmax(0,1.4fr) 64px 84px 84px 76px 76px'
const APP_COLS = 'minmax(0,1.6fr) 62px 62px 84px 84px 76px 76px'
const RECENT_COLS = 'minmax(0,1.1fr) minmax(0,1.6fr) 64px 64px 76px 76px'

/** "0:12", "3:05", "1:02:07": short and the same in both languages. */
function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const isLocal = (peer: string) => /^(127\.|\[::1\]|\[::ffff:127\.)/.test(peer)
const peerIp = (peer: string) => peer.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')

/** Who is on the other end: the app on this Mac, a LAN machine, or the server. */
function who(l: TunnelLink): { name: string; sub: string; key: string } {
  if (l.process) {
    const name = l.process.app ?? l.process.name
    const sub = l.process.app && l.process.app !== l.process.name ? `${l.process.name} · pid ${l.process.pid}` : `pid ${l.process.pid}`
    return { name, sub, key: name }
  }
  if (!l.peer) return { name: t('Từ server'), sub: t('kết nối server chuyển về'), key: t('Từ server') }
  if (isLocal(l.peer)) {
    // lsof takes ~50 ms; a connection gone before that can't be traced back.
    const quick = l.closedAt != null && l.closedAt - l.openedAt < 1000
    return { name: t('Không rõ tiến trình'), sub: quick ? t('đóng trước khi kịp nhận diện') : l.peer, key: t('Không rõ tiến trình') }
  }
  return { name: peerIp(l.peer), sub: t('máy khác trong mạng'), key: peerIp(l.peer) }
}

export function TunnelMonitorSheet({ tunnel, onClose, onStart }: { tunnel: Tunnel; onClose: () => void; onStart: () => void }) {
  const { byId } = useServers()
  const [m, setM] = useState<TunnelMonitor | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [seconds, setSeconds] = useState<'60' | '300' | '900'>('300')
  const [tab, setTab] = useState<Tab>('open')
  const [sort, setSort] = useState<SortKey>('rate')
  const [query, setQuery] = useState('')
  const [now, setNow] = useState(Date.now())

  // Poll once a second while open; the Rust side samples on its own.
  useEffect(() => {
    let alive = true
    const load = () =>
      void api.tunnelMonitor(tunnel.id).then((x) => {
        if (!alive) return
        setM(x)
        setLoaded(true)
        setNow(Date.now())
      })
    load()
    const timer = setInterval(load, 1000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [tunnel.id])

  const win = Number(seconds)
  const samples: TunnelSample[] = m?.samples ?? []
  const inWin = samples.slice(Math.max(0, samples.length - win))
  const last = samples[samples.length - 1]
  const peak = (k: 'rx' | 'tx') => Math.max(0, ...inWin.map((s) => s[k]))
  const avg = (k: 'rx' | 'tx') => (inWin.length ? inWin.reduce((a, s) => a + s[k], 0) / inWin.length : 0)
  const st = status(tunnel, now)
  const server = byId(tunnel.serverId)

  const q = query.trim().toLowerCase()
  const match = (l: TunnelLink) => !q || `${who(l).name} ${who(l).sub} ${l.target} ${l.peer ?? ''} ${l.error ?? ''}`.toLowerCase().includes(q)
  const open = (m?.open ?? [])
    .filter(match)
    .sort((a, b) => (sort === 'rate' ? b.rateRx + b.rateTx - (a.rateRx + a.rateTx) || b.openedAt - a.openedAt : sort === 'total' ? b.rx + b.tx - (a.rx + a.tx) : b.openedAt - a.openedAt))
  const recent = (m?.recent ?? []).filter(match)
  const apps = groupByApp([...(m?.open ?? []), ...(m?.recent ?? [])].filter(match)).sort((a, b) =>
    sort === 'rate' ? b.rateRx + b.rateTx - (a.rateRx + a.rateTx) || b.rx + b.tx - (a.rx + a.tx) : b.rx + b.tx - (a.rx + a.tx),
  )
  const failed = (m?.recent ?? []).filter((l) => l.error).length

  return (
    <Dialog.Root open onOpenChange={(e) => !e.open && onClose()} initialFocusEl={() => document.querySelector<HTMLElement>('[data-scope=dialog][data-part=content] input')} lazyMount unmountOnExit>
      <Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-[var(--scrim)]" />
        <Dialog.Positioner className="fixed inset-0 z-40 flex justify-end">
          <Dialog.Content className="flex h-full w-[min(940px,calc(100vw-96px))] flex-col border-l border-line bg-surface text-[12.5px] shadow-modal">
            <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <Dialog.Title className="m-0 flex items-center gap-2 text-[15px] font-semibold">
                  <span className="truncate">{tunnel.name}</span>
                  <span className="rounded-[4px] bg-sunken px-1.5 py-px text-[10.5px] font-normal text-ink2">{KIND_LABELS[tunnel.kind]}</span>
                  <span className="flex items-center gap-1.5 text-[11.5px] font-medium" style={{ color: st.color }}>
                    <span className="size-1.5 rounded-full" style={{ background: st.color }} />
                    {st.label}
                  </span>
                </Dialog.Title>
                <Dialog.Description className="m-0 truncate font-mono text-[11px] text-muted">{describe(tunnel, server?.name ?? tunnel.serverId)}</Dialog.Description>
              </span>
              <Dialog.CloseTrigger asChild>
                <Button variant="quiet" size="bare">
                  {t('Đóng')}
                </Button>
              </Dialog.CloseTrigger>
            </div>

            {loaded && !m ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2.5 px-6 text-center">
                <span className="text-[14px] font-semibold">{t('Tunnel đang tắt')}</span>
                <span className="max-w-[420px] leading-normal text-muted">{t('Số liệu có từ lúc tunnel bật và chỉ giữ trong bộ nhớ đến khi tắt.')}</span>
                <Button variant="primary" size="xs" onClick={onStart}>
                  {t('Bật tunnel')}
                </Button>
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col gap-3.5 px-5 py-4">
                <StatStrip
                  items={[
                    {
                      label: t('↓ Tải về'),
                      value: rate(last?.rx ?? 0),
                      hint: t('đỉnh {peak} · TB {avg}', {
                        peak: rate(peak('rx')),
                        avg: rate(avg('rx')),
                      }),
                      hintTone: RX,
                    },
                    {
                      label: t('↑ Tải lên'),
                      value: rate(last?.tx ?? 0),
                      hint: t('đỉnh {peak} · TB {avg}', {
                        peak: rate(peak('tx')),
                        avg: rate(avg('tx')),
                      }),
                      hintTone: TX,
                    },
                    {
                      label: t('Độ trễ SSH'),
                      value: latency(m?.rttUs ?? null),
                      hint: tunnel.run.state === 'running' ? t('Mac ↔ server') : t('chưa kết nối'),
                    },
                    {
                      label: t('Kết nối#count'),
                      value: String(last?.active ?? 0),
                      hint: m?.reconnects
                        ? t('{n} tổng · kết nối lại {r} lần', {
                            n: m.total,
                            r: m.reconnects,
                          })
                        : t('{n} tổng', { n: m?.total ?? 0 }),
                    },
                    {
                      label: t('Đã truyền'),
                      value: `↓ ${formatBytes(m?.rx ?? 0)}  ↑ ${formatBytes(m?.tx ?? 0)}`,
                      hint:
                        tunnel.run.state === 'running'
                          ? t('chạy {span}', {
                              span: spanText((now - tunnel.run.since) / 1000),
                            })
                          : undefined,
                    },
                  ]}
                />

                <div className="flex flex-col gap-2 rounded-xl border border-line px-3.5 pt-3 pb-2.5">
                  <div className="flex items-center gap-3">
                    <span className="font-semibold">{t('Lưu lượng')}</span>
                    <Legend color={RX} label={t('↓ tải về')} />
                    <Legend color={TX} label={t('↑ tải lên')} />
                    <Legend color="var(--success)" label={t('độ trễ SSH')} />
                    <span className="flex-1" />
                    <SegmentedControl
                      value={seconds}
                      onChange={setSeconds}
                      options={[
                        { id: '60', label: t('1 phút') },
                        { id: '300', label: t('5 phút') },
                        { id: '900', label: t('15 phút') },
                      ]}
                    />
                  </div>
                  <TrafficChart samples={samples} seconds={win} />
                </div>

                <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line">
                  <div className="flex flex-wrap items-center gap-2.5 border-b border-line bg-raised px-3 py-2">
                    <SegmentedControl
                      value={tab}
                      onChange={setTab}
                      options={[
                        {
                          id: 'open',
                          label: t('Đang mở ({n})', { n: m?.open.length ?? 0 }),
                        },
                        { id: 'apps', label: t('Theo ứng dụng') },
                        {
                          id: 'recent',
                          label: failed
                            ? t('Gần đây ({n} · {f} lỗi)', {
                                n: m?.recent.length ?? 0,
                                f: failed,
                              })
                            : t('Gần đây ({n})', { n: m?.recent.length ?? 0 }),
                        },
                      ]}
                    />
                    <span className="flex-1" />
                    <SearchInput value={query} onChange={setQuery} placeholder={t('Lọc ứng dụng, đích')} className="w-52 min-w-0" />
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
                    {tab === 'open' && (
                      <>
                        <Head cols={OPEN_COLS}>
                          <span>{t('Tiến trình')}</span>
                          <span>{t('Đích')}</span>
                          <SortHead k="opened" sort={sort} setSort={setSort} label={t('Mở được')} />
                          <SortHead k="rate" sort={sort} setSort={setSort} label={t('↓ Tốc độ')} />
                          <span className="text-right">{t('↑ Tốc độ')}</span>
                          <SortHead k="total" sort={sort} setSort={setSort} label={t('↓ Tổng')} />
                          <span className="text-right">{t('↑ Tổng')}</span>
                        </Head>
                        {open.map((l) => (
                          <Row key={l.id} cols={OPEN_COLS}>
                            <Who l={l} />
                            <Target l={l} />
                            <span className="num text-right text-ink2">{clock(now - l.openedAt)}</span>
                            <RateCell v={l.rateRx} color={RX} />
                            <RateCell v={l.rateTx} color={TX} />
                            <span className="num text-right">{formatBytes(l.rx)}</span>
                            <span className="num text-right">{formatBytes(l.tx)}</span>
                          </Row>
                        ))}
                        {!open.length && <Empty text={q ? t('Không có kết nối nào khớp') : t('Chưa có kết nối nào đang mở qua tunnel')} />}
                      </>
                    )}
                    {tab === 'apps' && (
                      <>
                        <Head cols={APP_COLS}>
                          <span>{t('Ứng dụng / máy')}</span>
                          <span className="text-right">{t('Đang mở')}</span>
                          <span className="text-right">{t('Tổng')}</span>
                          <SortHead k="rate" sort={sort} setSort={setSort} label={t('↓ Tốc độ')} />
                          <span className="text-right">{t('↑ Tốc độ')}</span>
                          <SortHead k="total" sort={sort} setSort={setSort} label={t('↓ Tổng')} />
                          <span className="text-right">{t('↑ Tổng')}</span>
                        </Head>
                        {apps.map((a) => (
                          <Row key={a.key} cols={APP_COLS}>
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate font-medium">{a.key}</span>
                              <span className="truncate text-[11px] text-muted">{a.targets.slice(0, 3).join(', ') + (a.targets.length > 3 ? ' …' : '')}</span>
                            </span>
                            <span className="num text-right">{a.open}</span>
                            <span className="num text-right text-ink2">{a.count}</span>
                            <RateCell v={a.rateRx} color={RX} />
                            <RateCell v={a.rateTx} color={TX} />
                            <span className="num text-right">{formatBytes(a.rx)}</span>
                            <span className="num text-right">{formatBytes(a.tx)}</span>
                          </Row>
                        ))}
                        {!apps.length && <Empty text={t('Chưa có kết nối nào')} />}
                        {!!apps.length && <span className="block px-3 py-2 text-[11px] text-muted">{t('Tính trên các kết nối đang mở và 100 kết nối gần nhất.')}</span>}
                      </>
                    )}
                    {tab === 'recent' && (
                      <>
                        <Head cols={RECENT_COLS}>
                          <span>{t('Tiến trình')}</span>
                          <span>{t('Đích')}</span>
                          <span className="text-right">{t('Đóng lúc')}</span>
                          <span className="text-right">{t('Kéo dài')}</span>
                          <span className="text-right">{t('↓ Tổng')}</span>
                          <span className="text-right">{t('↑ Tổng')}</span>
                        </Head>
                        {recent.map((l) => (
                          <Row key={l.id} cols={RECENT_COLS} tone={l.error ? 'danger' : undefined}>
                            <Who l={l} />
                            <Target l={l} />
                            <span className="num text-right text-ink2">{l.closedAt ? hms(new Date(l.closedAt)) : ''}</span>
                            <span className="num text-right text-ink2">{clock((l.closedAt ?? now) - l.openedAt)}</span>
                            <span className="num text-right">{formatBytes(l.rx)}</span>
                            <span className="num text-right">{formatBytes(l.tx)}</span>
                          </Row>
                        ))}
                        {!recent.length && <Empty text={q ? t('Không có kết nối nào khớp') : t('Chưa có kết nối nào đóng')} />}
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  )
}

type AppRow = {
  key: string
  open: number
  count: number
  rx: number
  tx: number
  rateRx: number
  rateTx: number
  targets: string[]
}

function groupByApp(links: TunnelLink[]): AppRow[] {
  const map = new Map<string, AppRow>()
  for (const l of links) {
    const key = who(l).key
    const a = map.get(key) ?? {
      key,
      open: 0,
      count: 0,
      rx: 0,
      tx: 0,
      rateRx: 0,
      rateTx: 0,
      targets: [],
    }
    a.count++
    if (!l.closedAt) a.open++
    a.rx += l.rx
    a.tx += l.tx
    a.rateRx += l.rateRx
    a.rateTx += l.rateTx
    const host = l.target.replace(/:\d+$/, '')
    if (host && !a.targets.includes(host)) a.targets.push(host)
    map.set(key, a)
  }
  return [...map.values()]
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-ink2">
      <span className="h-0.5 w-3 rounded-full" style={{ background: color }} />
      {label}
    </span>
  )
}

function Head({ cols, children }: { cols: string; children: ReactNode }) {
  return (
    <div className="sticky top-0 z-[1] grid items-center gap-3 border-b border-line bg-sunken px-3 py-[7px] text-[11px] whitespace-nowrap text-muted" style={{ gridTemplateColumns: cols }}>
      {children}
    </div>
  )
}

function Row({ cols, tone, children }: { cols: string; tone?: 'danger'; children: ReactNode }) {
  return (
    <div className={cx('grid items-center gap-3 border-b border-line px-3 py-1.5', tone === 'danger' && 'bg-danger-soft')} style={{ gridTemplateColumns: cols }}>
      {children}
    </div>
  )
}

/** Sorting is always biggest first, so the active column is just marked. */
function SortHead({ k, label, sort, setSort }: { k: SortKey; label: string; sort: SortKey; setSort: (k: SortKey) => void }) {
  const on = sort === k
  return (
    <button
      type="button"
      onClick={() => setSort(k)}
      className={cx('cursor-pointer text-right text-[11px] underline-offset-[3px]', on ? 'font-medium text-ink underline' : 'text-muted hover:text-ink2')}
    >
      {label}
    </button>
  )
}

function Who({ l }: { l: TunnelLink }) {
  const w = who(l)
  return (
    <span className="flex min-w-0 flex-col" title={l.peer ?? undefined}>
      <span className="truncate font-medium">{w.name}</span>
      <span className="truncate font-mono text-[10.5px] text-muted">{w.sub}</span>
    </span>
  )
}

function Target({ l }: { l: TunnelLink }) {
  return (
    <span className="flex min-w-0 flex-col" title={l.error ?? l.target}>
      <span className="truncate font-mono text-[11.5px]">{l.target || '…'}</span>
      {l.error ? (
        <span className="truncate text-[11px] text-danger">{l.error}</span>
      ) : l.openMs != null ? (
        <span className="truncate text-[10.5px] text-muted">{t('mở kênh mất {n} ms', { n: l.openMs })}</span>
      ) : null}
    </span>
  )
}

function RateCell({ v, color }: { v: number; color: string }) {
  const Icon = color === RX ? ArrowDown : ArrowUp
  return v ? (
    <span className="num flex items-center justify-end gap-0.5 font-medium" style={{ color }}>
      <Icon size={11} strokeWidth={2} />
      {rate(v)}
    </span>
  ) : (
    <span className="num text-right text-muted">—</span>
  )
}

function Empty({ text }: { text: string }) {
  return <div className="px-6 py-8 text-center text-muted">{text}</div>
}
