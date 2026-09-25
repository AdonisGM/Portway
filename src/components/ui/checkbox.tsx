import { Check } from 'lucide-react'
import type { ReactNode } from 'react'
import { cx } from './primitives'

export function Checkbox({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-[12px] text-ink2">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
      <span
        className={cx(
          'flex size-4 flex-none items-center justify-center rounded-[4px] border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-accent/40',
          checked ? 'border-accent bg-accent text-accent-fg' : 'border-line2 bg-sunken',
        )}
      >
        {checked && <Check size={12} strokeWidth={3} />}
      </span>
      {children}
    </label>
  )
}
