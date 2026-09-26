import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ChevronsRight,
  Copy,
  Download,
  Folder,
  Lock,
  AppWindow,
  FilePen,
  Pencil,
  ScrollText,
  ShieldCheck,
  SquareTerminal,
  Terminal,
  Trash2,
  Upload,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { useConnections } from '../../app/connections'
import { useEdits } from '../../app/edits'
import { useSettings } from '../../app/settings'
import { useNav } from '../../app/nav'
import { readCache, writeCache } from '../../app/session-cache'
import { useTransfers } from '../../app/transfers'
import { useToast } from '../../components/toast'
import { Modal } from '../../components/ui/modal'
import { Button, cx } from '../../components/ui/primitives'
import { SearchInput } from '../../components/ui/search-input'
import { api, isAppError, type AppError, type FileEntry, type Listing, type Server } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import { chooseDownloadDir } from '../../lib/download-dir'
import { formatBytes } from '../server/format'
import { FileDialog, type FileAction } from './dialogs'
import { crumbs, fileError, fullTime, isDirLike, joinPath, matcher, modeString, octal, parentOf, q, shortTime, tagOf, typeChar } from './format'
import { LogTail } from './log-tail'
import { TransferQueue } from './queue'

const GRID = '28px minmax(160px,1fr) 72px 104px 92px'
const SKELETON = ['60%', '45%', '70%', '40%', '55%', '65%']

type SortKey = 'name' | 'size' | 'mtime'
type Sort = { key: SortKey; dir: 1 | -1 }
type Selection = { path: string; names: string[]; anchor: string | null }
/** Kept in the session cache: the folder and its last listing. */
type Cached = { path: string; listing: Listing | null }

const asError = (e: unknown): AppError => (isAppError(e) ? e : { code: 'unknown', detail: String(e) })
const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p
const ownerOf = (e: FileEntry) => e.owner ?? String(e.uid ?? '?')
const groupOf = (e: FileEntry) => e.group ?? String(e.gid ?? '?')

function tagColors(e: FileEntry): [string, string] {
  if (e.kind === 'link') return ['var(--sunken)', 'var(--ink2)']
  if (isDirLike(e)) return ['var(--info-soft)', 'var(--info)']
  return ['var(--sunken)', 'var(--muted)']
}

/** The "Tệp (SFTP)" module: browse, manage and transfer files as the session's user. */
export function FilesScreen({ server, user }: { server: Server; user: string }) {
  const id = server.id
  const conns = useConnections()
  const nav = useNav()
  const toast = useToast()
  const edits = useEdits()
  const [chooseApp, setChooseApp] = useState<FileEntry | null>(null)
  const conn = conns.get(id, user)
  const live = conn?.status === 'connected'
  const sudo = live && conn.sudo
  const isRoot = user === 'root'
  const canChown = isRoot || sudo

  const [initial] = useState(() => readCache<Cached>(id, user, 'files')?.data)
  const [listing, setListing] = useState<Listing | null>(initial?.listing ?? null)
  const [error, setError] = useState<AppError | null>(null)
  const [loading, setLoading] = useState(false)
  const pathRef = useRef(initial?.path ?? '')
  const hasListing = useRef(!!listing)
  const seq = useRef(0)

  const load = useCallback(
    async (target: string): Promise<boolean> => {
      const n = ++seq.current
      setLoading(true)
      try {
        const l = await api.sftpList(id, user, target)
        if (n !== seq.current) return true
        setListing(l)
        setError(null)
        pathRef.current = l.path
        hasListing.current = true
        writeCache(id, user, 'files', { path: l.path, listing: l } satisfies Cached, new Date())
        return true
      } catch (e) {
        if (n !== seq.current) return false
        const err = asError(e)
        if (err.code === 'connection_lost' || err.code === 'not_connected') conns.markLost(id, user, err)
        else if (!hasListing.current) setError(err)
        else toast({ title: 'Không mở được thư mục', detail: fileError(err) })
        return false
      } finally {
        if (n === seq.current) setLoading(false)
      }
    },
    [id, user, conns, toast],
  )
  const reload = useCallback(() => load(pathRef.current), [load])

  // Read again whenever the session is (back) up; the cached listing shows meanwhile.
  useEffect(() => {
    if (live) void reload()
  }, [live, reload])

  const path = listing?.path ?? ''
  const dir = listing?.dir
  const canWrite = isRoot || !!dir?.writable

  // Filter, hidden files, sort.
  const [filter, setFilter] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [sort, setSort] = useState<Sort>({ key: 'name', dir: 1 })
  const all = useMemo(() => listing?.entries ?? [], [listing])
  const hiddenCount = all.filter((e) => e.name.startsWith('.')).length
  const shown = useMemo(() => {
    const match = matcher(filter)
    return all
      .filter((e) => (showHidden || !e.name.startsWith('.')) && match(e.name))
      .sort((a, b) => {
        const da = isDirLike(a)
        if (da !== isDirLike(b)) return da ? -1 : 1
        const by =
          sort.key === 'size' ? a.size - b.size : sort.key === 'mtime' ? (a.mtime ?? 0) - (b.mtime ?? 0) : a.name.localeCompare(b.name, 'en', { numeric: true })
        return by * sort.dir || a.name.localeCompare(b.name)
      })
  }, [all, filter, showHidden, sort])
  const order = shown.map((e) => e.name)

  // Selection belongs to one folder; names that are filtered away drop out.
  const [selection, setSelection] = useState<Selection>({ path: '', names: [], anchor: null })
  const selNames = selection.path === path ? selection.names.filter((n) => order.includes(n)) : []
  const sel = shown.filter((e) => selNames.includes(e.name))
  const one = sel.length === 1 ? sel[0] : null
  const select = (names: string[], anchor: string | null) => setSelection({ path, names, anchor })

  const clickRow = (e: MouseEvent, name: string) => {
    const on = selNames.includes(name)
    if (e.shiftKey && selection.anchor && selection.path === path && order.includes(selection.anchor)) {
      const a = order.indexOf(selection.anchor)
      const b = order.indexOf(name)
      const range = order.slice(Math.min(a, b), Math.max(a, b) + 1)
      select(e.metaKey || e.ctrlKey ? [...new Set([...selNames, ...range])] : range, selection.anchor)
    } else if (e.metaKey || e.ctrlKey) select(on ? selNames.filter((n) => n !== name) : [...selNames, name], name)
    else select([name], name)
  }

  const go = (target: string) => {
    setFilter('')
    return load(target)
  }

  // Dialogs.
  const [action, setAction] = useState<FileAction | null>(null)
  // A file followed with tail -F takes the place of the list until closed.
  const [tailing, setTailing] = useState<{ path: string; sudo: boolean } | null>(null)
  const [panel, setPanel] = useState(true)
  const [more, setMore] = useState(false)

  const run = async (what: () => Promise<unknown>, fail: string) => {
    try {
      await what()
    } catch (e) {
      const err = asError(e)
      if (err.code === 'connection_lost' || err.code === 'not_connected') conns.markLost(id, user, err)
      else toast({ title: fail, detail: fileError(err) })
    }
  }

  const terminalAt = (cwd: string) =>
    run(() => api.openTerminal(id, user, undefined, cwd).then(() => toast({ title: 'Đã mở Terminal', detail: `cd ${q(cwd)}` })), 'Không mở được Terminal')

  const download = (entries: FileEntry[]) =>
    run(async () => {
      if (!isTauri()) return toast({ title: 'Chỉ tải xuống được trong ứng dụng' })
      const dest = await chooseDownloadDir(entries.length)
      if (!dest) return
      // The queue opens on its own and shows progress; no toast on top of it.
      await api.download(server.name, id, user, entries.map((e) => e.path), dest)
    }, 'Không tải xuống được')

  // Uploads: names that already exist ask first.
  const [conflict, setConflict] = useState<{ paths: string[]; clashes: string[] } | null>(null)
  const sendUpload = (paths: string[], overwrite: boolean) =>
    run(
      () => api.upload(server.name, id, user, paths, path, overwrite),
      'Không tải lên được',
    )
  const startUpload = (paths: string[]) => {
    if (!paths.length || !listing) return
    const names = new Set(all.map((e) => e.name))
    const clashes = paths.map(baseName).filter((n) => names.has(n))
    if (clashes.length) setConflict({ paths, clashes })
    else void sendUpload(paths, false)
  }
  const pickUpload = async () => {
    if (!isTauri()) return toast({ title: 'Chỉ tải lên được trong ứng dụng' })
    const picked = await openDialog({ multiple: true, title: `Tải lên ${path}` })
    if (picked) startUpload(Array.isArray(picked) ? picked : [picked])
  }

  // Files dropped from Finder (Tauri gives real paths, the DOM does not).
  const [dropping, setDropping] = useState(false)
  const dropRef = useRef({ canWrite, startUpload })
  dropRef.current = { canWrite, startUpload }
  useEffect(() => {
    if (!isTauri()) return
    const off = getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload
      if (p.type === 'enter' || p.type === 'over') setDropping(dropRef.current.canWrite)
      else if (p.type === 'leave') setDropping(false)
      else if (p.type === 'drop') {
        setDropping(false)
        if (dropRef.current.canWrite) dropRef.current.startUpload(p.paths)
        else toast({ title: 'Không tải lên được', detail: 'Không có quyền ghi vào thư mục này' })
      }
    })
    return () => {
      void off.then((f) => f())
    }
  }, [toast])

  // Show new uploads once they land in the folder on screen.
  const { list: transfers } = useTransfers()
  const queueShown = transfers.length > 0
  const seen = useRef<Set<string> | null>(null)
  useEffect(() => {
    const finished = transfers.filter((t) => t.direction === 'up' && t.status === 'done' && t.serverId === id && t.user === user)
    if (!seen.current) {
      seen.current = new Set(finished.map((t) => t.id))
      return
    }
    const fresh = finished.filter((t) => !seen.current!.has(t.id))
    fresh.forEach((t) => seen.current!.add(t.id))
    if (fresh.some((t) => parentOf(t.target) === pathRef.current)) void reload()
  }, [transfers, id, user, reload])

  // Files saved from an editor on this Mac: show their new size and time.
  const editStamp = edits.list
    .filter((e) => e.serverId === id && e.user === user && e.status === 'synced' && parentOf(e.remotePath) === path)
    .map((e) => `${e.id}:${e.syncedAt}`)
    .join()
  const lastStamp = useRef(editStamp)
  useEffect(() => {
    if (editStamp === lastStamp.current) return
    lastStamp.current = editStamp
    if (editStamp) void reload()
  }, [editStamp, reload])

  // Another open session of this server as root, to open a folder this user cannot.
  const rootAccount = !isRoot && server.accounts.some((a) => a.user === 'root')
  const openAsRoot = () => {
    writeCache(id, 'root', 'files', { path, listing: null } satisfies Cached, new Date(0))
    if (!nav.sessions.some((s) => s.serverId === id && s.user === 'root')) nav.connect(id, 'root')
    nav.go({ kind: 'server', serverId: id, user: 'root', module: 'files' })
  }

  const onDone = (message: string, detail: string, name?: string) => {
    setAction(null)
    toast({ title: message, detail })
    void reload().then(() => name && setSelection({ path: pathRef.current, names: [name], anchor: name }))
  }

  if (tailing) {
    return <LogTail server={server} user={user} path={tailing.path} sudo={tailing.sudo} onClose={() => setTailing(null)} />
  }

  if (!listing) {
    return error ? (
      <div className="flex flex-col items-center gap-2.5 rounded-xl border border-line bg-surface px-6 py-10 text-center">
        <span className="text-[14px] font-semibold">Không mở được SFTP</span>
        <span className="max-w-[460px] leading-normal text-muted">{fileError(error)}</span>
        <Button size="sm" onClick={() => void reload()}>
          Thử lại
        </Button>
      </div>
    ) : (
      <div className="flex min-h-0 flex-1 flex-col">
        <Table loading />
      </div>
    )
  }

  const allOn = order.length > 0 && selNames.length === order.length
  const match = filter.trim()

  return (
    <div className="relative flex min-h-0 flex-1 flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <PathBar path={path} go={go} />
        <Button size="sm" onClick={() => void pickUpload()} disabled={!canWrite}>
          Tải lên
        </Button>
        <Button size="sm" onClick={() => setAction({ mode: 'newfile' })} disabled={!canWrite}>
          Tệp mới
        </Button>
        <Button size="sm" onClick={() => setAction({ mode: 'newdir' })} disabled={!canWrite}>
          Thư mục mới
        </Button>
        <Button
          size="sm"
          title="Mở màn Chuyển tệp với thư mục này ở bên trái"
          onClick={() => nav.openTransfer({ src: { kind: 'remote', serverId: id, user }, path })}
        >
          Chép sang máy khác
        </Button>
        <button
          type="button"
          title="Mở thư mục này trong Terminal"
          onClick={() => void terminalAt(path)}
          className="flex size-8 cursor-pointer items-center justify-center rounded-lg border border-line2 text-ink hover:border-muted"
        >
          <Terminal size={15} strokeWidth={1.8} />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={filter} onChange={setFilter} placeholder="Lọc trong thư mục (hỗ trợ *.log)" className="w-60 min-w-0" />
        <Button size="sm" variant={showHidden ? 'primary' : 'secondary'} onClick={() => setShowHidden(!showHidden)}>
          {showHidden ? 'Đang hiện tệp ẩn' : 'Tệp ẩn'} ({hiddenCount})
        </Button>
        <span className="flex-1" />
        {!listing.denied && (
          <span className="num text-[11px] text-muted">
            {shown.length} mục{match ? ' khớp' : ''}
          </span>
        )}
        {!panel && (
          <Button size="sm" onClick={() => setPanel(true)}>
            Hiện chi tiết
          </Button>
        )}
      </div>

      <div className="flex min-h-[260px] flex-1 gap-3">
        <Table
          loading={false}
          dim={loading}
          padBottom={queueShown}
          overlay={
            dropping && (
              <div className="pointer-events-none absolute inset-1.5 flex flex-col items-center justify-center gap-1.5 rounded-[10px] border-2 border-dashed border-accent bg-[color-mix(in_srgb,var(--surface)_80%,transparent)]">
                <Upload size={24} strokeWidth={1.8} />
                <span className="text-[14px] font-semibold">Thả để tải lên {path}</span>
                <span className="text-[11.5px] text-ink2">
                  {user}@{server.name}
                </span>
              </div>
            )
          }
          head={
            <>
              <button type="button" title="Chọn tất cả" onClick={() => select(allOn ? [] : order, null)} className="flex cursor-pointer">
                <Box on={allOn} />
              </button>
              <span className="flex items-center gap-2.5 whitespace-nowrap">
                <SortButton label="Tên" k="name" sort={sort} setSort={setSort} />
                {selNames.length > 0 && <span className="text-ink2">{`Đã chọn ${selNames.length}/${order.length}`}</span>}
              </span>
              <span className="flex justify-end">
                <SortButton label="Kích thước" k="size" sort={sort} setSort={setSort} />
              </span>
              <SortButton label="Sửa lần cuối" k="mtime" sort={sort} setSort={setSort} />
              <span>Quyền</span>
            </>
          }
        >
          {path !== '/' && (
            <Row onClick={() => void go(parentOf(path))} title="Lên thư mục cha">
              <span />
              <span className="flex items-center gap-2">
                <Tag text="↑" colors={['var(--sunken)', 'var(--muted)']} />
                <span className="font-semibold">..</span>
              </span>
            </Row>
          )}

          {listing.denied ? (
            <Blank icon={Lock} title="Không có quyền đọc thư mục này">
              <span className="max-w-[420px] leading-normal text-muted">
                {path} thuộc {ownerOf(listing.dir)}:{groupOf(listing.dir)}, quyền {octal(listing.dir.mode)}. User {user} không có quyền đọc và mở thư mục này.
              </span>
              {rootAccount && (
                <Button size="xs" onClick={openAsRoot}>
                  Mở bằng kết nối root
                </Button>
              )}
            </Blank>
          ) : all.length === 0 ? (
            <Blank icon={Folder} title="Thư mục trống">
              <span className="text-muted">{canWrite ? 'Kéo tệp từ máy vào đây để tải lên, hoặc tạo mới.' : 'Bạn không có quyền ghi vào thư mục này.'}</span>
              {canWrite && (
                <div className="flex gap-1.5">
                  <Button size="xs" onClick={() => void pickUpload()}>
                    Tải lên
                  </Button>
                  <Button size="xs" onClick={() => setAction({ mode: 'newfile' })}>
                    Tệp mới
                  </Button>
                </div>
              )}
            </Blank>
          ) : shown.length === 0 ? (
            <div className="p-7 text-center text-muted">
              {match ? `Không có mục nào khớp "${match}"` : 'Chỉ có tệp ẩn trong thư mục này. Bật "Tệp ẩn" để xem.'}
            </div>
          ) : (
            shown.map((e) => {
              const on = selNames.includes(e.name)
              const broken = e.kind === 'link' && e.targetKind == null
              return (
                <Row
                  key={e.name}
                  selected={on}
                  onClick={(ev) => clickRow(ev, e.name)}
                  onDoubleClick={() => (isDirLike(e) ? void go(e.path) : e.kind === 'file' && void edits.open(id, user, e.path))}
                >
                  <button
                    type="button"
                    title="Chọn"
                    onClick={(ev) => {
                      ev.stopPropagation()
                      select(on ? selNames.filter((n) => n !== e.name) : [...selNames, e.name], e.name)
                    }}
                    className="flex cursor-pointer"
                  >
                    <Box on={on} />
                  </button>
                  <span className="flex min-w-0 items-center gap-2">
                    <Tag text={tagOf(e)} colors={tagColors(e)} />
                    <span className={cx('truncate', isDirLike(e) && 'font-semibold', e.readable ? 'text-ink' : 'text-ink2')}>{e.name}</span>
                    {!e.readable && !broken && (
                      <span title={`Không có quyền đọc (${ownerOf(e)}:${groupOf(e)} · ${octal(e.mode)})`} className="flex text-warn">
                        <Lock size={12} strokeWidth={1.8} />
                      </span>
                    )}
                    {e.kind === 'link' && (
                      <span className={cx('min-w-0 truncate font-mono text-[11px]', broken ? 'text-danger' : 'text-muted')}>
                        → {e.linkTarget ?? '?'}
                        {broken ? ' (hỏng)' : ''}
                      </span>
                    )}
                  </span>
                  <span className="num text-right text-ink2">{isDirLike(e) || e.kind === 'link' ? '—' : formatBytes(e.size)}</span>
                  <span className="num text-muted">{shortTime(e.mtime)}</span>
                  <span className="font-mono text-[11px] text-muted">
                    {typeChar(e)}
                    {modeString(e.mode)}
                  </span>
                </Row>
              )
            })
          )}

        </Table>

        {panel && (
          <Details
            server={server}
            user={user}
            listing={listing}
            sel={sel}
            one={one}
            sudo={sudo}
            canWrite={canWrite}
            canChown={canChown}
            rootAccount={rootAccount}
            openAsRoot={openAsRoot}
            more={more}
            setMore={setMore}
            onCollapse={() => setPanel(false)}
            padBottom={queueShown}
            act={{
              rename: () => one && setAction({ mode: 'rename', entry: one }),
              chmod: () => setAction({ mode: 'chmod', entries: sel }),
              chown: () => setAction({ mode: 'chown', entries: sel }),
              remove: () => setAction({ mode: 'delete', entries: sel }),
              download: () => void download(sel),
              copy: () => {
                const text = sel.map((e) => e.path).join('\n')
                void run(() => copyText(text).then(() => toast({ title: 'Đã sao chép', detail: text })), 'Không sao chép được')
              },
              terminal: () => one && void terminalAt(isDirLike(one) ? one.path : path),
              follow: () => one && setTailing({ path: one.path, sudo: !isRoot && !one.readable && sudo }),
              edit: () => one && void edits.open(id, user, one.path),
              editWith: () => one && setChooseApp(one),
            }}
          />
        )}
      </div>

      <TransferQueue />

      {action && (
        <FileDialog action={action} serverId={id} user={user} dir={path} canChown={canChown} onClose={() => setAction(null)} onDone={onDone} />
      )}

      {chooseApp && (
        <Modal open onClose={() => setChooseApp(null)} width={420} title={`Mở ${chooseApp.name} bằng…`} subtitle="Lưu trong app là Portway tự tải lên server">
          <div className="flex flex-col gap-px">
            {[{ name: 'Editor mặc định của macOS', path: '' }, ...edits.apps].map((a) => (
              <button
                key={a.path || 'default'}
                type="button"
                onClick={() => {
                  setChooseApp(null)
                  void edits.open(id, user, chooseApp.path, a.path || null)
                }}
                className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-raised"
              >
                <AppWindow size={15} strokeWidth={1.8} className="text-ink2" />
                <span className="flex-1">{a.name}</span>
                {a.path && <span className="truncate font-mono text-[10.5px] text-muted">{a.path.replace(/\/[^/]+$/, '')}</span>}
              </button>
            ))}
          </div>
        </Modal>
      )}

      {conflict && (
        <Modal
          open
          onClose={() => setConflict(null)}
          width={480}
          title={conflict.clashes.length === 1 ? `Đã có ${conflict.clashes[0]} trong thư mục này` : `${conflict.clashes.length} mục đã có trong thư mục này`}
          subtitle={path}
          footer={
            <>
              <Button onClick={() => setConflict(null)}>Huỷ</Button>
              {conflict.paths.length > conflict.clashes.length && (
                <Button
                  onClick={() => {
                    const skip = new Set(conflict.clashes)
                    setConflict(null)
                    void sendUpload(conflict.paths.filter((p) => !skip.has(baseName(p))), false)
                  }}
                >
                  Bỏ qua mục trùng
                </Button>
              )}
              <Button
                variant="danger"
                onClick={() => {
                  setConflict(null)
                  void sendUpload(conflict.paths, true)
                }}
              >
                Ghi đè
              </Button>
            </>
          }
        >
          <span className="leading-relaxed text-ink2">
            Ghi đè sẽ thay nội dung tệp trên server bằng tệp từ máy này. Thư mục trùng tên được gộp: tệp trùng bên trong cũng bị ghi đè.
          </span>
          <div className="flex max-h-40 flex-col overflow-auto rounded-lg border border-line">
            {conflict.clashes.map((n) => (
              <span key={n} className="truncate border-t border-line px-2.5 py-1.5 font-mono text-[11.5px] first:border-t-0">
                {joinPath(path, n)}
              </span>
            ))}
          </div>
        </Modal>
      )}
    </div>
  )
}

/** Breadcrumbs; a click on the empty part turns them into a path input. */
function PathBar({ path, go }: { path: string; go: (p: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState<string | null>(null)
  const [bad, setBad] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  // Select the whole path when editing starts.
  const editing = draft !== null
  useEffect(() => {
    if (editing) input.current?.select()
  }, [editing])

  const submit = async () => {
    const raw = (draft ?? '').trim()
    // "~" is the user's home, which the server resolves from an empty path.
    const target = raw === '' || raw === '~' ? '' : raw.startsWith('/') ? raw : joinPath(path, raw)
    if (await go(target)) {
      setDraft(null)
      setBad(false)
    } else setBad(true)
  }

  if (draft !== null) {
    return (
      <input
        ref={input}
        value={draft}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        placeholder="/var/www"
        onChange={(e) => {
          setDraft(e.target.value)
          setBad(false)
        }}
        onBlur={() => {
          setDraft(null)
          setBad(false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit()
          if (e.key === 'Escape') {
            setDraft(null)
            setBad(false)
          }
        }}
        className={cx(
          'h-8 min-w-[220px] flex-1 rounded-lg border border-line2 bg-sunken px-2.5 font-mono text-[12px] text-ink outline-none select-text focus:border-accent',
          bad && '!border-danger',
        )}
      />
    )
  }

  const list = crumbs(path)
  return (
    <div
      onClick={() => setDraft(path)}
      title="Bấm vào khoảng trống để nhập đường dẫn"
      className="flex h-8 min-w-[220px] flex-1 cursor-text items-center gap-0.5 overflow-hidden rounded-lg border border-line2 bg-sunken px-2 font-mono text-[12px]"
    >
      {list.map((c, i) => (
        <span key={c.path} className="flex min-w-0 items-center">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              void go(c.path)
            }}
            className={cx('cursor-pointer truncate rounded px-[3px] py-px hover:bg-accent-soft', i === list.length - 1 ? 'text-ink' : 'text-ink2')}
          >
            {c.label}
          </button>
          {i > 0 && i < list.length - 1 && <span className="text-muted">/</span>}
        </span>
      ))}
    </div>
  )
}

/** Fills the height it is given; rows scroll inside under a fixed header. */
function Table({
  loading,
  dim,
  head,
  overlay,
  padBottom,
  children,
}: {
  loading: boolean
  dim?: boolean
  head?: ReactNode
  overlay?: ReactNode
  /** Room under the last row so it can scroll out from under the floating queue. */
  padBottom?: boolean
  children?: ReactNode
}) {
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface">
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain transition-opacity" style={{ opacity: dim ? 0.6 : 1 }}>
        <div
          className="sticky top-0 z-[1] grid items-center gap-3 bg-sunken px-3.5 py-2 text-[11px] text-muted"
          style={{ gridTemplateColumns: GRID }}
        >
          {head ?? (
            <>
              <span />
              <span>Tên</span>
              <span className="text-right">Kích thước</span>
              <span>Sửa lần cuối</span>
              <span>Quyền</span>
            </>
          )}
        </div>
        {loading
          ? SKELETON.map((w, i) => (
              <div key={i} className="grid items-center gap-3 border-t border-line px-3.5 py-2.5" style={{ gridTemplateColumns: GRID }}>
                <span className="size-[15px] rounded bg-sunken" />
                <span className="h-3 rounded-[5px] bg-sunken" style={{ width: w }} />
                <span className="h-2.5 rounded-[5px] bg-sunken" />
                <span className="h-2.5 rounded-[5px] bg-sunken" />
                <span className="h-2.5 rounded-[5px] bg-sunken" />
              </div>
            ))
          : children}
        {padBottom && <div className="h-14" />}
      </div>
      {overlay}
    </div>
  )
}

function Row({
  selected,
  onClick,
  onDoubleClick,
  title,
  children,
}: {
  selected?: boolean
  onClick: (e: MouseEvent) => void
  onDoubleClick?: () => void
  title?: string
  children: ReactNode
}) {
  return (
    <div
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      title={title}
      className={cx('grid cursor-default items-center gap-3 border-t border-line px-3.5 py-[7px] select-none', selected ? 'bg-accent-soft' : 'hover:bg-raised')}
      style={{ gridTemplateColumns: GRID }}
    >
      {children}
    </div>
  )
}

function Box({ on }: { on: boolean }) {
  return (
    <span
      className={cx(
        'block size-[15px] rounded border text-center text-[10px] leading-[13px] text-accent-fg',
        on ? 'border-accent bg-accent' : 'border-line2 bg-transparent',
      )}
    >
      {on ? '✓' : ''}
    </span>
  )
}

function Tag({ text, colors, large }: { text: string; colors: [string, string]; large?: boolean }) {
  return (
    <span
      className={cx('flex-none text-center font-mono text-[10px]', large ? 'min-w-[30px] rounded-[5px] px-1 py-[3px]' : 'w-[30px] rounded py-px')}
      style={{ background: colors[0], color: colors[1] }}
    >
      {text}
    </span>
  )
}

function SortButton({ label, k, sort, setSort }: { label: string; k: SortKey; sort: Sort; setSort: (s: Sort) => void }) {
  const on = sort.key === k
  const Icon = on && sort.dir === -1 ? ArrowDown : ArrowUp
  return (
    <button
      type="button"
      onClick={() => setSort({ key: k, dir: on ? (sort.dir === 1 ? -1 : 1) : k === 'name' ? 1 : -1 })}
      className={cx('inline-flex cursor-pointer items-center gap-[3px] text-[11px]', on ? 'text-ink' : 'text-muted')}
    >
      {label}
      <span className="flex" style={{ opacity: on ? 1 : 0 }}>
        <Icon size={11} strokeWidth={1.8} />
      </span>
    </button>
  )
}

function Blank({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2.5 border-t border-line px-6 py-10 text-center">
      <span className="flex text-muted">
        <Icon size={22} strokeWidth={1.8} />
      </span>
      <span className="text-[14px] font-semibold">{title}</span>
      {children}
    </div>
  )
}

type Acts = Record<'rename' | 'chmod' | 'chown' | 'remove' | 'download' | 'copy' | 'terminal' | 'follow' | 'edit' | 'editWith', () => void>

/** Right-hand panel: what this user may do with the selection, its details and the actions. */
function Details({
  user,
  listing,
  sel,
  one,
  sudo,
  canWrite,
  canChown,
  rootAccount,
  openAsRoot,
  more,
  setMore,
  onCollapse,
  padBottom,
  act,
}: {
  server: Server
  user: string
  listing: Listing
  sel: FileEntry[]
  one: FileEntry | null
  sudo: boolean
  canWrite: boolean
  canChown: boolean
  rootAccount: boolean
  openAsRoot: () => void
  more: boolean
  setMore: (v: boolean) => void
  onCollapse: () => void
  padBottom: boolean
  act: Acts
}) {
  const { settings } = useSettings()
  const { apps } = useEdits()
  const editorName = settings.editor ? (apps.find((a) => a.path === settings.editor)?.name ?? settings.editor.split('/').pop()!.replace(/\.app$/, '')) : null
  const isRoot = user === 'root'
  const dir = listing.dir
  const path = listing.path
  const sudoNote = sudo && !isRoot ? ' Sudo đang bật nhưng thao tác tệp vẫn chạy bằng quyền của ' + user + '; chỉ Đổi owner dùng sudo.' : ''

  // "Quyền của bạn": which bits apply and what they allow.
  let access: { text: string; why: string; bad: boolean; soft: boolean }
  if (!sel.length) {
    const read = isRoot || dir.readable
    const write = canWrite
    access = {
      text: 'Thư mục này: ' + [read ? 'Xem nội dung' : 'Không xem được', write ? 'Tạo, xoá bên trong' : 'Không tạo, xoá được'].join(' · '),
      why: isRoot ? 'Đang dùng root, không bị giới hạn quyền.' : `${path} thuộc ${ownerOf(dir)}:${groupOf(dir)} · ${octal(dir.mode)}.` + sudoNote,
      bad: !read || !write,
      soft: false,
    }
  } else if (one) {
    const r = isRoot || one.readable
    const w = isRoot || one.writable
    const bits = modeString(one.mode)
    const who =
      one.class === 'root'
        ? 'Bạn đang là root.'
        : one.class === 'owner'
          ? `Bạn là owner, áp dụng quyền owner: ${bits.slice(0, 3)}.`
          : one.class === 'group'
            ? `Bạn thuộc nhóm ${groupOf(one)}, áp dụng quyền group: ${bits.slice(3, 6)}.`
            : `Owner là ${ownerOf(one)}, bạn không thuộc nhóm ${groupOf(one)} nên áp dụng quyền others: ${bits.slice(6, 9)}.`
    access = {
      text: (isDirLike(one) ? [r ? 'Xem nội dung' : 'Không xem được', w ? 'Tạo, xoá bên trong' : 'Không tạo, xoá được'] : [r ? 'Đọc' : 'Không đọc', w ? 'Ghi' : 'Không ghi']).join(' · '),
      why: who + sudoNote,
      bad: !r,
      soft: r && !w,
    }
  } else {
    const nr = isRoot ? 0 : sel.filter((e) => !e.readable).length
    const nw = isRoot ? 0 : sel.filter((e) => !e.writable).length
    access = {
      text: nr || nw ? [nr ? `${nr} mục không đọc được` : '', nw ? `${nw} mục không ghi được` : ''].filter(Boolean).join(' · ') : 'Đọc · Ghi tất cả',
      why: 'Tính theo owner, group và quyền của từng mục.' + sudoNote,
      bad: nr > 0,
      soft: nw > 0,
    }
  }
  const escalate = !isRoot && rootAccount && (access.bad || access.soft || (!sel.length && !canWrite))

  const head = one
    ? { tag: tagOf(one), colors: tagColors(one), title: one.name, sub: path }
    : sel.length
      ? { tag: String(sel.length), colors: ['var(--accent-soft)', 'var(--ink)'] as [string, string], title: `Đã chọn ${sel.length} mục`, sub: path }
      : { tag: 'DIR', colors: ['var(--info-soft)', 'var(--info)'] as [string, string], title: path.split('/').filter(Boolean).pop() ?? '/', sub: 'Thư mục hiện tại' }

  const rows: [string, ReactNode, boolean?, string?][] = one
    ? [
        ['Đường dẫn', one.path, true],
        ['Loại', one.kind === 'link' ? 'Liên kết tượng trưng' : one.kind === 'dir' ? 'Thư mục' : one.kind === 'other' ? 'Tệp đặc biệt' : tagOf(one) === 'FILE' ? 'Tệp' : `Tệp .${tagOf(one).toLowerCase()}`],
        ...(one.kind === 'link'
          ? ([
              ['Trỏ tới', one.linkTarget ?? '?', true, one.targetKind ? undefined : 'var(--danger)'],
              [
                'Trạng thái link',
                one.targetKind ? `Hoạt động · ${one.targetKind === 'dir' ? 'thư mục' : 'tệp'}` : 'Hỏng, đích không tồn tại',
                false,
                one.targetKind ? 'var(--success)' : 'var(--danger)',
              ],
            ] as [string, ReactNode, boolean?, string?][])
          : []),
        ['Kích thước', isDirLike(one) || one.kind === 'link' ? '—' : formatBytes(one.size) + (one.size >= 1024 ? ` (${one.size.toLocaleString('vi-VN')} byte)` : '')],
        ['Quyền', `${typeChar(one)}${modeString(one.mode)}  ·  ${octal(one.mode)}`, true],
        ['Owner', ownerOf(one), true],
        ['Group', groupOf(one), true],
        ['Sửa lần cuối', fullTime(one.mtime)],
      ]
    : sel.length
      ? [
          ['Số mục', `${sel.filter((e) => !isDirLike(e)).length} tệp · ${sel.filter(isDirLike).length} thư mục`],
          [
            'Tổng dung lượng',
            formatBytes(sel.filter((e) => e.kind === 'file').reduce((a, e) => a + e.size, 0)) + (sel.some(isDirLike) ? ' (chưa tính nội dung thư mục)' : ''),
          ],
          ['Quyền', [...new Set(sel.map((e) => octal(e.mode)))].join(', '), true],
          ['Owner', [...new Set(sel.map((e) => `${ownerOf(e)}:${groupOf(e)}`))].join(', '), true],
          ['Thư mục', path, true],
        ]
      : []

  const ownsAll = sel.length > 0 && sel.every((e) => e.class === 'owner' || e.class === 'root')
  const actions: { label: string; icon: LucideIcon; run: () => void; ok: boolean; why?: string; meta?: string; danger?: boolean }[] = sel.length
    ? [
        { label: 'Đổi tên', icon: Pencil, run: act.rename, ok: !!one && canWrite, why: !one ? 'Chỉ đổi tên được một mục' : `Cần quyền ghi trên ${path}` },
        { label: 'Sửa quyền', icon: ShieldCheck, run: act.chmod, ok: ownsAll, why: 'Chỉ owner hoặc root mới đổi được quyền', meta: 'chmod' },
        { label: 'Đổi owner', icon: Users, run: act.chown, ok: canChown, why: 'Chỉ root mới đổi được owner. Bật sudo cho phiên này.', meta: 'chown' },
        { label: 'Tải xuống', icon: Download, run: act.download, ok: isRoot || sel.every((e) => e.readable), why: 'Có mục không đọc được', meta: 'chọn nơi lưu' },
        {
          label: 'Sửa trên máy',
          icon: FilePen,
          run: act.edit,
          ok: !!one && one.kind === 'file' && (isRoot || one.readable || sudo),
          why: !one || one.kind !== 'file' ? 'Chọn một tệp' : 'Không có quyền đọc. Bật sudo cho phiên này để sửa.',
          meta: editorName ?? 'editor mặc định',
        },
        {
          label: 'Mở bằng app khác…',
          icon: AppWindow,
          run: act.editWith,
          ok: !!one && one.kind === 'file' && (isRoot || one.readable || sudo),
          why: 'Chọn một tệp đọc được',
        },
        {
          label: 'Theo dõi (tail -f)',
          icon: ScrollText,
          run: act.follow,
          ok: !!one && !isDirLike(one) && one.kind !== 'other' && (isRoot || one.readable || sudo),
          why: !one || isDirLike(one) ? 'Chọn một tệp' : 'Không có quyền đọc. Bật sudo cho phiên này để theo dõi.',
          meta: one && !isRoot && !one.readable && sudo ? 'sudo' : undefined,
        },
        { label: 'Sao chép đường dẫn', icon: Copy, run: act.copy, ok: true },
        { label: 'Mở trong Terminal', icon: SquareTerminal, run: act.terminal, ok: !!one, why: 'Chỉ áp dụng cho một mục' },
        { label: 'Xoá', icon: Trash2, run: act.remove, ok: canWrite, why: `Cần quyền ghi trên ${path}`, danger: true },
      ]
    : []

  const Chev = more ? ChevronDown : ChevronRight
  return (
    <div
      className={cx(
        'flex w-[340px] flex-none flex-col gap-3 overflow-y-auto overscroll-contain rounded-xl border border-line bg-surface p-3.5 [scrollbar-width:thin] [&>*]:shrink-0',
        padBottom && 'pb-16',
      )}
    >
      <div className="flex items-center gap-2.5">
        <Tag text={head.tag} colors={head.colors} large />
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="truncate text-[13px] font-semibold">{head.title}</span>
          <span className="truncate text-[11px] text-muted">{head.sub}</span>
        </div>
        <button
          type="button"
          title="Thu gọn"
          onClick={onCollapse}
          className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-sunken"
        >
          <ChevronsRight size={14} strokeWidth={1.8} />
        </button>
      </div>

      <div className="flex flex-col gap-1.5 rounded-[9px] px-3 py-2.5" style={{ background: access.bad ? 'var(--warn-soft)' : 'var(--raised)' }}>
        <div className="flex items-center gap-1.5">
          <span className="flex-1 text-[11px] text-muted">Quyền của bạn ({user})</span>
          {sudo && !isRoot && <span className="rounded px-[5px] text-[10px] text-warn" style={{ background: 'var(--warn-soft)' }}>sudo</span>}
        </div>
        <span className="text-[13px] font-semibold" style={{ color: access.bad ? 'var(--warn)' : access.soft ? 'var(--ink2)' : 'var(--ink)' }}>
          {access.text}
        </span>
        <span className="text-[11.5px] leading-[1.45] text-ink2">{access.why}</span>
        {escalate && (
          <div className="flex flex-wrap gap-1.5">
            <Button size="xs" onClick={openAsRoot}>
              Mở bằng kết nối root
            </Button>
          </div>
        )}
      </div>

      {sel.length > 0 ? (
        <>
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] tracking-[.06em] text-muted uppercase">Thao tác</span>
            <div className="flex flex-col gap-px">
              {actions.map((a) => (
                <button
                  key={a.label}
                  type="button"
                  onClick={a.ok ? a.run : undefined}
                  title={a.ok ? undefined : a.why}
                  className={cx(
                    'flex items-center gap-2.5 rounded-[7px] px-2 py-[7px] text-left',
                    a.ok ? cx('cursor-pointer', a.danger ? 'hover:bg-danger-soft' : 'hover:bg-raised') : 'cursor-not-allowed opacity-45',
                    a.danger ? 'text-danger' : 'text-ink',
                  )}
                >
                  <span className={cx('flex', a.danger ? 'text-danger' : 'text-ink2')}>
                    <a.icon size={15} strokeWidth={1.8} />
                  </span>
                  <span className="flex flex-1 flex-col gap-px">
                    <span>{a.label}</span>
                    {!a.ok && a.why && <span className="text-[10.5px] text-muted">{a.why}</span>}
                  </span>
                  {a.meta && <span className="text-[11px] text-muted">{a.meta}</span>}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline">
              <span className="flex-1 text-[11px] tracking-[.06em] text-muted uppercase">Thông tin</span>
              <span className="text-[10.5px] text-muted">giờ máy bạn</span>
            </div>
            <MetaTable rows={rows} />
            {one && (
              <>
                <button type="button" onClick={() => setMore(!more)} className="flex cursor-pointer items-center gap-[5px] py-0.5 text-left text-[11.5px] text-ink2">
                  <Chev size={12} strokeWidth={1.8} />
                  Chi tiết thêm
                </button>
                {more && (
                  <MetaTable
                    rows={[
                      ['Truy cập lần cuối', fullTime(one.atime)],
                      ['UID', String(one.uid ?? '—'), true],
                      ['GID', String(one.gid ?? '—'), true],
                    ]}
                  />
                )}
              </>
            )}
          </div>

        </>
      ) : (
        <span className="pt-1.5 pb-1 text-[12px] leading-[1.6] text-muted">
          Bấm để chọn, Ctrl hoặc ⌘ + bấm để chọn thêm, Shift + bấm để chọn một dải. Bấm đúp thư mục để mở, bấm đúp tệp để sửa bằng editor trên máy (lưu là tự tải lên). Kéo tệp từ máy vào danh sách để tải lên.
        </span>
      )}
    </div>
  )
}

function MetaTable({ rows }: { rows: [string, ReactNode, boolean?, string?][] }) {
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-line">
      {rows.map(([k, v, mono, color]) => (
        <div key={k} className="grid items-baseline gap-2.5 border-t border-line px-2.5 py-1.5 first:border-t-0" style={{ gridTemplateColumns: '96px minmax(0,1fr)' }}>
          <span className="text-[11.5px] text-muted">{k}</span>
          <span className={cx('text-[12px] [overflow-wrap:anywhere] select-text', mono && 'font-mono')} style={{ color: color ?? 'var(--ink)' }}>
            {v}
          </span>
        </div>
      ))}
    </div>
  )
}
