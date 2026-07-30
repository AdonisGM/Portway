import { useEffect, type ReactNode } from 'react'

/**
 * The Servers detail drawer — the handoff's key behaviour (README line 50).
 *
 * It is absolutely positioned *over* the table rather than beside it, so the
 * table's eight column widths never move when it opens or closes. Closed it
 * sits at translateX(106%); the extra 6% keeps the shadow off-screen too.
 *
 * Closes on the `×` in its header, on the scrim, and on Escape via a global
 * listener that is removed on unmount (README line 122).
 */
interface Props {
  open: boolean
  onClose: () => void
  children: ReactNode
  label?: string
}

export function Drawer({ open, onClose, children, label }: Props) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <>
      <div
        onClick={onClose}
        aria-hidden
        className={`absolute inset-0 bg-scrim transition-opacity duration-180 ease-out ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />
      <aside
        aria-label={label}
        aria-hidden={!open}
        // 106% rather than 100% so the drawer's shadow clears the edge too.
        style={{ transform: open ? 'translateX(0)' : 'translateX(106%)' }}
        className="absolute inset-y-0 right-0 flex w-drawer flex-col border-l border-w10 bg-drawer shadow-drawer transition-transform duration-220 ease-drawer"
      >
        {children}
      </aside>
    </>
  )
}
