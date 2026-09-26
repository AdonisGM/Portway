import { useEffect, useState } from 'react'
import { Field, TextInput } from '../../components/ui/form-controls'
import { Modal } from '../../components/ui/modal'
import { Button } from '../../components/ui/primitives'
import { SegmentedControl } from '../../components/ui/segmented'
import { api, isAppError, type Container, type FwRule, type FwRuleInput, type Server } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import { addWords, deleteLine, portError, ruleLabel, sourceError, sourceLabel, toInput, ufwLine, ACTIONS } from './format'
import { withSudo } from '../../lib/commands'

const errText = (e: unknown) => (isAppError(e) ? (e.detail ?? e.code) : String(e))

function Cmd({ label = 'Lệnh sẽ chạy', text }: { label?: string; text: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-muted">{label}</span>
      <span className="rounded-md bg-sunken px-2.5 py-2 font-mono text-[11.5px] leading-[1.55] break-all whitespace-pre-wrap select-text">{text}</span>
    </div>
  )
}

function Fail({ text }: { text: string | null }) {
  return text ? <span className="rounded-md bg-danger-soft px-2 py-1.5 font-mono text-[11.5px] break-all whitespace-pre-wrap text-danger select-text">{text}</span> : null
}


type Src = 'any' | 'ip' | 'cidr'

/** "Mở cổng" / "Sửa rule". Editing removes the old rule and adds the new one
 *  (at the end: ufw has no in-place edit). */
export function RuleDialog({
  server,
  user,
  sudo,
  editing,
  dockerPorts,
  onFix,
  onClose,
  onDone,
}: {
  server: Server
  user: string
  sudo: boolean
  editing: FwRule | null
  /** Ports Docker publishes to everyone: a rule for them does nothing. */
  dockerPorts: Map<number, string>
  onFix: (port: number) => void
  onClose: () => void
  onDone: (title: string, cmd: string) => void
}) {
  const init: FwRuleInput = editing ? toInput(editing) : { action: 'allow', port: '', proto: 'tcp', from: null, comment: null }
  const [form, setForm] = useState<FwRuleInput>(init)
  const [src, setSrc] = useState<Src>(init.from ? (init.from.includes('/') ? 'cidr' : 'ip') : 'any')
  const [pending, setPending] = useState(false)
  const [fail, setFail] = useState<string | null>(null)
  const set = (p: Partial<FwRuleInput>) => setForm((f) => ({ ...f, ...p }))

  const input: FwRuleInput = { ...form, port: form.port.replace(/\s/g, ''), from: src === 'any' ? null : (form.from ?? '').trim() || null }
  const pErr = portError(form.port, form.proto)
  const sErr = src === 'any' ? undefined : sourceError(form.from ?? '')
  const ready = !!input.port && !pErr && !sErr && (src === 'any' || !!input.from)
  const add = ufwLine(addWords({ ...input, port: input.port || '…', from: src === 'any' ? null : input.from || '…' }))
  const cmd = withSudo(editing ? `${deleteLine(editing.spec)} && ${add}` : add, sudo && user !== 'root')
  const docker = /^\d+$/.test(input.port) ? dockerPorts.get(Number(input.port)) : undefined

  const save = async () => {
    setPending(true)
    setFail(null)
    try {
      if (editing) await api.firewallDelete(server.id, user, editing.spec, input)
      else await api.firewallAdd(server.id, user, input)
      onDone(editing ? 'Đã sửa rule' : 'Đã thêm rule', cmd)
    } catch (e) {
      setFail(errText(e))
    } finally {
      setPending(false)
    }
  }

  return (
    <Modal
      open
      onClose={() => !pending && onClose()}
      width={540}
      title={editing ? `Sửa rule ${ruleLabel(editing)}` : 'Mở cổng'}
      subtitle={`Rule UFW trên ${server.name}`}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Huỷ
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={pending || !ready}>
            {pending ? 'Đang gửi lệnh…' : editing ? 'Lưu rule' : 'Mở cổng'}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Cổng hoặc dải cổng" help="Ví dụ 8080, 80,443 hoặc 6000:6010" error={pErr}>
          <TextInput value={form.port} onChange={(v) => set({ port: v })} invalid={!!pErr} placeholder="3001" autoFocus />
        </Field>
        <Field label="Giao thức">
          <SegmentedControl
            full
            value={form.proto}
            onChange={(v) => set({ proto: v })}
            options={[
              { id: 'tcp', label: 'TCP' },
              { id: 'udp', label: 'UDP' },
              { id: 'any', label: 'Cả hai' },
            ]}
          />
        </Field>
      </div>
      <Field label="Nguồn" error={sErr}>
        <SegmentedControl
          full
          value={src}
          onChange={setSrc}
          options={[
            { id: 'any', label: 'Mọi nơi' },
            { id: 'ip', label: 'Một IP' },
            { id: 'cidr', label: 'Dải CIDR' },
          ]}
        />
        {src !== 'any' && (
          <TextInput value={form.from ?? ''} onChange={(v) => set({ from: v })} invalid={!!sErr} placeholder={src === 'ip' ? '113.161.72.4' : '113.161.0.0/16'} />
        )}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Hành động" help={form.action === 'limit' ? 'Chặn IP mở quá 6 kết nối trong 30 giây (chống dò mật khẩu SSH)' : undefined}>
          <SegmentedControl
            full
            value={form.action}
            onChange={(v) => set({ action: v })}
            options={[
              { id: 'allow', label: 'Cho phép' },
              { id: 'limit', label: 'Giới hạn' },
              { id: 'deny', label: 'Chặn' },
            ]}
          />
        </Field>
        <Field label="Ghi chú">
          <TextInput value={form.comment ?? ''} onChange={(v) => set({ comment: v })} placeholder="Umami" />
        </Field>
      </div>
      {docker && form.action !== 'deny' && (
        <div className="flex items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[11.5px] leading-normal text-ink2">
          <span className="flex-1">
            Cổng {input.port} đang do Docker publish ({docker}). Rule này không có tác dụng vì Docker mở cổng trước khi UFW kiểm tra.
          </span>
          <Button size="xs" onClick={() => onFix(Number(input.port))}>
            Cách khắc phục
          </Button>
        </div>
      )}
      {editing && <span className="text-[11.5px] text-muted">UFW không sửa rule tại chỗ: rule cũ bị xoá và rule mới được thêm vào cuối danh sách.</span>}
      <Cmd text={cmd} />
      <Fail text={fail} />
    </Modal>
  )
}

/** "Bật firewall": allow the SSH ports first so the session stays up. */
export function EnableDialog({
  server,
  user,
  sudo,
  rules,
  sshPorts,
  incoming,
  onClose,
  onDone,
}: {
  server: Server
  user: string
  sudo: boolean
  rules: FwRule[]
  /** SSH ports no rule allows yet. */
  sshPorts: number[]
  incoming: string
  onClose: () => void
  onDone: (title: string, cmd: string) => void
}) {
  const [pending, setPending] = useState(false)
  const [fail, setFail] = useState<string | null>(null)
  const parts = [...sshPorts.map((p) => ufwLine(['allow', `${p}/tcp`, 'comment', 'SSH (Portway)'])), 'ufw --force enable']
  const cmd = withSudo(parts.join(' && '), sudo && user !== 'root')
  const go = async () => {
    setPending(true)
    setFail(null)
    try {
      await api.firewallEnable(server.id, user, sshPorts)
      onDone('Firewall đã bật', cmd)
    } catch (e) {
      setFail(errText(e))
    } finally {
      setPending(false)
    }
  }
  // ufw appends new rules, so Portway's SSH rules come last.
  const list = [
    ...rules.map((r) => ({ text: `${ruleLabel(r)} · ${ACTIONS[r.action].label} · ${sourceLabel(r.from)}`, tag: r.comment ?? '' })),
    ...sshPorts.map((p) => ({ text: `${p}/tcp · Cho phép · Mọi nơi`, tag: 'Portway tự thêm' })),
  ]
  return (
    <Modal
      open
      onClose={() => !pending && onClose()}
      width={520}
      title="Bật firewall?"
      subtitle={`ufw enable trên ${server.name}`}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Huỷ
          </Button>
          <Button variant="primary" onClick={() => void go()} disabled={pending}>
            {pending ? 'Đang bật…' : 'Bật firewall'}
          </Button>
        </>
      }
    >
      <div className="rounded-lg bg-info-soft px-3 py-2.5 leading-normal text-ink2">
        {sshPorts.length
          ? `Portway sẽ thêm rule cho phép cổng SSH ${sshPorts.join(', ')} trước khi bật, để bạn không bị mất kết nối.`
          : 'Đã có rule cho phép cổng SSH, bật lên sẽ không làm mất kết nối.'}{' '}
        Kết nối vào mặc định sẽ bị {incoming === 'allow' ? 'cho phép' : incoming === 'reject' ? 'từ chối' : 'chặn'} nếu không khớp rule nào.
      </div>
      <span className="text-[11px] text-muted">Rule sẽ có hiệu lực sau khi bật (khớp từ trên xuống)</span>
      <div className="flex max-h-56 flex-col overflow-auto rounded-lg border border-line">
        {list.map((r, i) => (
          <div key={i} className="flex items-center gap-2.5 border-t border-line px-3 py-1.5 first:border-t-0">
            <span className="num w-5 text-muted">{i + 1}</span>
            <span className="flex-1 font-mono text-[12px]">{r.text}</span>
            {r.tag && <span className="text-[11px] text-muted">{r.tag}</span>}
          </div>
        ))}
        {!list.length && <span className="px-3 py-2 text-muted">Chưa có rule nào.</span>}
      </div>
      <Cmd text={cmd} />
      <Fail text={fail} />
    </Modal>
  )
}

/** Deleting the rule that lets SSH in: type the server's name. */
export function DeleteSshRule({
  server,
  user,
  sudo,
  rule,
  others,
  onClose,
  onDone,
}: {
  server: Server
  user: string
  sudo: boolean
  rule: FwRule
  /** Other rules that still let SSH in. */
  others: FwRule[]
  onClose: () => void
  onDone: (title: string, cmd: string) => void
}) {
  const [typed, setTyped] = useState('')
  const [pending, setPending] = useState(false)
  const [fail, setFail] = useState<string | null>(null)
  const cmd = withSudo(deleteLine(rule.spec), sudo && user !== 'root')
  const go = async () => {
    setPending(true)
    setFail(null)
    try {
      await api.firewallDelete(server.id, user, rule.spec)
      onDone('Đã xoá rule', cmd)
    } catch (e) {
      setFail(errText(e))
    } finally {
      setPending(false)
    }
  }
  return (
    <Modal
      open
      onClose={() => !pending && onClose()}
      width={480}
      title={`Xoá rule SSH ${ruleLabel(rule)}?`}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Huỷ
          </Button>
          <Button variant="danger" onClick={() => void go()} disabled={pending || typed !== server.name}>
            {pending ? 'Đang xoá…' : 'Xoá rule'}
          </Button>
        </>
      }
    >
      <div className="rounded-lg bg-warn-soft px-3 py-2.5 leading-normal text-ink2">
        Portway đang kết nối qua SSH. Rule khác vẫn cho phép SSH: {others.map((r) => `${ruleLabel(r)} từ ${sourceLabel(r.from)}`).join(', ')}. Nếu các rule đó không
        cho phép chính địa chỉ của bạn, bạn sẽ mất kết nối.
      </div>
      <Field label="Gõ lại tên server để xác nhận">
        <TextInput value={typed} onChange={setTyped} placeholder={server.name} autoFocus />
      </Field>
      <Cmd text={cmd} />
      <Fail text={fail} />
    </Modal>
  )
}

/** Docker publishes this port straight through iptables: how to close it. */
export function DockerFix({ server, user, port, container, onClose }: { server: Server; user: string; port: number; container: string; onClose: () => void }) {
  const [ctr, setCtr] = useState<Container | null>(null)
  useEffect(() => {
    api.dockerOverview(server.id, user).then(
      (s) => s.kind === 'ok' && setCtr(s.containers.find((c) => c.name === container) ?? null),
      () => {},
    )
  }, [server.id, user, container])
  const mapping = ctr?.ports.find((p) => p.hostPort === port)
  const target = mapping?.containerPort ?? port
  const file = ctr?.configFiles[0]
  const before = `${port}:${target}`
  const after = `127.0.0.1:${port}:${target}`
  const iptables = [
    `sudo iptables -I DOCKER-USER -i "$(ip route show default | awk '{print $5; exit}')" -p tcp --dport ${target} -j DROP`,
    `# nếu cần cho một dải IP vào: thêm -s <dải IP> -j RETURN trước dòng DROP`,
    `sudo netfilter-persistent save   # giữ rule sau khi khởi động lại (gói iptables-persistent)`,
  ].join('\n')
  return (
    <Modal open onClose={onClose} width={640} title={`Khắc phục: ${container} (${port}) mở ra internet`} subtitle="Docker publish cổng này trực tiếp qua iptables, trước UFW">
      <div className="flex flex-col gap-2 rounded-lg border border-line px-3 py-2.5">
        <span className="font-semibold">Cách 1 · Bind vào 127.0.0.1 (khuyên dùng)</span>
        {ctr?.project ? (
          <>
            <span className="font-mono text-[11.5px] text-muted select-text">{file ?? `project ${ctr.project}`}</span>
            <pre className="m-0 rounded-md bg-sunken px-2.5 py-2 font-mono text-[11.5px] leading-[1.6] select-text">
              {`  ${ctr.service ?? container}:\n    ports:\n`}
              <span className="text-danger">{`-     - "${before}"\n`}</span>
              <span className="text-success">{`+     - "${after}"`}</span>
            </pre>
            <span className="text-[11.5px] leading-normal text-ink2">Sửa file compose rồi chạy Up cho project (mục Docker · Compose) để tạo lại container.</span>
          </>
        ) : (
          <span className="text-[11.5px] leading-normal text-ink2">
            Chạy lại container với <span className="font-mono">-p {after}</span> thay cho <span className="font-mono">-p {before}</span>.
          </span>
        )}
        <span className="text-[11.5px] leading-normal text-ink2">Sau đó truy cập từ máy bạn qua SSH tunnel.</span>
      </div>
      <div className="flex flex-col gap-2 rounded-lg border border-line px-3 py-2.5">
        <span className="font-semibold">Cách 2 · Chặn trong chain DOCKER-USER</span>
        <span className="text-[11.5px] leading-normal text-ink2">Giữ nguyên container, thêm rule iptables mà Docker tôn trọng. Chỉ áp dụng cho IPv4.</span>
        <pre className="m-0 rounded-md bg-sunken px-2.5 py-2 font-mono text-[11.5px] leading-[1.6] break-all whitespace-pre-wrap select-text">{iptables}</pre>
        <div>
          <Button size="xs" onClick={() => void copyText(iptables)}>
            Sao chép lệnh
          </Button>
        </div>
      </div>
    </Modal>
  )
}
