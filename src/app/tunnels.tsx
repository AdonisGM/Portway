import { isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, type Tunnel, type TunnelSpec } from '../lib/api'

type Tunnels = {
  list: Tunnel[]
  running: number
  save: (spec: TunnelSpec) => Promise<Tunnel>
  remove: (id: string) => Promise<void>
  start: (id: string) => Promise<void>
  stop: (id: string) => Promise<void>
  /** Open the "Tunnel mới" dialog prefilled, from anywhere (Firewall, Docker). */
  draft: Partial<TunnelSpec> | null
  setDraft: (d: Partial<TunnelSpec> | null) => void
}

const TunnelsContext = createContext<Tunnels | null>(null)

/** Saved tunnels and their live state, mirrored from the Rust side. */
export function TunnelsProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Tunnel[]>([])
  const [draft, setDraft] = useState<Partial<TunnelSpec> | null>(null)

  useEffect(() => {
    void api.tunnels().then(setList)
    if (!isTauri()) return
    const off = listen<Tunnel>('tunnel', (e) => {
      setList((l) => (l.some((t) => t.id === e.payload.id) ? l.map((t) => (t.id === e.payload.id ? e.payload : t)) : l))
    })
    return () => {
      void off.then((f) => f())
    }
  }, [])

  const save = useCallback(async (spec: TunnelSpec) => {
    const saved = await api.saveTunnel(spec)
    setList((l) => (l.some((t) => t.id === saved.id) ? l.map((t) => (t.id === saved.id ? saved : t)) : [...l, saved]))
    return saved
  }, [])

  const remove = useCallback(async (id: string) => {
    await api.deleteTunnel(id)
    setList((l) => l.filter((t) => t.id !== id))
  }, [])

  const running = list.filter((t) => t.run.state === 'running').length

  return (
    <TunnelsContext.Provider value={{ list, running, save, remove, start: api.startTunnel, stop: api.stopTunnel, draft, setDraft }}>
      {children}
    </TunnelsContext.Provider>
  )
}

export function useTunnels() {
  const ctx = useContext(TunnelsContext)
  if (!ctx) throw new Error('useTunnels must be used inside <TunnelsProvider>')
  return ctx
}
