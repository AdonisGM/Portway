import { listen } from '@tauri-apps/api/event'
import { isTauri } from '@tauri-apps/api/core'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, type Transfer } from '../lib/api'

type Transfers = {
  list: Transfer[]
  cancel: (id: string) => void
  retry: (id: string) => void
  clearDone: () => void
}

const TransfersContext = createContext<Transfers | null>(null)

/** Upload/download queue, mirrored from the Rust side through `transfer` events. */
export function TransfersProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Transfer[]>([])

  useEffect(() => {
    void api.transfers().then(setList)
    if (!isTauri()) return
    const off = listen<Transfer>('transfer', (e) => {
      setList((l) => (l.some((t) => t.id === e.payload.id) ? l.map((t) => (t.id === e.payload.id ? e.payload : t)) : [...l, e.payload]))
    })
    return () => {
      void off.then((f) => f())
    }
  }, [])

  return (
    <TransfersContext.Provider
      value={{
        list,
        cancel: (id) => void api.cancelTransfer(id),
        retry: (id) => void api.retryTransfer(id),
        clearDone: () => void api.clearTransfers().then(setList),
      }}
    >
      {children}
    </TransfersContext.Provider>
  )
}

export function useTransfers() {
  const ctx = useContext(TransfersContext)
  if (!ctx) throw new Error('useTransfers must be used inside <TransfersProvider>')
  return ctx
}
