import { useCallback, useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { open as pickFile } from '@tauri-apps/plugin-dialog'
import { LARGE_FILE, message, sftpEdit, type RemoteFile } from '@/lib/api'
import { isMac } from '@/lib/platform'

/**
 * Files this session has open in a local application.
 *
 * Editing happens in whatever the user already uses — their editor, their
 * keybindings, their language support — rather than in an editor bundled into
 * this app, which would be several megabytes of someone else's preferences. The
 * price is that a save has to be *noticed*: the backend polls the scratch copy
 * and uploads it, and tells us here so the pane can say so. Without that line,
 * a write-back is invisible and the user has no reason to believe it happened.
 */
export interface EditState {
  /** Remote paths currently open, in the order they were opened. */
  open: string[]
  /** Last write-back, briefly, so a save is acknowledged. */
  saved: { remote: string; bytes: number } | null
  error: string | null
}

export function useEditing(sessionId: string, onSaved: () => void) {
  const [state, setState] = useState<EditState>({ open: [], saved: null, error: null })
  const timer = useRef<number | undefined>(undefined)
  const refresh = useRef(onSaved)
  refresh.current = onSaved

  useEffect(() => {
    const unsubs: Array<Promise<() => void>> = [
      listen<{ sessionId: string; remote: string; bytes: number }>('sftp://saved', (e) => {
        if (e.payload.sessionId !== sessionId) return
        setState((s) => ({ ...s, saved: { remote: e.payload.remote, bytes: e.payload.bytes } }))
        refresh.current()
        // The acknowledgement is transient on purpose — it reports an event,
        // not a state, and a permanent "saved" would go stale the moment the
        // next edit happens.
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(
          () => setState((s) => ({ ...s, saved: null })),
          3000,
        )
      }),
      listen<{ sessionId: string; remote: string; error: string }>(
        'sftp://save-failed',
        (e) => {
          if (e.payload.sessionId !== sessionId) return
          setState((s) => ({ ...s, error: `${e.payload.remote}: ${e.payload.error}` }))
        },
      ),
    ]
    return () => {
      window.clearTimeout(timer.current)
      unsubs.forEach((p) => void p.then((un) => un()))
    }
  }, [sessionId])

  /**
   * `choose` shows the OS file picker so the user can send the file to
   * something other than the registered default. Where applications live and
   * what one *is* differ per platform: a macOS app is a `.app` bundle under
   * /Applications, a Windows one is an `.exe` under Program Files. Pointing the
   * panel at a directory that does not exist is worse than not pointing it
   * anywhere, so this only sets a default where it knows one.
   */
  const edit = useCallback(
    async (file: RemoteFile, remote: string, choose: boolean) => {
      try {
        let opener: string | null = null
        if (choose) {
          const picked = await pickFile({
            multiple: false,
            directory: false,
            ...(isMac
              ? { defaultPath: '/Applications', filters: [{ name: 'Applications', extensions: ['app'] }] }
              : { filters: [{ name: 'Programs', extensions: ['exe', 'bat', 'cmd'] }] }),
            title: `Open ${file.name} with…`,
          })
          if (typeof picked !== 'string') return // dismissed
          opener = picked
        }
        await sftpEdit(sessionId, remote, opener, (file.size ?? 0) > LARGE_FILE)
        setState((s) =>
          s.open.includes(remote) ? s : { ...s, open: [...s.open, remote], error: null },
        )
      } catch (e) {
        setState((s) => ({ ...s, error: message(e) }))
      }
    },
    [sessionId],
  )

  return {
    ...state,
    edit,
    clearError: () => setState((s) => ({ ...s, error: null })),
  }
}
