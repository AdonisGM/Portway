import { useCallback, useEffect, useRef, useState } from 'react'
import type { RemoteFile } from '@/lib/api'
import {
  LARGE_FILE,
  message,
  sftpChmod,
  sftpChown,
  sftpList,
  sftpRemove,
  sftpRename,
} from '@/lib/api'
import { formatMtime, formatSize } from '@/lib/bytes'
import type { Session } from '@/data/types'
import { Chip } from '@/components/ui/Chip'
import { StatusDot } from '@/components/ui/primitives'
import { DataTable, type Column } from '@/components/layout/DataTable'
import { FileIcon } from './FileIcons'
import { useSftpColumns, type SftpColumnId } from './columns'
import { ColumnPicker } from './ColumnPicker'
import { useDropUpload } from './useDropUpload'
import { ContextMenu, MenuItem, MenuSeparator, type MenuPoint } from '@/components/ui/ContextMenu'
import { OwnerDialog, PermissionsDialog, RenameDialog } from './FileDialogs'
import { useEditing } from './useEditing'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { formatSize as size } from '@/lib/bytes'

/**
 * Real SFTP browsing over the session's existing SSH connection, with a
 * configurable column set, type icons, and OS drag-and-drop upload.
 */

/**
 * `..` is ours, not the server's, so it is always first and always present.
 * Its owner and mode are blank rather than invented — it stands for the parent
 * directory, whose attributes this listing does not describe.
 */
const PARENT: RemoteFile = {
  name: '..',
  size: null,
  modified: null,
  kind: 'dir',
  uid: null,
  gid: null,
  owner: null,
  group: null,
  mode: null,
  modeText: null,
}

/**
 * `root:staff`, or `1500:1600` where the server had no names for the ids.
 *
 * Owner and group are resolved as a pair or not at all — they come out of one
 * line — so there is no case where a name is mixed with a number.
 */
function ownerText(file: RemoteFile): string {
  if (file.owner !== null) return `${file.owner}:${file.group ?? '?'}`
  if (file.uid !== null) return `${file.uid}:${file.gid ?? '?'}`
  return '—'
}

interface Props {
  session: Session
  /** Live width from the divider — dynamic, so it cannot be a token. */
  width: number
  /** True mid-drag: text selection would otherwise fight the pointer. */
  resizing: boolean
}

export function SftpPane({ session, width, resizing }: Props) {
  const [path, setPath] = useState('')
  const [files, setFiles] = useState<RemoteFile[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const cols = useSftpColumns()
  const paneRef = useRef<HTMLDivElement>(null)
  // One piece of state for the whole right-click flow: which row was hit, where
  // the menu goes, and which dialog it opened. Keeping them together means a
  // dialog can never outlive the row it was opened on.
  const [menu, setMenu] = useState<{ file: RemoteFile; at: MenuPoint } | null>(null)
  const [dialog, setDialog] = useState<'rename' | 'mode' | 'owner' | 'delete' | null>(null)
  const [acting, setActing] = useState<RemoteFile | null>(null)
  // Separate from `error`, which means "this folder could not be read" and so
  // replaces the table. A failed rename or chmod must leave the listing where
  // it is — losing your place is a worse outcome than the failure itself.
  const [opError, setOpError] = useState<string | null>(null)
  // Held separately from `dialog` because it is a question about a file rather
  // than a change to one: answering it opens the editor, cancelling does nothing.
  const [confirmLarge, setConfirmLarge] = useState<RemoteFile | null>(null)

  const load = useCallback(
    async (target: string, system = false) => {
      setBusy(true)
      setError(null)
      try {
        const listing = await sftpList(session.id, target, system)
        setPath(listing.path)
        setFiles(listing.files)
      } catch (e) {
        setError(message(e))
      } finally {
        setBusy(false)
      }
    },
    [session.id],
  )

  // The first listing is Portway's own doing, so it is logged as `system`;
  // every navigation after this is the user's and logged as `user`.
  useEffect(() => {
    if (session.status !== 'open') return
    void load('', true)
  }, [session.status, load])

  const segments = path.split('/').filter(Boolean)

  const goTo = (index: number) => {
    const next = '/' + segments.slice(0, index + 1).join('/')
    void load(next)
  }

  const goUp = () => {
    if (segments.length === 0) return
    void load('/' + segments.slice(0, -1).join('/') || '/')
  }

  const drop = useDropUpload({
    sessionId: session.id,
    // Only a live session with a resolved path can receive a drop; before that
    // there is nowhere on the far end to put anything.
    remoteDir: session.status === 'open' && path ? path : null,
    paneRef,
    onUploaded: () => void load(path),
  })

  /** Absolute path of a listed entry, in the folder currently shown. */
  const pathOf = (file: RemoteFile) =>
    path.endsWith('/') ? `${path}${file.name}` : `${path}/${file.name}`

  /** Runs one remote change, then re-reads the folder so the row shows truth. */
  const act = async (run: () => Promise<unknown>) => {
    setDialog(null)
    setActing(null)
    setOpError(null)
    try {
      await run()
      await load(path)
    } catch (e) {
      setOpError(message(e))
    }
  }

  const openDialog = (kind: 'rename' | 'mode' | 'owner' | 'delete') => {
    setActing(menu?.file ?? null)
    setDialog(kind)
    setMenu(null)
  }

  const editing = useEditing(session.id, () => void load(path))

  /**
   * Opening for edit. Files over 5MB ask first: "edit" means handing the file
   * to a text editor, and a 200MB log opened by accident freezes whichever one
   * the user has.
   */
  const openFile = (file: RemoteFile, choose: boolean) => {
    setMenu(null)
    if ((file.size ?? 0) > LARGE_FILE && !choose) {
      setConfirmLarge(file)
      return
    }
    void editing.edit(file, pathOf(file), choose)
  }

  const RENDERERS: Record<SftpColumnId, Column<RemoteFile>> = {
    name: {
      key: 'name',
      header: 'Name',
      className: 'cell-ellipsis',
      render: (file) => (
        <span
          className={`flex min-w-0 items-center gap-2 ${
            file.kind === 'dir' ? 'text-fg' : ''
          }`}
        >
          <span className={file.kind === 'dir' ? 'text-fg-2' : 'text-faint'}>
            <FileIcon name={file.name} kind={file.kind} />
          </span>
          <span className="cell-ellipsis">
            {file.name}
            {file.kind === 'dir' ? '/' : ''}
          </span>
        </span>
      ),
    },
    size: {
      key: 'size',
      header: 'Size',
      headerClassName: 'text-right',
      className: 'text-right text-muted',
      render: (file) => formatSize(file.size),
    },
    modified: {
      key: 'modified',
      header: 'Modified',
      className: 'cell-ellipsis text-meta text-faint',
      render: (file) => formatMtime(file.modified),
    },
    owner: {
      key: 'owner',
      header: 'Owner',
      className: 'cell-ellipsis text-meta text-faint',
      // Names when the server resolved them, numbers when it did not. Titled
      // either way: a long `user:group` pair outgrows this column long before
      // it stops mattering which one it is.
      render: (file) => {
        const text = ownerText(file)
        return <span title={text === '—' ? undefined : text}>{text}</span>
      },
    },
    mode: {
      key: 'mode',
      header: 'Permissions',
      className: 'text-meta text-faint',
      // Both forms, because the octal is what you type and the letters are what
      // you read — a stray write bit is invisible in `644` and obvious in `rw-`.
      render: (file) =>
        file.mode === null ? '—' : `${file.mode} ${file.modeText ?? ''}`.trim(),
    },
  }
  const columns = cols.shown.map((c) => RENDERERS[c.id])

  return (
    <div
      ref={paneRef}
      style={{ width }}
      className={`relative flex flex-none flex-col border-l border-w08 bg-panel ${
        resizing ? 'select-none' : ''
      }`}
    >
      {/* The drop target is the whole pane, so there is no small rectangle to
          find. Drawn as an overlay rather than a border so the table underneath
          does not reflow the moment a file crosses the window. */}
      {drop.state !== 'idle' ? (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-scrim">
          <span className="rounded-field border border-accent-27 bg-drawer px-3 py-2 font-mono text-cell text-fg">
            {drop.state === 'uploading' ? 'uploading…' : `drop to upload into ${path || '/'}`}
          </span>
        </div>
      ) : null}
      <div className="flex flex-none items-center gap-2 border-b border-w06 px-3 py-2 font-mono text-mono text-faint">
        <StatusDot tone={session.status === 'open' ? 'warn' : 'faint'} size="sm" />
        SFTP
        <span className="ml-auto">{busy ? 'loading…' : 'remote'}</span>
        <ColumnPicker visible={cols.visible} onToggle={cols.toggle} />
      </div>

      <div className="flex flex-none items-center gap-1.5 border-b border-w06 px-3 py-2 font-mono text-meta text-fg-2">
        <button
          type="button"
          aria-label="Parent directory"
          onClick={goUp}
          disabled={segments.length === 0}
          className="text-faint transition-colors hover:text-fg disabled:opacity-40"
        >
          ↑
        </button>
        <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          {segments.length === 0 ? <span className="text-faint">/</span> : null}
          {segments.map((segment, i) => (
            <span key={`${segment}-${i}`} className="flex flex-none items-center gap-1.5">
              <span className="text-faint">/</span>
              <button
                type="button"
                onClick={() => goTo(i)}
                className="transition-colors hover:text-fg"
              >
                {segment}
              </button>
            </span>
          ))}
        </span>
        <Chip className="ml-auto flex-none" onClick={() => void load(path)}>
          Refresh
        </Chip>
      </div>

      {/* Upload and file-operation failures share one dismissible line: both
          are things that went wrong *to* the listing, not instead of it. */}
      {drop.error ?? opError ?? editing.error ? (
        <button
          type="button"
          onClick={() => {
            drop.clearError()
            setOpError(null)
            editing.clearError()
          }}
          className="flex-none border-b border-w06 px-3 py-2 text-left font-mono text-mono/cmd break-words text-warn"
        >
          ! {drop.error ?? opError ?? editing.error}
        </button>
      ) : null}

      {session.status !== 'open' ? (
        <div className="flex flex-1 items-center justify-center font-mono text-mono text-faint">
          {session.status === 'connecting' ? 'connecting…' : 'not connected'}
        </div>
      ) : error ? (
        <div className="flex flex-1 items-start justify-center px-3 py-6">
          <span className="font-mono text-mono/cmd break-words text-warn">! {error}</span>
        </div>
      ) : (
        <DataTable
          rows={[PARENT, ...files]}
          columns={columns}
          gridTemplate={cols.gridTemplate}
          rowKey={(file) => file.name}
          density="compact"
          onRowClick={(file) => {
            if (file.name === '..') return goUp()
            if (file.kind === 'dir') {
              return void load(path.endsWith('/') ? `${path}${file.name}` : `${path}/${file.name}`)
            }
          }}
          emptyMessage="empty directory"
          onRowContextMenu={(file, e) => {
            // `..` is ours, not an entry on the server — there is nothing on the
            // far end to rename or chmod.
            if (file.name === '..') return
            setMenu({ file, at: { x: e.clientX, y: e.clientY } })
          }}
        />
      )}
      <ContextMenu at={menu?.at ?? null} onClose={() => setMenu(null)} estimatedHeight={menu?.file.kind === 'file' ? 270 : 190}>
        {menu?.file.kind === 'file' ? (
          <>
            <MenuItem onClick={() => menu && openFile(menu.file, false)}>Open</MenuItem>
            <MenuItem onClick={() => menu && openFile(menu.file, true)}>Open with…</MenuItem>
            <MenuSeparator />
          </>
        ) : null}
        <MenuItem onClick={() => openDialog('rename')}>Rename…</MenuItem>
        <MenuItem onClick={() => openDialog('mode')}>Permissions…</MenuItem>
        <MenuItem onClick={() => openDialog('owner')}>Owner…</MenuItem>
        <MenuSeparator />
        <MenuItem
          onClick={() => {
            if (menu) void navigator.clipboard.writeText(pathOf(menu.file))
            setMenu(null)
          }}
        >
          Copy path
        </MenuItem>
        <MenuSeparator />
        <MenuItem danger onClick={() => openDialog('delete')}>
          Delete…
        </MenuItem>
      </ContextMenu>

      {/* What is open elsewhere, and whether the last save landed. Editing is
          invisible otherwise: the file is in another app and the write-back
          happens without anyone pressing anything here. */}
      {editing.open.length > 0 ? (
        <div className="flex-none border-t border-w06 px-3 py-2 font-mono text-mono text-faint">
          {editing.saved ? (
            <span className="text-accent">
              saved {editing.saved.remote.split('/').pop()} · {size(editing.saved.bytes)}
            </span>
          ) : (
            <>
              editing {editing.open.length}{' '}
              {editing.open.length === 1 ? 'file' : 'files'} · saves upload
            </>
          )}
        </div>
      ) : null}

      {confirmLarge ? (
        <ConfirmDialog
          open
          title="Large file"
          confirmVariant="accent"
          confirmLabel="Open anyway"
          onCancel={() => setConfirmLarge(null)}
          onConfirm={() => {
            const file = confirmLarge
            setConfirmLarge(null)
            void editing.edit(file, pathOf(file), false)
          }}
        >
          <div className="flex flex-col gap-2">
            <span>
              <span className="font-mono text-cell text-fg">{confirmLarge.name}</span> is{' '}
              {size(confirmLarge.size)} — over the 5 MB edit limit.
            </span>
            <span className="text-muted">
              It is downloaded in full and handed to a local application, which may take a
              moment to open it.
            </span>
          </div>
        </ConfirmDialog>
      ) : null}

      {dialog === 'rename' && acting ? (
        <RenameDialog
          file={acting}
          onCancel={() => setDialog(null)}
          onRename={(name) =>
            void act(() =>
              sftpRename(
                session.id,
                pathOf(acting),
                path.endsWith('/') ? `${path}${name}` : `${path}/${name}`,
              ),
            )
          }
        />
      ) : null}

      {dialog === 'mode' && acting ? (
        <PermissionsDialog
          file={acting}
          onCancel={() => setDialog(null)}
          onApply={(mode) => void act(() => sftpChmod(session.id, pathOf(acting), mode))}
        />
      ) : null}

      {dialog === 'delete' && acting ? (
        <ConfirmDialog
          open
          title={acting.kind === 'dir' ? 'Delete folder' : 'Delete file'}
          confirmLabel="Delete"
          onCancel={() => setDialog(null)}
          onConfirm={() =>
            void act(() => sftpRemove(session.id, pathOf(acting), acting.kind === 'dir'))
          }
        >
          <div className="flex flex-col gap-2">
            <span>
              <span className="font-mono text-cell text-fg">{pathOf(acting)}</span>
            </span>
            {/* The folder case is the one worth spelling out: SFTP cannot remove
                a directory that has anything in it, so this empties it first —
                which means agreeing to this agrees to everything inside. */}
            <span className="text-muted">
              {acting.kind === 'dir'
                ? 'This deletes the folder and everything inside it. There is no undo on the server.'
                : 'There is no undo on the server.'}
            </span>
          </div>
        </ConfirmDialog>
      ) : null}

      {dialog === 'owner' && acting ? (
        <OwnerDialog
          file={acting}
          onCancel={() => setDialog(null)}
          onApply={(uid, gid, recursive) =>
            void act(() => sftpChown(session.id, pathOf(acting), uid, gid, recursive))
          }
        />
      ) : null}
    </div>
  )
}
