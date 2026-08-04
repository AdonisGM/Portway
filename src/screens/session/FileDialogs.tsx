import { useState } from 'react'
import type { Principal, Principals, RemoteFile } from '@/lib/api'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Field } from '@/components/ui/Field'
import { Select, type SelectOption } from '@/components/ui/Select'
import { ToggleField } from '@/components/ui/Toggle'

/**
 * Rename, permissions and owner, as three small dialogs over the SFTP pane.
 *
 * All three change something on a machine that has no undo, so each states the
 * exact path it will act on and each says what it is about to do in the words
 * the shell would use — `chmod 755`, `chown 1000:1000 -R`. A dialog that only
 * says "Apply" leaves the user to guess.
 */

export function RenameDialog({
  file,
  onCancel,
  onRename,
}: {
  file: RemoteFile
  onCancel: () => void
  onRename: (name: string) => void
}) {
  const [name, setName] = useState(file.name)
  const unchanged = name.trim() === file.name || name.trim() === ''

  return (
    <ConfirmDialog
      open
      title="Rename"
      confirmVariant="accent"
      confirmLabel="Rename"
      confirmDisabled={unchanged || name.includes('/')}
      onCancel={onCancel}
      onConfirm={() => onRename(name.trim())}
    >
      {
        <div className="flex flex-col gap-3">
          <Field
            label="New name"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !unchanged) onRename(name.trim())
            }}
          />
          {/* A name with a slash in it is a move, not a rename, and would put
              the entry somewhere the pane is not showing. */}
          {name.includes('/') ? (
            <span className="font-mono text-mono text-warn">
              ! a name cannot contain “/”
            </span>
          ) : null}
        </div>
      }
    </ConfirmDialog>
  )
}

/** `rwx` for one of owner/group/other. */
const BITS = [
  { label: 'read', value: 4 },
  { label: 'write', value: 2 },
  { label: 'execute', value: 1 },
] as const

const WHO = [
  { label: 'Owner', shift: 6 },
  { label: 'Group', shift: 3 },
  { label: 'Others', shift: 0 },
] as const

export function PermissionsDialog({
  file,
  onCancel,
  onApply,
}: {
  file: RemoteFile
  onCancel: () => void
  onApply: (mode: number) => void
}) {
  // Seeded from what the server reported, so the dialog opens showing the
  // truth rather than a default that would silently widen access on save.
  const [mode, setMode] = useState(() => Number.parseInt(file.mode ?? '644', 8))

  const toggle = (shift: number, bit: number) => setMode((m) => m ^ (bit << shift))
  const octal = (mode & 0o777).toString(8).padStart(3, '0')

  return (
    <ConfirmDialog
      open
      title="Permissions"
      confirmVariant="accent"
      confirmLabel="Apply"
      onCancel={onCancel}
      onConfirm={() => onApply(mode & 0o777)}
    >
      {
        <div className="flex flex-col gap-3">
          <span className="font-mono text-mono text-faint">{file.name}</span>

          <div className="flex flex-col gap-1.5">
            {WHO.map((who) => (
              <div key={who.label} className="flex items-center gap-3">
                <span className="w-14 flex-none text-cell text-fg-2">{who.label}</span>
                {BITS.map((bit) => (
                  <label
                    key={bit.label}
                    className="flex flex-1 cursor-pointer items-center gap-1.5 text-meta text-muted"
                  >
                    <Switch
                      on={(mode & (bit.value << who.shift)) !== 0}
                      onToggle={() => toggle(who.shift, bit.value)}
                      label={`${who.label} ${bit.label}`}
                    />
                    {bit.label}
                  </label>
                ))}
              </div>
            ))}
          </div>

          {/* The number is the readout, not the input — it is what the switches
              add up to, and what you would have typed at a shell. */}
          <span className="font-mono text-cell text-fg-2">
            chmod {octal} <span className="text-faint">{file.name}</span>
          </span>
        </div>
      }
    </ConfirmDialog>
  )
}

/** The design's toggle, at the size a nine-up grid can carry. */
function Switch({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onToggle}
      className={`relative h-4 w-7 flex-none rounded-toggle transition-colors ${
        on ? 'bg-accent' : 'bg-w12'
      }`}
    >
      <span
        className={`absolute top-0.5 size-3 rounded-toggle transition-all ${
          on ? 'right-0.5 bg-ink' : 'left-0.5 bg-muted'
        }`}
      />
    </button>
  )
}

/**
 * The picker's options: everyone the server named, and whatever the file has
 * now whether or not that is one of them.
 *
 * The current id is always present as an option. A uid that appears in no list
 * — an NFS mapping, a container's offset user, an account deleted after the
 * file was written — is still this file's owner, and a dropdown unable to show
 * the current value would read as though the file had none.
 */
function principalOptions(
  known: Principal[],
  current: number,
  currentName: string | null,
): SelectOption[] {
  const listed = known.map((p) => ({ value: String(p.id), label: `${p.name} · ${p.id}` }))
  if (!Number.isInteger(current) || current < 0) return listed
  if (known.some((p) => p.id === current)) return listed
  return [
    { value: String(current), label: currentName ? `${currentName} · ${current}` : `${current}` },
    ...listed,
  ]
}

const nameFor = (known: Principal[], id: number): string | null =>
  known.find((p) => p.id === id)?.name ?? null

export function OwnerDialog({
  file,
  principals,
  onCancel,
  onApply,
}: {
  file: RemoteFile
  /** `null` while the list is still being read, or when the server refused it. */
  principals: Principals | null
  onCancel: () => void
  onApply: (uid: number, gid: number, recursive: boolean) => void
}) {
  const [uid, setUid] = useState(String(file.uid ?? 0))
  const [gid, setGid] = useState(String(file.gid ?? 0))
  const [recursive, setRecursive] = useState(false)

  const uidNum = Number(uid)
  const gidNum = Number(gid)
  const valid =
    Number.isInteger(uidNum) && uidNum >= 0 && Number.isInteger(gidNum) && gidNum >= 0

  const users = principals?.users ?? []
  const groups = principals?.groups ?? []
  // Nothing to pick from is its own state, and a different one from "still
  // loading": the server has answered, and the answer was that it will not say.
  const nothingToPick = principals !== null && users.length === 0 && groups.length === 0

  const ownerName = nameFor(users, uidNum) ?? file.owner
  const groupName = nameFor(groups, gidNum) ?? file.group

  return (
    <ConfirmDialog
      open
      title="Owner"
      confirmVariant="accent"
      confirmLabel="Apply"
      confirmDisabled={!valid}
      onCancel={onCancel}
      onConfirm={() => onApply(uidNum, gidNum, recursive)}
    >
      {
        <div className="flex flex-col gap-3">
          <span className="font-mono text-mono text-faint">{file.name}</span>

          {/* The pickers are the way in; the numbers below stay because they
              are what `chown` is given, and because a host whose accounts come
              from LDAP lists nobody here. Either can drive the other. */}
          {users.length > 0 || groups.length > 0 ? (
            <div className="grid grid-cols-2 gap-3">
              <Select
                label="Owner"
                options={principalOptions(users, uidNum, file.owner)}
                value={String(uidNum)}
                onChange={setUid}
                disabled={users.length === 0}
              />
              <Select
                label="Group"
                options={principalOptions(groups, gidNum, file.group)}
                value={String(gidNum)}
                onChange={setGid}
                disabled={groups.length === 0}
              />
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <Field label="User id" value={uid} autoFocus onChange={(e) => setUid(e.target.value)} />
            <Field label="Group id" value={gid} onChange={(e) => setGid(e.target.value)} />
          </div>

          {nothingToPick ? (
            <span className="text-meta text-faint">
              This server did not hand over /etc/passwd — type the ids.
            </span>
          ) : null}

          {file.kind === 'dir' ? (
            <ToggleField
              label="Apply to everything inside"
              checked={recursive}
              onChange={setRecursive}
            />
          ) : null}

          {/* Numbers, because numbers are what is sent. The names ride along in
              brackets so the line can be checked against the intent. */}
          <span className="font-mono text-cell text-fg-2">
            chown {uidNum}:{gidNum}
            {recursive ? ' -R' : ''} <span className="text-faint">{file.name}</span>
            {ownerName || groupName ? (
              <span className="text-faint">
                {'  '}
                {ownerName ?? uidNum}:{groupName ?? gidNum}
              </span>
            ) : null}
          </span>
        </div>
      }
    </ConfirmDialog>
  )
}
