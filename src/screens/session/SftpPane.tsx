import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Principals, RemoteFile } from '@/lib/api'
import {
  CWD_HOOK,
  LARGE_FILE,
  message,
  sftpChmod,
  sftpChown,
  sftpList,
  sftpPrincipals,
  sftpRemove,
  sftpRename,
  sshCd,
  sshWrite,
  sudoCheck,
  sudoUnlock,
} from '@/lib/api'
import { encodeText } from '@/lib/bytes'
import { formatMtime, formatSize } from '@/lib/bytes'
import type { Session } from '@/data/types'
import { Chip } from '@/components/ui/Chip'
import { StatusDot } from '@/components/ui/primitives'
import { DataTable, type Column, type SortState } from '@/components/layout/DataTable'
import { FileIcon } from './FileIcons'
import { useSftpColumns, type SftpColumnId } from './columns'
import { ColumnPicker } from './ColumnPicker'
import { useDropUpload } from './useDropUpload'
import { useTransfer } from './useTransfer'
import { TransferFooter } from './TransferFooter'
import {
  ContextMenu,
  MenuItem,
  MenuSeparator,
  MenuSub,
  type MenuPoint,
} from '@/components/ui/ContextMenu'
import {
  OwnerDialog,
  PermissionsDialog,
  RenameDialog,
  RootActionDialog,
  ShellSyncDialog,
  SudoDialog,
} from './FileDialogs'
import { useEditing } from './useEditing'
import { useShellCwd } from './useShellCwd'
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

/**
 * Orders two entries by one column.
 *
 * On the values, never on what the cell prints: `formatSize` gives `9 KB` and
 * `412 MB`, and sorting those as text puts the megabytes first. `owner` is the
 * exception — it is a mix of names and numbers with no single underlying value,
 * so the string the column shows is the thing being ordered.
 *
 * A missing value always sorts last, in both directions. Directories have no
 * size and some servers report no mtime; leaving those at the end keeps the
 * rows worth reading at the top whichever way the caret points.
 */
function compareFiles(a: RemoteFile, b: RemoteFile, key: string): number {
  const text = (x: string, y: string) => x.localeCompare(y, undefined, { numeric: true })

  const missingLast = (x: number | null, y: number | null): number | null => {
    if (x === null && y === null) return 0
    if (x === null) return 1
    if (y === null) return -1
    return null
  }

  switch (key) {
    case 'size': {
      const gap = missingLast(a.size, b.size)
      return gap ?? (a.size! - b.size!)
    }
    case 'modified': {
      const gap = missingLast(a.modified, b.modified)
      return gap ?? (a.modified! - b.modified!)
    }
    case 'owner':
      return text(ownerText(a), ownerText(b))
    case 'mode': {
      // The octal, as a number: `755` before `1755`, and `40` before `644`.
      const gap = missingLast(
        a.mode === null ? null : Number(a.mode),
        b.mode === null ? null : Number(b.mode),
      )
      return gap ?? Number(a.mode) - Number(b.mode)
    }
    default:
      return text(a.name, b.name)
  }
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
  // `sudo` rides along so the answer opens the file the way it was asked for.
  const [confirmLarge, setConfirmLarge] = useState<{ file: RemoteFile; sudo: boolean } | null>(
    null,
  )
  // An action waiting on a sudo password. An object rather than a bare
  // function, because `setState` given a function calls it.
  const [pending, setPending] = useState<{ run: () => void } | null>(null)
  const [sudoBusy, setSudoBusy] = useState(false)
  // The host's answer to the last password, kept in the dialog rather than on
  // the pane: a wrong password is something to correct where it was typed.
  const [sudoError, setSudoError] = useState<string | null>(null)
  // A view preference, so it outlives a `cd` — sorting by size and then
  // stepping into a folder must not silently drop back to name order.
  const [sort, setSort] = useState<SortState | null>(null)
  // The server's accounts, read once per session rather than per dialog: it is
  // two small files, but it is still a round trip, and the Owner dialog is the
  // kind of thing that gets opened repeatedly while getting a tree right.
  // `null` means "not read yet"; the dialog draws its numeric fields either way.
  const [principals, setPrincipals] = useState<Principals | null>(null)
  // This listing came back only because root read it. Drawn, not hidden.
  const [elevated, setElevated] = useState(false)
  // The directory a listing was refused for, so `Browse as root` knows which.
  const [refused, setRefused] = useState<string | null>(null)
  // Whether the dialog now open is the root version of itself. The dialogs are
  // the same either way — what changes is the command underneath and the
  // confirm in front of it.
  const [asRoot, setAsRoot] = useState(false)

  const load = useCallback(
    async (target: string, system = false, sudo = false) => {
      setBusy(true)
      setError(null)
      try {
        const listing = await sftpList(session.id, target, system, sudo)
        setPath(listing.path)
        setFiles(listing.files)
        setElevated(listing.elevated)
        setRefused(null)
      } catch (e) {
        setError(message(e))
        // Kept so the pane can offer to try again as root, and *only* for a
        // refusal — a path that does not exist will not start existing.
        setRefused(message(e).toLowerCase().includes('permission denied') ? target : null)
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

  // Fetched when the Owner dialog is first wanted, not on connect: most
  // sessions never open it, and a pane that opens is not a request for the
  // account list. A refusal is remembered as empty lists rather than retried.
  useEffect(() => {
    if (dialog !== 'owner' || principals !== null) return
    let cancelled = false
    void sftpPrincipals(session.id)
      .then((found) => !cancelled && setPrincipals(found))
      .catch(() => !cancelled && setPrincipals({ users: [], groups: [] }))
    return () => {
      cancelled = true
    }
  }, [dialog, principals, session.id])

  /**
   * The rows as shown: directories first whatever the sort, the way Finder and
   * Explorer both keep them. A folder has no size and no meaningful mtime for
   * the thing being compared, so letting them interleave by size would scatter
   * the structure of the folder through the file list.
   *
   * `sort === null` is the server order — already directories-first by name —
   * so the default costs no sort at all.
   */
  const rows = useMemo(() => {
    if (!sort) return files
    const direction = sort.dir === 'asc' ? 1 : -1
    return [...files].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
      return direction * compareFiles(a, b, sort.key)
    })
  }, [files, sort])

  /** asc → desc → unsorted, which is the cycle `DataTable` documents. */
  const toggleSort = (key: string) =>
    setSort((current) => {
      if (current?.key !== key) return { key, dir: 'asc' }
      return current.dir === 'asc' ? { key, dir: 'desc' } : null
    })

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

  /** A long operation of our own — a delete — on the same footer an upload
   *  uses. `done` is the second it stays up afterwards, as uploads do. */
  const [working, setWorking] = useState<'idle' | 'running' | 'done'>('idle')
  useEffect(() => {
    if (working !== 'done') return
    const timer = window.setTimeout(() => setWorking('idle'), 1000)
    return () => window.clearTimeout(timer)
  }, [working])

  // `done` keeps the finished bar on screen for a moment — see `DropState`.
  const transfer = useTransfer(
    session.id,
    drop.state === 'uploading' || drop.state === 'done' || working !== 'idle',
  )

  /** Absolute path of a listed entry, in the folder currently shown. */
  const pathOf = (file: RemoteFile) =>
    path.endsWith('/') ? `${path}${file.name}` : `${path}/${file.name}`

  /**
   * Runs one remote change, then re-reads the folder so the row shows truth.
   *
   * `reports` marks the operations that send progress — a recursive delete can
   * take minutes over a big tree, and the dialog closes the moment it starts.
   * Without this the app looks like it did nothing at all.
   */
  const act = async (run: () => Promise<unknown>, reports = false) => {
    setDialog(null)
    setActing(null)
    setOpError(null)
    if (reports) setWorking('running')
    try {
      await run()
      await load(path)
      if (reports) setWorking('done')
    } catch (e) {
      if (reports) setWorking('idle')
      setOpError(message(e))
    }
  }

  const openDialog = (kind: 'rename' | 'mode' | 'owner' | 'delete', sudo = false) => {
    setActing(menu?.file ?? null)
    setAsRoot(sudo)
    setDialog(kind)
    setMenu(null)
  }

  const editing = useEditing(session.id, () => void load(path))

  /**
   * Everything that runs as root, held at one gate.
   *
   * Confirmed *before* the password rather than after, and before it even
   * matters whether one is needed: the question "should this run as root at
   * all" is the user's, and on a session that is already unlocked — or a
   * NOPASSWD host — nothing else would ever have stopped to ask it.
   */
  const [rootAction, setRootAction] = useState<{
    action: string
    path: string
    command: string
    writes: boolean
    run: () => void
  } | null>(null)

  const confirmRoot = (ask: NonNullable<typeof rootAction>) => {
    setMenu(null)
    setRootAction(ask)
  }

  /**
   * Runs something that needs root, collecting a password first if the host
   * wants one.
   *
   * The check comes first so that the great many hosts with a NOPASSWD rule —
   * or a `sudo` timestamp still warm from the user's own terminal — never see a
   * password box they have no use for. A host that refuses outright says so
   * here, before anything has been typed.
   */
  const withSudo = async (run: () => void) => {
    try {
      const check = await sudoCheck(session.id)
      if (check.status === 'refused') {
        setOpError(`sudo: ${check.detail || 'this account may not run sudo on this server'}`)
        return
      }
      if (check.status === 'needsPassword') {
        setSudoError(null)
        setPending({ run })
        return
      }
      run()
    } catch (e) {
      setOpError(message(e))
    }
  }

  /** The dialog's answer: check it against the host, then do what was waiting. */
  const unlock = async (password: string) => {
    setSudoBusy(true)
    setSudoError(null)
    try {
      await sudoUnlock(session.id, password)
      const waiting = pending
      setPending(null)
      waiting?.run()
    } catch (e) {
      // The dialog stays open on a refusal — the password is the thing to
      // correct, and closing would throw away the action waiting behind it.
      setSudoError(message(e))
    } finally {
      setSudoBusy(false)
    }
  }

  /**
   * Opening for edit. Files over 5MB ask first: "edit" means handing the file
   * to a text editor, and a 200MB log opened by accident freezes whichever one
   * the user has.
   *
   * `sudo` makes every write-back go through root. It is asked for here, while
   * the user is looking at this pane, rather than when a save fails — by then
   * they are in another application and have just pressed save, and a password
   * box from a window in the background is not something to put in front of
   * somebody who did not ask for one.
   */
  const openFile = (file: RemoteFile, choose: boolean, sudo = false) => {
    setMenu(null)
    const start = () => {
      if ((file.size ?? 0) > LARGE_FILE && !choose) {
        setConfirmLarge({ file, sudo })
        return
      }
      void editing.edit(file, pathOf(file), choose, sudo)
    }
    if (!sudo) return start()

    const remote = pathOf(file)
    confirmRoot({
      action: 'Open as root',
      path: remote,
      // Both halves, because opening as root is both: the read only happens if
      // the ordinary one is refused, and the write happens on every save from
      // then on. Saying only the first would understate what is being agreed to.
      command: `sudo cat -- '${remote}'   ·   every save: sudo cp -- <copy> '${remote}'`,
      writes: true,
      run: () => void withSudo(start),
    })
  }

  /**
   * One remote change, confirmed first when it runs as root.
   *
   * The ordinary path is unchanged: a chmod as the account is a chmod. The
   * elevated one goes through the same gate every other root action does, so
   * there is exactly one place where "this will run as root" is stated and
   * agreed to.
   */
  const apply = (
    action: string,
    command: string,
    target: string,
    run: () => Promise<unknown>,
    reports = false,
  ) => {
    if (!asRoot) return void act(run, reports)
    confirmRoot({
      action,
      path: target,
      command,
      writes: true,
      run: () => void withSudo(() => void act(run, reports)),
    })
  }

  /** The other half: a save that was refused, sent again as root. */
  const saveAsRoot = (remote: string) =>
    confirmRoot({
      action: 'Save as root',
      path: remote,
      command: `sudo cp -- <copy in your home> '${remote}'`,
      writes: true,
      run: () => void withSudo(() => void editing.elevate(remote)),
    })

  /* ---------------------------------------------------------------------
     The two panes, kept in step.

     Deliberately asymmetric, because the two directions are not the same
     kind of act. Sending `cd` is typing at a shell the user is looking at,
     when they have just asked for it. Learning where that shell *is* cannot
     be done by asking without typing into whatever program happens to be
     running — so that direction listens, and offers a way to make the shell
     speak when it is silent.
  --------------------------------------------------------------------- */

  const shellCwd = useShellCwd(session.id)
  const [askingSync, setAskingSync] = useState(false)

  /** Takes the terminal to the folder this pane is showing. */
  const sendCd = () => {
    if (!path) return
    setOpError(null)
    void sshCd(session.id, path).catch((e) => setOpError(message(e)))
  }

  /**
   * Goes to the folder the terminal is in — or, when the shell has never said
   * where that is, explains how to make it say.
   */
  const followShell = () => {
    if (shellCwd === null) {
      setAskingSync(true)
      return
    }
    if (shellCwd !== path) void load(shellCwd)
  }

  /** The user's decision, in the dialog: type the hook at the shell once. */
  const enableSync = () => {
    setAskingSync(false)
    void sshWrite(session.id, encodeText(`${CWD_HOOK}\n`)).catch((e) => setOpError(message(e)))
  }

  // One line for every kind of failure that leaves the listing standing. The
  // others come first because they are things the user has just done and is
  // waiting on, where a refused write-back arrives on its own schedule.
  //
  // Resolved together rather than separately, because only one of them brings a
  // button: a `Save as root` beside somebody else's message would be offering
  // to fix the wrong thing.
  const immediate = drop.error ?? opError ?? editing.error ?? null
  const refusedSave = immediate === null ? editing.failed : null
  const complaint = immediate ?? refusedSave?.error ?? null

  const RENDERERS: Record<SftpColumnId, Column<RemoteFile>> = {
    name: {
      key: 'name',
      sortable: true,
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
      sortable: true,
      header: 'Size',
      headerClassName: 'text-right',
      className: 'text-right text-muted',
      render: (file) => formatSize(file.size),
    },
    modified: {
      key: 'modified',
      sortable: true,
      header: 'Modified',
      className: 'cell-ellipsis text-meta text-faint',
      render: (file) => formatMtime(file.modified),
    },
    owner: {
      key: 'owner',
      sortable: true,
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
      sortable: true,
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
          does not reflow the moment a file crosses the window.
          Only while the pointer is over it: once the upload starts, the footer
          says how it is going, and a scrim over the listing would hide both the
          files and the bar reporting on them. */}
      {drop.state === 'over' ? (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-scrim">
          <span className="rounded-field border border-accent-27 bg-drawer px-3 py-2 font-mono text-cell text-fg">
            drop to upload into {path || '/'}
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
        {/* The two directions, then Refresh. `flex-none` on all three so a
            narrow pane eats the breadcrumb — which already scrolls out of its
            own overflow — rather than the controls. */}
        {/* This listing exists only because root read it. Said plainly, in the
            place the listing is: a pane that draws an elevated listing exactly
            like an ordinary one has stopped reporting what it did. */}
        {elevated ? (
          <span className="flex-none rounded-chip bg-w07 px-1.5 py-0.25 font-mono text-status uppercase text-warn">
            as root
          </span>
        ) : null}
        <span className="ml-auto flex flex-none items-center gap-1.5">
          <Chip
            className="flex-none"
            disabled={session.status !== 'open' || !path}
            title={path ? `Type "cd ${path}" at the terminal` : 'No folder yet'}
            onClick={sendCd}
          >
            cd here
          </Chip>
          {/* Enabled either way. With a directory known it goes there; without
              one it says why it cannot, which is the more useful answer than a
              control that is greyed out with no explanation. */}
          <Chip
            className="flex-none"
            disabled={session.status !== 'open' || shellCwd === path}
            title={
              shellCwd === null
                ? 'The shell has not said where it is — how to make it'
                : `Go to the terminal's folder, ${shellCwd}`
            }
            onClick={followShell}
          >
            follow
          </Chip>
          <Chip className="flex-none" onClick={() => void load(path)}>
            Refresh
          </Chip>
        </span>
      </div>

      {/* Upload and file-operation failures share one dismissible line: both
          are things that went wrong *to* the listing, not instead of it.

          A refused write-back is the one failure with an answer attached, so it
          brings a button. The editor has already written the file — what is on
          the scratch copy is what the user saved — so the fix is to send that
          again as root, not to ask them to save a second time. */}
      {complaint ? (
        <div className="flex flex-none items-start gap-2 border-b border-w06 px-3 py-2">
          <button
            type="button"
            onClick={() => {
              drop.clearError()
              setOpError(null)
              editing.clearError()
            }}
            className="min-w-0 flex-1 text-left font-mono text-mono/cmd break-words text-warn"
          >
            ! {complaint}
          </button>
          {refusedSave ? (
            <Chip className="flex-none" onClick={() => saveAsRoot(refusedSave.remote)}>
              Save as root
            </Chip>
          ) : null}
        </div>
      ) : null}

      {/* A folder the account cannot read, with the way in. The listing is not
          retried behind the user's back where a password would be wanted —
          clicking a folder must not raise a credentials prompt — so it is
          offered here instead. */}
      {refused ? (
        <div className="flex flex-none items-center gap-2 border-b border-w06 px-3 py-2">
          <span className="min-w-0 flex-1 font-mono text-mono text-faint">
            this account cannot read {refused}
          </span>
          <Chip
            className="flex-none text-warn"
            onClick={() =>
              confirmRoot({
                action: 'Browse as root',
                path: refused,
                command: `sudo find '${refused}' -maxdepth 1 -mindepth 1 -printf …`,
                writes: false,
                run: () => void withSudo(() => void load(refused, false, true)),
              })
            }
          >
            Browse as root
          </Chip>
        </div>
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
          rows={[PARENT, ...rows]}
          columns={columns}
          gridTemplate={cols.gridTemplate}
          rowKey={(file) => file.name}
          density="compact"
          sort={sort}
          onToggleSort={toggleSort}
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

      {/* Below the table, per the handoff. It appears and disappears with the
          transfer, which does resize the listing above it — but the listing is
          scrolled by the user, not anchored to the bottom, so a row moving up
          three lines is the whole of it. */}
      {transfer ? <TransferFooter transfer={transfer} /> : null}

      <ContextMenu at={menu?.at ?? null} onClose={() => setMenu(null)} estimatedHeight={menu?.file.kind === 'file' ? 300 : 240}>
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
        {/* Every root action behind one row rather than scattered through the
            menu beside its ordinary twin. Two things at once: the menu stays
            short enough to scan, and nothing that runs as root can be reached
            by a pointer sliding down the list. */}
        <MenuSub label="As root" root estimatedHeight={210}>
          {menu?.file.kind === 'file' ? (
            // The case this whole feature exists for: a config file that reads
            // fine and refuses to be written. Named "as root" rather than "with
            // sudo" because what changes is who writes the file; sudo is only how.
            <MenuItem root onClick={() => menu && openFile(menu.file, false, true)}>
              Open as root…
            </MenuItem>
          ) : null}
          <MenuItem root onClick={() => openDialog('rename', true)}>
            Rename as root…
          </MenuItem>
          <MenuItem root onClick={() => openDialog('mode', true)}>
            Permissions as root…
          </MenuItem>
          <MenuItem root onClick={() => openDialog('owner', true)}>
            Owner as root…
          </MenuItem>
          <MenuSeparator />
          <MenuItem danger onClick={() => openDialog('delete', true)}>
            Delete as root…
          </MenuItem>
        </MenuSub>
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
              {editing.saved.elevated ? ' · as root' : ''}
            </span>
          ) : (
            <>
              editing {editing.open.length}{' '}
              {editing.open.length === 1 ? 'file' : 'files'} · saves upload
              {/* Which of them go up as root, because that is the fact worth
                  knowing before pressing save in another window. */}
              {editing.elevated.length > 0
                ? editing.elevated.length === editing.open.length
                  ? ' as root'
                  : ` · ${editing.elevated.length} as root`
                : ''}
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
            const { file, sudo } = confirmLarge
            setConfirmLarge(null)
            void editing.edit(file, pathOf(file), false, sudo)
          }}
        >
          <div className="flex flex-col gap-2">
            <span>
              <span className="font-mono text-cell text-fg">{confirmLarge.file.name}</span> is{' '}
              {size(confirmLarge.file.size)} — over the 5 MB edit limit.
            </span>
            <span className="text-muted">
              It is downloaded in full and handed to a local application, which may take a
              moment to open it.
            </span>
          </div>
        </ConfirmDialog>
      ) : null}

      {askingSync ? (
        <ShellSyncDialog
          hook={CWD_HOOK}
          onCancel={() => setAskingSync(false)}
          onEnable={enableSync}
        />
      ) : null}

      {/* Every path to root passes through here first — including the ones
          where sudo is already unlocked and nothing else would have asked. */}
      {rootAction ? (
        <RootActionDialog
          action={rootAction.action}
          host={session.name}
          path={rootAction.path}
          command={rootAction.command}
          writes={rootAction.writes}
          onCancel={() => setRootAction(null)}
          onConfirm={() => {
            const ask = rootAction
            setRootAction(null)
            ask.run()
          }}
        />
      ) : null}

      {/* Asked once per session, and only where the host says it wants one. */}
      {pending ? (
        <SudoDialog
          user={session.info?.user ?? 'this account'}
          host={session.name}
          busy={sudoBusy}
          error={sudoError}
          onCancel={() => {
            setPending(null)
            setSudoError(null)
          }}
          onUnlock={(password) => void unlock(password)}
        />
      ) : null}

      {dialog === 'rename' && acting ? (
        <RenameDialog
          file={acting}
          onCancel={() => setDialog(null)}
          onRename={(name) => {
            const to = path.endsWith('/') ? `${path}${name}` : `${path}/${name}`
            apply(
              'Rename as root',
              `sudo mv -n -- '${pathOf(acting)}' '${to}'`,
              pathOf(acting),
              () => sftpRename(session.id, pathOf(acting), to, asRoot),
            )
          }}
        />
      ) : null}

      {dialog === 'mode' && acting ? (
        <PermissionsDialog
          file={acting}
          onCancel={() => setDialog(null)}
          onApply={(mode) =>
            apply(
              'Permissions as root',
              `sudo chmod ${(mode & 0o777).toString(8).padStart(4, '0')} -- '${pathOf(acting)}'`,
              pathOf(acting),
              () => sftpChmod(session.id, pathOf(acting), mode, asRoot),
            )
          }
        />
      ) : null}

      {dialog === 'delete' && acting ? (
        <ConfirmDialog
          open
          title={acting.kind === 'dir' ? 'Delete folder' : 'Delete file'}
          confirmLabel="Delete"
          onCancel={() => setDialog(null)}
          onConfirm={() =>
            apply(
              'Delete as root',
              `sudo rm -f${acting.kind === 'dir' ? 'r' : ''} -- '${pathOf(acting)}'`,
              pathOf(acting),
              () => sftpRemove(session.id, pathOf(acting), acting.kind === 'dir', asRoot),
              true,
            )
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
          principals={principals}
          onCancel={() => setDialog(null)}
          onApply={(uid, gid, recursive) =>
            apply(
              'Owner as root',
              `sudo chown ${recursive ? '-R ' : ''}${uid}:${gid} -- '${pathOf(acting)}'`,
              pathOf(acting),
              () => sftpChown(session.id, pathOf(acting), uid, gid, recursive, asRoot),
            )
          }
        />
      ) : null}
    </div>
  )
}
