import { isTauri } from '@tauri-apps/api/core'
import { homeDir } from '@tauri-apps/api/path'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { ArrowLeft, ArrowLeftRight, ArrowRight, Info } from 'lucide-react'
import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { useConnections } from '../../app/connections'
import { useNav, type PaneSide, type PaneSource } from '../../app/nav'
import { useServers } from '../../app/servers'
import { useTransfers } from '../../app/transfers'
import { useToast } from '../../components/toast'
import { t } from '../../i18n'
import { TextInput } from '../../components/ui/form-controls'
import { Modal } from '../../components/ui/modal'
import { Button, cx } from '../../components/ui/primitives'
import { api, isAppError, type FileEntry, type TransferItem } from '../../lib/api'
import { fileError, isDirLike, parentOf, q } from '../files/format'
import { TransferQueue } from '../files/queue'
import { ConnectPrompt } from '../server/connect-prompt'
import { ConflictDialog, mixedKinds, type Choice, type Clash } from './conflict'
import { baseName, endOf, hostName, LOCAL_KEY, sameSource, shortPath, sourceName, sourceOf, uniqueName } from './format'
import { Pane, type DropHint } from './pane'
import { canWriteHere, listFor, usePane, type Pane as PaneState } from './use-pane'

type CopyItem = { name: string; path: string; entry?: FileEntry }
type Job = { from: PaneSource; fromSide: PaneSide | null; to: PaneSide; dir: string; items: CopyItem[]; taken: Set<string> }
/** A drag between the panes, started with the mouse on a row. */
type Drag = { side: PaneSide; name: string; x: number; y: number; started: boolean; names: string[] }
type Hover = { over: PaneSide | null; dir: string | null }

const other = (s: PaneSide): PaneSide => (s === 'L' ? 'R' : 'L')

/** Pane and folder row under a point of the window. */
function hit(x: number, y: number): Hover {
  const el = document.elementFromPoint(x, y)
  const pane = el?.closest<HTMLElement>('[data-pane]')
  const dir = el?.closest<HTMLElement>('[data-dir-path]')
  return { over: (pane?.dataset.pane as PaneSide | undefined) ?? null, dir: pane && dir && pane.contains(dir) ? (dir.dataset.dirPath ?? null) : null }
}

/** "Chuyển tệp": copy between this Mac and a server, or between two servers. */
export function TransferScreen() {
  const nav = useNav()
  const conns = useConnections()
  const { servers, byId } = useServers()
  const toast = useToast()
  const { list: transfers } = useTransfers()
  const L = usePane('L')
  const R = usePane('R')
  const panes: Record<PaneSide, PaneState> = { L, R }
  const [active, setActive] = useState<PaneSide>('L')
  const [home, setHome] = useState<string | null>(null)
  const [conflict, setConflict] = useState<(Job & { clashes: Clash[] }) | null>(null)
  const [newFolder, setNewFolder] = useState<PaneSide | null>(null)

  useEffect(() => {
    if (isTauri()) void homeDir().then((h) => setHome(h.replace(/\/+$/, '')))
  }, [])

  const name = (s: PaneSource) => sourceName(s, byId)
  const where = (s: PaneSource, dir: string) => (s.kind === 'local' ? t('Máy này · {path}', { path: shortPath(dir, home) }) : `${name(s)}:${dir}`)
  const fail = (title: string) => (e: unknown) => toast({ title, detail: isAppError(e) ? fileError(e) : String(e) })

  const sources = [
    { value: LOCAL_KEY, label: t('Máy này') },
    ...servers.flatMap((s) => s.accounts.map((a) => ({ value: `${s.id}|${a.user}`, label: `${a.user}@${s.name}` }))),
  ]
  const pickSource = (side: PaneSide, key: string) => {
    const src = sourceOf(key)
    if (src.kind === 'remote') nav.openSession(src.serverId, src.user)
    panes[side].setSource(src)
  }
  const connect = (p: PaneState) => p.src.kind === 'remote' && nav.openSession(p.src.serverId, p.src.user)

  /** Why items of `from` cannot go to the folder on screen in `to`, or null. */
  const blocked = (from: PaneState, to: PaneState, entries: FileEntry[], dir = to.path): string | null => {
    if (!entries.length) return t('Chọn tệp ở {name} trước', { name: name(from.src) })
    if (from.src.kind === 'local' && to.src.kind === 'local') return t('Hai bên đều là máy này. Chọn một server ở một bên.')
    if (!to.ready || !to.listing) return t('{name} chưa sẵn sàng', { name: name(to.src) })
    if (sameSource(from.src, to.src) && from.path === dir) return t('Hai bên đang mở cùng một thư mục')
    if (dir === to.path && !canWriteHere(to)) return t('{user} không có quyền ghi vào {path}', { user: to.listing.user, path: shortPath(to.path, to.src.kind === 'local' ? home : null) })
    const unreadable = entries.filter((e) => !e.readable)
    if (unreadable.length)
      return unreadable.length > 1
        ? t('Không đọc được {name} và {n} mục khác', { name: unreadable[0].name, n: unreadable.length - 1 })
        : t('Không đọc được {name}', { name: unreadable[0].name })
    if (entries.some((e) => sameSource(from.src, to.src) && isDirLike(e) && (dir === e.path || dir.startsWith(e.path + '/')))) return t('Không chép thư mục vào chính nó')
    return null
  }

  const send = async (job: Job, items: TransferItem[]) => {
    if (!items.length) return
    const to = panes[job.to]
    try {
      await api.transferCopy(endOf(job.from, byId), endOf(to.src, byId), job.dir, items)
      if (job.fromSide) panes[job.fromSide].select([], null)
    } catch (e) {
      fail(t('Không chép được'))(e)
    }
  }

  /** Copy into `dir` of the `to` pane; asks first about names already there. */
  const copy = async (from: PaneSource, fromSide: PaneSide | null, to: PaneSide, items: CopyItem[], dir: string) => {
    const dest = panes[to]
    try {
      // Read the destination again: the pane may be minutes old.
      const l = await listFor(dest.src, dir)
      if (l.denied || !(l.dir.writable || (dest.src.kind === 'remote' && dest.src.user === 'root'))) {
        return toast({ title: t('Không chép được'), detail: t('{user} không có quyền ghi vào {path}', { user: l.user, path: where(dest.src, l.path) }) })
      }
      const there = new Map(l.entries.map((e) => [e.name, e]))
      const job: Job = { from, fromSide, to, dir: l.path, items, taken: new Set(there.keys()) }
      const clashes = items.flatMap((i) => (there.has(i.name) ? [{ name: i.name, src: i.entry, dest: there.get(i.name)! }] : []))
      if (clashes.length) setConflict({ ...job, clashes })
      else await send(job, items.map((i) => ({ path: i.path, overwrite: false })))
    } catch (e) {
      fail(t('Không chép được'))(e)
    }
  }

  const resolve = (job: Job & { clashes: Clash[] }, choice: Choice) => {
    setConflict(null)
    const clash = new Map(job.clashes.map((c) => [c.name, c]))
    const taken = new Set(job.taken)
    const items: TransferItem[] = job.items.flatMap((i): TransferItem[] => {
      const c = clash.get(i.name)
      if (!c) return [{ path: i.path, overwrite: false }]
      if (choice === 'skip') return []
      if (choice === 'overwrite' && !mixedKinds(c)) return [{ path: i.path, overwrite: true }]
      const renamed = uniqueName(i.name, taken)
      taken.add(renamed)
      return [{ path: i.path, name: renamed, overwrite: false }]
    })
    void send(job, items)
  }

  const itemsOf = (p: PaneState, names: string[]): CopyItem[] =>
    p.shown.filter((e) => names.includes(e.name)).map((e) => ({ name: e.name, path: e.path, entry: e }))

  const copySelection = (fromSide: PaneSide) => {
    const from = panes[fromSide]
    const to = panes[other(fromSide)]
    const why = blocked(from, to, from.selected)
    if (why) return toast({ title: t('Chưa chép được'), detail: why })
    void copy(from.src, fromSide, other(fromSide), itemsOf(from, from.selNames), to.path)
  }

  // Latest state for the window listeners below.
  const latest = useRef({ panes, active, copy, blocked, copySelection, itemsOf, conflict, newFolder })
  latest.current = { panes, active, copy, blocked, copySelection, itemsOf, conflict, newFolder }

  // Drag rows to the other pane (or onto a folder in it).
  const drag = useRef<Drag | null>(null)
  const [dragging, setDragging] = useState<(Drag & Hover) | null>(null)
  const rowMouseDown = (side: PaneSide) => (e: MouseEvent, rowName: string) => {
    if (e.button !== 0 || e.shiftKey || e.metaKey || e.ctrlKey) return
    drag.current = { side, name: rowName, x: e.clientX, y: e.clientY, started: false, names: [] }
  }
  useEffect(() => {
    const move = (e: globalThis.MouseEvent) => {
      const d = drag.current
      if (!d) return
      if (!d.started) {
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return
        const p = latest.current.panes[d.side]
        d.started = true
        d.names = p.selNames.includes(d.name) ? p.selNames : [d.name]
        if (!p.selNames.includes(d.name)) p.select([d.name], d.name)
        document.body.style.cursor = 'copy'
      }
      const h = hit(e.clientX, e.clientY)
      setDragging({ ...d, x: e.clientX, y: e.clientY, over: h.over === d.side ? null : h.over, dir: h.over === d.side ? null : h.dir })
    }
    const up = (e: globalThis.MouseEvent) => {
      const d = drag.current
      drag.current = null
      if (!d?.started) return
      document.body.style.cursor = ''
      setDragging(null)
      const { over, dir } = hit(e.clientX, e.clientY)
      if (!over || over === d.side) return
      const { panes: ps, blocked: why, copy: run, itemsOf: items } = latest.current
      const from = ps[d.side]
      const to = ps[over]
      const entries = from.shown.filter((x) => d.names.includes(x.name))
      const reason = why(from, to, entries, dir ?? to.path)
      if (reason) return toast({ title: t('Chưa chép được'), detail: reason })
      void run(from.src, d.side, over, items(from, d.names), dir ?? to.path)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
    }
  }, [toast])

  // Files dropped from Finder onto a server pane are uploaded there.
  const [finder, setFinder] = useState<(Hover & { count: number }) | null>(null)
  useEffect(() => {
    if (!isTauri()) return
    let count = 0
    const off = getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload
      if (p.type === 'leave') return setFinder(null)
      if (p.type === 'enter') count = p.paths.length
      const h = hit(p.position.x / window.devicePixelRatio, p.position.y / window.devicePixelRatio)
      if (p.type !== 'drop') return setFinder({ ...h, count })
      setFinder(null)
      if (!h.over) return
      const to = latest.current.panes[h.over]
      if (to.src.kind === 'local') return toast({ title: t('Đã ở trên máy này'), detail: t('Thả vào pane của một server để tải lên.') })
      if (!to.ready || !to.listing) return toast({ title: t('Chưa tải lên được'), detail: t('{name} chưa sẵn sàng', { name: sourceName(to.src, byId) }) })
      void latest.current.copy({ kind: 'local' }, null, h.over, p.paths.map((path) => ({ name: baseName(path), path })), h.dir ?? to.path)
    })
    return () => {
      void off.then((f) => f())
    }
  }, [toast, byId])

  const hint = (side: PaneSide): DropHint | null => {
    const to = panes[side]
    const label = (dir: string) => (to.src.kind === 'local' ? t('Tải về máy này · {path}', { path: shortPath(dir, home) }) : t('Chép sang {dest}', { dest: `${name(to.src)}:${dir}` }))
    if (dragging?.started && dragging.over === side) {
      return { dir: dragging.dir, label: label(dragging.dir ?? to.path), sub: t('{n} mục từ {name}', { n: dragging.names.length, name: name(panes[dragging.side].src) }) }
    }
    if (finder?.over === side) {
      if (to.src.kind === 'local') return { dir: null, label: t('Đây là máy này'), sub: t('Thả vào pane của một server để tải lên') }
      return { dir: finder.dir, label: label(finder.dir ?? to.path), sub: t('{n} mục từ Finder', { n: finder.count }) }
    }
    return null
  }

  // Keyboard: the active pane moves, selects and opens; ⌘← ⌘→ copy.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable], [data-scope=select], [data-scope=dialog]')) return
      const { panes: ps, active: side, copySelection: copySel, conflict: c, newFolder: nf } = latest.current
      if (c || nf || document.querySelector('[data-scope=dialog][data-part=content]')) return
      const p = ps[side]
      const idx = p.cursor ? p.order.indexOf(p.cursor) : -1
      const entry = p.shown.find((x) => x.name === p.cursor)
      const meta = e.metaKey || e.ctrlKey
      let handled = true
      if (e.key === 'Tab') setActive(other(side))
      else if (meta && e.key === 'ArrowRight') copySel('L')
      else if (meta && e.key === 'ArrowLeft') copySel('R')
      else if ((meta && e.key === 'ArrowUp') || e.key === 'Backspace') {
        if (p.listing && p.path !== '/') void p.load(parentOf(p.path))
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!p.order.length) return
        const next = p.order[Math.max(0, Math.min(p.order.length - 1, idx < 0 ? 0 : idx + (e.key === 'ArrowDown' ? 1 : -1)))]
        p.setCursor(next)
        if (e.shiftKey) {
          const anchor = p.anchor ?? p.cursor ?? next
          const a = p.order.indexOf(anchor)
          const b = p.order.indexOf(next)
          p.select(p.order.slice(Math.min(a, b), Math.max(a, b) + 1), anchor)
        } else p.select([next], next)
      } else if (e.key === ' ' && p.cursor) {
        const on = p.selNames.includes(p.cursor)
        p.select(on ? p.selNames.filter((n) => n !== p.cursor) : [...p.selNames, p.cursor], p.cursor)
      } else if (e.key === 'Enter' && entry && isDirLike(entry)) void p.load(entry.path)
      else if (meta && e.key.toLowerCase() === 'a') p.select(p.order, null)
      else if (e.key === 'Escape') p.select([], null)
      else handled = false
      if (handled) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Show new files once a copy lands in a folder on screen.
  const seen = useRef<Set<string> | null>(null)
  useEffect(() => {
    const done = transfers.filter((t) => t.status === 'done')
    if (!seen.current) {
      seen.current = new Set(done.map((t) => t.id))
      return
    }
    const fresh = done.filter((t) => !seen.current!.has(t.id))
    fresh.forEach((t) => seen.current!.add(t.id))
    for (const p of [L, R]) {
      const lands = fresh.some((t) => {
        if (parentOf(t.target) !== p.path) return false
        if (p.src.kind === 'local') return t.direction === 'down'
        const [sid, user] = t.direction === 'copy' ? [t.destServerId, t.destUser] : [t.serverId, t.user]
        return t.direction !== 'down' && sid === p.src.serverId && user === p.src.user
      })
      if (lands) void p.reload()
    }
    // Reload only when the list of transfers changes.
  }, [transfers])

  const terminal = (p: PaneState) => {
    if (!p.listing) return
    const path = p.listing.path
    const run =
      p.src.kind === 'local' ? api.localTerminal(path) : api.openTerminal(p.src.serverId, p.src.user, undefined, path)
    void run.then(() => toast({ title: t('Đã mở Terminal'), detail: `cd ${q(path)}` })).catch(fail(t('Không mở được Terminal')))
  }

  const lr = blocked(L, R, L.selected)
  const rl = blocked(R, L, R.selected)
  const relay = L.src.kind === 'remote' && R.src.kind === 'remote' && !sameSource(L.src, R.src)
  const relayText =
    L.src.kind === 'remote' && R.src.kind === 'remote' && L.src.serverId === R.src.serverId
      ? t('Hai phiên SSH khác nhau ({a} và {b}): Portway đọc bằng phiên này và ghi bằng phiên kia, dữ liệu vẫn đi qua máy bạn.', { a: L.src.user, b: R.src.user })
      : t('{a} và {b} không kết nối trực tiếp với nhau: Portway đọc tệp từ server này và ghi sang server kia qua máy bạn, không lưu tạm trên máy. Tốc độ phụ thuộc mạng của máy bạn tới cả hai server.', { a: hostName(L.src, byId), b: hostName(R.src, byId) })

  // One connection question at a time, for whichever pane's server needs it.
  const asking = [L, R].find((p) => p.src.kind === 'remote' && p.conn?.status === 'prompt')
  const askServer = asking?.src.kind === 'remote' ? byId(asking.src.serverId) : undefined

  // Flag clashes only where a copy between the panes could happen.
  const linked = !(L.src.kind === 'local' && R.src.kind === 'local') && !(sameSource(L.src, R.src) && L.path === R.path)
  const namesOf = (p: PaneState) => new Set(linked && p.listing && !p.listing.denied ? p.all.map((e) => e.name) : [])

  return (
    <div className="relative flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-none flex-wrap items-end gap-2">
        <div className="flex min-w-[260px] flex-1 flex-col gap-0.5">
          <span className="text-[23px] font-semibold">{t('Chuyển tệp')}</span>
          <span className="text-muted">{t('Chép tệp giữa máy bạn và server, hoặc giữa hai server qua SFTP. Chọn rồi bấm mũi tên, hoặc kéo sang pane bên kia.')}</span>
        </div>
        <Button size="sm" onClick={() => nav.swapPanes()} title={t('Đổi chỗ hai pane')}>
          <ArrowLeftRight size={14} strokeWidth={1.8} />
          {t('Đổi hai bên')}
        </Button>
      </div>

      {L.src.kind === 'local' && R.src.kind === 'local' && (
        <div className="flex flex-none items-start gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-[12px] leading-normal text-ink2">
          <Info size={14} strokeWidth={1.8} className="mt-px flex-none text-info" />
          <span>{t('Hai bên đều là máy này. Chọn một server ở ô nguồn của một pane để bắt đầu chép.')}</span>
        </div>
      )}
      {relay && (
        <div className="flex flex-none items-start gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-[12px] leading-normal text-ink2">
          <Info size={14} strokeWidth={1.8} className="mt-px flex-none text-info" />
          <span>{relayText}</span>
        </div>
      )}

      <div className="grid min-h-[320px] flex-1 gap-2" style={{ gridTemplateColumns: 'minmax(0,1fr) 44px minmax(0,1fr)' }}>
        <Pane
          pane={L}
          home={home}
          active={active === 'L'}
          onActivate={() => setActive('L')}
          otherNames={namesOf(R)}
          sources={sources}
          onPickSource={(k) => pickSource('L', k)}
          onRowMouseDown={rowMouseDown('L')}
          drop={hint('L')}
          padBottom={transfers.length > 0}
          onConnect={() => connect(L)}
          onTerminal={() => terminal(L)}
          onNewFolder={() => setNewFolder('L')}
        />
        <div className="flex flex-col items-center justify-center gap-2">
          <ArrowButton title={lr ?? t('Chép {n} mục sang {dest} (⌘→)', { n: L.selected.length, dest: where(R.src, R.path) })} off={!!lr} onClick={() => copySelection('L')}>
            <ArrowRight size={16} strokeWidth={1.9} />
          </ArrowButton>
          <span className="num h-4 text-[11px] text-muted">{L.selected.length ? `${L.selected.length} →` : R.selected.length ? `← ${R.selected.length}` : ''}</span>
          <ArrowButton title={rl ?? t('Chép {n} mục sang {dest} (⌘←)', { n: R.selected.length, dest: where(L.src, L.path) })} off={!!rl} onClick={() => copySelection('R')}>
            <ArrowLeft size={16} strokeWidth={1.9} />
          </ArrowButton>
        </div>
        <Pane
          pane={R}
          home={home}
          active={active === 'R'}
          onActivate={() => setActive('R')}
          otherNames={namesOf(L)}
          sources={sources}
          onPickSource={(k) => pickSource('R', k)}
          onRowMouseDown={rowMouseDown('R')}
          drop={hint('R')}
          padBottom={transfers.length > 0}
          onConnect={() => connect(R)}
          onTerminal={() => terminal(R)}
          onNewFolder={() => setNewFolder('R')}
        />
      </div>

      <span className="flex-none text-[11px] text-muted">
        {t('Phím tắt: ⇥ đổi pane · ↑↓ di chuyển (⇧ chọn dải) · Space chọn · ↵ mở thư mục · ⌫ lên thư mục cha · ⌘A chọn hết · ⌘→ ⌘← chép sang bên kia')}
      </span>

      <TransferQueue />

      {dragging?.started && (
        <div
          className="pointer-events-none fixed z-50 rounded-md border border-line2 bg-surface px-2 py-1 text-[11.5px] shadow-pop"
          style={{ left: dragging.x + 14, top: dragging.y + 12 }}
        >
          {dragging.names.length === 1 ? dragging.names[0] : t('{n} mục', { n: dragging.names.length })}
        </div>
      )}

      {conflict && (
        <ConflictDialog
          where={where(panes[conflict.to].src, conflict.dir)}
          clashes={conflict.clashes}
          total={conflict.items.length}
          onCancel={() => setConflict(null)}
          onChoose={(c) => resolve(conflict, c)}
        />
      )}

      {newFolder && <NewFolder pane={panes[newFolder]} onClose={() => setNewFolder(null)} />}

      {asking && askServer && asking.src.kind === 'remote' && asking.conn?.status === 'prompt' && (
        <ConnectPrompt
          server={askServer}
          user={asking.src.user}
          prompt={asking.conn.prompt}
          onCancel={() => asking.src.kind === 'remote' && conns.markLost(asking.src.serverId, asking.src.user, { code: 'cancelled' })}
        />
      )}
    </div>
  )
}

function ArrowButton({ title, off, onClick, children }: { title: string; off: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      aria-disabled={off}
      className={cx(
        'flex size-9 items-center justify-center rounded-lg border',
        off ? 'cursor-not-allowed border-line2 text-muted opacity-50' : 'cursor-pointer border-accent bg-accent text-accent-fg hover:opacity-90',
      )}
    >
      {children}
    </button>
  )
}

function NewFolder({ pane: p, onClose }: { pane: PaneState; onClose: () => void }) {
  const toast = useToast()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const dir = p.path
  const submit = async () => {
    const n = value.trim()
    if (!n || busy) return
    setBusy(true)
    try {
      const made = p.src.kind === 'local' ? await api.localMkdir(dir, n) : await api.sftpMkdir(p.src.serverId, p.src.user, dir, n)
      onClose()
      await p.reload()
      const created = baseName(made)
      p.select([created], created)
      p.setCursor(created)
    } catch (e) {
      toast({ title: t('Không tạo được thư mục'), detail: isAppError(e) ? fileError(e) : String(e) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      width={420}
      title={t('Thư mục mới')}
      subtitle={dir}
      footer={
        <>
          <Button onClick={onClose}>{t('Huỷ')}</Button>
          <Button variant="primary" disabled={!value.trim() || busy} onClick={() => void submit()}>
            {t('Tạo')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <TextInput value={value} onChange={setValue} placeholder={t('ten-thu-muc')} autoFocus />
      </form>
    </Modal>
  )
}
