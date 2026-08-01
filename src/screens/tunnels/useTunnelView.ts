import { useCallback, useState } from 'react'

/**
 * Map or list, remembered.
 *
 * Which one you want is a working preference rather than a per-visit choice —
 * somebody who reads the table is not persuaded by the diagram once a session —
 * so it is kept the same way the SFTP column set is, in `localStorage` under a
 * `portway.` key. Same reasoning, same shape as `useSftpColumns`.
 */
export type TunnelView = 'map' | 'list'

const STORAGE_KEY = 'portway.tunnelView'

function stored(): TunnelView {
  return localStorage.getItem(STORAGE_KEY) === 'list' ? 'list' : 'map'
}

export function useTunnelView(): [TunnelView, (next: TunnelView) => void] {
  const [view, setView] = useState<TunnelView>(stored)

  const choose = useCallback((next: TunnelView) => {
    localStorage.setItem(STORAGE_KEY, next)
    setView(next)
  }, [])

  return [view, choose]
}
