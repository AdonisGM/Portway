import type { ButtonHTMLAttributes } from 'react'
import { type VariantProps } from 'tailwind-variants'
import { tv } from '@/lib/tv'

/**
 * The small inline affordances that live inside table rows and pane headers:
 * SSH / SFTP on a host row, Upload in the SFTP path bar, Copy pub and `···` in
 * SSH Keys, Verified / Trust new / Remove in Known hosts.
 *
 * Padding is the handoff's 3px 9px; Sync now in Settings is the one at
 * 4px 10px, which is what `size="md"` is for.
 */
const chip = tv({
  base: 'rounded-chip transition-colors',
  variants: {
    tone: {
      strong: 'bg-w07 text-fg hover:bg-w15',
      soft: 'bg-w05 text-fg-2 hover:bg-w15 hover:text-fg',
      danger: 'bg-w05 text-danger hover:bg-danger-fill',
    },
    size: {
      sm: 'px-2.25 py-0.75 text-mono', // 3px 9px, 11px
      md: 'px-2.5 py-1 rounded-nav text-meta', // 4px 10px, 11.5px
    },
  },
  defaultVariants: { tone: 'soft', size: 'sm' },
})

type Props = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof chip>

export function Chip({ tone, size, className, type = 'button', ...rest }: Props) {
  return <button type={type} className={chip({ tone, size, className })} {...rest} />
}
