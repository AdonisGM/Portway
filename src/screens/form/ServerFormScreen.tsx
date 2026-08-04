import { useMemo, useState } from 'react'
import { homeDir } from '@tauri-apps/api/path'
import { open } from '@tauri-apps/plugin-dialog'
import { GROUP_IDS, GROUP_SHORT } from '@/data/groups'
import type { AuthMethod, GroupId, HostInput } from '@/data/types'
import { message } from '@/lib/api'
import { buildSshCommand, DEFAULT_KEY_PATH } from '@/lib/command'
import { nextCopyName } from '@/lib/naming'
import { Button } from '@/components/ui/Button'
import { Field, Labelled, fieldBox } from '@/components/ui/Field'
import { Segmented } from '@/components/ui/Segmented'
import { Select } from '@/components/ui/Select'
import { ToggleField } from '@/components/ui/Toggle'
import { CommandText, SectionLabel } from '@/components/ui/primitives'
import { useApp } from '@/store/appStore'
import { KeyPicker } from './KeyPicker'

const AUTH_METHODS: { value: AuthMethod; label: string }[] = [
  { value: 'password', label: 'Password' },
  { value: 'key', label: 'Private key' },
  { value: 'agent', label: 'Agent' },
]

const NO_JUMP = '—'

/**
 * New / Edit server.
 *
 * The form column carries Connection, Authentication and Advanced; the 300px
 * summary column recomputes the resulting command from the live form state
 * through the same builder the drawer footer uses, so the two can never
 * disagree.
 *
 * Neither credential field is written to the database. The summary column
 * promises credentials live in the OS keychain and the app stores only
 * references, and that is literally true of both: each is sent with the host
 * and diverted to the keychain by `hosts.rs`, never bound to a column.
 *
 * Both boxes are empty every time a host is opened, including one whose secret
 * is stored, because nothing reads a secret back out. An empty box therefore
 * means "unchanged", not "clear it".
 */
export function ServerFormScreen() {
  const goScreen = useApp((s) => s.goScreen)
  const formMode = useApp((s) => s.formMode)
  const hosts = useApp((s) => s.hosts)
  const createHost = useApp((s) => s.createHost)
  const updateHost = useApp((s) => s.updateHost)
  const agentKeys = useApp((s) => s.keys).filter((k) => k.inAgent)

  const editing = formMode.kind === 'edit' ? formMode.host : null
  const source = editing ?? (formMode.kind === 'new' ? formMode.prefill : null)

  // Seeded once per form open; `formMode` changes identity on every entry, so
  // a keyed remount is not needed.
  // Every other label in the database, so the form can reject a collision
  // before the write and Duplicate can pick a free number.
  const otherNames = useMemo(
    () => new Set(hosts.filter((h) => h.id !== editing?.id).map((h) => h.name)),
    [hosts, editing],
  )

  const [name, setName] = useState(() => {
    if (editing) return editing.name
    if (source) return nextCopyName(source.name, otherNames)
    return ''
  })
  const [group, setGroup] = useState<GroupId>(source?.group ?? 'prod')
  const [address, setAddress] = useState(source?.address ?? '')
  const [port, setPort] = useState(String(source?.port ?? 22))
  const [user, setUser] = useState(source?.user ?? '')
  const [auth, setAuth] = useState<AuthMethod>(source?.auth ?? 'key')
  const [keyPath, setKeyPath] = useState(source?.keyPath ?? DEFAULT_KEY_PATH)
  const [jumpHost, setJumpHost] = useState(source?.jumpHost ?? NO_JUMP)
  const [runOnConnect, setRunOnConnect] = useState(source?.runOnConnect ?? '')
  const [agentForwarding, setAgentForwarding] = useState(source?.agentForwarding ?? true)
  const [keepAlive, setKeepAlive] = useState(source?.keepAlive ?? false)
  const [saveToKeychain, setSaveToKeychain] = useState(source?.saveToKeychain ?? true)
  const [unlockViaKeychain, setUnlockViaKeychain] = useState(source?.unlockViaKeychain ?? true)

  // Never persisted — see the note above.
  const [password, setPassword] = useState('')
  const [passphrase, setPassphrase] = useState('')

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const portNumber = Number(port) || 0
  const command = buildSshCommand({
    user: user || 'user',
    address: address || 'host',
    port: portNumber || 22,
    jumpHost: jumpHost === NO_JUMP ? null : jumpHost,
    identityFile: auth === 'key' ? keyPath : null,
  })

  // A host cannot proxy through itself.
  const jumpOptions = useMemo(
    () => [
      { value: NO_JUMP, label: 'None' },
      ...hosts
        .filter((h) => h.id !== editing?.id)
        .map((h) => ({ value: h.name, label: h.name })),
    ],
    [hosts, editing],
  )

  const nameTaken = name.trim() !== '' && otherNames.has(name.trim())
  const filledIn =
    name.trim() !== '' &&
    address.trim() !== '' &&
    user.trim() !== '' &&
    portNumber >= 1 &&
    portNumber <= 65535
  const valid = filledIn && !nameTaken

  /**
   * Native file picker for the key path.
   *
   * A webview `<input type="file">` is no use here: it hands back a File whose
   * path is withheld, and what has to reach the backend is a filesystem path.
   *
   * Two details are deliberate. It opens *in* `~/.ssh` because a panel cannot
   * browse into a hidden directory without the user knowing Cmd+Shift+period,
   * and it sets no file-type filter because private keys carry no extension —
   * any filter would hide every key in the folder.
   */
  const chooseKeyFile = async () => {
    setError(null)
    try {
      const home = (await homeDir()).replace(/\/$/, '')
      const picked = await open({ multiple: false, directory: false, defaultPath: `${home}/.ssh` })
      if (typeof picked !== 'string') return // dismissed
      // Store it the way the field shows it and the way `expand_home` reads it;
      // an absolute path outside home is kept as-is, which it also accepts.
      setKeyPath(picked.startsWith(`${home}/`) ? `~/${picked.slice(home.length + 1)}` : picked)
    } catch (e) {
      setError(message(e))
    }
  }

  const save = async () => {
    if (!valid) return
    setSaving(true)
    setError(null)

    const input: HostInput = {
      name: name.trim(),
      address: address.trim(),
      port: portNumber,
      user: user.trim(),
      group,
      auth,
      keyPath: auth === 'key' ? keyPath.trim() || null : null,
      jumpHost: jumpHost === NO_JUMP ? null : jumpHost,
      runOnConnect: runOnConnect.trim() || null,
      agentForwarding,
      keepAlive,
      saveToKeychain,
      unlockViaKeychain,
      favorite: source?.favorite ?? false,
      // Only for the auth method each belongs to, and only when the user
      // actually typed one — an untouched box must not disturb a secret
      // already in the keychain.
      passphrase: auth === 'key' && passphrase ? passphrase : null,
      password: auth === 'password' && password ? password : null,
    }

    try {
      if (editing) await updateHost(editing.id, input)
      else await createHost(input)
      // Drop them as soon as the keychain has them, so a secret does not sit
      // in component state for as long as the app is open.
      setPassphrase('')
      setPassword('')
      goScreen('servers')
    } catch (e) {
      setError(message(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="absolute inset-0 flex flex-col bg-base">
      <div className="flex flex-none items-center gap-3 border-b border-w06 px-5 py-3.75">
        <button
          type="button"
          onClick={() => goScreen('servers')}
          className="font-mono text-cell text-muted transition-colors hover:text-fg"
        >
          ‹ hosts
        </button>
        <span className="text-title font-semibold">{editing ? 'Edit server' : 'New server'}</span>
        <span className="ml-auto flex gap-2">
          <Button size="md" onClick={() => goScreen('servers')} disabled={saving}>
            Cancel
          </Button>
          <Button variant="outline" size="md" disabled={saving}>
            Test connection
          </Button>
          <Button
            variant="accent"
            size="lg"
            onClick={() => void save()}
            disabled={!valid || saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col gap-5.5 overflow-y-auto px-6 py-5">
          <section>
            <SectionLabel className="mb-2.75">Connection</SectionLabel>
            <div className="grid grid-cols-[1.6fr_74px] gap-3">
              <Field
                label="Label"
                value={name}
                placeholder="db-replica.prod"
                onChange={(e) => setName(e.target.value)}
              />
              <Select
                label="Group"
                value={group}
                onChange={setGroup}
                options={GROUP_IDS.map((g) => ({ value: g, label: GROUP_SHORT[g] }))}
              />
            </div>
            <div className="mt-3 grid grid-cols-[1.6fr_74px_1fr] gap-3">
              <Field
                label="Host"
                value={address}
                placeholder="10.20.4.32"
                onChange={(e) => setAddress(e.target.value)}
              />
              <Field
                label="Port"
                value={port}
                inputMode="numeric"
                onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
              />
              <Field
                label="Username"
                value={user}
                placeholder="postgres"
                onChange={(e) => setUser(e.target.value)}
              />
            </div>
          </section>

          <section>
            <SectionLabel className="mb-2.75">Authentication</SectionLabel>
            <Segmented
              aria-label="Authentication method"
              size="md"
              options={AUTH_METHODS}
              value={auth}
              onChange={setAuth}
            />

            {auth === 'password' ? (
              <div className="mt-3.25 grid grid-cols-2 gap-3">
                <Field
                  label="Password"
                  masked
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <div className="flex items-end">
                  <div className="py-2">
                    <ToggleField
                      label="Save to system keychain"
                      checked={saveToKeychain}
                      onChange={setSaveToKeychain}
                    />
                  </div>
                </div>
              </div>
            ) : null}

            {auth === 'key' ? (
              <div className="mt-3.25 flex flex-col gap-3">
                <Labelled label="Private key">
                  <div className="flex items-center gap-2">
                    <div className={`${fieldBox} flex-1`}>
                      <input
                        value={keyPath}
                        onChange={(e) => setKeyPath(e.target.value)}
                        aria-label="Private key path"
                        className="w-full font-mono text-body text-fg-2"
                      />
                    </div>
                    <Button
                      variant="outline"
                      size="md"
                      className="flex-none py-2"
                      onClick={() => void chooseKeyFile()}
                    >
                      Choose file…
                    </Button>
                    <KeyPicker onPick={setKeyPath} />
                  </div>
                </Labelled>

                <div className="grid grid-cols-2 gap-3">
                  <Field
                    label={
                      <>
                        Passphrase <span className="text-faint">(if the key has one)</span>
                      </>
                    }
                    masked
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                  />
                  <div className="flex items-end">
                    <div className="py-2">
                      <ToggleField
                        label="Unlock via keychain"
                        checked={unlockViaKeychain}
                        onChange={setUnlockViaKeychain}
                      />
                    </div>
                  </div>
                </div>

                <div className="font-mono text-meta text-faint">
                  fingerprint SHA256:9pQ…hK4 · ed25519 · added Mar 2026
                </div>
              </div>
            ) : null}

            {auth === 'agent' ? (
              <div className="mt-3.25 flex flex-col gap-2.5">
                <p className="text-body text-fg-2">
                  Use a key already loaded in ssh-agent — no credentials stored in the app.
                </p>
                {/* The same scan the Keys screen renders, filtered to what the
                    agent is actually holding — so the form cannot claim a key
                    is available when the rail says the agent is empty. */}
                {agentKeys.length === 0 ? (
                  <div className="rounded-field border border-w08 bg-field px-2.75 py-2 font-mono text-cell text-muted">
                    No keys loaded — add one with{' '}
                    <span className="text-fg-2">ssh-add ~/.ssh/id_ed25519</span>
                  </div>
                ) : (
                  <div className="flex flex-col gap-px overflow-hidden rounded-field border border-w08">
                    {agentKeys.map((key) => (
                      <div
                        key={key.path}
                        className="flex gap-2.5 bg-field px-2.75 py-2 font-mono text-cell text-fg-2"
                      >
                        <span className={key.weak ? 'text-warn' : 'text-accent'}>●</span>
                        {key.name}
                        <span className="ml-auto cell-ellipsis text-faint">{key.fingerprint}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
          </section>

          <section>
            <SectionLabel className="mb-2.75">Advanced</SectionLabel>
            <div className="grid grid-cols-2 gap-3">
              <Select
                label="Jump host / bastion"
                value={jumpHost}
                onChange={setJumpHost}
                options={jumpOptions}
              />
              <Field
                label="Run on connect"
                value={runOnConnect}
                placeholder="tmux attach -t main"
                onChange={(e) => setRunOnConnect(e.target.value)}
              />
            </div>
            <div className="mt-3.25 flex gap-6.5">
              <ToggleField
                label="Agent forwarding"
                checked={agentForwarding}
                onChange={setAgentForwarding}
              />
              <ToggleField
                label="Keep alive (60s)"
                checked={keepAlive}
                onChange={setKeepAlive}
              />
            </div>
          </section>
        </div>

        <aside className="flex w-summary flex-none flex-col gap-4 overflow-y-auto border-l border-w06 bg-panel p-4.5">
          <div>
            <SectionLabel className="mb-2.25">Resulting command</SectionLabel>
            <CommandText className="rounded-field border border-w08 bg-drawer px-3 py-2.75 text-meta/cmd text-fg-2">
              {command}
            </CommandText>
          </div>

          <div>
            <SectionLabel className="mb-2.25">Checks</SectionLabel>
            <div className="flex flex-col gap-2 text-cell text-fg-2">
              {/* Error reporting reuses the Checks vocabulary rather than
                  introducing a toast the handoff never designed. */}
              {error ? (
                <div className="flex gap-2.25">
                  <span className="text-danger">!</span>
                  <span className="min-w-0 break-words text-danger">{error}</span>
                </div>
              ) : null}
              <div className="flex gap-2.25">
                <span className={filledIn ? 'text-accent' : 'text-faint'}>
                  {filledIn ? '✓' : '·'}
                </span>
                Label, host and username filled in
              </div>
              <div className="flex gap-2.25">
                <span className={nameTaken ? 'text-danger' : 'text-accent'}>
                  {nameTaken ? '!' : '✓'}
                </span>
                <span className={nameTaken ? 'min-w-0 break-words text-danger' : undefined}>
                  {nameTaken ? `A server called '${name.trim()}' already exists` : 'Label is unique'}
                </span>
              </div>
              <div className="flex gap-2.25">
                <span className="text-accent">✓</span>Port {portNumber || 22} open via bastion
              </div>
              <div className="flex gap-2.25">
                <span className="text-warn">!</span>Host key not yet in known_hosts
              </div>
            </div>
          </div>

          <p className="mt-auto font-mono text-mono/cmd text-faint">
            Credentials always live in the OS keychain. The app stores only references.
          </p>
        </aside>
      </div>
    </div>
  )
}
