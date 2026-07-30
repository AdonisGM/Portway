import { useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { listSshKeys, message, type KeyFile } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { useAnchoredPanel } from '@/components/ui/useAnchoredPanel'

/**
 * "From SSH Keys" — picks a private key that is actually on this machine.
 *
 * It lists a real scan of `~/.ssh` (`keys.rs`), not the Keys screen's mock. The
 * path chosen here is handed to `load_secret_key` on connect, so offering the
 * mock's invented names would produce a host that cannot authenticate — the
 * failure arriving much later, at the first connection attempt.
 *
 * The panel is the one in `Select`: portalled, fixed, flipped when it would
 * overflow, dismissed on outside press and on scroll.
 */
interface Props {
  onPick: (path: string) => void
}

const ROW_HEIGHT = 34

export function KeyPicker({ onPick }: Props) {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [keys, setKeys] = useState<KeyFile[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const dismiss = useCallback(() => setOpen(false), [])
  const { panelRef, style } = useAnchoredPanel(open, anchorRef, {
    align: 'right',
    estimatedHeight: (keys?.length ?? 3) * ROW_HEIGHT + 8,
    onDismiss: dismiss,
  }, [keys?.length])

  // Re-read on every open: keys get generated and removed while the form is
  // sitting there, and a scan of one directory is too cheap to cache.
  const toggle = async () => {
    if (open) return setOpen(false)
    setOpen(true)
    setError(null)
    try {
      setKeys(await listSshKeys())
    } catch (e) {
      setError(message(e))
      setKeys([])
    }
  }

  const pick = (key: KeyFile) => {
    onPick(key.path)
    setOpen(false)
  }

  const panel =
    open &&
    createPortal(
      <div
        ref={panelRef}
        role="listbox"
        aria-label="Private keys in ~/.ssh"
        style={style}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        className="z-60 overflow-y-auto rounded-field border border-w10 bg-drawer py-1 shadow-drawer"
      >
        {keys === null ? (
          <div className="px-2.5 py-1.5 text-body text-muted">Reading ~/.ssh…</div>
        ) : error ? (
          <div className="px-2.5 py-1.5 text-body text-danger">{error}</div>
        ) : keys.length === 0 ? (
          // Says where it looked: the answer to "why is this empty" is almost
          // always that the keys live somewhere else, and Choose file… is right
          // there for that.
          <div className="px-2.5 py-1.5 text-body text-muted">No private keys in ~/.ssh</div>
        ) : (
          keys.map((key) => (
            <div
              key={key.path}
              role="option"
              aria-selected={false}
              onClick={() => pick(key)}
              className="flex cursor-pointer items-center gap-3 px-2.5 py-1.5 text-fg-2 hover:bg-w07 hover:text-fg"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-body">{key.name}</span>
              {key.kind ? (
                <span className="flex-none font-mono text-meta text-muted">{key.kind}</span>
              ) : null}
            </div>
          ))
        )}
      </div>,
      document.body,
    )

  return (
    <>
      <Button
        ref={anchorRef}
        size="md"
        className="flex-none py-2"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => void toggle()}
      >
        From SSH Keys
      </Button>
      {panel}
    </>
  )
}
