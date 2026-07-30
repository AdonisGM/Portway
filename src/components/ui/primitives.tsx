import type { ReactNode } from 'react'
import { tv } from '@/lib/tv'
import { useApp } from '@/store/appStore'
import type { GroupId } from '@/data/types'

/** Section heading — ~15 of them across the app. */
export function SectionLabel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`section-label ${className}`}>{children}</div>
}

/**
 * Status is stored semantically and resolved to a colour here, never baked
 * into the data — otherwise the Settings accent picker would silently recolour
 * unrelated dots (see data/types.ts).
 */
const dot = tv({
  // `block` is load-bearing: a bare <span> is display:inline, which ignores
  // width and height entirely. It only looked right inside flex parents.
  base: 'block flex-none rounded-full',
  variants: {
    size: {
      xs: 'size-1.25', // 5px — sidebar sessions
      sm: 'size-1.5', // 6px — groups, tabs, pane headers
      md: 'size-1.75', // 7px — table rows, drawer header
    },
    tone: {
      accent: 'bg-accent',
      warn: 'bg-warn',
      faint: 'bg-faint',
      prod: 'bg-prod',
      staging: 'bg-staging',
      dev: 'bg-dev',
      home: 'bg-home',
    },
  },
  defaultVariants: { size: 'md', tone: 'faint' },
})

type DotTone = 'accent' | 'warn' | 'faint' | GroupId

export function StatusDot({
  tone,
  size,
  className,
}: {
  tone: DotTone
  size?: 'xs' | 'sm' | 'md'
  className?: string
}) {
  return <span className={dot({ tone, size, className })} />
}

/**
 * A group's dot. Honours Settings › "Colour hosts by group": off renders every
 * group in `faint`, which is the prototype's `envColorMode: 'mono'`
 * (SSH Client.dc.html:763-765).
 */
export function GroupDot({
  group,
  size,
  className,
}: {
  group: GroupId
  size?: 'xs' | 'sm' | 'md'
  className?: string
}) {
  const coloured = useApp((s) => s.settings.colourHostsByGroup)
  return <StatusDot tone={coloured ? group : 'faint'} size={size} className={className} />
}

/** `label ————— value` — the drawer's meta list and every Settings row. */
export function MetaRow({
  label,
  children,
  className = '',
}: {
  label: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={`flex items-center justify-between gap-2.5 ${className}`}>
      <span className="text-faint">{label}</span>
      {children}
    </div>
  )
}

/** The `SSH` / `SFTP` badge on a session tab. */
export function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="flex-none rounded-badge bg-w08 px-1.25 py-0.25 text-badge tracking-badge text-fg-2">
      {children}
    </span>
  )
}

/** A `$ command` block: the drawer footer and the form's summary box. */
export function CommandText({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`selectable font-mono break-all ${className}`}>{children}</div>
  )
}
