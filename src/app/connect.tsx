import { isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, type ConnectLive, type ConnectView } from '../lib/api'

const EMPTY: ConnectView = { enabled: false, device: null, error: null, selfSeen: false, nearby: [], peers: [], pairing: null, link: null, linkError: null, wake: null, transfers: [], clip: null, machine: null, live: null }

const ConnectContext = createContext<ConnectView | null>(null)

/** CPU, memory and network use over the last few minutes, for the charts. A
 *  `null` marks a gap (the link was down). */
export type Sample = { cpu: number; ram: number; rx: number; tx: number }
export type History = { self: (Sample | null)[]; peers: Record<string, (Sample | null)[]> }
export const KEEP_SAMPLES = 90
const HistoryContext = createContext<History>({ self: [], peers: {} })

const same = (a: Sample | null | undefined, b: Sample) => !!a && a.cpu === b.cpu && a.ram === b.ram && a.rx === b.rx && a.tx === b.tx

function grow(list: (Sample | null)[] | undefined, live: ConnectLive | null): (Sample | null)[] | undefined {
  const cur = list ?? []
  const last = cur[cur.length - 1]
  if (!live) return cur.length === 0 || last === null ? list : [...cur, null].slice(-KEEP_SAMPLES)
  const next: Sample = { cpu: live.cpu, ram: live.ramUsed, rx: live.netRx, tx: live.netTx }
  // The same view arrives again after every unrelated change.
  return same(last, next) ? list : [...cur, next].slice(-KEEP_SAMPLES)
}

function withSamples(h: History, v: ConnectView): History {
  const self = grow(h.self, v.live) ?? h.self
  const peers = { ...h.peers }
  let changed = self !== h.self
  for (const p of v.peers) {
    const next = grow(h.peers[p.id], p.live)
    if (next !== h.peers[p.id] && next) {
      peers[p.id] = next
      changed = true
    }
  }
  return changed ? { self, peers } : h
}

/** Portway Connect's state as the Rust side last reported it: one `connect`
 *  event after every change, so any screen (and the pairing dialog, which
 *  must show up wherever the user is) reads the same picture. */
export function ConnectProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<ConnectView>(EMPTY)
  const [history, setHistory] = useState<History>({ self: [], peers: {} })
  const apply = (v: ConnectView) => {
    setView(v)
    setHistory((h) => withSamples(h, v))
  }

  useEffect(() => {
    void api.connectState().then(apply)
    if (!isTauri()) return
    const off = listen<ConnectView>('connect', (e) => apply(e.payload))
    return () => {
      void off.then((f) => f())
    }
  }, [])

  return (
    <ConnectContext.Provider value={view}>
      <HistoryContext.Provider value={history}>{children}</HistoryContext.Provider>
    </ConnectContext.Provider>
  )
}

export function useConnect() {
  const ctx = useContext(ConnectContext)
  if (!ctx) throw new Error('useConnect must be used inside <ConnectProvider>')
  return ctx
}

export const useConnectHistory = () => useContext(HistoryContext)
