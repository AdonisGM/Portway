import { useCallback, useEffect, useRef, useState } from 'react'
import { useConnections } from '../../app/connections'
import { useNav } from '../../app/nav'
import { readCache, writeCache } from '../../app/session-cache'
import { useServers } from '../../app/servers'
import { useToast } from '../../components/toast'
import { Button } from '../../components/ui/primitives'
import { SearchInput } from '../../components/ui/search-input'
import { api, isAppError, type AppError, type Server, type Unit } from '../../lib/api'
import { ActionConfirm, type ActionAsk } from '../server/action-confirm'
import { useLive } from '../server/refresh'
import { PickUnits } from './dialogs'
import { defaultWatch } from './format'
import { UnitsView } from './units'
import { withSudo } from '../../lib/commands'
import { t } from '../../i18n'

const STATUS_MS = 10_000

const asError = (e: unknown): AppError => (isAppError(e) ? e : { code: 'unknown', detail: String(e) })

/** State of the watched units, every 10 s while the session is up. */
function useUnits(serverId: string, user: string, units: string[] | null) {
  const { markLost } = useConnections()
  const { live, sudo } = useLive(serverId, user)
  const [list, setList] = useState<Unit[] | null>(() => readCache<Unit[]>(serverId, user, 'services')?.data ?? null)
  const [error, setError] = useState<AppError | null>(null)
  const key = units?.join(' ') ?? null

  const load = useCallback(async () => {
    if (key == null) return
    try {
      const got = await api.servicesStatus(serverId, user, key ? key.split(' ') : [])
      setList(got)
      setError(null)
      writeCache(serverId, user, 'services', got, new Date())
    } catch (e) {
      const err = asError(e)
      if (err.code === 'connection_lost' || err.code === 'not_connected') markLost(serverId, user, err)
      else setError(err)
    }
  }, [serverId, user, key, markLost])

  useEffect(() => {
    if (!live) return
    void load()
    const timer = setInterval(load, STATUS_MS)
    return () => clearInterval(timer)
  }, [live, sudo, load])

  return { list, error, load }
}

export function ServicesScreen({ server, user }: { server: Server; user: string }) {
  const nav = useNav()
  const toast = useToast()
  const { setWatchedUnits } = useServers()
  const { sudo } = useLive(server.id, user)
  const watched = server.watchedUnits ?? null
  const { list, error, load } = useUnits(server.id, user, watched)
  const [query, setQuery] = useState('')
  const [pick, setPick] = useState(false)
  const [ask, setAsk] = useState<ActionAsk | null>(null)

  // First visit: start from what failed plus the usual server software, once.
  const seeded = useRef(false)
  useEffect(() => {
    if (watched != null || seeded.current) return
    seeded.current = true
    api.servicesAll(server.id, user).then(
      (all) => void setWatchedUnits(server.id, defaultWatch(all)),
      (e) => toast({ title: t('Không đọc được danh sách unit'), detail: asError(e).detail ?? asError(e).code }),
    )
  }, [watched, server.id, user, setWatchedUnits, toast])

  // A unit watched under an alias (sshd.service) comes back as the unit
  // (ssh.service); save the real names once so it is listed once.
  useEffect(() => {
    if (!list || !watched) return
    const real = new Map<string, string>()
    for (const u of list) for (const n of [u.name, ...u.aliases]) real.set(n, u.name)
    const next = [...new Set(watched.map((w) => real.get(w) ?? w))]
    if (next.length !== watched.length || next.some((n, i) => n !== watched[i])) void setWatchedUnits(server.id, next)
  }, [list, watched, server.id, setWatchedUnits])

  const failed = (list ?? []).filter((u) => u.activeState === 'failed').length

  if (nav.servicesView === 'jobs') {
    return <div className="flex h-60 items-center justify-center rounded-xl border border-dashed border-line2 text-muted">{t('Tác vụ định kỳ sẽ làm ở bước tiếp theo')}</div>
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-none flex-wrap items-center gap-2">
        <div className="flex min-w-[220px] flex-1 flex-col gap-0.5">
          <span className="text-[15px] font-semibold">{t('Dịch vụ')}</span>
          <span className="text-muted">
            {watched == null
              ? t('Đang chọn unit để theo dõi…')
              : failed
                ? t('{n} unit đang theo dõi · {failed} lỗi', { n: watched.length, failed })
                : t('{n} unit đang theo dõi', { n: watched.length })}
          </span>
        </div>
        <SearchInput value={query} onChange={setQuery} placeholder={t('Tìm unit')} className="w-60 min-w-0" />
        <Button size="sm" onClick={() => setPick(true)}>
          + {t('Theo dõi unit')}
        </Button>
      </div>


      {error && <span className="font-mono text-[11.5px] text-danger select-text">{error.detail ?? error.code}</span>}

      <UnitsView
        server={server}
        user={user}
        sudo={sudo}
        units={list}
        watched={watched}
        query={query}
        onAsk={setAsk}
        onPick={() => setPick(true)}
        reload={load}
      />

      {pick && watched && (
        <PickUnits
          server={server}
          user={user}
          watched={watched}
          onChange={(units) => void setWatchedUnits(server.id, [...new Set(units)])}
          onClose={() => setPick(false)}
        />
      )}
      {ask && (
        <ActionConfirm
          ask={ask}
          serverName={server.name}
          user={user}
          sudo={sudo}
          onClose={() => setAsk(null)}
          onDone={() => {
            toast({ title: t('Đã chạy lệnh'), detail: withSudo(ask.command, sudo && user !== 'root') })
            setAsk(null)
          }}
        />
      )}
    </div>
  )
}
