import { useCallback, useEffect, useState } from 'react'
import type { RemoteFile } from '@/lib/api'
import { message, sftpList } from '@/lib/api'
import { formatMtime, formatSize } from '@/lib/bytes'
import type { Session } from '@/data/types'
import { Chip } from '@/components/ui/Chip'
import { StatusDot } from '@/components/ui/primitives'
import { DataTable, type Column } from '@/components/layout/DataTable'

/**
 * Real SFTP browsing over the session's existing SSH connection.
 *
 * `..` is synthesised rather than taken from the server listing so it is
 * always first and always present, which is what the design draws.
 */
export function SftpPane({ session }: { session: Session }) {
  const [path, setPath] = useState('')
  const [files, setFiles] = useState<RemoteFile[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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

  const columns: Column<RemoteFile>[] = [
    {
      key: 'name',
      header: 'Name',
      className: 'cell-ellipsis',
      render: (file) => (
        <span className={file.kind === 'dir' ? 'text-fg' : ''}>
          {file.name}
          {file.kind === 'dir' ? '/' : ''}
        </span>
      ),
    },
    {
      key: 'size',
      header: 'Size',
      headerClassName: 'text-right',
      className: 'text-right text-muted',
      render: (file) => formatSize(file.size),
    },
    {
      key: 'modified',
      header: 'Modified',
      className: 'cell-ellipsis text-meta text-faint',
      render: (file) => formatMtime(file.modified),
    },
  ]

  return (
    <div className="flex w-sftp flex-none flex-col border-l border-w08 bg-panel">
      <div className="flex flex-none items-center gap-2 border-b border-w06 px-3 py-2 font-mono text-mono text-faint">
        <StatusDot tone={session.status === 'open' ? 'warn' : 'faint'} size="sm" />
        SFTP
        <span className="ml-auto">{busy ? 'loading…' : 'remote'}</span>
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
          rows={[{ name: '..', size: null, modified: null, kind: 'dir' as const }, ...files]}
          columns={columns}
          gridTemplate="1.7fr 78px 100px"
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
