import type { ReactNode } from 'react'

/**
 * Every screen in the handoff is the same skeleton: a bar with a hairline
 * under it, a body that scrolls, and a mono footer with a hairline over it.
 * Defining it once is what keeps the seven screens from drifting apart.
 *
 * Screens are absolutely positioned inside the main area so switching between
 * them never reflows the shell (README line 32).
 */
interface Props {
  header?: ReactNode
  footer?: ReactNode
  children: ReactNode
  /** The drawer renders here, outside the scrolling body, so it overlays. */
  overlay?: ReactNode
}

export function ScreenShell({ header, footer, children, overlay }: Props) {
  return (
    <div className="absolute inset-0 flex flex-col">
      {header}
      {children}
      {footer}
      {overlay}
    </div>
  )
}

/** The `12px 16px` bar at the top of every screen. */
export function ScreenHeader({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-none items-center gap-2.5 border-b border-w06 px-4.5 py-4">
      {children}
    </div>
  )
}

/** Screen title, 600 14px. */
export function ScreenTitle({ children }: { children: ReactNode }) {
  return <span className="flex-none text-title font-semibold">{children}</span>
}

/** The muted mono caption that sits next to most screen titles. */
export function ScreenSubtitle({ children }: { children: ReactNode }) {
  return <span className="flex-none font-mono text-meta text-faint">{children}</span>
}

/**
 * The `9px 16px` mono footer. Pass two children and the second is pushed to
 * the right edge, which is how Servers and SSH Keys use it.
 */
export function FooterBar({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-none items-center gap-4 border-t border-w06 px-4 py-2.5 font-mono text-mono text-faint">
      {children}
    </div>
  )
}

export function FooterRight({ children }: { children: ReactNode }) {
  return <span className="ml-auto">{children}</span>
}
