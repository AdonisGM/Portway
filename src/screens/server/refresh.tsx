import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useConnections } from '../../app/connections'
import { readCache, writeCache } from '../../app/session-cache'
import { isAppError, type AppError } from '../../lib/api'

const REFRESH_MS = 60_000

/** Whether the session can be read right now, and whether sudo is on. Reads
 *  pause while reconnecting and start again (at once) when the session is
 *  back or sudo changes. */
export function useLive(serverId: string, user: string) {
  const conn = useConnections().get(serverId, user)
  return { live: conn?.status === 'connected', sudo: conn?.status === 'connected' && conn.sudo }
}

type Cached<T> = { value: T; sudo: boolean }

/** Read once, then every minute (or `everyMs`) or on demand: for overview
 *  cards that are heavier than the live 5 s numbers. The last result of each
 *  session is kept (`name` in the session cache): coming back to a session
 *  shows it at once, and it is not read again until it is `everyMs` old or
 *  sudo changed. */
export function useRefreshed<T>(
  serverId: string,
  user: string,
  name: string,
  load: (serverId: string, user: string) => Promise<T>,
  everyMs = REFRESH_MS,
) {
  const { markLost } = useConnections()
  const { live, sudo } = useLive(serverId, user)
  const [initial] = useState(() => readCache<Cached<T>>(serverId, user, name))
  const [data, setData] = useState<T | null>(initial?.data.value ?? null)
  const [error, setError] = useState<AppError | null>(null)
  const [at, setAt] = useState<Date | null>(initial?.at ?? null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      const value = await load(serverId, user)
      const now = new Date()
      setData(value)
      setError(null)
      setAt(now)
      writeCache(serverId, user, name, { value, sudo } satisfies Cached<T>, now)
    } catch (e) {
      const err = isAppError(e) ? e : { code: 'unknown', detail: String(e) }
      if (err.code === 'connection_lost' || err.code === 'not_connected') markLost(serverId, user, err)
      else setError(err)
    } finally {
      setBusy(false)
    }
  }, [serverId, user, name, markLost, load, sudo])

  useEffect(() => {
    if (!live) return
    const cached = readCache<Cached<T>>(serverId, user, name)
    const age = cached ? Date.now() - cached.at.getTime() : Infinity
    const fresh = !!cached && cached.data.sudo === sudo && age < everyMs
    let interval: ReturnType<typeof setInterval> | undefined
    const first = setTimeout(
      () => {
        void refresh()
        interval = setInterval(refresh, everyMs)
      },
      fresh ? everyMs - age : 0,
    )
    return () => {
      clearTimeout(first)
      clearInterval(interval)
    }
  }, [refresh, everyMs, live, sudo, serverId, user, name])

  return { data, error, at, busy, refresh, live }
}

/** "cập nhật 2 phút trước" and a refresh button, as in the design. */
export function RefreshControl({
  at,
  busy,
  error,
  onRefresh,
  live = true,
}: {
  at: Date | null
  busy: boolean
  error: AppError | null
  onRefresh: () => void
  live?: boolean
}) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  const mins = at ? Math.floor((now - at.getTime()) / 60_000) : 0
  const label = !live ? 'tạm dừng' : error ? 'không đọc được' : !at ? 'đang đọc…' : mins < 1 ? 'cập nhật vừa xong' : `cập nhật ${mins} phút trước`
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] whitespace-nowrap text-muted">
      {label}
      <button
        type="button"
        title="Làm mới"
        onClick={onRefresh}
        disabled={busy || !live}
        className="flex size-5 cursor-pointer items-center justify-center rounded-[5px] border border-line2 text-ink2 hover:border-muted disabled:cursor-default"
      >
        <RefreshCw size={12} strokeWidth={1.9} className={busy ? 'animate-spin' : undefined} />
      </button>
    </span>
  )
}

export function ErrorLine({ error }: { error: AppError | null }) {
  if (!error) return null
  return (
    <span className="font-mono text-[11px] text-danger select-text">
      {error.code}
      {error.detail ? `: ${error.detail}` : ''}
    </span>
  )
}
