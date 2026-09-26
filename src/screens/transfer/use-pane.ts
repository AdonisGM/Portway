import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConnections, type Connection } from '../../app/connections'
import { useNav, type PaneSide, type PaneSource } from '../../app/nav'
import { useToast } from '../../components/toast'
import { api, isAppError, type AppError, type FileEntry, type Listing } from '../../lib/api'
import { fileError, isDirLike } from '../files/format'
import { sourceKey } from './format'

export type SortKey = 'name' | 'size' | 'mtime'
export type Sort = { key: SortKey; dir: 1 | -1 }

const asError = (e: unknown): AppError => (isAppError(e) ? e : { code: 'unknown', detail: String(e) })

export const listFor = (src: PaneSource, path: string) =>
  src.kind === 'local' ? api.localList(path) : api.sftpList(src.serverId, src.user, path)

/** One pane of "Chuyển tệp": its source, folder listing, selection and cursor. */
export function usePane(side: PaneSide) {
  const nav = useNav()
  const conns = useConnections()
  const toast = useToast()
  const spot = nav.panes[side]
  const src = spot.src
  const key = sourceKey(src)
  const conn: Connection | undefined = src.kind === 'remote' ? conns.get(src.serverId, src.user) : undefined
  // Local folders are always there; a server needs its session up.
  const ready = src.kind === 'local' || conn?.status === 'connected'
  const live = ready || conn?.status === 'reconnecting'

  const [listing, setListing] = useState<Listing | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)
  // The source the listing on screen belongs to; a new source starts blank.
  const listedKey = useRef(key)
  const pathRef = useRef(spot.path)
  pathRef.current = listing?.path ?? spot.path
  const setPane = nav.setPane
  const markLost = conns.markLost

  const load = useCallback(
    async (target: string, fallback?: string): Promise<Listing | null> => {
      const n = ++seq.current
      setLoading(true)
      try {
        const l = await listFor(src, target)
        if (n !== seq.current) return l
        listedKey.current = key
        setListing(l)
        setError(null)
        setPane(side, { src, path: l.path })
        return l
      } catch (e) {
        const err = asError(e)
        if (n !== seq.current) return null
        if (fallback !== undefined && err.code === 'not_found') return load(fallback)
        if (src.kind === 'remote' && (err.code === 'connection_lost' || err.code === 'not_connected')) markLost(src.serverId, src.user, err)
        else if (listedKey.current !== key || !listing) setError(err)
        else toast({ title: 'Không mở được thư mục', detail: fileError(err) })
        return null
      } finally {
        if (n === seq.current) setLoading(false)
      }
    },
    // `listing` only decides where an error shows; not worth reloading for.
    [key, side, setPane, markLost, toast],
  )

  // A new source: drop the old listing and read the saved folder (home if it is gone).
  useEffect(() => {
    if (listedKey.current !== key) {
      setListing(null)
      setError(null)
      setSel({ path: '', names: [], anchor: null })
    }
    if (ready) void load(pathRef.current, '')
    // Only when the source changes or its session comes (back) up.
  }, [key, ready])

  const reload = useCallback(() => load(pathRef.current), [load])

  const path = listing?.path ?? ''
  const [showHidden, setShowHidden] = useState(false)
  const [sort, setSort] = useState<Sort>({ key: 'name', dir: 1 })
  const all = useMemo(() => (listing && listedKey.current === key ? listing.entries : []), [listing, key])
  const hiddenCount = all.filter((e) => e.name.startsWith('.')).length
  const shown = useMemo(
    () =>
      all
        .filter((e) => showHidden || !e.name.startsWith('.'))
        .sort((a, b) => {
          const da = isDirLike(a)
          if (da !== isDirLike(b)) return da ? -1 : 1
          const by =
            sort.key === 'size' ? a.size - b.size : sort.key === 'mtime' ? (a.mtime ?? 0) - (b.mtime ?? 0) : a.name.localeCompare(b.name, 'en', { numeric: true })
          return by * sort.dir || a.name.localeCompare(b.name)
        }),
    [all, showHidden, sort],
  )
  const order = useMemo(() => shown.map((e) => e.name), [shown])

  // Selection and keyboard cursor belong to one folder.
  const [sel, setSel] = useState<{ path: string; names: string[]; anchor: string | null }>({ path: '', names: [], anchor: null })
  const selNames = sel.path === path ? sel.names.filter((n) => order.includes(n)) : []
  const selected: FileEntry[] = shown.filter((e) => selNames.includes(e.name))
  const select = (names: string[], anchor: string | null = sel.anchor) => setSel({ path, names, anchor })
  const [cursorAt, setCursorAt] = useState<{ path: string; name: string } | null>(null)
  const cursor = cursorAt?.path === path && order.includes(cursorAt.name) ? cursorAt.name : null
  const setCursor = (name: string | null) => setCursorAt(name ? { path, name } : null)

  return {
    side,
    src,
    key,
    conn,
    ready,
    live,
    listing: listing && listedKey.current === key ? listing : null,
    error,
    loading,
    path,
    load,
    reload,
    showHidden,
    setShowHidden,
    hiddenCount,
    sort,
    setSort,
    all,
    shown,
    order,
    selNames,
    selected,
    anchor: sel.path === path ? sel.anchor : null,
    select,
    cursor,
    setCursor,
    setSource: (next: PaneSource) => setPane(side, { src: next, path: next.kind === 'local' ? '~/Downloads' : '' }),
  }
}

export type Pane = ReturnType<typeof usePane>

/** Whether the session's user may create files in the folder on screen. */
export function canWriteHere(p: Pane) {
  const l = p.listing
  if (!l || l.denied) return false
  return (p.src.kind === 'remote' && p.src.user === 'root') || l.dir.writable
}
