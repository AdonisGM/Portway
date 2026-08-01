import { useEffect, useState } from 'react'
import type { Tunnel, TunnelInput } from '@/lib/api'
import { message } from '@/lib/api'
import { tunnelForward } from '@/lib/command'
import type { Host, TunnelAutostart, TunnelKind } from '@/data/types'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Segmented } from '@/components/ui/Segmented'
import { Select } from '@/components/ui/Select'
import { CommandText } from '@/components/ui/primitives'

/**
 * New / Edit tunnel.
 *
 * The handoff draws the Tunnels table and nothing that creates a row for it, so
 * the shape here is ours — the same position the new-tab picker and the column
 * picker were in. A dialog rather than a screen: a forward is six fields, and a
 * whole screen for six fields would be the heaviest thing in the app.
 *
 * The three types need different fields, and the difference is not cosmetic: a
 * dynamic forward has no destination to type, because each client that connects
 * supplies its own. Hiding those two boxes is what says so.
 *
 * The destination picker exists because of one question this form kept
 * provoking: *I already chose the server — why is it asking for another
 * address?* Because the two are different things. `Via host` is the route; the
 * destination is where the route ends, **read from the server's position**, and
 * far more often than not it is that same server — a port bound to its own
 * loopback, which is exactly what a forward is for. So the common case is now a
 * choice that says the server's name back to you, and the address box only
 * appears when the answer really is somewhere else.
 */

/** What a server calls itself. */
const LOOPBACK = ['127.0.0.1', 'localhost', '::1', '0.0.0.0']

type Destination = 'self' | 'other'
const KINDS: { value: TunnelKind; label: string; hint: string }[] = [
  { value: 'local', label: 'Local  (ssh -L)', hint: 'Listen here, connect from the server.' },
  { value: 'remote', label: 'Remote  (ssh -R)', hint: 'Listen on the server, connect from here.' },
  { value: 'dynamic', label: 'Dynamic  (ssh -D)', hint: 'A SOCKS5 proxy, routed through the server.' },
]

const AUTOSTARTS: { value: TunnelAutostart; label: string }[] = [
  { value: 'manual', label: 'manual' },
  { value: 'session', label: 'on session' },
  { value: 'launch', label: 'on launch' },
]

export function TunnelForm({
  tunnel,
  hosts,
  onSave,
  onCancel,
}: {
  /** Null for a new one. */
  tunnel: Tunnel | null
  hosts: Host[]
  onSave: (input: TunnelInput) => Promise<void>
  onCancel: () => void
}) {
  const [label, setLabel] = useState(tunnel?.label ?? '')
  const [hostId, setHostId] = useState(tunnel?.hostId ?? hosts[0]?.id ?? 0)
  const [kind, setKind] = useState<TunnelKind>(tunnel?.kind ?? 'local')
  const [bindAddress, setBindAddress] = useState(tunnel?.bindAddress ?? '127.0.0.1')
  const [bindPort, setBindPort] = useState(String(tunnel?.bindPort ?? ''))
  const [targetHost, setTargetHost] = useState(tunnel?.targetHost ?? '127.0.0.1')
  /**
   * Which of the two the destination is. Derived from the address rather than
   * stored, so an existing tunnel opens on the option that describes it and
   * there is no second source of truth to keep in step.
   */
  const [destination, setDestination] = useState<Destination>(
    tunnel && !LOOPBACK.includes((tunnel.targetHost ?? '').trim()) ? 'other' : 'self',
  )
  /** Remembered, so flipping to `self` and back does not lose what was typed. */
  const [lastElsewhere, setLastElsewhere] = useState(
    tunnel && !LOOPBACK.includes((tunnel.targetHost ?? '').trim()) ? (tunnel.targetHost ?? '') : '',
  )
  const [targetPort, setTargetPort] = useState(
    tunnel?.targetPort === null || tunnel?.targetPort === undefined ? '' : String(tunnel.targetPort),
  )
  const [autostart, setAutostart] = useState<TunnelAutostart>(tunnel?.autostart ?? 'manual')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Escape closes it, the way every other overlay in the app does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const dynamic = kind === 'dynamic'
  const viaName = hosts.find((h) => h.id === hostId)?.name ?? 'the server'
  /** Which end resolves the destination address — the whole point of the picker. */
  const resolvedBy = kind === 'remote' ? 'this machine' : viaName

  const chooseDestination = (next: Destination) => {
    setDestination(next)
    if (next === 'self') {
      // Remembered first, so coming back is not retyping.
      if (!LOOPBACK.includes(targetHost.trim())) setLastElsewhere(targetHost)
      setTargetHost('127.0.0.1')
    } else {
      setTargetHost(lastElsewhere)
    }
  }

  const preview = tunnelForward({
    kind,
    bindAddress: bindAddress || '?',
    bindPort: Number(bindPort) || 0,
    targetHost: targetHost || null,
    targetPort: Number(targetPort) || null,
  })

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await onSave({
        label,
        hostId,
        kind,
        bindAddress,
        bindPort: Number(bindPort),
        targetHost: dynamic ? null : targetHost,
        targetPort: dynamic ? null : Number(targetPort),
        autostart,
      })
    } catch (e) {
      setError(message(e))
      setBusy(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal
      aria-label={tunnel ? `Edit ${tunnel.label}` : 'New tunnel'}
      className="absolute inset-0 z-50 flex items-start justify-center bg-scrim pt-20"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div className="flex w-[520px] max-w-[92%] flex-col gap-3.5 rounded-field border border-w10 bg-drawer p-4 shadow-drawer">
        <span className="text-body font-semibold">{tunnel ? 'Edit tunnel' : 'New tunnel'}</span>

        <Field
          label="Label"
          value={label}
          autoFocus
          placeholder="pg replica"
          onChange={(e) => setLabel(e.target.value)}
        />

        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Via host"
            value={String(hostId)}
            onChange={(value) => setHostId(Number(value))}
            options={hosts.map((h) => ({ value: String(h.id), label: h.name }))}
          />
          <Select
            label="Type"
            value={kind}
            onChange={setKind}
            options={KINDS.map((k) => ({ value: k.value, label: k.label }))}
          />
        </div>

        <span className="text-meta text-muted">{KINDS.find((k) => k.value === kind)?.hint}</span>

        <div className="grid grid-cols-2 gap-3">
          <Field
            label={kind === 'remote' ? 'Listen on the server' : 'Listen here'}
            value={bindAddress}
            onChange={(e) => setBindAddress(e.target.value)}
          />
          <Field
            label="Port"
            value={bindPort}
            inputMode="numeric"
            placeholder="5432"
            onChange={(e) => setBindPort(e.target.value)}
          />
        </div>

        {/* Anything but loopback puts the forward on the network this machine is
            on, which is a decision rather than a detail. */}
        {bindAddress.trim() !== '' && bindAddress.trim() !== '127.0.0.1' && !dynamic ? (
          <span className="text-meta text-warn">
            {bindAddress} is not loopback — anything that can reach this machine can use the
            forward.
          </span>
        ) : null}

        {dynamic ? null : (
          <>
            {/* The question the old form kept provoking, answered before it is
                asked: the second address is not a second name for the server
                you already picked, it is where the route ends — and usually
                that *is* the server. Naming it here is what makes the other
                option legible as the exception it is. */}
            <div className="flex flex-col gap-2">
              <span className="text-label tracking-label text-faint uppercase">Destination</span>
              <Segmented
                aria-label="Destination"
                size="xs"
                options={[
                  {
                    value: 'self',
                    label: kind === 'remote' ? 'This machine' : `${viaName} itself`,
                  },
                  { value: 'other', label: 'Another machine' },
                ]}
                value={destination}
                onChange={chooseDestination}
              />
            </div>

            {/* On `self` there is no address box at all — which is the real
                fix. The commonest forward there is asks for one number, and a
                second address field sitting there wanting `127.0.0.1` is the
                thing that made it look like the server had to be named twice. */}
            <div className="grid grid-cols-2 gap-3">
              {destination === 'other' ? (
                <Field
                  label={kind === 'remote' ? 'Connect from here to' : 'Connect from the server to'}
                  value={targetHost}
                  placeholder="10.20.4.31"
                  onChange={(e) => setTargetHost(e.target.value)}
                />
              ) : null}
              <Field
                label={destination === 'other' ? 'Port' : 'Port on ' + resolvedBy}
                value={targetPort}
                inputMode="numeric"
                placeholder="5432"
                onChange={(e) => setTargetPort(e.target.value)}
              />
            </div>

            <span className="text-meta text-muted">
              {destination === 'self'
                ? `127.0.0.1 is how ${resolvedBy} names itself. The port does not have to be open to anyone else — the connection to it is made from inside.`
                : `Read from ${resolvedBy}, not from here. It has to be an address that end can reach.`}
            </span>
          </>
        )}

        <Select
          label="Autostart"
          value={autostart}
          onChange={setAutostart}
          options={AUTOSTARTS.map((a) => ({ value: a.value, label: a.label }))}
        />

        <CommandText className="text-mono text-faint">{preview}</CommandText>

        {error ? <span className="text-meta break-words text-warn">! {error}</span> : null}

        <div className="mt-1 flex justify-end gap-2">
          <Button size="md" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="accent" size="lg" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  )
}
