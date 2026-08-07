import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * A menu anchored to a point rather than an element.
 *
 * `useAnchoredPanel` positions against a ref's rectangle, which every other
 * popover in the app has; a context menu has only the cursor, so it gets its
 * own small version. The dismissal rules are the same ones — outside press,
 * scroll, resize, Escape — because a menu that outlives what it was opened on
 * is worse than one that closes early.
 *
 * Flipped rather than clamped when it would overflow: a menu that has slid up
 * to fit still points at the thing it belongs to, one that has been squashed
 * against the edge does not.
 */
export interface MenuPoint {
  x: number
  y: number
}

interface Props {
  at: MenuPoint | null
  onClose: () => void
  children: ReactNode
  /** Rough height, to decide whether to flip before it has been measured. */
  estimatedHeight?: number
}

const GAP = 2
const WIDTH = 190

export function ContextMenu({ at, onClose, children, estimatedHeight = 200 }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<React.CSSProperties>({})

  useEffect(() => {
    if (!at) return
    const flipUp = at.y + GAP + estimatedHeight > window.innerHeight - 8
    const flipLeft = at.x + WIDTH > window.innerWidth - 8
    setStyle({
      position: 'fixed',
      top: flipUp ? undefined : at.y + GAP,
      bottom: flipUp ? window.innerHeight - at.y + GAP : undefined,
      left: flipLeft ? undefined : at.x + GAP,
      right: flipLeft ? window.innerWidth - at.x + GAP : undefined,
      width: WIDTH,
    })
  }, [at, estimatedHeight])

  useEffect(() => {
    if (!at) return
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onClose)
    window.addEventListener('scroll', onClose, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [at, onClose])

  if (!at) return null

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={style}
      className="z-60 overflow-hidden rounded-field border border-w10 bg-drawer py-1 shadow-drawer"
    >
      {children}
    </div>,
    document.body,
  )
}

interface ItemProps {
  onClick: () => void
  children: ReactNode
  /** Destructive actions read in the danger colour, as they do in the drawer. */
  danger?: boolean
  /** Runs on the server as root: warn colour, and a marker at the end of the row. */
  root?: boolean
  disabled?: boolean
}

export function MenuItem({ onClick, children, danger, root, disabled }: ItemProps) {
  // Three tones, and `root` is not `danger`. Red in this app means "this cannot
  // be undone"; running as root is not that — it is ordinary work with the
  // safety rail removed. It needs to be impossible to hit by accident while
  // reaching for the item above it, which is what the colour and the marker
  // are for, but it must not borrow the weight that Delete has earned.
  const tone = danger
    ? 'text-danger hover:bg-danger-fill'
    : root
      ? 'text-warn hover:bg-w07'
      : 'text-fg-2 hover:bg-w07 hover:text-fg'

  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-body transition-colors disabled:opacity-40 ${tone}`}
    >
      {children}
      {/* Sits at the end of the row rather than in the label, so the eye finds
          every root item in one pass down the menu instead of reading each. */}
      {root ? (
        <span className="ml-auto rounded-chip bg-w07 px-1.25 py-0.25 font-mono text-status uppercase">
          root
        </span>
      ) : null}
    </button>
  )
}

export function MenuSeparator() {
  return <div className="my-1 h-px bg-w06" role="separator" />
}

/**
 * A row that opens a menu of its own beside it.
 *
 * Here so that a group of related actions can be one line in the parent rather
 * than six. A context menu that runs past a dozen entries stops being scanned
 * and starts being hunted through, and the entry somebody wants is found by
 * position — which is exactly how the wrong one gets clicked.
 *
 * It also puts a step in front of whatever is inside it, and for the root
 * actions that is the point rather than a side effect: they cannot be reached
 * by a pointer sliding down the parent.
 *
 * Rendered through a portal because the parent menu clips its own corners with
 * `overflow-hidden`, which would take the child with them.
 */
export function MenuSub({
  label,
  root,
  children,
  estimatedHeight = 200,
}: {
  label: ReactNode
  /** Same tone and marker as a root item — the group is what it contains. */
  root?: boolean
  children: ReactNode
  estimatedHeight?: number
}) {
  const [open, setOpen] = useState(false)
  const [style, setStyle] = useState<React.CSSProperties>({})
  const trigger = useRef<HTMLButtonElement>(null)
  const closing = useRef<number | undefined>(undefined)

  const show = () => {
    window.clearTimeout(closing.current)
    const box = trigger.current?.getBoundingClientRect()
    if (!box) return
    // To the right, and to the left where that would leave the screen. Same
    // rule the parent uses: flipped still points at what opened it.
    const flipLeft = box.right + WIDTH > window.innerWidth - 8
    setStyle({
      position: 'fixed',
      // Aligned with the row, then lifted if the panel would run off the
      // bottom — a submenu whose last item is off-screen is a submenu with a
      // hidden action in it.
      top: Math.max(8, Math.min(box.top - 4, window.innerHeight - 8 - estimatedHeight)),
      left: flipLeft ? undefined : box.right + GAP,
      right: flipLeft ? window.innerWidth - box.left + GAP : undefined,
      width: WIDTH,
    })
    setOpen(true)
  }

  const hide = () => {
    window.clearTimeout(closing.current)
    // Not immediately: the diagonal from this label to the first item of the
    // panel crosses the gap between the two, and closing there makes the
    // submenu unreachable by the movement everybody uses to reach it.
    closing.current = window.setTimeout(() => setOpen(false), 140)
  }

  useEffect(() => () => window.clearTimeout(closing.current), [])

  const tone = root
    ? 'text-warn hover:bg-w07'
    : 'text-fg-2 hover:bg-w07 hover:text-fg'

  return (
    <>
      <button
        ref={trigger}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        onPointerEnter={show}
        onPointerLeave={hide}
        // Opens, never toggles. The pointer has already entered the row by the
        // time it can be clicked, so the panel is open and a toggle would read
        // as the click having closed it — which is what it did.
        onClick={show}
        className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-body transition-colors ${tone} ${
          open ? 'bg-w07' : ''
        }`}
      >
        {label}
        <span className="ml-auto flex items-center gap-1.5">
          {root ? (
            <span className="rounded-chip bg-w07 px-1.25 py-0.25 font-mono text-status uppercase">
              root
            </span>
          ) : null}
          <span aria-hidden>›</span>
        </span>
      </button>

      {open
        ? createPortal(
            <div
              role="menu"
              style={style}
              onPointerEnter={() => window.clearTimeout(closing.current)}
              onPointerLeave={hide}
              className="z-70 overflow-hidden rounded-field border border-w10 bg-drawer py-1 shadow-drawer"
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
