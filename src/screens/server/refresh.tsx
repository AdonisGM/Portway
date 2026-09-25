import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useConnections } from '../../app/connections'
import { isAppError, type AppError } from '../../lib/api'

const REFRESH_MS = 60_000

/** Read once, then every minute (or `everyMs`) or on demand: for overview
 *  cards that are heavier than the live 5 s numbers. */
export function useRefreshed<T>(serverId: string, user: string, load: (serverId: string, user: string) => Promise<T>, everyMs = REFRESH_MS) {
  const { markLost } = useConnections()
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [at, setAt] = useState<Date | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      setData(await load(serverId, user))
      setError(null)
      setAt(new Date())
    } catch (e) {
      const err = isAppError(e) ? e : { code: 'unknown', detail: String(e) }
      if (err.code === 'connection_lost' || err.code === 'not_connected') markLost(serverId, user, err)
      else setError(err)
    } finally {
      setBusy(false)
    }
  }, [serverId, user, markLost, load])

  useEffect(() => {
    void refresh()
    const timer = setInterval(refresh, everyMs)
    return () => clearInterval(timer)
  }, [refresh, everyMs])

  return { data, error, at, busy, refresh }
}

/** "cập nhật 2 phút trước" and a refresh button, as in the design. */
export function RefreshControl({ at, busy, error, onRefresh }: { at: Date | null; busy: boolean; error: AppError | null; onRefresh: () => void }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  const mins = at ? Math.floor((now - at.getTime()) / 60_000) : 0
  const label = error ? 'không đọc được' : !at ? 'đang đọc…' : mins < 1 ? 'cập nhật vừa xong' : `cập nhật ${mins} phút trước`
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] whitespace-nowrap text-muted">
      {label}
      <button
        type="button"
        title="Làm mới"
        onClick={onRefresh}
        disabled={busy}
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
