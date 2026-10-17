import { KEEP_SAMPLES } from '../../app/connect'

type Series = { values: (number | null)[]; color: string; fill?: boolean }

const W = 300
const H = 52

/** Lines for the last `KEEP_SAMPLES` readings, the newest at the right edge;
 *  a null breaks the line (the link was down). */
function paths(values: (number | null)[], max: number) {
  const offset = KEEP_SAMPLES - values.length
  const runs: [number, number][][] = []
  let run: [number, number][] = []
  values.forEach((v, i) => {
    if (v === null) {
      if (run.length) runs.push(run)
      run = []
      return
    }
    const x = ((offset + i) / (KEEP_SAMPLES - 1)) * W
    run.push([x, H - 1 - (Math.min(v, max) / max) * (H - 3)])
  })
  if (run.length) runs.push(run)
  const pt = (p: [number, number]) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`
  const line = runs.map((r) => 'M' + r.map(pt).join('L')).join('')
  const area = runs.map((r) => `M${r[0][0].toFixed(1)},${H}L${r.map(pt).join('L')}L${r[r.length - 1][0].toFixed(1)},${H}Z`).join('')
  return { line, area }
}

/** A small chart over the last few minutes: lines (optionally filled) on a
 *  scale of 0 to `max`, with a faint line at half. */
export function LiveChart({ series, max }: { series: Series[]; max: number }) {
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-[52px] w-full overflow-visible" aria-hidden>
      <line x1={0} x2={W} y1={H / 2} y2={H / 2} stroke="var(--line)" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
      <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} stroke="var(--line2)" vectorEffect="non-scaling-stroke" />
      {series.map((s, i) => {
        const p = paths(s.values, max)
        return (
          <g key={i}>
            {s.fill && <path d={p.area} fill={s.color} fillOpacity={0.16} />}
            <path d={p.line} fill="none" stroke={s.color} strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </g>
        )
      })}
    </svg>
  )
}

/** A scale that ends on 1, 2 or 5 of some power of ten, so it does not jump with every reading. */
export function niceMax(v: number): number {
  if (v <= 0) return 100_000
  const p = 10 ** Math.floor(Math.log10(v))
  const m = v / p
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p
}
