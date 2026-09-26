import { AlertTriangle, Info, Lock } from 'lucide-react'
import type { ReactNode } from 'react'
import { t } from '../../i18n'
import { api, type FirewallState, type Ports, type PortWarning, type Server } from '../../lib/api'
import { ErrorLine, RefreshControl, useRefreshed } from './refresh'
import { UseSudoButton } from './sudo'

const loadPorts = (s: string, u: string) => api.ports(s, u)

/** "[::]" for IPv6 addresses so "addr:port" stays readable. */
const hostPort = (bind: string, port: number) => `${bind.includes(':') ? `[${bind}]` : bind}:${port}`

type Severity = 'danger' | 'warn' | 'info'

function describe(w: PortWarning): { severity: Severity; title: string; desc: string } {
  switch (w.kind) {
    case 'databasePublic':
      return {
        severity: 'danger',
        title: w.guessed
          ? t('Cổng {port} (thường dùng cho {name}) đang mở trên IP công khai', { port: w.port, name: w.name })
          : t('{name} ({port}) đang lắng nghe trên IP công khai', { name: w.name, port: w.port }),
        desc: w.docker
          ? t('Bind {addr} qua container {container}. Nếu chỉ dùng nội bộ, publish thành 127.0.0.1:{port} trong docker-compose.yml.', {
              addr: hostPort(w.bind, w.port),
              container: w.via ?? '',
              port: w.port,
            })
          : t('Bind {addr}. Nếu chỉ dùng nội bộ, cấu hình lắng nghe trên 127.0.0.1.', { addr: `${hostPort(w.bind, w.port)}${w.via ? ` (${w.via})` : ''}` }),
      }
    case 'dockerBypass':
      return {
        severity: 'warn',
        title: t('Cổng Docker {port} không đi qua firewall', { port: w.port }),
        desc: t('Container {container} được publish bằng rule iptables của Docker, nằm trước UFW, nên cổng {port} mở ra ngoài dù UFW không cho phép.', {
          container: w.container,
          port: w.port,
        }),
      }
    case 'ruleIneffective':
      return {
        severity: 'warn',
        title: t('Rule UFW cho cổng {port} không có tác dụng', { port: w.port }),
        desc: t('UFW chỉ cho {from}, nhưng container {container} được Docker publish trực tiếp nên mọi IP đều vào được.', { from: w.from, container: w.container }),
      }
    case 'ruleUnused':
      return {
        severity: 'info',
        title: t('UFW cho phép {to} nhưng không có tiến trình nào lắng nghe', { to: w.to }),
        desc: t('Rule này có thể đã thừa.'),
      }
  }
}

const TONE: Record<Severity, { bg: string; fg: string }> = {
  danger: { bg: 'var(--danger-soft)', fg: 'var(--danger)' },
  warn: { bg: 'var(--warn-soft)', fg: 'var(--warn)' },
  info: { bg: 'var(--raised)', fg: 'var(--muted)' },
}

function Tile({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="flex flex-col gap-[3px] bg-raised px-3 py-2.5" title={title}>
      <span className="text-[11px] text-muted">{label}</span>
      {children}
    </div>
  )
}

/** A function, not a constant, so the words follow the current language. */
const policy = (): Record<string, string> => ({ allow: t('cho phép#policy'), reject: t('từ chối#policy'), deny: t('chặn#policy') })
const TOOL = { ufw: 'UFW', firewalld: 'firewalld' } as const

function FirewallTile({ fw, server, user }: { fw: FirewallState | null; server: Server; user: string }) {
  if (!fw) return <span className="pt-[3px] text-[12px] text-muted">{t('Đang đọc…')}</span>
  if (fw.kind === 'needsRoot')
    return (
      <span className="flex items-center gap-1.5 pt-[3px] text-[12px] text-muted">
        <Lock size={13} strokeWidth={1.9} />
        <span className="flex-1">{t('{tool} · cần root để đọc rule', { tool: TOOL[fw.backend] })}</span>
        <UseSudoButton server={server} user={user} />
      </span>
    )
  if (fw.kind === 'error')
    return (
      <span className="pt-[3px] text-[12px] text-danger" title={fw.detail}>
        {t('Không đọc được {tool}', { tool: TOOL[fw.backend] })}
      </span>
    )
  if (fw.kind === 'none')
    return <span className="pt-[3px] text-[12px] text-muted">{fw.iptables ? t('Dùng iptables trực tiếp ({n} rule)', { n: fw.iptables }) : t('Không có UFW hay firewalld')}</span>
  if (!fw.enabled) return <span className="pt-[3px] text-[12px] text-warn">{t('{tool} đang tắt, mọi cổng đang lắng nghe đều mở ra ngoài', { tool: TOOL[fw.backend] })}</span>
  const allow = fw.rules.filter((r) => r.action === 'allow' || r.action === 'limit').length
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="num text-[18px] font-semibold">{allow}</span>
      <span className="text-[12px] text-ink2">
        {t('rule cho phép · {tool} đang bật, mặc định {policy} kết nối vào', {
          n: allow,
          tool: TOOL[fw.backend],
          policy: policy()[fw.incoming] ?? fw.incoming,
        })}
      </span>
    </span>
  )
}

const loadFirewall = (s: string, u: string) => api.firewallState(s, u)

/** "Cổng mạng & firewall": what listens, what UFW allows, and what to worry about. */
export function PortsCard({ server, user }: { server: Server; user: string }) {
  const { data, error, at, busy, refresh, live } = useRefreshed<Ports>(server.id, user, 'ports', loadPorts)
  const firewall = useRefreshed<FirewallState>(server.id, user, 'firewallState', loadFirewall)
  const publicCount = data?.listening.filter((l) => l.scope === 'public').length ?? 0
  const listTitle = data?.listening
    .map((l) => `${l.port}/${l.proto} · ${hostPort(l.bind, l.port)}${l.container ? ` · ${l.container}` : l.process ? ` · ${l.process}` : ''}`)
    .join('\n')

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface p-4">
      <div className="flex items-start gap-2">
        <span className="flex-1 text-[15px] font-semibold">{t('Cổng mạng & firewall')}</span>
        <RefreshControl
          at={at}
          busy={busy || firewall.busy}
          error={error}
          onRefresh={() => {
            void refresh()
            void firewall.refresh()
          }}
          live={live}
        />
      </div>
      <ErrorLine error={error} />

      {data ? (
        <>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[10px] border border-line bg-line">
            <Tile label={t('Đang lắng nghe')} title={listTitle}>
              <span className="flex items-baseline gap-1.5">
                <span className="num text-[18px] font-semibold">{data.listening.length}</span>
                <span className="text-[12px] text-ink2">{t('cổng · {n} trên IP công khai', { n: publicCount, total: data.listening.length })}</span>
              </span>
            </Tile>
            <Tile label="Firewall">
              <FirewallTile fw={firewall.data} server={server} user={user} />
            </Tile>
          </div>

          {data.warnings.map((w, i) => {
            const d = describe(w)
            const Icon = d.severity === 'info' ? Info : AlertTriangle
            return (
              <div key={i} className="flex items-start gap-2.5 rounded-lg px-2.5 py-2" style={{ background: TONE[d.severity].bg }}>
                <Icon size={14} strokeWidth={1.9} className="mt-px flex-none" style={{ color: TONE[d.severity].fg }} />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="leading-snug font-medium text-ink">{d.title}</span>
                  <span className="text-[11.5px] leading-snug text-ink2">{d.desc}</span>
                </div>
              </div>
            )
          })}

          {!data.processesComplete && (
            <span className="text-[11px] text-muted">
              {t('Đang xem bằng {user} không có sudo, nên không biết tiến trình nào giữ các cổng của user khác.', { user })}
            </span>
          )}
        </>
      ) : (
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[10px] border border-line bg-line">
          {[0, 1].map((i) => (
            <div key={i} className="flex flex-col gap-2 bg-raised px-3 py-3">
              <span className="block h-2.5 w-1/3 rounded-md bg-sunken" />
              <span className="block h-4 w-1/2 rounded-md bg-sunken" />
            </div>
          ))}
        </div>
      )}

      <span className="border-t border-line pt-2 text-[11px] leading-normal text-muted">
        {t('Firewall của nhà cung cấp cloud (Security Group, Cloud Firewall) nằm ngoài server nên Portway không kiểm tra được.')}
      </span>
    </div>
  )
}
