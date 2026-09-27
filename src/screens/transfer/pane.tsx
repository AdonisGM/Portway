import { ArrowDown, ArrowUp, Eye, EyeOff, Folder, FolderPlus, Lock, RotateCw, Terminal, Upload, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { useServers } from '../../app/servers'
import { SelectField, type Option } from '../../components/ui/form-controls'
import { t } from '../../i18n'
import { Button, cx } from '../../components/ui/primitives'
import type { FileEntry } from '../../lib/api'
import { formatBytes, connectError } from '../server/format'
import { fileError, fullTime, isDirLike, joinPath, octal, parentOf, shortTime, tagOf } from '../files/format'
import { crumbsOf, sourceName } from './format'
import { canWriteHere, type Pane as PaneState, type Sort, type SortKey } from './use-pane'

const GRID = '18px minmax(0,1fr) 64px 78px'

export type DropHint = { dir: string | null; label: string; sub: string }

function tagColors(e: FileEntry): [string, string] {
  if (e.kind === 'link') return ['var(--sunken)', 'var(--ink2)']
  if (isDirLike(e)) return ['var(--info-soft)', 'var(--info)']
  return ['var(--sunken)', 'var(--muted)']
}

/** One side of "Chuyển tệp": source picker, folder bar and the file list. */
export function Pane({
  pane: p,
  home,
  active,
  onActivate,
  otherNames,
  sources,
  onPickSource,
  onRowMouseDown,
  drop,
  padBottom,
  onConnect,
  onTerminal,
  onNewFolder,
}: {
  pane: PaneState
  home: string | null
  active: boolean
  onActivate: () => void
  /** Names in the other pane's folder, to flag the ones that would clash. */
  otherNames: Set<string>
  sources: Option[]
  onPickSource: (key: string) => void
  onRowMouseDown: (e: MouseEvent, name: string) => void
  /** Something is being dragged over this pane. */
  drop: DropHint | null
  padBottom: boolean
  onConnect: () => void
  onTerminal: () => void
  onNewFolder: () => void
}) {
  const { byId } = useServers()
  const server = p.src.kind === 'remote' ? byId(p.src.serverId) : undefined
  const listing = p.listing
  const writable = canWriteHere(p)

  // Keep the keyboard cursor in view.
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!p.cursor || !list.current) return
    list.current.querySelector(`[data-name="${CSS.escape(p.cursor)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [p.cursor])

  const clickRow = (e: MouseEvent, name: string) => {
    const on = p.selNames.includes(name)
    p.setCursor(name)
    if (e.shiftKey && p.anchor && p.order.includes(p.anchor)) {
      const a = p.order.indexOf(p.anchor)
      const b = p.order.indexOf(name)
      const range = p.order.slice(Math.min(a, b), Math.max(a, b) + 1)
      p.select(e.metaKey || e.ctrlKey ? [...new Set([...p.selNames, ...range])] : range, p.anchor)
    } else if (e.metaKey || e.ctrlKey) p.select(on ? p.selNames.filter((n) => n !== name) : [...p.selNames, name], name)
    else p.select([name], name)
  }

  const allOn = p.order.length > 0 && p.selNames.length === p.order.length
  const count = p.selNames.length ? t('Đã chọn {n}/{total}', { n: p.selNames.length, total: p.order.length }) : t('{n} mục', { n: p.order.length })

  let body: ReactNode
  if (p.src.kind === 'remote' && !server) {
    body = <Blank icon={Lock} title={t('Server không còn trong danh sách')} />
  } else if (p.src.kind === 'remote' && (!p.conn || p.conn.status === 'failed')) {
    const err = p.conn?.status === 'failed' && p.conn.error.code !== 'cancelled' ? connectError(p.conn.error, server!.host, server!.port) : null
    body = (
      <Blank icon={Lock} title={err ? err.title : t('Chưa kết nối {name}', { name: sourceName(p.src, byId) })}>
        {err && <span className="max-w-[360px] leading-normal text-muted">{err.message}</span>}
        <Button size="xs" onClick={onConnect}>
          {err ? t('Thử lại') : t('Kết nối')}
        </Button>
      </Blank>
    )
  } else if (p.src.kind === 'remote' && (p.conn?.status === 'connecting' || p.conn?.status === 'prompt')) {
    body = <div className="p-7 text-center text-muted">{t('Đang kết nối tới {name}…', { name: sourceName(p.src, byId) })}</div>
  } else if (!listing) {
    body = p.error ? (
      <Blank icon={Lock} title={t('Không mở được thư mục')}>
        <span className="max-w-[360px] leading-normal text-muted">{fileError(p.error)}</span>
        <Button size="xs" onClick={() => void p.load('')}>
          {t('Về thư mục nhà')}
        </Button>
      </Blank>
    ) : (
      <Skeleton />
    )
  } else if (listing.denied) {
    body =
      p.src.kind === 'local' ? (
        <Blank icon={Lock} title={t('macOS chưa cho Portway đọc thư mục này')}>
          <span className="max-w-[360px] leading-normal text-muted">
            {t('Mở Cài đặt hệ thống › Quyền riêng tư & Bảo mật › Tệp và thư mục, bật quyền cho Portway rồi bấm làm mới.')}
          </span>
        </Blank>
      ) : (
        <Blank icon={Lock} title={t('Không có quyền đọc thư mục này')}>
          <span className="max-w-[360px] leading-normal text-muted">
            {t('{path} thuộc {owner}:{group}, quyền {mode}.', { path: listing.path, owner: listing.dir.owner ?? listing.dir.uid ?? '?', group: listing.dir.group ?? listing.dir.gid ?? '?', mode: octal(listing.dir.mode) })}
          </span>
        </Blank>
      )
  } else if (!p.all.length) {
    body = <Blank icon={Folder} title={t('Thư mục trống')} />
  } else if (!p.shown.length) {
    body = <div className="p-7 text-center text-muted">{t('Chỉ có tệp ẩn trong thư mục này. Bấm nút con mắt để xem.')}</div>
  } else {
    body = p.shown.map((e) => {
      const on = p.selNames.includes(e.name)
      const dir = isDirLike(e)
      const target = drop?.dir === e.path
      return (
        <div
          key={e.name}
          data-name={e.name}
          data-dir-path={dir && e.readable ? e.path : undefined}
          onMouseDown={(ev) => onRowMouseDown(ev, e.name)}
          onClick={(ev) => clickRow(ev, e.name)}
          onDoubleClick={() => dir && void p.load(e.path)}
          title={e.name + '\n' + t('Sửa lúc {time}', { time: fullTime(e.mtime) })}
          className={cx(
            'grid cursor-default items-center gap-2.5 border-t border-line px-3 py-[6px] select-none',
            target ? 'bg-accent-soft outline-2 -outline-offset-2 outline-accent' : on ? 'bg-accent-soft' : 'hover:bg-raised',
            p.cursor === e.name && active && 'shadow-[inset_2px_0_0_var(--accent)]',
          )}
          style={{ gridTemplateColumns: GRID }}
        >
          <button
            type="button"
            title={t('Chọn')}
            onMouseDown={(ev) => ev.stopPropagation()}
            onClick={(ev) => {
              ev.stopPropagation()
              p.setCursor(e.name)
              p.select(on ? p.selNames.filter((n) => n !== e.name) : [...p.selNames, e.name], e.name)
            }}
            className="flex cursor-pointer"
          >
            <Box on={on} />
          </button>
          <span className="flex min-w-0 items-center gap-2">
            <Tag text={tagOf(e)} colors={tagColors(e)} />
            <span className={cx('truncate', dir && 'font-semibold', e.readable ? 'text-ink' : 'text-ink2')}>{e.name}</span>
            {!e.readable && (
              <span title={t('Không có quyền đọc')} className="flex flex-none text-warn">
                <Lock size={12} strokeWidth={1.8} />
              </span>
            )}
            {otherNames.has(e.name) && (
              <span title={t('Thư mục bên kia đã có mục cùng tên')} className="flex-none rounded px-1.5 py-px text-[10px] text-warn" style={{ background: 'var(--warn-soft)' }}>
                {t('trùng tên')}
              </span>
            )}
          </span>
          <span className="num text-right text-ink2">{dir || e.kind === 'link' ? '—' : formatBytes(e.size)}</span>
          <span className="num truncate text-muted">{shortTime(e.mtime)}</span>
        </div>
      )
    })
  }

  return (
    <div
      data-pane={p.side}
      onMouseDown={onActivate}
      className={cx(
        'relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border bg-surface transition-colors',
        active ? 'border-ink2' : 'border-line',
      )}
    >
      <div className="flex flex-none items-center gap-1.5 border-b border-line px-2.5 py-2">
        <SelectField value={p.key} onChange={onPickSource} options={sources} className="h-8 min-w-0 flex-1" />
        <IconButton title={t('Làm mới')} disabled={!p.ready} onClick={() => void p.reload()}>
          <RotateCw size={14} strokeWidth={1.8} className={cx(p.loading && 'animate-spin')} />
        </IconButton>
        <IconButton title={p.showHidden ? t('Ẩn tệp ẩn ({n})', { n: p.hiddenCount }) : t('Hiện tệp ẩn ({n})', { n: p.hiddenCount })} on={p.showHidden} onClick={() => p.setShowHidden(!p.showHidden)}>
          {p.showHidden ? <Eye size={14} strokeWidth={1.8} /> : <EyeOff size={14} strokeWidth={1.8} />}
        </IconButton>
        <IconButton title={writable ? t('Thư mục mới') : t('Không có quyền ghi vào thư mục này')} disabled={!writable} onClick={onNewFolder}>
          <FolderPlus size={14} strokeWidth={1.8} />
        </IconButton>
        <IconButton
          title={p.src.kind === 'local' ? t('Mở thư mục này trong Terminal') : t('Mở trong Terminal ({name})', { name: sourceName(p.src, byId) })}
          disabled={!listing}
          onClick={onTerminal}
        >
          <Terminal size={14} strokeWidth={1.8} />
        </IconButton>
      </div>

      <div className="flex flex-none flex-col gap-1 border-b border-line px-2.5 py-2">
        <PathBar path={listing?.path ?? ''} home={p.src.kind === 'local' ? home : null} disabled={!listing} go={(to) => p.load(to)} />
        {listing && !listing.denied && !writable && (
          <span className="flex items-center gap-1.5 px-0.5 text-[11px] text-warn">
            <Lock size={11} strokeWidth={1.8} />
            {t('Chỉ đọc: {user} không có quyền ghi vào thư mục này', { user: listing.user })}
          </span>
        )}
      </div>

      <div ref={list} className="min-h-0 flex-1 overflow-auto overscroll-contain transition-opacity" style={{ opacity: p.loading || !p.ready ? 0.6 : 1 }}>
        <div className="sticky top-0 z-[1] grid items-center gap-2.5 bg-sunken px-3 py-[7px] text-[11px] text-muted" style={{ gridTemplateColumns: GRID }}>
          <button type="button" title={t('Chọn tất cả')} onClick={() => p.select(allOn ? [] : p.order, null)} className="flex cursor-pointer" disabled={!p.order.length}>
            <Box on={allOn} partial={!allOn && p.selNames.length > 0} />
          </button>
          <span className="flex min-w-0 items-center gap-2.5 whitespace-nowrap">
            <SortButton label={t('Tên')} k="name" sort={p.sort} setSort={p.setSort} />
            {listing && !listing.denied && <span className={cx('truncate', p.selNames.length ? 'text-ink2' : '')}>{count}</span>}
          </span>
          <span className="flex justify-end">
            <SortButton label={t('Cỡ')} k="size" sort={p.sort} setSort={p.setSort} end />
          </span>
          <SortButton label={t('Sửa lúc')} k="mtime" sort={p.sort} setSort={p.setSort} />
        </div>
        {listing && listing.path !== '/' && (
          <div
            onClick={() => void p.load(parentOf(listing.path))}
            data-dir-path={parentOf(listing.path)}
            title={t('Lên thư mục cha (⌫)')}
            className={cx(
              'grid cursor-default items-center gap-2.5 border-t border-line px-3 py-[6px] select-none hover:bg-raised',
              drop?.dir === parentOf(listing.path) && 'bg-accent-soft outline-2 -outline-offset-2 outline-accent',
            )}
            style={{ gridTemplateColumns: GRID }}
          >
            <span />
            <span className="flex items-center gap-2">
              <Tag text="↑" colors={['var(--sunken)', 'var(--muted)']} />
              <span className="font-semibold">..</span>
            </span>
          </div>
        )}
        {body}
        {padBottom && <div className="h-14" />}
      </div>

      {drop && !drop.dir && (
        <div className="pointer-events-none absolute inset-1.5 top-[92px] flex flex-col items-center justify-center gap-1.5 rounded-[10px] border-2 border-dashed border-accent bg-[color-mix(in_srgb,var(--surface)_82%,transparent)] px-4 text-center">
          <Upload size={22} strokeWidth={1.8} />
          <span className="text-[13.5px] font-semibold [overflow-wrap:anywhere]">{drop.label}</span>
          <span className="text-[11.5px] text-ink2">{drop.sub}</span>
        </div>
      )}
    </div>
  )
}

/** Breadcrumbs; a click on the empty part turns them into a path input. */
function PathBar({ path, home, disabled, go }: { path: string; home: string | null; disabled: boolean; go: (p: string) => Promise<unknown> }) {
  const [draft, setDraft] = useState<string | null>(null)
  const [bad, setBad] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const editing = draft !== null
  useEffect(() => {
    if (editing) input.current?.select()
  }, [editing])
  // A long path shows its end: the folder you are in.
  useEffect(() => {
    if (bar.current) bar.current.scrollLeft = bar.current.scrollWidth
  }, [path, editing])

  const submit = async () => {
    const raw = (draft ?? '').trim()
    // "~" is the home folder on either side ('' asks the server for it).
    const target = raw === '' || raw === '~' ? (home ?? '') : raw.startsWith('~/') && home ? home + raw.slice(1) : raw.startsWith('/') ? raw : joinPath(path, raw)
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
        onChange={(e) => {
          setDraft(e.target.value)
          setBad(false)
        }}
        onBlur={() => {
          setDraft(null)
          setBad(false)
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') void submit()
          if (e.key === 'Escape') {
            setDraft(null)
            setBad(false)
          }
        }}
        className={cx(
          'h-7 w-full rounded-md border border-line2 bg-sunken px-2 font-mono text-[11.5px] text-ink outline-none select-text focus:border-accent',
          bad && '!border-danger',
        )}
      />
    )
  }

  const list = crumbsOf(path, home)
  return (
    <div
      ref={bar}
      onClick={() => !disabled && setDraft(home && (path === home || path.startsWith(home + '/')) ? '~' + path.slice(home.length) : path)}
      title={t('Bấm vào khoảng trống để nhập đường dẫn')}
      className="flex h-7 min-w-0 cursor-text items-center gap-0.5 overflow-x-auto rounded-md border border-line2 bg-sunken px-1.5 font-mono text-[11.5px] [scrollbar-width:none]"
    >
      {path &&
        list.map((c, i) => (
          <span key={c.path} className="flex flex-none items-center">
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
            {i < list.length - 1 && !(i === 0 && c.label === '/') && <span className="text-muted">/</span>}
          </span>
        ))}
    </div>
  )
}

function IconButton({ title, onClick, disabled, on, children }: { title: string; onClick: () => void; disabled?: boolean; on?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'flex size-8 flex-none items-center justify-center rounded-lg border',
        on ? 'border-ink2 bg-raised text-ink' : 'border-line2 text-ink',
        disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer hover:border-muted',
      )}
    >
      {children}
    </button>
  )
}

/** `end`: the column is right-aligned, so the arrow goes first and the label
 *  lines up with the values under it. */
function SortButton({ label, k, sort, setSort, end }: { label: string; k: SortKey; sort: Sort; setSort: (s: Sort) => void; end?: boolean }) {
  const on = sort.key === k
  const Icon = on && sort.dir === -1 ? ArrowDown : ArrowUp
  const arrow = (
    <span className="flex" style={{ opacity: on ? 1 : 0 }}>
      <Icon size={11} strokeWidth={1.8} />
    </span>
  )
  return (
    <button
      type="button"
      onClick={() => setSort({ key: k, dir: on ? (sort.dir === 1 ? -1 : 1) : k === 'name' ? 1 : -1 })}
      className={cx('inline-flex cursor-pointer items-center gap-[3px] text-[11px]', on ? 'text-ink' : 'text-muted')}
    >
      {end && arrow}
      {label}
      {!end && arrow}
    </button>
  )
}

function Box({ on, partial }: { on: boolean; partial?: boolean }) {
  return (
    <span
      className={cx(
        'block size-[15px] rounded border text-center text-[10px] leading-[13px] text-accent-fg',
        on || partial ? 'border-accent bg-accent' : 'border-line2 bg-transparent',
      )}
    >
      {on ? '✓' : partial ? '–' : ''}
    </span>
  )
}

function Tag({ text, colors }: { text: string; colors: [string, string] }) {
  return (
    <span className="w-[30px] flex-none rounded py-px text-center font-mono text-[10px]" style={{ background: colors[0], color: colors[1] }}>
      {text}
    </span>
  )
}

function Blank({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2.5 border-t border-line px-6 py-10 text-center">
      <span className="flex text-muted">
        <Icon size={20} strokeWidth={1.8} />
      </span>
      <span className="text-[13.5px] font-semibold">{title}</span>
      {children}
    </div>
  )
}

function Skeleton() {
  return (
    <>
      {['60%', '45%', '70%', '40%', '55%'].map((w, i) => (
        <div key={i} className="grid items-center gap-2.5 border-t border-line px-3 py-2.5" style={{ gridTemplateColumns: GRID }}>
          <span className="size-[15px] rounded bg-sunken" />
          <span className="h-3 rounded-[5px] bg-sunken" style={{ width: w }} />
          <span className="h-2.5 rounded-[5px] bg-sunken" />
          <span className="h-2.5 rounded-[5px] bg-sunken" />
        </div>
      ))}
    </>
  )
}
