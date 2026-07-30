import { tv } from '@/lib/tv'

/**
 * Three appearances of the same control in the handoff:
 *  · Servers toolbar — All | Recent | Favorites  (6px 11px, 11.5px)
 *  · Form auth       — Password | Private key | Agent (7px 14px, 12px)
 *  · Settings theme  — Auto | Dark (5px 11px, 11.5px)
 *
 * The mock draws the first with a `#ffffff12` border and the other two with
 * `#ffffff14`; that difference rides along with the size rather than becoming
 * a separate prop nobody would remember to set.
 */
const wrap = tv({
  base: 'flex w-max overflow-hidden rounded-field bg-field',
  variants: {
    size: {
      sm: 'border border-w07',
      md: 'border border-w08',
      xs: 'border border-w08',
    },
  },
  defaultVariants: { size: 'sm' },
})

const item = tv({
  base: 'transition-colors',
  variants: {
    size: {
      sm: 'px-2.75 py-1.5 text-meta', // 6px 11px
      md: 'px-3.5 py-1.75 text-cell', // 7px 14px
      xs: 'px-2.75 py-1.25 text-meta', // 5px 11px
    },
    selected: {
      true: 'text-fg',
      false: 'text-muted hover:text-fg',
    },
  },
  compoundVariants: [
    { size: 'sm', selected: true, class: 'bg-w07' },
    { size: 'md', selected: true, class: 'bg-w08' },
    { size: 'xs', selected: true, class: 'bg-w08' },
  ],
  defaultVariants: { size: 'sm', selected: false },
})

export interface SegmentedOption<T extends string> {
  value: T
  label: string
}

interface Props<T extends string> {
  options: SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  size?: 'xs' | 'sm' | 'md'
  className?: string
  'aria-label'?: string
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = 'sm',
  className,
  ...rest
}: Props<T>) {
  return (
    <div role="tablist" aria-label={rest['aria-label']} className={wrap({ size, className })}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          onClick={() => onChange(option.value)}
          className={item({ size, selected: option.value === value })}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
