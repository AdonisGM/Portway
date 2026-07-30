import { useCallback, useEffect, useRef, useState } from 'react'
import type { RemoteFile } from '@/lib/api'
import { message, sftpList } from '@/lib/api'
import { formatMtime, formatSize } from '@/lib/bytes'
import type { Session } from '@/data/types'
import { Chip } from '@/components/ui/Chip'
import { StatusDot } from '@/components/ui/primitives'
import { DataTable, type Column } from '@/components/layout/DataTable'
import { FileIcon } from './FileIcons'
import { useSftpColumns, type SftpColumnId } from './columns'
import { ColumnPicker } from './ColumnPicker'
import { useDropUpload } from './useDropUpload'

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
  mode: null,
  modeText: null,
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
      // Numeric: SFTP only carries the names in a field russh-sftp drops.
      render: (file) => (file.uid === null ? '—' : `${file.uid}:${file.gid ?? '?'}`),
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

      {drop.error ? (
        <button
          type="button"
          onClick={drop.clearError}
          className="flex-none border-b border-w06 px-3 py-2 text-left font-mono text-mono/cmd break-words text-warn"
        >
          ! {drop.error}
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
        />
      )}
    </div>
  )
}
