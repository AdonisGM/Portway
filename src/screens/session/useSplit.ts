import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * The draggable divider between the terminal and the SFTP pane.
 *
 * The handoff fixes the SFTP pane at 470px and then asks for exactly this:
 * "Make this divider draggable in production; remember the split." So 470 is
 * the starting width, not the width.
 *
 * Both sides have a floor, because a split pane that can be dragged to nothing
 * is a way to lose a pane by accident — and neither of these panes degrades
 * gracefully. The terminal's floor is a column count: below about 40 columns a
 * shell's own output starts wrapping, and the PTY is told the real size, so the
 * damage is on the remote side and outlives the drag. The SFTP floor is its
 * three-column table, which collapses into ellipsis before it collapses to
 * nothing.
 */

/** ~40 columns of 13px mono, plus the pane's own 28px of horizontal padding. */
const MIN_TERMINAL = 340

/** The file table's `1.7fr 78px 100px` stops being readable below this. */
const MIN_SFTP = 320

const STORAGE_KEY = 'portway.sftpWidth'

/**
 * The handoff's 470px, read from the token rather than repeated here — it is a
 * design value, and theme.css stays the one place those live. Only the starting
 * width: once the user drags, their choice is what is remembered.
 */
function designWidth(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--spacing-sftp')
  return Number.parseFloat(raw) || 470
}

const clamp = (width: number, total: number) => {
  // A window narrow enough that both floors cannot hold gives the remainder to
  // the terminal: it is the pane you cannot work without.
  const max = Math.max(MIN_SFTP, total - MIN_TERMINAL)
  return Math.min(Math.max(width, MIN_SFTP), max)
}

function stored(): number {
  const raw = Number(localStorage.getItem(STORAGE_KEY))
  return Number.isFinite(raw) && raw > 0 ? raw : designWidth()
}

export function useSplit(containerRef: React.RefObject<HTMLDivElement | null>) {
  const [width, setWidth] = useState(stored)
  const [dragging, setDragging] = useState(false)
  // The width the user chose, before this window's size had a say. Re-clamping
  // the stored value on every resize would let a narrow window permanently
  // shrink a split the user set wide.
  const wanted = useRef(width)

  const fit = useCallback(() => {
    const total = containerRef.current?.getBoundingClientRect().width
    if (!total) return
    setWidth(clamp(wanted.current, total))
  }, [containerRef])

  useEffect(() => {
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [fit])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // preventDefault stops the drag from painting a text selection across both
    // panes — and, less obviously, stops the browser focusing the handle, which
    // is the whole keyboard path. So focus is taken explicitly.
    e.preventDefault()
    e.currentTarget.focus()
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    const box = containerRef.current?.getBoundingClientRect()
    if (!box) return
    // Measured from the right edge, because the handle sits on the SFTP pane's
    // left border and that is the edge being dragged.
    const next = clamp(box.right - e.clientX, box.width)
    wanted.current = next
    setWidth(next)
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    setDragging(false)
    localStorage.setItem(STORAGE_KEY, String(wanted.current))
  }

  /** Keyboard: the divider is focusable, so the split is reachable without a mouse. */
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 50 : 10
    const total = containerRef.current?.getBoundingClientRect().width
    if (!total) return
    let next: number | null = null
    if (e.key === 'ArrowLeft') next = clamp(width + step, total)
    if (e.key === 'ArrowRight') next = clamp(width - step, total)
    if (next === null) return
    e.preventDefault()
    wanted.current = next
    setWidth(next)
    localStorage.setItem(STORAGE_KEY, String(next))
  }

  return { width, dragging, onPointerDown, onPointerMove, onPointerUp, onKeyDown }
}
