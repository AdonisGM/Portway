import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useConnections } from '../../app/connections'
import { useNav } from '../../app/nav'
import { readCache, writeCache } from '../../app/session-cache'
import { useTunnels } from '../../app/tunnels'
import { useToast } from '../../components/toast'
import { Button, Chip, cx, TONES } from '../../components/ui/primitives'
import { RowMenu } from '../../components/ui/row-menu'
import { t } from '../../i18n'
import { api, isAppError, type AppError, type FirewallState, type FwCtx, type FwOp, type FwRule, type Listen, type Ports, type Server } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import { useLive } from '../server/refresh'
import { DeleteSshRule, DockerFix, EnableDialog, FwConfirm, RuleDialog } from './dialogs'
import { ACTIONS, allows, BACKEND_LABELS, isPublicBind, protoLabel, ruleLabel, ruleTarget, shadowedBy, sourceLabel, toInput } from './format'

const REFRESH_MS = 30_000

type Data = { fw: FirewallState; ports: Ports }

const asError = (e: unknown): AppError => (isAppError(e) ? e : { code: 'unknown', detail: String(e) })

function useFirewall(serverId: string, user: string) {
  const { markLost } = useConnections()
  const { live, sudo } = useLive(serverId, user)
  const [data, setData] = useState<Data | null>(() => readCache<Data>(serverId, user, 'firewall')?.data ?? null)
  const [error, setError] = useState<AppError | null>(null)
  const load = useCallback(async () => {
    try {
      const [fw, ports] = await Promise.all([api.firewallState(serverId, user), api.ports(serverId, user)])
      setData({ fw, ports })
      setError(null)
      writeCache(serverId, user, 'firewall', { fw, ports }, new Date())
    } catch (e) {
      const err = asError(e)
      if (err.code === 'connection_lost' || err.code === 'not_connected') markLost(serverId, user, err)
      else setError(err)
    }
  }, [serverId, user, markLost])
  useEffect(() => {
    if (!live) return
    void load()
    const timer = setInterval(load, REFRESH_MS)
    return () => clearInterval(timer)
  }, [live, sudo, load])
  return { data, error, load }
}

type Ask = { title: string; body: ReactNode; note?: ReactNode; op: FwOp; confirm: string; danger?: boolean; doneTitle: string }

/** A default policy (incoming / outgoing) as words; unknown values as they are. */
const policy = (p: string) => (p === 'allow' ? t('cho phép') : p === 'reject' ? t('từ chối') : p === 'deny' ? t('chặn') : p)

/** Ports sshd listens on (so enabling the firewall never locks the session out). */
function sshPortsOf(ports: Ports, server: Server): number[] {
  const byProcess = ports.listening.filter((l) => l.proto === 'tcp' && l.process?.startsWith('sshd')).map((l) => l.port)
  if (byProcess.length) return [...new Set(byProcess)]
  if (ports.listening.some((l) => l.proto === 'tcp' && l.port === 22)) return [22]
  return [server.port]
}

const bindText = (l: Listen) => `${l.bind.includes(':') ? `[${l.bind}]` : l.bind}:${l.port}`

export function FirewallScreen({ server, user }: { server: Server; user: string }) {
  const toast = useToast()
  const nav = useNav()
  const tunnels = useTunnels()
  const { sudo } = useLive(server.id, user)
  const priv = user === 'root' || sudo
  const { data, error, load } = useFirewall(server.id, user)
  const [menu, setMenu] = useState<string | null>(null)
  const [ask, setAsk] = useState<Ask | null>(null)
  const [ruleDlg, setRuleDlg] = useState<{ editing: FwRule | null } | null>(null)
  const [enable, setEnable] = useState(false)
  const [sshDelete, setSshDelete] = useState<FwRule | null>(null)
  const [fix, setFix] = useState<{ port: number; container: string } | null>(null)

  const done = (title: string) => {
    toast({ title })
    setRuleDlg(null)
    setEnable(false)
    setSshDelete(null)
    setAsk(null)
    void load()
  }

  if (!data) {
    return error ? (
      <span className="font-mono text-[11.5px] text-danger select-text">{error.detail ?? error.code}</span>
    ) : (
      <div className="flex flex-col overflow-hidden rounded-xl border border-line bg-surface" aria-busy="true">
        {['55%', '40%', '65%', '45%'].map((w, i) => (
          <div key={i} className="flex items-center gap-4 border-t border-line px-3.5 py-3 first:border-t-0">
            <span className="h-3 rounded-[5px] bg-sunken" style={{ width: w }} />
            <span className="h-2.5 w-24 rounded-[5px] bg-sunken" />
          </div>
        ))}
      </div>
    )
  }

  const { fw, ports } = data
  const m = fw.kind === 'managed' ? fw : null
  const ctx: FwCtx | null = m ? { backend: m.backend, zone: m.zone, enabled: m.enabled } : null
  const rules = m?.rules ?? []
  const sshPorts = sshPortsOf(ports, server)
  // Ports Docker publishes to every address go around any host firewall.
  const bypass = new Map<number, string>()
  for (const l of ports.listening) if (l.container && l.scope === 'public' && l.proto === 'tcp') bypass.set(l.port, l.container)
  for (const w of ports.warnings) if (w.kind === 'dockerBypass' || w.kind === 'ruleIneffective') bypass.set(w.port, w.container)
  const publicListen = ports.listening.filter((l) => isPublicBind(l) && !l.container)
  const blocked = m?.enabled && m.incoming !== 'allow' ? publicListen.filter((l) => !rules.some((r) => allows(r, l.port, l.proto))) : []
  const exposedOff = m && !m.enabled ? publicListen : []
  const local = ports.listening.filter((l) => l.scope === 'loopback')
  const stale = rules.filter((r) => {
    if (r.action === 'deny' || r.action === 'reject' || r.route || r.direction !== 'in') return false
    const target = ruleTarget(r)
    if (!target) return false
    return !ports.listening.some((l) => allows(r, l.port, l.proto)) && ![...bypass.keys()].some((p) => allows(r, p, 'tcp'))
  })
  const sshRules = rules.filter((r) => sshPorts.some((p) => allows(r, p, 'tcp')))

  const deleteRule = (r: FwRule) => {
    const guarded = m?.enabled && sshRules.includes(r)
    if (guarded) return setSshDelete(r)
    setAsk({
      title: t('Xoá rule {rule}?', { rule: ruleLabel(r) }),
      body:
        r.action === 'deny' || r.action === 'reject'
          ? t('Kết nối từ {source} sẽ không còn bị chặn riêng nữa mà theo các rule còn lại.', { source: sourceLabel(r.from).toLowerCase() })
          : m?.enabled
            ? t('Kết nối từ {source} tới {rule} sẽ theo mặc định ({policy}).', { source: sourceLabel(r.from).toLowerCase(), rule: ruleLabel(r), policy: policy(m.incoming) })
            : t('Kết nối từ {source} tới {rule} sẽ theo mặc định ({policy}) khi firewall được bật.', {
                source: sourceLabel(r.from).toLowerCase(),
                rule: ruleLabel(r),
                policy: policy(m?.incoming ?? 'deny'),
              }),
      op: { op: 'delete', rule: r },
      confirm: t('Xoá rule'),
      danger: true,
      doneTitle: t('Đã xoá rule'),
    })
  }

  const disable = () =>
    setAsk({
      title: t('Tắt firewall?'),
      body: t('Mọi cổng đang lắng nghe trên địa chỉ công khai sẽ truy cập được từ internet. Các rule vẫn được giữ để bật lại sau.'),
      op: { op: 'disable' },
      confirm: t('Tắt firewall'),
      danger: true,
      doneTitle: t('Firewall đã tắt'),
    })

  const tunnelCmd = (port: number) => {
    const account = server.accounts.find((a) => a.user === user)
    const key = account?.auth.kind === 'key' ? ` -i ${account.auth.path}` : ''
    return `ssh -N -L ${port}:127.0.0.1:${port}${server.port !== 22 ? ` -p ${server.port}` : ''}${key} ${user}@${server.host}`
  }

  const sub = !m
    ? fw.kind === 'none'
      ? t('Chưa có firewall do UFW hay firewalld quản lý')
      : fw.kind === 'needsRoot'
        ? t('{backend} · cần quyền root để đọc', { backend: BACKEND_LABELS[fw.backend] })
        : t('{backend} · không đọc được', { backend: BACKEND_LABELS[fw.backend] })
    : m.enabled
      ? t('Đang bật · mặc định {incoming} kết nối vào, {outgoing} kết nối ra', { incoming: policy(m.incoming), outgoing: policy(m.outgoing) })
      : m.backend === 'firewalld'
        ? t('firewalld đang dừng')
        : t('Đang tắt')
  const suggest = (fw.kind === 'none' ? fw.family : 'other') === 'rhel' ? 'sudo dnf install firewalld' : 'sudo apt install ufw'

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-[260px] flex-1 flex-col gap-0.5">
          <span className="text-[15px] font-semibold">
            Firewall{m ? ` · ${BACKEND_LABELS[m.backend]}` : ''}
            {m?.zone ? <span className="font-normal text-muted"> · zone {m.zone}</span> : null}
          </span>
          <span className="text-muted">{sub}</span>
          <span className="text-[11px] text-muted">{t('Firewall của nhà cung cấp cloud (security group / security list) không kiểm tra được từ bên trong server.')}</span>
        </div>
        {m?.enabled && (
          <Button size="sm" onClick={disable} disabled={!priv}>
            {t('Tắt firewall')}
          </Button>
        )}
        <Button size="sm" variant="primary" onClick={() => setRuleDlg({ editing: null })} disabled={!m || !priv}>
          {t('Mở cổng')}
        </Button>
      </div>

      {error && <span className="font-mono text-[11.5px] text-danger select-text">{error.detail ?? error.code}</span>}

      {m && m.alsoActive.length > 0 && (
        <div className="rounded-[10px] border border-line bg-danger-soft px-3.5 py-2.5 leading-normal">
          <span className="font-semibold text-danger">
            {t('Có hai công cụ firewall cùng bật: {backend} và {others}.', { backend: BACKEND_LABELS[m.backend], others: m.alsoActive.map((b) => BACKEND_LABELS[b]).join(', ') })}
          </span>{' '}
          <span className="text-ink2">
            {t('Chúng ghi đè rule của nhau nên kết quả khó đoán. Portway đang quản lý {backend} (hợp với hệ điều hành này); nên tắt công cụ còn lại.', {
              backend: BACKEND_LABELS[m.backend],
            })}
          </span>
        </div>
      )}

      {fw.kind === 'none' && (
        <Card>
          <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
            <span className="text-[14px] font-semibold">{fw.iptables ? t('Server dùng iptables trực tiếp') : t('Chưa có firewall')}</span>
            <span className="max-w-[560px] leading-normal text-muted">
              {fw.iptables
                ? t('Có {n} rule iptables nhưng không do UFW hay firewalld quản lý. Portway chưa đọc được rule iptables thuần; bên dưới là các cổng đang lắng nghe.', { n: fw.iptables })
                : t('Không thấy UFW hay firewalld. {hint}; cài xong Portway quản lý được ngay tại đây.', {
                    hint: fw.family === 'rhel' ? t('Họ RHEL (Oracle Linux, Rocky, Alma) thường dùng firewalld') : t('Debian/Ubuntu thường dùng UFW'),
                  })}
            </span>
            {!fw.iptables && (
              <div className="flex items-center gap-2">
                <span className="rounded-md bg-sunken px-2.5 py-1.5 font-mono text-[11.5px] select-text">{suggest}</span>
                <Button size="xs" onClick={() => void copyText(suggest)}>
                  {t('Sao chép')}
                </Button>
              </div>
            )}
          </div>
        </Card>
      )}
      {fw.kind === 'error' && <span className="font-mono text-[11.5px] text-danger select-text">{fw.detail}</span>}

      {m && !m.enabled && (
        <div className="flex items-center gap-3 rounded-[10px] border border-line bg-warn-soft px-3.5 py-2.5">
          <span className="size-2 flex-none rounded-full bg-warn" />
          <div className="flex flex-1 flex-col gap-0.5">
            <span className="font-semibold">{t('Firewall đang tắt')}</span>
            <span className="text-[11.5px] text-ink2">
              {m.backend === 'firewalld'
                ? t('Mọi cổng lắng nghe trên địa chỉ công khai đều truy cập được từ internet. Rule bên dưới chưa có hiệu lực (đây là cấu hình vĩnh viễn, dùng khi firewalld chạy).')
                : t('Mọi cổng lắng nghe trên địa chỉ công khai đều truy cập được từ internet. Rule bên dưới chưa có hiệu lực.')}
            </span>
          </div>
          <Button size="xs" variant="primary" onClick={() => setEnable(true)} disabled={!priv}>
            {t('Bật firewall')}
          </Button>
        </div>
      )}

      {bypass.size > 0 && (
        <Group title={t('⚠ Mở ra internet, không đi qua firewall')} hint={t('Docker tự mở các cổng này trước firewall của server, rule firewall không có tác dụng.')} tone="danger">
          {[...bypass].map(([port, container]) => (
            <Line key={port} cols="70px minmax(0,1fr) auto">
              <span className="num font-semibold">{port}</span>
              <span className="truncate">
                {container} <span className="text-muted">· container</span>
              </span>
              <Button size="xs" onClick={() => setFix({ port, container })}>
                {t('Cách khắc phục')}
              </Button>
            </Line>
          ))}
        </Group>
      )}

      {m && (
        <Group
          title={m.enabled ? t('Rule firewall') : t('Rule firewall (chưa có hiệu lực)')}
          hint={
            m.ordered
              ? t('Rule khớp đầu tiên được áp dụng, thứ tự từ trên xuống. Lấy từ ufw show added.')
              : m.zones.length > 1
                ? t('Service, port và rich rule của các zone {zones}; firewalld không xét thứ tự. Lấy từ firewall-cmd --list-all.', { zones: m.zones.join(', ') })
                : t('Service, port và rich rule của zone {zone}; firewalld không xét thứ tự. Lấy từ firewall-cmd --list-all.', { zone: String(m.zone) })
          }
        >
          <div className="grid items-center gap-3 bg-sunken px-3.5 py-2 text-[11px] text-muted" style={{ gridTemplateColumns: RULE_COLS }}>
            <span>{m.ordered ? '#' : ''}</span>
            <span>{m.backend === 'firewalld' ? t('Cổng / Service') : t('Cổng / App')}</span>
            <span>{t('Từ')}</span>
            <span>{t('Hành động')}</span>
            <span>{t('Ghi chú#rule')}</span>
            <span />
          </div>
          {rules.map((r, i) => {
            const act = ACTIONS[r.action]
            const isSsh = sshRules.includes(r)
            const editable = r.editable
            const noEffect = (r.action === 'allow' || r.action === 'limit') && r.from !== 'any' && [...bypass.keys()].some((p) => allows(r, p, 'tcp'))
            const lastSsh = m.enabled && isSsh && sshRules.length === 1
            const shadow = m.ordered ? shadowedBy(rules, i) : null
            const key = r.spec.join(' ')
            return (
              <div key={key} className="grid items-center gap-3 border-t border-line px-3.5 py-2" style={{ gridTemplateColumns: RULE_COLS }}>
                <span className="num text-muted">{m.ordered ? i + 1 : ''}</span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-mono text-[12px] font-semibold">{ruleLabel(r)}</span>
                  <span className="truncate text-[11px] text-muted">
                    {protoLabel(r)}
                    {r.route ? t(' · route (chuyển tiếp)') : ''}
                    {r.direction === 'out' ? t(' · chiều ra') : ''}
                    {r.interface ? ` · on ${r.interface}` : ''}
                  </span>
                </span>
                <span className="truncate font-mono text-[12px]">{sourceLabel(r.from)}</span>
                <span>
                  <span className="rounded-[5px] px-2 py-[3px] text-[11px] font-medium" style={{ color: act.fg, background: act.bg }}>
                    {act.label}
                  </span>
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-ink2" title={r.native}>
                    {r.comment ?? (m.backend === 'firewalld' && r.spec[1] === 'rich-rule' ? 'rich rule' : '—')}
                  </span>
                  {isSsh && (
                    <span className="text-[11px] text-info">
                      {t('Portway đang dùng (SSH)')}
                      {m.backend === 'ufw' && r.action === 'allow' ? t(' · nên dùng Giới hạn để chống dò mật khẩu') : ''}
                    </span>
                  )}
                  {noEffect && <span className="text-[11px] text-danger">{t('Không có hiệu lực: Docker đã mở cổng này cho mọi nơi')}</span>}
                  {shadow != null && (
                    <span className="text-[11px] text-warn">
                      {t('Không có tác dụng: rule #{n} ({rule}, {action}) khớp trước', {
                        n: shadow + 1,
                        rule: ruleLabel(rules[shadow]),
                        action: ACTIONS[rules[shadow].action].label.toLowerCase(),
                      })}
                    </span>
                  )}
                </span>
                <span className="flex justify-end">
                  <RowMenu
                    open={menu === key}
                    setOpen={(v) => setMenu(v ? key : null)}
                    items={[
                      {
                        label: t('Sửa'),
                        run: () => setRuleDlg({ editing: r }),
                        ok: priv && editable,
                        why: !priv
                          ? t('Cần quyền root')
                          : r.app
                            ? t('Rule theo {kind}: xoá rồi mở cổng mới', { kind: m.backend === 'firewalld' ? 'service' : 'app profile' })
                            : t('Rule phức tạp (interface, log, route…): sửa trong Terminal'),
                      },
                      ...(m.backend === 'ufw' && isSsh && r.action === 'allow' && editable
                        ? [
                            {
                              label: t('Đổi sang Giới hạn (limit)'),
                              ok: priv,
                              why: t('Cần quyền root'),
                              run: () => {
                                const next = { ...toInput(r), action: 'limit' as const }
                                // The new rule goes last: say if an earlier rule would still win.
                                const after = [...rules.filter((x) => x !== r), { ...r, action: 'limit' as const, spec: [] }]
                                const blocker = shadowedBy(after, after.length - 1)
                                setAsk({
                                  title: t('Đổi rule {rule} sang Giới hạn?', { rule: ruleLabel(r) }),
                                  body: t(
                                    'UFW sẽ chặn một IP nếu nó mở quá 6 kết nối trong 30 giây, đủ để chặn dò mật khẩu mà không ảnh hưởng người dùng bình thường. Kết nối SSH đang mở không bị ngắt.',
                                  ),
                                  note:
                                    blocker != null
                                      ? t(
                                          'Rule mới được thêm vào cuối danh sách, sau {rule} ({action} từ {source}). Rule đó khớp trước nên limit sẽ không có tác dụng cho tới khi bạn xoá nó.',
                                          {
                                            rule: ruleLabel(after[blocker]),
                                            action: ACTIONS[after[blocker].action].label.toLowerCase(),
                                            source: sourceLabel(after[blocker].from).toLowerCase(),
                                          },
                                        )
                                      : t('UFW không sửa rule tại chỗ: rule cũ bị xoá và rule mới được thêm vào cuối danh sách.'),
                                  op: { op: 'replace', rule: r, with: next },
                                  confirm: t('Đổi sang Giới hạn'),
                                  doneTitle: t('SSH đã dùng limit'),
                                })
                              },
                            },
                          ]
                        : []),
                      {
                        label: t('Xoá'),
                        run: () => deleteRule(r),
                        ok: priv && !lastSsh,
                        why: !priv ? t('Cần quyền root') : t('Rule SSH duy nhất: xoá sẽ làm mất kết nối tới server'),
                        danger: true,
                      },
                    ]}
                  />
                </span>
              </div>
            )
          })}
          {!rules.length && <div className="px-3.5 py-6 text-center text-muted">{t('Chưa có rule nào. Kết nối vào đều theo mặc định.')}</div>}
        </Group>
      )}

      {exposedOff.length > 0 && (
        <Group title={t('Mở ra internet vì firewall đang tắt')} hint={t('Tiến trình lắng nghe trên địa chỉ công khai, không có gì chặn.')} tone="warn">
          {exposedOff.map((l) => (
            <ListenLine key={`${l.proto}${l.port}`} l={l} complete={ports.processesComplete} />
          ))}
        </Group>
      )}

      {blocked.length > 0 && (
        <Group title={t('Lắng nghe công khai nhưng bị firewall chặn')} hint={t('An toàn: tiến trình bind địa chỉ công khai nhưng không có rule cho phép.')}>
          {blocked.map((l) => (
            <ListenLine key={`${l.proto}${l.port}`} l={l} complete={ports.processesComplete}>
              <Chip tone={TONES.success}>{t('Đang bị chặn')}</Chip>
            </ListenLine>
          ))}
        </Group>
      )}

      {!m && publicListen.length > 0 && (
        <Group
          title={t('Lắng nghe trên địa chỉ công khai')}
          hint={
            t('Không đọc được rule firewall nên Portway không biết cổng nào bị chặn (có thể có iptables/nftables hoặc firewall của cloud).') +
            (ports.processesComplete ? '' : t(' Tên tiến trình của user khác cần quyền root.'))
          }
          tone="warn"
        >
          {publicListen.map((l) => (
            <ListenLine key={`${l.proto}${l.port}${l.bind}`} l={l} complete={ports.processesComplete} />
          ))}
        </Group>
      )}
      {local.length > 0 && (
        <Group title={t('Chỉ truy cập trong server (127.0.0.1)')} hint={t('Không mở ra ngoài. Dùng SSH tunnel để truy cập từ máy bạn.')}>
          {local.map((l) => (
            <ListenLine key={`${l.proto}${l.port}${l.bind}`} l={l} complete={ports.processesComplete}>
              {l.proto === 'tcp' && (
                <span className="flex gap-1">
                  <Button
                    size="xs"
                    variant="primary"
                    onClick={() => {
                      tunnels.setDraft({ kind: 'local', serverId: server.id, user, dest: `127.0.0.1:${l.port}`, name: l.process ?? t('Cổng {port}', { port: l.port }) })
                      nav.go({ kind: 'tunnels' })
                    }}
                  >
                    {t('Mở tunnel')}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      const c = tunnelCmd(l.port)
                      void copyText(c).then(() => toast({ title: t('Đã sao chép lệnh tunnel'), detail: c }))
                    }}
                  >
                    {t('Lệnh ssh')}
                  </Button>
                </span>
              )}
            </ListenLine>
          ))}
        </Group>
      )}

      {stale.length > 0 && m && (
        <Group title={t('Rule thừa')} hint={t('Rule cho phép cổng nhưng không có tiến trình nào lắng nghe.')} tone="warn">
          {stale.map((r) => (
            <Line key={r.spec.join(' ')} cols="120px minmax(0,1fr) auto auto">
              <span className="font-mono text-[12px] font-semibold">{ruleLabel(r)}</span>
              <span className="truncate text-ink2">
                {r.comment ? `${r.comment} · ` : ''}
                {t('từ {source}', { source: sourceLabel(r.from) })}
              </span>
              <Chip tone={TONES.warn}>{t('Không có tiến trình')}</Chip>
              <Button size="xs" onClick={() => deleteRule(r)} disabled={!priv}>
                {t('Xoá rule')}
              </Button>
            </Line>
          ))}
        </Group>
      )}


      {ctx && ruleDlg && (
        <RuleDialog
          server={server}
          user={user}
          sudo={sudo}
          ctx={ctx}
          editing={ruleDlg.editing}
          dockerPorts={bypass}
          onFix={(port) => setFix({ port, container: bypass.get(port) ?? '' })}
          onClose={() => setRuleDlg(null)}
          onDone={done}
        />
      )}
      {ctx && m && enable && (
        <EnableDialog
          server={server}
          user={user}
          sudo={sudo}
          ctx={ctx}
          rules={rules}
          sshPorts={sshPorts.filter((p) => !rules.some((r) => allows(r, p, 'tcp')))}
          incoming={m.incoming}
          onClose={() => setEnable(false)}
          onDone={done}
        />
      )}
      {ctx && sshDelete && (
        <DeleteSshRule
          server={server}
          user={user}
          sudo={sudo}
          ctx={ctx}
          rule={sshDelete}
          others={sshRules.filter((r) => r.spec.join(' ') !== sshDelete.spec.join(' '))}
          onClose={() => setSshDelete(null)}
          onDone={done}
        />
      )}
      {fix && <DockerFix server={server} user={user} port={fix.port} container={fix.container} onClose={() => setFix(null)} />}
      {ctx && ask && <FwConfirm server={server} user={user} sudo={sudo} ctx={ctx} {...ask} onClose={() => setAsk(null)} onDone={done} />}
    </div>
  )
}

const RULE_COLS = '28px minmax(130px,1fr) minmax(120px,0.8fr) 90px minmax(160px,1.4fr) 40px'

function Card({ children }: { children: ReactNode }) {
  // No overflow-hidden: row menus must be able to hang outside the card.
  return <div className="rounded-xl border border-line bg-surface">{children}</div>
}

function Group({ title, hint, tone, children }: { title: string; hint: string; tone?: 'danger' | 'warn'; children: ReactNode }) {
  return (
    <Card>
      <div className={cx('flex flex-col gap-0.5 rounded-t-xl border-b border-line px-3.5 py-2.5', tone === 'danger' ? 'bg-danger-soft' : tone === 'warn' ? 'bg-warn-soft' : 'bg-raised')}>
        <span className={cx('font-semibold', tone === 'danger' && 'text-danger')}>{title}</span>
        <span className="text-[11.5px] text-ink2">{hint}</span>
      </div>
      {children}
    </Card>
  )
}

function Line({ cols, children }: { cols: string; children: ReactNode }) {
  return (
    <div className="grid items-center gap-3 border-t border-line px-3.5 py-2 first:border-t-0" style={{ gridTemplateColumns: cols }}>
      {children}
    </div>
  )
}

/** One template for every group of listening ports, with a fixed last column
 *  (a chip, two buttons or nothing), so the columns line up across groups. */
const LISTEN_COLS = '70px 44px minmax(0,1fr) minmax(0,1fr) 200px'

function ListenLine({ l, children, complete }: { l: Listen; children?: ReactNode; complete: boolean }) {
  return (
    <Line cols={LISTEN_COLS}>
      <span className="num font-semibold">{l.port}</span>
      <span className="text-[11.5px] text-muted">{l.proto}</span>
      <span className="truncate">{l.container ? `docker · ${l.container}` : (l.process ?? (complete ? t('— (không thuộc tiến trình nào trong server)') : t('— (cần root để biết tiến trình)')))}</span>
      <span className={cx('truncate font-mono text-[11.5px]', isPublicBind(l) ? 'text-warn' : 'text-muted')}>{bindText(l)}</span>
      <span className="flex justify-end">{children}</span>
    </Line>
  )
}
