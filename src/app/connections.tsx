import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, isAppError, type AppError, type ConnectOptions, type ConnectResult, type HostInfo } from '../lib/api'
import { useServers } from './servers'

/** What the connection needs from the user before it can go on. */
export type Prompt = Exclude<ConnectResult, { status: 'connected' }>

export type Connection =
  | { status: 'connecting' }
  | { status: 'connected'; info: HostInfo; since: number }
  | { status: 'prompt'; prompt: Prompt }
  | { status: 'failed'; error: AppError }

export const connKey = (serverId: string, user: string) => `${serverId}|${user}`

type Connections = {
  get: (serverId: string, user: string) => Connection | undefined
  /** Start (or retry) connecting; resolves once connected, prompting or failed. */
  connect: (serverId: string, user: string, opts?: ConnectOptions) => Promise<void>
  disconnect: (serverId: string, user: string) => Promise<void>
  /** The session dropped (e.g. a stats call found it closed). */
  markLost: (serverId: string, user: string, error: AppError) => void
}

const ConnectionsContext = createContext<Connections | null>(null)

/** SSH connection state per server × user, mirrored from the Rust sessions. */
export function ConnectionsProvider({ children }: { children: ReactNode }) {
  const { refresh } = useServers()
  const [map, setMap] = useState<Record<string, Connection>>({})
  // Ignore results of attempts that were superseded (retry, disconnect).
  const attempt = useRef<Record<string, number>>({})
  // Password/passphrase of the attempt that stopped at the host key question,
  // so trusting the key does not ask for them again. Memory only, cleared once
  // the attempt ends.
  const pending = useRef<Record<string, ConnectOptions>>({})

  // A fresh UI (first launch or a webview reload) starts with no sessions.
  useEffect(() => {
    void api.disconnectAll().catch(() => {})
  }, [])

  const set = (key: string, c: Connection | undefined) =>
    setMap((m) => {
      const next = { ...m }
      if (c) next[key] = c
      else delete next[key]
      return next
    })

  const connect = useCallback(
    async (serverId: string, user: string, opts?: ConnectOptions) => {
      const key = connKey(serverId, user)
      const id = (attempt.current[key] ?? 0) + 1
      attempt.current[key] = id
      set(key, { status: 'connecting' })
      const merged = opts?.trustFingerprint ? { ...pending.current[key], ...opts } : opts
      delete pending.current[key]
      try {
        const r = await api.connect(serverId, user, merged)
        if (attempt.current[key] !== id) return
        if (r.status === 'hostKey' && (merged?.password || merged?.passphrase)) {
          pending.current[key] = { password: merged.password, passphrase: merged.passphrase, remember: merged.remember }
        }
        if (r.status === 'connected') {
          set(key, { status: 'connected', info: r.info, since: Date.now() })
          // The OS may have just been detected and saved.
          refresh()
        } else {
          set(key, { status: 'prompt', prompt: r })
        }
      } catch (e) {
        if (attempt.current[key] !== id) return
        set(key, { status: 'failed', error: isAppError(e) ? e : { code: 'unknown', detail: String(e) } })
      }
    },
    [refresh],
  )

  const disconnect = useCallback(async (serverId: string, user: string) => {
    const key = connKey(serverId, user)
    attempt.current[key] = (attempt.current[key] ?? 0) + 1
    delete pending.current[key]
    set(key, undefined)
    await api.disconnect(serverId, user).catch(() => {})
  }, [])

  const markLost = useCallback((serverId: string, user: string, error: AppError) => {
    delete pending.current[connKey(serverId, user)]
    set(connKey(serverId, user), { status: 'failed', error })
  }, [])

  return (
    <ConnectionsContext.Provider value={{ get: (s, u) => map[connKey(s, u)], connect, disconnect, markLost }}>
      {children}
    </ConnectionsContext.Provider>
  )
}

export function useConnections() {
  const ctx = useContext(ConnectionsContext)
  if (!ctx) throw new Error('useConnections must be used inside <ConnectionsProvider>')
  return ctx
}
