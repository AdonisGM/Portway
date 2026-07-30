import type { ComponentProps } from 'react'
import { type VariantProps } from 'tailwind-variants'
import { tv } from '@/lib/tv'

/**
 * The design has no icon set — actions are text labels — so one button covers
 * every call to action in the app: New server, Save, Cancel, Test connection,
 * Import…, Generate key, New tunnel, Choose file…, the drawer's SSH/SFTP pair
 * and its Edit/Duplicate/Delete row.
 *
 * Sizes are named for their role rather than a t-shirt scale, because the
 * handoff's paddings are specific: toolbar buttons are 6px 12px, header
 * buttons 7px 14px, Save 7px 16px, and the drawer's split pair 8px.
 */
const button = tv({
  base: 'rounded-field text-center transition-colors disabled:cursor-not-allowed disabled:opacity-40',
  variants: {
    variant: {
      accent: 'bg-accent font-medium text-ink',
      outline: 'border border-w14 text-fg hover:bg-w06',
      soft: 'bg-w05 text-fg-2 hover:bg-w10',
      danger: 'bg-w05 text-danger hover:bg-danger-fill',
      // Filled destructive — the confirming action in a delete dialog. Built
      // like `accent` so the two primaries read as the same kind of control.
      dangerSolid: 'bg-danger font-medium text-ink',
    },
    size: {
      // px-3 py-1.5 = 12px 6px — toolbar / screen-header actions
      sm: 'px-3 py-1.5 text-cell',
      // px-3.5 py-1.75 = 14px 7px — form header (Cancel, Test connection)
      md: 'px-3.5 py-1.75 text-cell',
      // px-4 py-1.75 = 16px 7px — the primary Save
      lg: 'px-4 py-1.75 text-cell',
      // full-width halves of the drawer's SSH / SFTP pair
      block: 'w-full py-2 text-body',
      // the drawer’s second action row: Edit · Duplicate · Del
      row: 'rounded-nav px-2.25 py-1.5 text-meta',
    },
  },
  defaultVariants: { variant: 'soft', size: 'sm' },
})

// ComponentProps rather than ButtonHTMLAttributes so `ref` comes along — React
// 19 passes it as an ordinary prop, and the confirm dialog focuses Cancel.
type Props = ComponentProps<'button'> & VariantProps<typeof button>

export function Button({ variant, size, className, type = 'button', ...rest }: Props) {
  return <button type={type} className={button({ variant, size, className })} {...rest} />
}
