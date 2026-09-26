import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, isAppError, type AppError, type ConnectOptions, type ConnectResult, type HostInfo } from '../lib/api'
import { clearSessionCache } from './session-cache'
import { useServers } from './servers'

/** What the connection needs from the user before it can go on. */
export type Prompt = Exclude<ConnectResult, { status: 'connected' }>

export type Connection =
  | { status: 'connecting' }
  | { status: 'connected'; info: HostInfo; since: number; sudo: boolean }
  /** Dropped after being connected; retrying on its own with the same credential. */
  | { status: 'reconnecting'; info: HostInfo; since: number; sudo: boolean; attempt: number; lostAt: number; error: AppError }
  | { status: 'prompt'; prompt: Prompt }
  | { status: 'failed'; error: AppError }

export const connKey = (serverId: string, user: string) => `${serverId}|${user}`

/** Seconds between automatic reconnect attempts; stops after the last one. */
const RETRY_DELAYS = [2, 4, 8, 15, 30, 30, 60, 60]

type Connections = {
  get: (serverId: string, user: string) => Connection | undefined
  /** Start (or retry) connecting; resolves once connected, prompting or failed. */
  connect: (serverId: string, user: string, opts?: ConnectOptions) => Promise<void>
  disconnect: (serverId: string, user: string) => Promise<void>
  /** The session dropped (a read found it closed). Reconnects on its own if it
   *  was connected; otherwise marks it failed. */
  markLost: (serverId: string, user: string, error: AppError) => void
  /** Try reconnecting now instead of waiting for the next attempt. */
  retryNow: (serverId: string, user: string) => void
  setSudo: (serverId: string, user: string, on: boolean) => void
  /** Whether the sudo password dialog is open for this session. */
  sudoAsked: (serverId: string, user: string) => boolean
  askSudo: (serverId: string, user: string, open: boolean) => void
}

const ConnectionsContext = createContext<Connections | null>(null)

const asError = (e: unknown): AppError => (isAppError(e) ? e : { code: 'unknown', detail: String(e) })

/** SSH connection state per server × user, mirrored from the Rust sessions. */
export function ConnectionsProvider({ children }: { children: ReactNode }) {
  const { refresh } = useServers()
  const [map, setMap] = useState<Record<string, Connection>>({})
  const [sudoPrompt, setSudoPrompt] = useState<Record<string, boolean>>({})
  // Latest map for callbacks that run later (timers).
  const mapRef = useRef(map)
  mapRef.current = map
  // Ignore results of attempts that were superseded (retry, disconnect).
  const attempt = useRef<Record<string, number>>({})
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  // Password/passphrase of the attempt that stopped at the host key question,
  // so trusting the key does not ask for them again. Memory only.
  const pending = useRef<Record<string, ConnectOptions>>({})

  // A fresh UI (first launch or a webview reload) starts with no sessions.
  useEffect(() => {
    void api.disconnectAll().catch(() => {})
  }, [])

  const set = (key: string, c: Connection | undefined) => {
    const next = { ...mapRef.current }
    if (c) next[key] = c
    else delete next[key]
    mapRef.current = next
    setMap(next)
  }

  const stopTimer = (key: string) => {
    clearTimeout(timers.current[key])
    delete timers.current[key]
  }

  const connect = useCallback(
    async (serverId: string, user: string, opts?: ConnectOptions) => {
      const key = connKey(serverId, user)
      stopTimer(key)
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
          set(key, { status: 'connected', info: r.info, since: Date.now(), sudo: false })
          // The OS may have just been detected and saved.
          refresh()
        } else {
          set(key, { status: 'prompt', prompt: r })
        }
      } catch (e) {
        if (attempt.current[key] !== id) return
        set(key, { status: 'failed', error: asError(e) })
      }
    },
    [refresh],
  )

  /** One automatic reconnect attempt; schedules the next one on network errors. */
  const tryReconnect = useCallback(async (serverId: string, user: string) => {
    const key = connKey(serverId, user)
    stopTimer(key)
    const cur = mapRef.current[key]
    if (cur?.status !== 'reconnecting') return
    const id = (attempt.current[key] ?? 0) + 1
    attempt.current[key] = id
    const n = cur.attempt + 1
    set(key, { ...cur, attempt: n })
    try {
      const r = await api.reconnect(serverId, user)
      if (attempt.current[key] !== id) return
      if (r.status === 'connected') set(key, { status: 'connected', info: r.info, since: Date.now(), sudo: cur.sudo })
      else set(key, { status: 'prompt', prompt: r })
    } catch (e) {
      if (attempt.current[key] !== id) return
      const error = asError(e)
      const retryable = ['timeout', 'refused', 'network', 'dns', 'ssh', 'connection_lost', 'exec_timeout'].includes(error.code)
      if (!retryable || n >= RETRY_DELAYS.length) {
        set(key, { status: 'failed', error })
        return
      }
      set(key, { ...cur, attempt: n, error })
      timers.current[key] = setTimeout(() => void tryReconnect(serverId, user), RETRY_DELAYS[n] * 1000)
    }
  }, [])

  const disconnect = useCallback(async (serverId: string, user: string) => {
    const key = connKey(serverId, user)
    stopTimer(key)
    attempt.current[key] = (attempt.current[key] ?? 0) + 1
    delete pending.current[key]
    set(key, undefined)
    clearSessionCache(serverId, user)
    await api.disconnect(serverId, user).catch(() => {})
  }, [])

  const markLost = useCallback(
    (serverId: string, user: string, error: AppError) => {
      const key = connKey(serverId, user)
      delete pending.current[key]
      const cur = mapRef.current[key]
      if (cur?.status === 'connected') {
        set(key, { status: 'reconnecting', info: cur.info, since: cur.since, sudo: cur.sudo, attempt: 0, lostAt: Date.now(), error })
        timers.current[key] = setTimeout(() => void tryReconnect(serverId, user), RETRY_DELAYS[0] * 1000)
      } else if (cur?.status !== 'reconnecting') {
        stopTimer(key)
        set(key, { status: 'failed', error })
      }
    },
    [tryReconnect],
  )

  const retryNow = useCallback((serverId: string, user: string) => void tryReconnect(serverId, user), [tryReconnect])

  const setSudo = useCallback((serverId: string, user: string, on: boolean) => {
    const key = connKey(serverId, user)
    const c = mapRef.current[key]
    if (c?.status === 'connected' || c?.status === 'reconnecting') set(key, { ...c, sudo: on })
  }, [])

  const askSudo = useCallback((serverId: string, user: string, open: boolean) => {
    setSudoPrompt((p) => ({ ...p, [connKey(serverId, user)]: open }))
  }, [])

  useEffect(() => () => Object.values(timers.current).forEach(clearTimeout), [])

  return (
    <ConnectionsContext.Provider
      value={{
        get: (s, u) => map[connKey(s, u)],
        connect,
        disconnect,
        markLost,
        retryNow,
        setSudo,
        sudoAsked: (s, u) => !!sudoPrompt[connKey(s, u)],
        askSudo,
      }}
    >
      {children}
    </ConnectionsContext.Provider>
  )
}

export function useConnections() {
  const ctx = useContext(ConnectionsContext)
  if (!ctx) throw new Error('useConnections must be used inside <ConnectionsProvider>')
  return ctx
}
