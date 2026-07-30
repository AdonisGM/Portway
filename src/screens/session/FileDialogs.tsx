import { useState } from 'react'
import type { RemoteFile } from '@/lib/api'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { Field } from '@/components/ui/Field'
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

export function OwnerDialog({
  file,
  onCancel,
  onApply,
}: {
  file: RemoteFile
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

          {/* Numeric, because SFTP never sends the names — the same limit the
              Owner column carries. */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="User id" value={uid} autoFocus onChange={(e) => setUid(e.target.value)} />
            <Field label="Group id" value={gid} onChange={(e) => setGid(e.target.value)} />
          </div>

          {file.kind === 'dir' ? (
            <ToggleField
              label="Apply to everything inside"
              checked={recursive}
              onChange={setRecursive}
            />
          ) : null}

          <span className="font-mono text-cell text-fg-2">
            chown {uidNum}:{gidNum}
            {recursive ? ' -R' : ''} <span className="text-faint">{file.name}</span>
          </span>
        </div>
      }
    </ConfirmDialog>
  )
}
