// Ported from HomeUI (home/apps/web/src/components/ui/segmented.tsx).
import { cx } from './primitives'

/** Single-choice button group. */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  size = 'sm',
  full,
}: {
  value: T
  onChange: (v: T) => void
  options: Array<{ id: T; label: string }>
  size?: 'sm' | 'md'
  full?: boolean
}) {
  return (
    <div className={cx('flex gap-0.5 rounded-lg border border-line2 bg-sunken p-0.5', full && 'w-full')}>
      {options.map((o) => {
        const active = o.id === value
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            className={cx(
              'cursor-pointer rounded-md px-2.5 font-medium whitespace-nowrap transition-colors',
              size === 'sm' ? 'h-6 text-[11.5px]' : 'h-[30px] text-[12.5px]',
              full && 'flex-1',
              active ? 'bg-surface text-ink' : 'bg-transparent text-muted hover:text-ink2',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
