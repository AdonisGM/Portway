import { useState } from 'react'
import { message } from '@/lib/api'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useApp } from '@/store/appStore'

/** Wires the drawer's `Del` chip to the delete command. */
export function DeleteHostDialog() {
  const pending = useApp((s) => s.pendingDelete)
  const cancelDelete = useApp((s) => s.cancelDelete)
  const deleteHost = useApp((s) => s.deleteHost)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const confirm = async () => {
    if (!pending) return
    setBusy(true)
    setError(null)
    try {
      await deleteHost(pending.id)
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ConfirmDialog
      open={pending !== null}
      title="Delete server"
      confirmLabel={busy ? 'Deleting…' : 'Delete'}
      onConfirm={() => void confirm()}
      onCancel={() => {
        setError(null)
        cancelDelete()
      }}
      busy={busy}
    >
      <span className="font-mono text-fg">{pending?.name}</span> will be removed from Portway.
      The server itself is not touched, and any open session for it closes.
      {error ? <div className="mt-2 font-mono text-mono text-warn">! {error}</div> : null}
    </ConfirmDialog>
  )
}
