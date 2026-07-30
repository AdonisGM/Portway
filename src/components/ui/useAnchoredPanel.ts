import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'

/**
 * Positions a floating panel against an anchor element.
 *
 * Shared by `Select` and `QueryInput`, and written to be the one place that
 * knows how a popover behaves in this app: portalled to `document.body` and
 * positioned `fixed`, because every place we use one sits inside an
 * `overflow-y-auto` column that would otherwise clip it; flipped above the
 * anchor when there is no room below; dismissed on an outside press, on scroll
 * and on resize, since a panel that outlives its anchor is worse than one that
 * closes.
 */
interface Options {
  /** `stretch` matches the anchor's width, `left`/`right` hug the content. */
  align?: 'stretch' | 'left' | 'right'
  maxHeight?: number
  /** Approximate content height, used to decide whether to flip. */
  estimatedHeight?: number
  onDismiss: () => void
}

const GAP = 4

export function useAnchoredPanel<T extends HTMLElement>(
  open: boolean,
  anchorRef: RefObject<T | null>,
  { align = 'stretch', maxHeight = 260, estimatedHeight = maxHeight, onDismiss }: Options,
  deps: unknown[] = [],
) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<CSSProperties>({})

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return
    const rect = anchorRef.current.getBoundingClientRect()
    const height = Math.min(estimatedHeight, maxHeight)
    const flip = rect.bottom + GAP + height > window.innerHeight - 8

    setStyle({
      position: 'fixed',
      top: flip ? undefined : rect.bottom + GAP,
      bottom: flip ? window.innerHeight - rect.top + GAP : undefined,
      left: align === 'right' ? undefined : rect.left,
      right: align === 'right' ? window.innerWidth - rect.right : undefined,
      width: align === 'stretch' ? rect.width : undefined,
      minWidth: align === 'stretch' ? undefined : rect.width,
      maxHeight,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, align, maxHeight, estimatedHeight, ...deps])

  useEffect(() => {
    if (!open) return

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (anchorRef.current?.contains(target) || panelRef.current?.contains(target)) return
      onDismiss()
    }
    const dismiss = () => onDismiss()

    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [open, anchorRef, onDismiss])

  return { panelRef, style }
}
