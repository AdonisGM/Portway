import { useEffect, useState, type ReactNode } from 'react'
import { Field, TextInput } from '../../components/ui/form-controls'
import { Modal } from '../../components/ui/modal'
import { Button } from '../../components/ui/primitives'
import { t } from '../../i18n'
import { SegmentedControl } from '../../components/ui/segmented'
import { api, isAppError, type Container, type FwCtx, type FwOp, type FwRule, type FwRuleInput, type Server } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import { ACTIONS, BACKEND_LABELS, portError, ruleLabel, sourceError, sourceLabel, toInput } from './format'

const errText = (e: unknown) => {
  if (!isAppError(e)) return String(e)
  switch (e.code) {
    case 'firewall_changed':
      return t('Firewall trên server vừa thay đổi (công cụ, zone hoặc trạng thái bật/tắt). Đóng và mở lại để xem bản mới.')
    case 'rule_gone':
      return t('Rule này không còn trên server. Đóng lại để tải danh sách mới.')
    case 'limit_unsupported':
      return t('firewalld không có kiểu Giới hạn như UFW.')
    default:
      return e.detail ?? e.code
  }
}

/** The exact commands of a change, from the same planner that runs it. */
function usePlan(ctx: FwCtx, op: FwOp | null, sudo: boolean) {
  const [preview, setPreview] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // One key for ctx, op and sudo, so a re-render with equal values does not refetch.
  const key = JSON.stringify([ctx, op, sudo])
  useEffect(() => {
    const [c, o, s] = JSON.parse(key) as [FwCtx, FwOp | null, boolean]
    if (!o) return setPreview(null)
    let stop = false
    const timer = setTimeout(
      () =>
        api.firewallPlan(c, o, s).then(
          (p) => !stop && (setPreview(p), setError(null)),
          (e) => !stop && (setPreview(null), setError(errText(e))),
        ),
      150,
    )
    return () => {
      stop = true
      clearTimeout(timer)
    }
  }, [key])
  return { preview, error }
}

function Preview({ text, error }: { text: string | null; error?: string | null }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-muted">{t('Lệnh chính xác sẽ chạy')}</span>
      <pre className="m-0 rounded-md bg-sunken px-2.5 py-2 font-mono text-[11.5px] leading-[1.6] break-all whitespace-pre-wrap select-text">
        {error ? <span className="text-danger">{error}</span> : (text ?? '…')}
      </pre>
    </div>
  )
}

function Result({ text }: { text: string | null }) {
  return text ? <span className="rounded-md bg-danger-soft px-2.5 py-2 text-[11.5px] leading-normal whitespace-pre-wrap text-danger select-text">{text}</span> : null
}

type Common = { server: Server; user: string; sudo: boolean; ctx: FwCtx; onClose: () => void; onDone: (title: string) => void }

/** Run a planned change and keep what went wrong on screen. */
function useApply({ server, user, ctx, onDone }: Common) {
  const [pending, setPending] = useState(false)
  const [fail, setFail] = useState<string | null>(null)
  const run = async (op: FwOp, title: string) => {
    setPending(true)
    setFail(null)
    try {
      await api.firewallApply(server.id, user, ctx, op)
      onDone(title)
    } catch (e) {
      setFail(errText(e))
    } finally {
      setPending(false)
    }
  }
  return { pending, fail, run }
}

/** Confirm any firewall change: where it runs, as whom, the exact commands. */
export function FwConfirm(
  props: Common & { title: string; body: ReactNode; note?: ReactNode; op: FwOp; confirm: string; danger?: boolean; doneTitle: string },
) {
  const { server, user, sudo, ctx, onClose, title, body, note, op, confirm, danger, doneTitle } = props
  const { preview, error } = usePlan(ctx, op, sudo && user !== 'root')
  const { pending, fail, run } = useApply(props)
  return (
    <Modal
      open
      onClose={() => !pending && onClose()}
      width={580}
      title={title}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            {t('Huỷ')}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={() => void run(op, doneTitle)} disabled={pending || !preview}>
            {pending ? t('Đang chạy…') : confirm}
          </Button>
        </>
      }
    >
      <div className="leading-relaxed text-ink2">{body}</div>
      <div className="grid gap-x-3 gap-y-1.5 rounded-lg bg-raised px-3 py-2.5" style={{ gridTemplateColumns: 'auto 1fr' }}>
        <span className="text-[11px] text-muted">Server</span>
        <span className="font-mono text-[12px]">{server.name}</span>
        <span className="text-[11px] text-muted">Firewall</span>
        <span className="font-mono text-[12px]">
          {BACKEND_LABELS[ctx.backend]}
          {ctx.zone ? ` · zone ${ctx.zone}` : ''}
        </span>
        <span className="text-[11px] text-muted">{t('Chạy bằng')}</span>
        <span className="font-mono text-[12px]">
          {user}
          {sudo && user !== 'root' ? ' (sudo)' : ''}
        </span>
      </div>
      <Preview text={preview} error={error} />
      {note && <div className="rounded-lg bg-warn-soft px-3 py-2 text-[11.5px] leading-normal text-ink2">{note}</div>}
      <Result text={fail} />
    </Modal>
  )
}

type Src = 'any' | 'ip' | 'cidr'

/** "Mở cổng" / "Sửa rule" in the common form. */
export function RuleDialog(
  props: Common & {
    editing: FwRule | null
    /** Ports Docker publishes to everyone: a rule for them does nothing. */
    dockerPorts: Map<number, string>
    onFix: (port: number) => void
  },
) {
  const { user, sudo, ctx, editing, dockerPorts, onFix, onClose } = props
  const fwd = ctx.backend === 'firewalld'
  const init: FwRuleInput = editing ? toInput(editing) : { action: 'allow', port: '', proto: 'tcp', from: null, comment: null }
  const [form, setForm] = useState<FwRuleInput>(fwd && init.action === 'limit' ? { ...init, action: 'allow' } : init)
  const [src, setSrc] = useState<Src>(init.from ? (init.from.includes('/') ? 'cidr' : 'ip') : 'any')
  const set = (p: Partial<FwRuleInput>) => setForm((f) => ({ ...f, ...p }))

  const input: FwRuleInput = {
    ...form,
    port: form.port.replace(/\s/g, ''),
    from: src === 'any' ? null : (form.from ?? '').trim() || null,
    comment: fwd ? null : form.comment,
  }
  const pErr = portError(form.port, form.proto)
  const sErr = src === 'any' ? undefined : sourceError(form.from ?? '')
  const ready = !!input.port && !pErr && !sErr && (src === 'any' || !!input.from)
  const op: FwOp | null = ready ? (editing ? { op: 'replace', rule: editing, with: input } : { op: 'add', rule: input }) : null
  const { preview, error } = usePlan(ctx, op, sudo && user !== 'root')
  const { pending, fail, run } = useApply(props)
  const docker = /^\d+$/.test(input.port) ? dockerPorts.get(Number(input.port)) : undefined

  return (
    <Modal
      open
      onClose={() => !pending && onClose()}
      width={580}
      title={editing ? t('Sửa rule {rule}', { rule: ruleLabel(editing) }) : t('Mở cổng')}
      subtitle={t('{firewall} trên {server}', { firewall: `${BACKEND_LABELS[ctx.backend]}${ctx.zone ? ` · zone ${ctx.zone}` : ''}`, server: props.server.name })}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            {t('Huỷ')}
          </Button>
          <Button variant="primary" onClick={() => op && void run(op, editing ? t('Đã sửa rule') : t('Đã thêm rule'))} disabled={pending || !op || !preview}>
            {pending ? t('Đang chạy…') : editing ? t('Lưu rule') : t('Mở cổng')}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('Cổng hoặc dải cổng')} help={t('Ví dụ 8080, 80,443 hoặc 6000:6010')} error={pErr}>
          <TextInput value={form.port} onChange={(v) => set({ port: v })} invalid={!!pErr} placeholder="3001" autoFocus />
        </Field>
        <Field label={t('Giao thức')}>
          <SegmentedControl
            full
            value={form.proto}
            onChange={(v) => set({ proto: v })}
            options={[
              { id: 'tcp', label: 'TCP' },
              { id: 'udp', label: 'UDP' },
              { id: 'any', label: t('Cả hai') },
            ]}
          />
        </Field>
      </div>
      <Field label={t('Nguồn')} error={sErr}>
        <SegmentedControl
          full
          value={src}
          onChange={setSrc}
          options={[
            { id: 'any', label: t('Mọi nơi') },
            { id: 'ip', label: t('Một IP') },
            { id: 'cidr', label: t('Dải CIDR') },
          ]}
        />
        {src !== 'any' && (
          <TextInput value={form.from ?? ''} onChange={(v) => set({ from: v })} invalid={!!sErr} placeholder={src === 'ip' ? '113.161.72.4' : '113.161.0.0/16'} />
        )}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('Hành động')} help={form.action === 'limit' ? t('Chặn IP mở quá 6 kết nối trong 30 giây (chống dò mật khẩu SSH)') : undefined}>
          <SegmentedControl
            full
            value={form.action}
            onChange={(v) => set({ action: v })}
            options={[
              { id: 'allow', label: t('Cho phép') },
              ...(fwd ? [] : [{ id: 'limit' as const, label: t('Giới hạn') }]),
              { id: 'deny', label: t('Chặn') },
            ]}
          />
        </Field>
        <Field label={t('Ghi chú#rule')}>
          {fwd ? (
            <span className="flex h-[34px] items-center text-[11.5px] text-muted">{t('firewalld không lưu ghi chú cho rule')}</span>
          ) : (
            <TextInput value={form.comment ?? ''} onChange={(v) => set({ comment: v })} placeholder="Umami" />
          )}
        </Field>
      </div>
      {docker && form.action !== 'deny' && (
        <div className="flex items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[11.5px] leading-normal text-ink2">
          <span className="flex-1">
            {t('Cổng {port} đang do Docker publish ({container}). Rule này không có tác dụng vì Docker mở cổng trước khi firewall kiểm tra.', { port: input.port, container: docker })}
          </span>
          <Button size="xs" onClick={() => onFix(Number(input.port))}>
            {t('Cách khắc phục')}
          </Button>
        </div>
      )}
      {editing && (
        <span className="text-[11.5px] text-muted">
          {fwd ? t('firewalld không sửa rule tại chỗ: rule cũ bị gỡ và rule mới được thêm.') : t('UFW không sửa rule tại chỗ: rule cũ bị xoá và rule mới được thêm vào cuối danh sách.')}
        </span>
      )}
      <Preview text={op ? preview : t('Điền cổng hợp lệ để xem lệnh')} error={op ? error : null} />
      <Result text={fail} />
    </Modal>
  )
}

/** "Bật firewall": allow the SSH ports first, then check a new connection. */
export function EnableDialog(props: Common & { rules: FwRule[]; sshPorts: number[]; incoming: string }) {
  const { ctx, rules, sshPorts, incoming } = props
  const list = [
    ...rules.map((r) => ({ text: `${ruleLabel(r)} · ${ACTIONS[r.action].label} · ${sourceLabel(r.from)}`, tag: r.comment ?? (r.zone ? `zone ${r.zone}` : '') })),
    ...sshPorts.map((p) => ({ text: t('{port}/tcp · Cho phép · Mọi nơi', { port: p }), tag: t('Portway tự thêm') })),
  ]
  return (
    <FwConfirm
      {...props}
      title={t('Bật firewall?')}
      op={{ op: 'enable', sshPorts }}
      confirm={t('Bật firewall')}
      doneTitle={t('Firewall đã bật')}
      body={
        <>
          {sshPorts.length ? t('Portway thêm rule cho phép cổng SSH {ports} trước khi bật. ', { ports: sshPorts.join(', ') }) : t('Đã có rule cho phép cổng SSH. ')}
          {t('Sau khi bật, Portway mở thử một kết nối SSH mới; không được thì tự tắt lại. Kết nối vào không khớp rule nào sẽ bị {policy}.', {
            policy: incoming === 'allow' ? t('cho phép#done') : incoming === 'reject' ? t('từ chối#done') : t('chặn#done'),
          })}
          <span className="mt-2 flex max-h-44 flex-col overflow-auto rounded-lg border border-line">
            {list.map((r, i) => (
              <span key={i} className="flex items-center gap-2.5 border-t border-line px-3 py-1.5 first:border-t-0">
                <span className="flex-1 font-mono text-[12px]">{r.text}</span>
                {r.tag && <span className="text-[11px] text-muted">{r.tag}</span>}
              </span>
            ))}
            {!list.length && <span className="px-3 py-2 text-muted">{t('Chưa có rule nào.')}</span>}
          </span>
          {ctx.backend === 'ufw' && <span className="mt-1 block text-[11px] text-muted">{t('UFW khớp rule từ trên xuống.')}</span>}
        </>
      }
    />
  )
}

/** Deleting a rule that lets SSH in: type the server's name first. */
export function DeleteSshRule(props: Common & { rule: FwRule; others: FwRule[] }) {
  const { server, rule, others, sudo, user, ctx, onClose } = props
  const [typed, setTyped] = useState('')
  const op: FwOp = { op: 'delete', rule }
  const { preview, error } = usePlan(ctx, op, sudo && user !== 'root')
  const { pending, fail, run } = useApply(props)
  return (
    <Modal
      open
      onClose={() => !pending && onClose()}
      width={560}
      title={t('Xoá rule SSH {rule}?', { rule: ruleLabel(rule) })}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            {t('Huỷ')}
          </Button>
          <Button variant="danger" onClick={() => void run(op, t('Đã xoá rule'))} disabled={pending || typed !== server.name || !preview}>
            {pending ? t('Đang chạy…') : t('Xoá rule')}
          </Button>
        </>
      }
    >
      <div className="rounded-lg bg-warn-soft px-3 py-2.5 leading-normal text-ink2">
        {t('Portway đang kết nối qua SSH. Rule khác vẫn cho phép SSH: {rules}. Sau khi xoá, Portway mở thử một kết nối SSH mới; không được thì tự hoàn tác.', {
          rules: others.map((r) => t('{rule} từ {source}', { rule: ruleLabel(r), source: sourceLabel(r.from) })).join(', '),
        })}
      </div>
      <Field label={t('Gõ lại tên server để xác nhận')}>
        <TextInput value={typed} onChange={setTyped} placeholder={server.name} autoFocus />
      </Field>
      <Preview text={preview} error={error} />
      <Result text={fail} />
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
    t('# nếu cần cho một dải IP vào: thêm -s <dải IP> -j RETURN trước dòng DROP'),
    'sudo netfilter-persistent save   # ' + t('giữ rule sau khi khởi động lại (gói iptables-persistent)'),
  ].join('\n')
  return (
    <Modal
      open
      onClose={onClose}
      width={640}
      title={t('Khắc phục: {container} ({port}) mở ra internet', { container, port })}
      subtitle={t('Docker publish cổng này trực tiếp qua iptables, trước firewall')}
    >
      <div className="flex flex-col gap-2 rounded-lg border border-line px-3 py-2.5">
        <span className="font-semibold">{t('Cách 1 · Bind vào 127.0.0.1 (khuyên dùng)')}</span>
        {ctr?.project ? (
          <>
            <span className="font-mono text-[11.5px] text-muted select-text">{file ?? `project ${ctr.project}`}</span>
            <pre className="m-0 rounded-md bg-sunken px-2.5 py-2 font-mono text-[11.5px] leading-[1.6] select-text">
              {`  ${ctr.service ?? container}:\n    ports:\n`}
              <span className="text-danger">{`-     - "${before}"\n`}</span>
              <span className="text-success">{`+     - "${after}"`}</span>
            </pre>
            <span className="text-[11.5px] leading-normal text-ink2">{t('Sửa file compose rồi chạy Up cho project (mục Docker · Compose) để tạo lại container.')}</span>
          </>
        ) : (
          <span className="text-[11.5px] leading-normal text-ink2">
            {t('Chạy lại container với')} <span className="font-mono">-p {after}</span> {t('thay cho')} <span className="font-mono">-p {before}</span>.
          </span>
        )}
        <span className="text-[11.5px] leading-normal text-ink2">{t('Sau đó truy cập từ máy bạn qua SSH tunnel.')}</span>
      </div>
      <div className="flex flex-col gap-2 rounded-lg border border-line px-3 py-2.5">
        <span className="font-semibold">{t('Cách 2 · Chặn trong chain DOCKER-USER')}</span>
        <span className="text-[11.5px] leading-normal text-ink2">{t('Giữ nguyên container, thêm rule iptables mà Docker tôn trọng. Chỉ áp dụng cho IPv4.')}</span>
        <pre className="m-0 rounded-md bg-sunken px-2.5 py-2 font-mono text-[11.5px] leading-[1.6] break-all whitespace-pre-wrap select-text">{iptables}</pre>
        <div>
          <Button size="xs" onClick={() => void copyText(iptables)}>
            {t('Sao chép lệnh')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
