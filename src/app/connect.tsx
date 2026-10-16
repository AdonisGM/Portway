import { isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, type ConnectView } from '../lib/api'

const EMPTY: ConnectView = { enabled: false, device: null, error: null, selfSeen: false, nearby: [], peers: [], pairing: null, link: null, linkError: null, wake: null }

const ConnectContext = createContext<ConnectView | null>(null)

/** Portway Connect's state as the Rust side last reported it: one `connect`
 *  event after every change, so any screen (and the pairing dialog, which
 *  must show up wherever the user is) reads the same picture. */
export function ConnectProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<ConnectView>(EMPTY)

  useEffect(() => {
    void api.connectState().then(setView)
    if (!isTauri()) return
    const off = listen<ConnectView>('connect', (e) => setView(e.payload))
    return () => {
      void off.then((f) => f())
    }
  }, [])

  return <ConnectContext.Provider value={view}>{children}</ConnectContext.Provider>
}

export function useConnect() {
  const ctx = useContext(ConnectContext)
  if (!ctx) throw new Error('useConnect must be used inside <ConnectProvider>')
  return ctx
}
