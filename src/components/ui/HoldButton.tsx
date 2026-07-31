import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * A confirm button that has to be held down.
 *
 * Used for the destructive half of a confirm dialog. A dialog already asks
 * once, but a dialog is answered by a click in the same place the previous
 * click landed — the muscle memory that dismisses a dialog is the same motion
 * that confirms it. Holding cannot be done by accident, and it gives back the
 * one thing a modal takes away: the chance to change your mind *during* the
 * gesture rather than only before it.
 *
 * The fill sweeps left to right and brightens as it goes, so the button reads
 * as filling up rather than merely animating. Letting go early rewinds it —
 * quickly, because a rewind that takes as long as the fill feels like a
 * punishment for hesitating.
 */
const HOLD_MS = 900
const REWIND_MS = 180

interface Props {
  onConfirm: () => void
  children: ReactNode
  disabled?: boolean
  className?: string
  /** Announced to screen readers, which cannot see the fill. */
  label?: string
}

export function HoldButton({ onConfirm, children, disabled, className = '', label }: Props) {
  const [progress, setProgress] = useState(0)
  const [holding, setHolding] = useState(false)
  const frame = useRef<number | undefined>(undefined)
  const startedAt = useRef(0)
  // Guards the case where the pointer is released in the same frame the hold
  // completes: without it both the rewind and the confirm would run.
  const done = useRef(false)

  const stop = useCallback(() => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current)
    frame.current = undefined
  }, [])

  const start = useCallback(() => {
    if (disabled || done.current) return
    setHolding(true)
    startedAt.current = performance.now()

    const tick = (now: number) => {
      const next = Math.min((now - startedAt.current) / HOLD_MS, 1)
      setProgress(next)
      if (next < 1) {
        frame.current = requestAnimationFrame(tick)
        return
      }
      done.current = true
      setHolding(false)
      onConfirm()
    }
    frame.current = requestAnimationFrame(tick)
  }, [disabled, onConfirm])

  const cancel = useCallback(() => {
    if (done.current) return
    stop()
    setHolding(false)
    setProgress(0)
  }, [stop])

  useEffect(() => stop, [stop])

  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={label}
      // Space and Enter repeat while held, which is exactly the gesture — so
      // the keyboard gets the same control rather than a different one.
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault()
          if (!holding) start()
        }
      }}
      onKeyUp={cancel}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        start()
      }}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      // Dragging off the button is a way to back out, the same as it is for an
      // ordinary click.
      onPointerLeave={cancel}
      className={`relative overflow-hidden rounded-field bg-danger px-4 py-1.75 text-center text-cell font-medium text-ink select-none disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
    >
      {/* The curtain. `scaleX` from the left edge rather than a width change,
          so it is composited rather than laid out on every frame. */}
      <span
        aria-hidden
        style={{
          transform: `scaleX(${progress})`,
          // No transition while held — the rAF loop is already per-frame, and a
          // transition on top of it would lag the pointer. Only the rewind
          // animates.
          transitionDuration: holding ? '0ms' : `${REWIND_MS}ms`,
        }}
        className="absolute inset-0 origin-left bg-danger-bright transition-transform ease-out"
      />
      <span className="relative">{children}</span>
    </button>
  )
}
