import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'

/**
 * What the SFTP pane's transfer footer is currently showing.
 *
 * Progress arrives as events rather than being polled, because the upload is a
 * single `invoke` that does not return until it is finished — there is nothing
 * to ask. The backend throttles them; this only has to hold the latest.
 */
export interface Transfer {
  /** The file on the wire right now. */
  name: string
  bytes: number
  total: number
  /** Bytes per second, already smoothed. */
  rate: number
  filesDone: number
  /** 1 for a single file, which is how the footer knows to draw one bar. */
  filesTotal: number
}

/**
 * `active` is the pane telling us a transfer is in flight. The last event of
 * one upload would otherwise stay on screen until the next, and a finished
 * transfer that keeps showing `98%` is worse than no footer at all.
 */
export function useTransfer(sessionId: string, active: boolean): Transfer | null {
  const [transfer, setTransfer] = useState<Transfer | null>(null)

  useEffect(() => {
    const pending = listen<Transfer & { sessionId: string }>('sftp://progress', (event) => {
      if (event.payload.sessionId !== sessionId) return
      setTransfer(event.payload)
    })
    return () => {
      void pending.then((un) => un())
    }
  }, [sessionId])

  useEffect(() => {
    if (!active) setTransfer(null)
  }, [active])

  return active ? transfer : null
}
