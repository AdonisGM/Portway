// Ported from HomeUI (home/apps/web/src/components/ui/primitives.tsx).
import type { CSSProperties, ReactNode } from 'react'

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx('text-[11px] font-medium text-muted', className)}>{children}</span>
}

export function Caption({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx('text-[11px] leading-relaxed text-muted', className)}>{children}</span>
}

/** Status chip; tones are explicit {fg, bg} token pairs. */
export function Chip({
  tone,
  children,
  className,
}: {
  tone: { fg: string; bg: string }
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-[4px] px-2 py-[3px] text-[11px] font-medium whitespace-nowrap',
        className,
      )}
      style={{ color: tone.fg, background: tone.bg }}
    >
      {children}
    </span>
  )
}

export const TONES = {
  success: { fg: 'var(--success)', bg: 'var(--success-soft)' },
  warn: { fg: 'var(--warn)', bg: 'var(--warn-soft)' },
  danger: { fg: 'var(--danger)', bg: 'var(--danger-soft)' },
  info: { fg: 'var(--info)', bg: 'var(--info-soft)' },
  neutral: { fg: 'var(--muted)', bg: 'var(--sunken)' },
}

type ButtonProps = {
  variant?: 'primary' | 'secondary' | 'ghost' | 'link' | 'quiet' | 'dashed' | 'danger'
  size?: 'bare' | 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  children: ReactNode
  onClick?: () => void
  type?: 'button' | 'submit'
  disabled?: boolean
  className?: string
  style?: CSSProperties
  title?: string
}

export function Button({
  variant = 'secondary',
  size = 'md',
  children,
  onClick,
  type = 'button',
  disabled,
  className,
  style,
  title,
}: ButtonProps) {
  // Size scale from the design system: height, font size, horizontal padding, radius.
  const sizes = {
    bare: 'h-auto p-0 text-[12px] rounded-none',
    xs: 'h-6 px-2 text-[11px] rounded-md',
    sm: 'h-7 px-2.5 text-[12px] rounded-md',
    md: 'h-8 px-3 text-[12px] rounded-lg',
    lg: 'h-[38px] px-4 text-[13px] rounded-lg',
    xl: 'h-[42px] px-4 text-[14px] rounded-lg',
  }
  const variants = {
    primary: 'bg-accent text-accent-fg border border-accent font-medium hover:opacity-90',
    secondary: 'bg-surface text-ink border border-line2 font-medium hover:bg-sunken',
    ghost: 'bg-transparent text-ink2 border border-transparent hover:bg-sunken',
    link: 'bg-transparent text-accent border border-transparent font-medium hover:bg-accent-soft',
    quiet: 'bg-transparent text-muted border-none hover:text-ink',
    danger: 'bg-danger text-white border border-danger font-medium hover:opacity-90',
    dashed: 'bg-transparent text-accent border border-dashed border-line2 font-medium hover:bg-accent-soft',
  }
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={style}
      className={cx(
        'inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        sizes[size],
        variants[variant],
        className,
      )}
    >
      {children}
    </button>
  )
}
