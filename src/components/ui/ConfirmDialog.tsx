import { useEffect, useRef, type ReactNode } from 'react'
import { Button } from './Button'

/**
 * NOT IN THE HANDOFF. The design deliberately leaves delete confirmation
 * undesigned (README line 126); this was designed on request, so it borrows
 * entirely from patterns the handoff already establishes rather than
 * introducing new ones:
 *
 *   · the drawer's surface — `bg-drawer`, a `w10` hairline, `shadow-drawer`
 *   · the drawer's scrim at the same 35% black
 *   · the screen-title type scale for the heading
 *   · the existing button variants for the two actions
 *
 * Escape cancels and the scrim is clickable, matching how the drawer closes.
 * Focus lands on Cancel so a stray Enter is never destructive.
 */
interface Props {
  open: boolean
  title: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  children: ReactNode
  busy?: boolean
}

export function ConfirmDialog({
  open,
  title,
  confirmLabel,
  onConfirm,
  onCancel,
  children,
  busy,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Capture phase + stopImmediatePropagation so Escape dismisses only this
      // dialog. The drawer underneath listens for Escape on `window` too, and
      // would otherwise close behind the modal.
      e.stopImmediatePropagation()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    cancelRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onCancel])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-scrim" onClick={onCancel} aria-hidden />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-dialog rounded-field border border-w10 bg-drawer p-4.5 shadow-drawer"
      >
        <h2 className="text-title font-semibold">{title}</h2>
        <div className="mt-2 text-body/cmd text-fg-2">{children}</div>

        <div className="mt-4.5 flex justify-end gap-2">
          <Button ref={cancelRef} size="md" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="dangerSolid" size="md" onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
