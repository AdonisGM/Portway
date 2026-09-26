import { isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { useToast } from '../components/toast'
import { api, isAppError, type Edit, type EditorApp } from '../lib/api'

type Edits = {
  list: Edit[]
  apps: EditorApp[]
  /** Download a server file and open it in an app; saving there uploads it. */
  open: (serverId: string, user: string, path: string, app?: string | null) => Promise<void>
  stop: (id: string) => void
  resolve: (id: string, overwrite: boolean) => Promise<void>
  reopen: (id: string, app?: string | null) => void
}

const EditsContext = createContext<Edits | null>(null)

function editError(e: unknown): string {
  if (!isAppError(e)) return String(e)
  switch (e.code) {
    case 'permission_denied':
      return `Không có quyền đọc ${e.detail ?? 'tệp này'}. Bật sudo cho phiên này để sửa tệp của root.`
    case 'too_big':
      return 'Tệp lớn hơn 20 MB, không mở để sửa.'
    case 'not_a_file':
      return 'Chỉ sửa được tệp, không phải thư mục.'
    case 'not_connected':
      return 'Phiên SSH chưa kết nối.'
    default:
      return e.detail ?? e.code
  }
}

/** Files open in an app on this Mac, mirrored from the Rust side (`edit` events). */
export function EditsProvider({ children }: { children: ReactNode }) {
  const toast = useToast()
  const [list, setList] = useState<Edit[]>([])
  const [apps, setApps] = useState<EditorApp[]>([])

  useEffect(() => {
    void api.edits().then(setList)
    void api.editorApps().then(setApps)
    if (!isTauri()) return
    const offs = [
      listen<Edit>('edit', (e) => setList((l) => (l.some((x) => x.id === e.payload.id) ? l.map((x) => (x.id === e.payload.id ? e.payload : x)) : [...l, e.payload]))),
      listen<string>('editClosed', (e) => setList((l) => l.filter((x) => x.id !== e.payload))),
    ]
    return () => offs.forEach((o) => void o.then((f) => f()))
  }, [])

  const open = useCallback(
    async (serverId: string, user: string, path: string, app?: string | null) => {
      try {
        await api.editOpen(serverId, user, path, app)
      } catch (e) {
        toast({ title: 'Không mở được để sửa', detail: editError(e) })
      }
    },
    [toast],
  )

  return (
    <EditsContext.Provider
      value={{
        list,
        apps,
        open,
        stop: (id) => {
          setList((l) => l.filter((x) => x.id !== id))
          void api.editStop(id)
        },
        resolve: (id, overwrite) => api.editResolve(id, overwrite).catch((e) => toast({ title: 'Không làm được', detail: editError(e) })),
        reopen: (id, app) => void api.editReopen(id, app).catch((e) => toast({ title: 'Không mở lại được', detail: editError(e) })),
      }}
    >
      {children}
    </EditsContext.Provider>
  )
}

export function useEdits() {
  const ctx = useContext(EditsContext)
  if (!ctx) throw new Error('useEdits must be used inside <EditsProvider>')
  return ctx
}
