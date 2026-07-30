import { useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPanel } from '@/components/ui/useAnchoredPanel'
import { SFTP_COLUMNS, type SftpColumnId } from './columns'

/**
 * The wrench on the SFTP pane's header: which columns the table shows.
 *
 * Same anchored panel as the rest of the app's popovers, so it clips and
 * dismisses like they do. Name has no checkbox — it is the table rather than a
 * column of it — and renders as a fixed row so the list still reads as the
 * whole set rather than looking like Name is missing.
 */
interface Props {
  visible: SftpColumnId[]
  onToggle: (id: SftpColumnId) => void
}

const ROW_HEIGHT = 30

export function ColumnPicker({ visible, onToggle }: Props) {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const dismiss = useCallback(() => setOpen(false), [])
  const { panelRef, style } = useAnchoredPanel(open, anchorRef, {
    align: 'right',
    estimatedHeight: SFTP_COLUMNS.length * ROW_HEIGHT + 8,
    onDismiss: dismiss,
  })

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-label="Choose columns"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex-none transition-colors ${open ? 'text-fg' : 'hover:text-fg'}`}
      >
        <Wrench />
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="menu"
            aria-label="Columns"
            style={style}
            onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
            className="z-60 overflow-y-auto rounded-field border border-w10 bg-drawer py-1 shadow-drawer"
          >
            {SFTP_COLUMNS.map((column) => {
              const on = visible.includes(column.id)
              return (
                <button
                  key={column.id}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={on}
                  disabled={column.fixed}
                  onClick={() => onToggle(column.id)}
                  className={`flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left text-body transition-colors ${
                    column.fixed
                      ? 'cursor-default text-faint'
                      : 'text-fg-2 hover:bg-w07 hover:text-fg'
                  }`}
                >
                  <span className={`flex-none ${on ? 'text-accent' : 'opacity-0'}`} aria-hidden>
                    ✓
                  </span>
                  {column.label}
                  {column.fixed ? <span className="ml-auto text-meta">always</span> : null}
                </button>
              )
            })}
          </div>,
          document.body,
        )}
    </>
  )
}

/** Drawn to match the nav icons: 16 viewBox, 1.3 stroke, currentColor. */
function Wrench() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10.4 2.2a3.7 3.7 0 0 0-3.2 5.5L2.4 12.5a1.2 1.2 0 0 0 1.7 1.7l4.8-4.8a3.7 3.7 0 0 0 4.7-4.8l-2 2-1.9-.5-.5-1.9 2-2a3.7 3.7 0 0 0-.8-.1Z" />
    </svg>
  )
}
