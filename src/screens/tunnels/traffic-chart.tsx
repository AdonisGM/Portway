import { useEffect, useRef, useState } from 'react'
import { t } from '../../i18n'
import { hms } from '../../i18n/dates'
import type { TunnelSample } from '../../lib/api'
import { formatBytes } from '../server/format'

export const RX = 'var(--info)'
export const TX = 'var(--warn)'

export const rate = (bytes: number) => formatBytes(bytes) + '/s'

/** "0.42 ms", "8.1 ms", "38 ms", "3.3 s". */
export function latency(us: number | null) {
  if (us == null) return '—'
  const ms = us / 1000
  if (ms >= 1000) return (ms / 1000).toFixed(1) + ' s'
  return ms < 1 ? ms.toFixed(2) + ' ms' : ms < 10 ? ms.toFixed(1) + ' ms' : Math.round(ms) + ' ms'
}

/** A round top for the rate axis: 1, 2 or 5 × 1024ⁿ, at least 1 KB/s so an
 *  idle tunnel doesn't blow a few bytes up to full height. */
function niceMax(v: number) {
  const m = Math.max(v, 1024)
  const unit = Math.pow(1024, Math.floor(Math.log(m) / Math.log(1024)))
  const x = m / unit
  const step = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1024].find((s) => s >= x) ?? 1024
  return step * unit
}

/** Samples of the last `n` seconds, oldest first; missing seconds (before the
 *  tunnel started) are left out and drawn as blank. */
const lastN = (samples: TunnelSample[], n: number) => samples.slice(Math.max(0, samples.length - n))

/** Line (and area under it) of the values, right-aligned on `n` slots. A null
 *  (not measured) breaks the line; the area is only for series without gaps. */
function paths(values: (number | null)[], n: number, w: number, h: number, max: number) {
  const step = w / Math.max(1, n - 1)
  const x0 = w - (values.length - 1) * step
  const pts = values.map((v, i) => (v == null ? null : ([x0 + i * step, h - (Math.min(v, max) / max) * h] as const)))
  if (!pts.length) return { line: '', area: '' }
  const line = pts.map((p, i) => (p ? `${i && pts[i - 1] ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}` : '')).join('')
  const first = pts[0]
  const end = pts[pts.length - 1]
  const area = first && end ? `${line}L${end[0].toFixed(1)},${h}L${first[0].toFixed(1)},${h}Z` : ''
  return { line, area }
}

/** The last minute on a tunnel row: ↓ filled, ↑ as a line. */
export function Sparkline({ samples, width = 84, height = 24 }: { samples: TunnelSample[]; width?: number; height?: number }) {
  const s = lastN(samples, 60)
  const max = niceMax(Math.max(0, ...s.map((x) => Math.max(x.rx, x.tx))))
  const down = paths(
    s.map((x) => x.rx),
    60,
    width,
    height - 1,
    max,
  )
  const up = paths(
    s.map((x) => x.tx),
    60,
    width,
    height - 1,
    max,
  )
  return (
    <svg width={width} height={height} className="flex-none overflow-visible" aria-hidden>
      <line x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} stroke="var(--line)" />
      <path d={down.area} fill={RX} fillOpacity={0.22} />
      <path d={down.line} fill="none" stroke={RX} strokeWidth={1.2} />
      <path d={up.line} fill="none" stroke={TX} strokeWidth={1.2} />
    </svg>
  )
}

const GUTTER = 64
const RATE_H = 170
const RTT_H = 38
const GAP = 22
/** Room above the top grid line for its label. */
const TOP = 8

/** Rate over the chosen window (↓ area, ↑ line) with the SSH round trip in a
 *  strip below; hovering shows the numbers of that second. */
export function TrafficChart({ samples, seconds }: { samples: TunnelSample[]; seconds: number }) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)
  const [hover, setHover] = useState<number | null>(null)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(200, e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const s = lastN(samples, seconds)
  const w = width - GUTTER
  const max = niceMax(Math.max(0, ...s.map((x) => Math.max(x.rx, x.tx))))
  const down = paths(
    s.map((x) => x.rx),
    seconds,
    w,
    RATE_H,
    max,
  )
  const up = paths(
    s.map((x) => x.tx),
    seconds,
    w,
    RATE_H,
    max,
  )
  const rtts = s.map((x) => x.rttUs)
  const rttTop = Math.max(1000, ...rtts.map((v) => v ?? 0))
  const rttMax = rttTop * 1.15
  const rtt = paths(rtts, seconds, w, RTT_H, rttMax)
  const step = w / Math.max(1, seconds - 1)
  const x0 = w - (s.length - 1) * step
  const at = hover != null ? s[hover] : null
  const total = TOP + RATE_H + GAP + RTT_H + 16
  const span = seconds >= 120 ? t('{n} phút trước', { n: Math.round(seconds / 60) }) : t('{n} giây trước', { n: seconds })

  const onMove = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - r.left - GUTTER
    const i = Math.round((x - x0) / step)
    setHover(x < 0 || i < 0 || i >= s.length ? null : i)
  }

  return (
    <div ref={box} className="relative select-none" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg width={width} height={total} className="block">
        <g transform={`translate(0,${TOP})`}>
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={GUTTER} x2={width} y1={RATE_H - f * RATE_H + 0.5} y2={RATE_H - f * RATE_H + 0.5} stroke="var(--line)" strokeDasharray={f ? '3 3' : undefined} />
              <text x={GUTTER - 8} y={RATE_H - f * RATE_H + 4} textAnchor="end" className="num fill-[var(--muted)] text-[10.5px]">
                {f ? rate(max * f) : '0'}
              </text>
            </g>
          ))}
          <g transform={`translate(${GUTTER},0)`}>
            <path d={down.area} fill={RX} fillOpacity={0.18} />
            <path d={down.line} fill="none" stroke={RX} strokeWidth={1.5} strokeLinejoin="round" />
            <path d={up.line} fill="none" stroke={TX} strokeWidth={1.5} strokeLinejoin="round" />
          </g>

          <text x={GUTTER - 8} y={RATE_H + GAP + RTT_H / 2 + 4} textAnchor="end" className="fill-[var(--muted)] text-[10.5px]">
            {t('Độ trễ')}
          </text>
          <text x={GUTTER + 4} y={RATE_H + GAP + 4} className="num fill-[var(--muted)] text-[10px]">
            {latency(rttTop)}
          </text>
          <g transform={`translate(${GUTTER},${RATE_H + GAP})`}>
            <line x1={0} x2={w} y1={RTT_H + 0.5} y2={RTT_H + 0.5} stroke="var(--line)" />
            <path d={rtt.line} fill="none" stroke="var(--success)" strokeWidth={1.3} strokeLinejoin="round" />
          </g>
          <text x={GUTTER} y={total - TOP - 2} className="fill-[var(--muted)] text-[10.5px]">
            {span}
          </text>
          <text x={width} y={total - TOP - 2} textAnchor="end" className="fill-[var(--muted)] text-[10.5px]">
            {t('bây giờ')}
          </text>

          {at && hover != null && <line x1={GUTTER + x0 + hover * step} x2={GUTTER + x0 + hover * step} y1={0} y2={RATE_H + GAP + RTT_H} stroke="var(--line2)" />}
        </g>
      </svg>
      {at && hover != null && (
        <div
          className="pointer-events-none absolute top-1 flex flex-col gap-0.5 rounded-lg border border-line2 bg-surface px-2.5 py-1.5 text-[11px] shadow-pop"
          style={GUTTER + x0 + hover * step > width - 170 ? { right: width - (GUTTER + x0 + hover * step) + 10 } : { left: GUTTER + x0 + hover * step + 10 }}
        >
          <span className="num text-muted">{hms(new Date(at.at))}</span>
          <span className="num" style={{ color: RX }}>
            ↓ {rate(at.rx)}
          </span>
          <span className="num" style={{ color: TX }}>
            ↑ {rate(at.tx)}
          </span>
          <span className="num text-ink2">{t('{n} kết nối', { n: at.active })}</span>
          <span className="num" style={{ color: 'var(--success)' }}>
            {t('Độ trễ')} {latency(at.rttUs)}
          </span>
        </div>
      )}
    </div>
  )
}
