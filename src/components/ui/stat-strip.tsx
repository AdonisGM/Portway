// Ported from HomeUI (home/apps/web/src/components/ui/primitives.tsx, StatStrip).
import { Caption, cx } from './primitives'

export type StatItem = { label: string; value: string; hint?: string; hintTone?: string }

/** Joined row of figures, used on overview screens. */
export function StatStrip({ items }: { items: StatItem[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(168px,1fr))] overflow-hidden rounded-xl border border-line bg-surface shadow-card">
      {items.map((it, i) => (
        <div key={it.label} className={cx('flex flex-col gap-0.5 px-3.5 py-3', i > 0 && 'border-l border-line')}>
          <span className="text-[10.5px] font-medium text-muted">{it.label}</span>
          <span className="num text-[18px] font-medium whitespace-nowrap">{it.value}</span>
          {it.hint ? (
            it.hintTone ? (
              <span className="num text-[11px] font-medium" style={{ color: it.hintTone }}>
                {it.hint}
              </span>
            ) : (
              <Caption className="num">{it.hint}</Caption>
            )
          ) : null}
        </div>
      ))}
    </div>
  )
}

/** Placeholder with the same shape while the first numbers load. */
export function StatStripSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(168px,1fr))] overflow-hidden rounded-xl border border-line bg-surface" aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={cx('flex flex-col gap-2 px-3.5 py-3.5', i > 0 && 'border-l border-line')}>
          <span className="block h-2.5 w-2/5 rounded-md bg-sunken" />
          <span className="block h-5 w-3/5 rounded-md bg-sunken" />
          <span className="block h-2 w-1/2 rounded-md bg-sunken" />
        </div>
      ))}
    </div>
  )
}
