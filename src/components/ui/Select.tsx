import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { Caret } from './Caret'
import { Labelled, fieldBox } from './Field'

/**
 * The one dropdown in the app.
 *
 * A native `<select>` hands its popup to the OS, which draws a light,
 * system-styled list — jarring against a dense dark tool, and impossible to
 * bring in line with the design tokens. This replaces it with a listbox we
 * draw ourselves.
 *
 * The panel is portalled to `document.body` and positioned `fixed` from the
 * trigger's rect: both places it is used sit inside `overflow-y-auto` columns,
 * which would otherwise clip it or scroll it away from its trigger.
 *
 * Two looks, matching the two places the handoff draws a dropdown:
 *   · `field`  — the form's boxed control (Group, Jump host)
 *   · `inline` — a Settings row's right-aligned mono value
 */

export interface SelectOption<T extends string = string> {
  value: T
  label: string
}

interface Props<T extends string> {
  options: SelectOption<T>[]
  value: T
  onChange: (value: T) => void
  variant?: 'field' | 'inline'
  /** Renders the field label above the control; `field` variant only. */
  label?: ReactNode
  'aria-label'?: string
  className?: string
  disabled?: boolean
}

/** Panel geometry — kept out of the design tokens because it is ours, not the handoff's. */
const GAP = 4
const MAX_PANEL_HEIGHT = 260


export function Select<T extends string>({
  options,
  value,
  onChange,
  variant = 'field',
  label,
  className = '',
  disabled,
  ...rest
}: Props<T>) {
  const id = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [style, setStyle] = useState<React.CSSProperties>({})

  const selected = options.find((o) => o.value === value)
  const longestLabel = options.reduce(
    (longest, o) => (o.label.length > longest.length ? o.label : longest),
    '',
  )

  const close = useCallback(() => {
    setOpen(false)
    triggerRef.current?.focus()
  }, [])

  const openPanel = () => {
    if (disabled) return
    const index = options.findIndex((o) => o.value === value)
    setActive(index === -1 ? 0 : index)
    setOpen(true)
  }

  const pick = (option: SelectOption<T>) => {
    onChange(option.value)
    close()
  }

  // Position against the trigger. Flips above when there is not enough room
  // below, so a control near the bottom of the window still opens fully.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const estimated = Math.min(options.length * 30 + 8, MAX_PANEL_HEIGHT)
    const flip = rect.bottom + GAP + estimated > window.innerHeight - 8

    setStyle({
      position: 'fixed',
      top: flip ? undefined : rect.bottom + GAP,
      bottom: flip ? window.innerHeight - rect.top + GAP : undefined,
      // `field` matches the trigger's width; `inline` hugs its content and
      // stays flush with the right edge it was aligned to.
      left: variant === 'field' ? rect.left : undefined,
      right: variant === 'field' ? undefined : window.innerWidth - rect.right,
      width: variant === 'field' ? rect.width : undefined,
      minWidth: variant === 'field' ? undefined : rect.width,
      maxHeight: MAX_PANEL_HEIGHT,
    })
  }, [open, options.length, variant])

  // Close on an outside press, and on scroll or resize — cheaper and steadier
  // than tracking the trigger, and a dropdown that outlives its anchor is worse
  // than one that closes.
  useEffect(() => {
    if (!open) return

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return
      setOpen(false)
    }
    const onDismiss = () => setOpen(false)

    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('resize', onDismiss)
    window.addEventListener('scroll', onDismiss, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('resize', onDismiss)
      window.removeEventListener('scroll', onDismiss, true)
    }
  }, [open])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return

    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        openPanel()
      }
      return
    }

    switch (e.key) {
      case 'Escape':
        e.preventDefault()
        // The drawer listens for Escape on window too; keep it to the dropdown.
        e.stopPropagation()
        close()
        break
      case 'ArrowDown':
        e.preventDefault()
        setActive((i) => Math.min(i + 1, options.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        setActive((i) => Math.max(i - 1, 0))
        break
      case 'Home':
        e.preventDefault()
        setActive(0)
        break
      case 'End':
        e.preventDefault()
        setActive(options.length - 1)
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        if (options[active]) pick(options[active])
        break
    }
  }

  const trigger = (
    <button
      ref={triggerRef}
      id={id}
      type="button"
      role="combobox"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-label={rest['aria-label']}
      disabled={disabled}
      onClick={() => (open ? setOpen(false) : openPanel())}
      onKeyDown={onKeyDown}
      className={
        variant === 'field'
          ? `${fieldBox} flex items-center gap-2 text-left text-fg-2 disabled:opacity-40 ${className}`
          : // Boxed like the Theme segmented control it shares a column with, so
            // a Settings row reads as something you can operate rather than a
            // value that happens to be printed there.
            `flex items-center gap-2 rounded-field border border-w08 bg-field px-2.5 py-1.25 font-mono text-cell text-muted transition-colors hover:border-w12 hover:text-fg-2 focus-visible:border-accent-27 disabled:opacity-40 ${className}`
      }
    >
      {variant === 'inline' ? (
        // Both labels share one grid cell, so the widest option sets the box's
        // width and it stays put when the value changes. The `field` variant
        // doesn't do this: its width comes from the form's grid column, and a
        // long host name would blow that out.
        <span className="grid min-w-0 flex-1">
          <span aria-hidden className="invisible col-start-1 row-start-1 truncate">
            {longestLabel}
          </span>
          <span className="col-start-1 row-start-1 truncate">{selected?.label ?? ''}</span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate text-body">{selected?.label ?? ''}</span>
      )}
      <Caret direction={open ? 'up' : 'down'} />
    </button>
  )

  const panel =
    open &&
    createPortal(
      <div
        ref={panelRef}
        role="listbox"
        aria-label={rest['aria-label']}
        style={style}
        className="z-60 overflow-y-auto rounded-field border border-w10 bg-drawer py-1 shadow-drawer"
      >
        {options.map((option, i) => {
          const isSelected = option.value === value
          return (
            <div
              key={option.value}
              role="option"
              aria-selected={isSelected}
              onPointerEnter={() => setActive(i)}
              onClick={() => pick(option)}
              className={`flex cursor-pointer items-center gap-2 px-2.5 py-1.5 ${
                variant === 'field' ? 'text-body' : 'font-mono text-cell'
              } ${i === active ? 'bg-w07 text-fg' : 'text-fg-2'}`}
            >
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              <span aria-hidden className={`flex-none ${isSelected ? 'text-accent' : 'opacity-0'}`}>
                ✓
              </span>
            </div>
          )
        })}
      </div>,
      document.body,
    )

  if (variant === 'inline' || !label) {
    return (
      <>
        {trigger}
        {panel}
      </>
    )
  }

  return (
    <Labelled label={label} htmlFor={id}>
      {trigger}
      {panel}
    </Labelled>
  )
}
