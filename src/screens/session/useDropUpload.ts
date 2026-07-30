import { useEffect, useRef, useState } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { message, sftpUploadPath } from '@/lib/api'

/**
 * Files and folders dropped from the OS, uploaded into the folder the pane is
 * showing.
 *
 * This cannot be an HTML5 `drop` handler. A webview hands JavaScript a `File`
 * with its path withheld — the same wall the key field's "Choose file…" ran
 * into — so the OS drop arrives as a Tauri webview event carrying real paths
 * instead. That event is window-wide, which is why the pane's own rectangle is
 * checked here: a drop on the terminal side must not upload anything.
 *
 * Positions come in physical pixels and the rectangle is in CSS pixels, hence
 * the `devicePixelRatio` division — on this display they differ by two, so
 * skipping it would make the pane appear to start halfway across the window.
 */
export type DropState = 'idle' | 'over' | 'uploading'

interface Options {
  sessionId: string
  /** Where to put what lands. Null while the session is not usable. */
  remoteDir: string | null
  /** The pane, for hit-testing the drop against. */
  paneRef: React.RefObject<HTMLElement | null>
  /** Refresh the listing once something has landed. */
  onUploaded: () => void
}

export function useDropUpload({ sessionId, remoteDir, paneRef, onUploaded }: Options) {
  const [state, setState] = useState<DropState>('idle')
  const [error, setError] = useState<string | null>(null)
  // The listener is registered once, but reads live values on every event.
  const latest = useRef({ sessionId, remoteDir, onUploaded })
  latest.current = { sessionId, remoteDir, onUploaded }

  useEffect(() => {
    let unlisten: (() => void) | undefined
    let alive = true

    const inPane = (position: { x: number; y: number }) => {
      const box = paneRef.current?.getBoundingClientRect()
      if (!box) return false
      const scale = window.devicePixelRatio || 1
      const x = position.x / scale
      const y = position.y / scale
      return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom
    }

    void getCurrentWebview()
      .onDragDropEvent(async (event) => {
        const payload = event.payload
        if (payload.type === 'leave') return setState('idle')
        if (payload.type === 'enter' || payload.type === 'over') {
          return setState(inPane(payload.position) ? 'over' : 'idle')
        }
        if (payload.type !== 'drop') return

        setState('idle')
        const { sessionId: id, remoteDir: dir, onUploaded: refresh } = latest.current
        if (!dir || !inPane(payload.position)) return

        setState('uploading')
        setError(null)
        try {
          // Sequentially: they share one SFTP channel, and a progress line that
          // counts up in order is more use than several interleaved ones.
          for (const path of payload.paths) {
            await sftpUploadPath(id, path, dir)
          }
          refresh()
        } catch (e) {
          setError(message(e))
        } finally {
          setState('idle')
        }
      })
      .then((un) => {
        if (alive) unlisten = un
        else un()
      })

    return () => {
      alive = false
      unlisten?.()
    }
  }, [paneRef])

  return { state, error, clearError: () => setError(null) }
}
