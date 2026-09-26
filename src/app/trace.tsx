import { isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, type TraceEntry } from '../lib/api'

const KEEP = 2000

export type TraceFilter = { status: 'all' | 'running' | 'error' | 'slow'; session: string | null }

/** Slower than this counts as slow in the filter. */
export const SLOW_MS = 2000

type Trace = {
  /** Oldest first. */
  list: TraceEntry[]
  running: number
  filter: TraceFilter
  setFilter: (f: TraceFilter) => void
  clear: () => void
}

const TraceContext = createContext<Trace | null>(null)

/** The debug trace from the Rust side, kept in sync through `trace` events.
 *  Mounted at the top so the rail can show what is running on any screen. */
export function TraceProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<TraceEntry[]>([])
  const [filter, setFilter] = useState<TraceFilter>({ status: 'all', session: null })

  useEffect(() => {
    void api.traceList().then(setList)
    if (!isTauri()) return
    const off = listen<TraceEntry>('trace', (e) => {
      const t = e.payload
      setList((l) => {
        // Updates of an entry come often (start, got a channel, end); it is
        // almost always one of the last ones.
        for (let i = l.length - 1; i >= Math.max(0, l.length - 200); i--) {
          if (l[i].id === t.id) {
            const next = l.slice()
            next[i] = t
            return next
          }
        }
        const next = [...l, t]
        return next.length > KEEP ? next.slice(next.length - KEEP) : next
      })
    })
    return () => {
      void off.then((f) => f())
    }
  }, [])

  const running = useMemo(() => list.filter((t) => t.status === 'running' || t.status === 'waiting').length, [list])

  return (
    <TraceContext.Provider
      value={{
        list,
        running,
        filter,
        setFilter,
        clear: () => {
          void api.traceClear().then(() => setList((l) => l.filter((t) => t.status === 'running' || t.status === 'waiting')))
        },
      }}
    >
      {children}
    </TraceContext.Provider>
  )
}

export function useTrace() {
  const ctx = useContext(TraceContext)
  if (!ctx) throw new Error('useTrace must be used inside <TraceProvider>')
  return ctx
}
