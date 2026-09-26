import { useState } from 'react'
import { Checkbox } from '../../components/ui/checkbox'
import { Field, TextInput } from '../../components/ui/form-controls'
import { Modal } from '../../components/ui/modal'
import { Button, cx } from '../../components/ui/primitives'
import { api, isAppError, type FileEntry } from '../../lib/api'
import { fileError, joinPath, modeString, octal, parentOf, q } from './format'

export type FileAction =
  | { mode: 'newfile' | 'newdir' }
  | { mode: 'rename'; entry: FileEntry }
  | { mode: 'chmod' | 'chown' | 'delete'; entries: FileEntry[] }

type Props = { action: FileAction; serverId: string; user: string; dir: string; canChown: boolean; onClose: () => void; onDone: (message: string, detail: string, select?: string) => void }

function Command({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-muted">Lệnh tương ứng</span>
      <span className="rounded-md bg-sunken px-2 py-1.5 font-mono text-[11.5px] leading-normal break-all text-ink2 select-text">{text}</span>
    </div>
  )
}

/** One dialog for every file operation; each shows the equivalent shell command. */
export function FileDialog(props: Props) {
  const { action } = props
  if (action.mode === 'chmod') return <ChmodDialog {...props} entries={action.entries} />
  if (action.mode === 'chown') return <ChownDialog {...props} entries={action.entries} />
  if (action.mode === 'delete') return <DeleteDialog {...props} entries={action.entries} />
  return <NameDialog {...props} />
}

function useRun(onDone: Props['onDone']) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (work: () => Promise<unknown>, message: string, detail: string, select?: string) => {
    setBusy(true)
    setError(null)
    try {
      await work()
      onDone(message, detail, select)
    } catch (e) {
      setError(isAppError(e) ? fileError(e) : String(e))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, setError, run }
}

function NameDialog({ action, serverId, user, dir, onClose, onDone }: Props) {
  const rename = action.mode === 'rename' ? action.entry : null
  const [name, setName] = useState(rename?.name ?? '')
  const { busy, error, setError, run } = useRun(onDone)
  const n = name.trim()
  const title = action.mode === 'newdir' ? 'Thư mục mới' : action.mode === 'newfile' ? 'Tệp mới' : `Đổi tên ${rename!.name}`
  // Quote the real name only; an empty one shows as a bare "…".
  const at = (d: string) => (n ? q(joinPath(d, n)) : q(joinPath(d, '')) + '…')
  const cmd =
    action.mode === 'newdir' ? `mkdir ${at(dir)}` : action.mode === 'newfile' ? `touch ${at(dir)}` : `mv ${q(rename!.path)} ${at(parentOf(rename!.path))}`
  const submit = () => {
    if (!n || (rename && n === rename.name)) return
    if (action.mode === 'newdir') void run(() => api.sftpMkdir(serverId, user, dir, n), `Đã tạo thư mục ${n}`, cmd, n)
    else if (action.mode === 'newfile') void run(() => api.sftpTouch(serverId, user, dir, n), `Đã tạo tệp ${n}`, cmd, n)
    else void run(() => api.sftpRename(serverId, user, rename!.path, n), `Đã đổi tên thành ${n}`, cmd, n)
  }
  return (
    <Modal
      open
      onClose={onClose}
      width={460}
      title={title}
      subtitle={rename ? parentOf(rename.path) : dir}
      footer={
        <>
          <Button onClick={onClose}>Huỷ</Button>
          <Button variant="primary" onClick={submit} disabled={busy || !n || (!!rename && n === rename.name)}>
            {rename ? 'Đổi tên' : 'Tạo'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <Field label="Tên" error={error ?? undefined}>
          <TextInput
            value={name}
            onChange={(v) => {
              setName(v)
              setError(null)
            }}
            invalid={!!error}
            autoFocus
          />
        </Field>
        <Command text={cmd} />
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}

const WHO = ['Owner', 'Group', 'Others']
const BITS = ['Đọc', 'Ghi', 'Chạy']

function ChmodDialog({ serverId, user, entries, onClose, onDone }: Props & { entries: FileEntry[] }) {
  const same = entries.every((e) => (e.mode & 0o777) === (entries[0].mode & 0o777))
  const [mode, setMode] = useState(same ? entries[0].mode & 0o7777 : 0o644)
  const [text, setText] = useState(octal(mode))
  const [recursive, setRecursive] = useState(false)
  const { busy, error, run } = useRun(onDone)
  const hasDir = entries.some((e) => e.kind === 'dir')
  const paths = entries.map((e) => e.path)
  const cmd = `chmod ${recursive ? '-R ' : ''}${octal(mode)} ${paths.map(q).join(' ')}`
  const toggle = (bit: number) => {
    const next = mode ^ bit
    setMode(next)
    setText(octal(next))
  }
  return (
    <Modal
      open
      onClose={onClose}
      width={480}
      title="Sửa quyền"
      subtitle={entries.length === 1 ? entries[0].path : `${entries.length} mục`}
      footer={
        <>
          <Button onClick={onClose}>Huỷ</Button>
          <Button variant="primary" disabled={busy} onClick={() => void run(() => api.sftpChmod(serverId, user, paths, mode, recursive), 'Đã sửa quyền', cmd)}>
            Áp dụng
          </Button>
        </>
      }
    >
      {!same && <span className="text-[11.5px] text-warn">Các mục đang có quyền khác nhau; tất cả sẽ được đặt thành {octal(mode)}.</span>}
      <div className="grid gap-px overflow-hidden rounded-lg border border-line bg-line" style={{ gridTemplateColumns: '90px repeat(3, 1fr)' }}>
        <span className="bg-sunken px-2.5 py-1.5" />
        {BITS.map((b) => (
          <span key={b} className="bg-sunken px-2.5 py-1.5 text-center text-[11px] text-muted">
            {b}
          </span>
        ))}
        {WHO.map((w, i) => (
          <div key={w} className="contents">
            <span className="bg-surface px-2.5 py-2 text-[12px]">{w}</span>
            {[4, 2, 1].map((b) => {
              const bit = b << ((2 - i) * 3)
              const on = (mode & bit) !== 0
              return (
                <button
                  key={b}
                  type="button"
                  onClick={() => toggle(bit)}
                  className={cx('cursor-pointer bg-surface py-2 font-mono text-[12px] hover:bg-raised', on ? 'text-ink' : 'text-muted')}
                >
                  {on ? '✓' : '·'}
                </button>
              )
            })}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="Dạng số" error={/^[0-7]{3,4}$/.test(text) ? undefined : 'Nhập 3–4 chữ số 0–7'}>
          <TextInput
            value={text}
            numeric
            onChange={(v) => {
              const t = v.replace(/[^0-7]/g, '').slice(0, 4)
              setText(t)
              if (/^[0-7]{3,4}$/.test(t)) setMode(parseInt(t, 8))
            }}
          />
        </Field>
        <Field label="Kết quả">
          <span className="flex h-[34px] items-center font-mono text-[13px]">{modeString(mode)}</span>
        </Field>
      </div>
      {hasDir && (
        <Checkbox checked={recursive} onChange={setRecursive}>
          Áp dụng cho mọi thứ bên trong thư mục (-R)
        </Checkbox>
      )}
      {error && <span className="text-[11px] text-danger">{error}</span>}
      <Command text={cmd} />
    </Modal>
  )
}

function ChownDialog({ serverId, user, entries, canChown, onClose, onDone }: Props & { entries: FileEntry[] }) {
  const [owner, setOwner] = useState(entries[0].owner ?? String(entries[0].uid ?? ''))
  const [group, setGroup] = useState(entries[0].group ?? String(entries[0].gid ?? ''))
  const [recursive, setRecursive] = useState(false)
  const { busy, error, run } = useRun(onDone)
  const paths = entries.map((e) => e.path)
  const cmd = `${user === 'root' ? '' : 'sudo '}chown ${recursive ? '-R ' : ''}${owner || '…'}:${group || '…'} -- ${paths.map(q).join(' ')}`
  return (
    <Modal
      open
      onClose={onClose}
      width={460}
      title="Đổi owner"
      subtitle={entries.length === 1 ? entries[0].path : `${entries.length} mục`}
      footer={
        <>
          <Button onClick={onClose}>Huỷ</Button>
          <Button variant="primary" disabled={busy || !canChown || !owner.trim() || !group.trim()} onClick={() => void run(() => api.sftpChown(serverId, user, paths, owner.trim(), group.trim(), recursive), 'Đã đổi owner', cmd)}>
            Áp dụng
          </Button>
        </>
      }
    >
      {!canChown && <span className="text-[11.5px] text-warn">Chỉ root mới đổi được owner. Bật sudo cho phiên này hoặc kết nối bằng root.</span>}
      <div className="grid grid-cols-2 gap-2.5">
        <Field label="Owner">
          <TextInput value={owner} onChange={setOwner} />
        </Field>
        <Field label="Group">
          <TextInput value={group} onChange={setGroup} />
        </Field>
      </div>
      {entries.some((e) => e.kind === 'dir') && (
        <Checkbox checked={recursive} onChange={setRecursive}>
          Áp dụng cho mọi thứ bên trong thư mục (-R)
        </Checkbox>
      )}
      {error && <span className="text-[11px] text-danger">{error}</span>}
      <Command text={cmd} />
    </Modal>
  )
}

function DeleteDialog({ serverId, user, entries, onClose, onDone }: Props & { entries: FileEntry[] }) {
  const { busy, error, run } = useRun(onDone)
  const paths = entries.map((e) => e.path)
  const dirs = entries.filter((e) => e.kind === 'dir').length
  const cmd = `rm ${dirs ? '-r ' : ''}${paths.map(q).join(' ')}`
  return (
    <Modal
      open
      onClose={onClose}
      width={480}
      title={entries.length === 1 ? `Xoá ${entries[0].name}?` : `Xoá ${entries.length} mục?`}
      subtitle="Không hoàn tác được"
      footer={
        <>
          <Button onClick={onClose}>Huỷ</Button>
          <Button variant="danger" disabled={busy} onClick={() => void run(() => api.sftpRemove(serverId, user, paths), `Đã xoá ${entries.length} mục`, cmd)}>
            {busy ? 'Đang xoá…' : 'Xoá'}
          </Button>
        </>
      }
    >
      <span className="leading-relaxed text-ink2">
        {dirs ? 'Thư mục sẽ bị xoá cùng toàn bộ nội dung bên trong. ' : ''}Link chỉ bị xoá bản thân link, không đụng tới đích.
      </span>
      <div className="flex max-h-40 flex-col overflow-auto rounded-lg border border-line">
        {entries.map((e) => (
          <span key={e.path} className="truncate border-t border-line px-2.5 py-1.5 font-mono text-[11.5px] first:border-t-0">
            {e.path}
            {e.kind === 'dir' ? '/' : ''}
          </span>
        ))}
      </div>
      {error && <span className="text-[11px] text-danger">{error}</span>}
      <Command text={cmd} />
    </Modal>
  )
}
