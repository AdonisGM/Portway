import { t } from '../../i18n'
import type { AppError, Server, Tunnel, TunnelSpec } from '../../lib/api'
import { formatBytes } from '../server/format'
import { spanText } from '../docker/format'

export const KIND_LABELS = { local: 'Local', socks: 'SOCKS', remote: 'Remote' } as const

/** `-p 2201 -i ~/.ssh/key user@host`, like the Rust side builds it. */
export function targetArgs(server: Server | undefined, user: string) {
  if (!server) return `${user}@?`
  const account = server.accounts.find((a) => a.user === user)
  const parts: string[] = []
  if (server.port !== 22) parts.push(`-p ${server.port}`)
  if (account?.auth.kind === 'key') parts.push(`-i ${account.auth.path}`)
  parts.push(`${user}@${server.host}`)
  return parts.join(' ')
}

export function commandFor(tn: Pick<TunnelSpec, 'kind' | 'bind' | 'port' | 'dest' | 'autoReconnect'>, target: string) {
  const fwd = tn.kind === 'local' ? `-L ${tn.bind}:${tn.port}:${tn.dest}` : tn.kind === 'socks' ? `-D ${tn.bind}:${tn.port}` : `-R ${tn.port}:${tn.dest}`
  const keep = tn.autoReconnect ? ' -o ServerAliveInterval=15 -o ExitOnForwardFailure=yes' : ''
  return `ssh -N ${fwd}${keep} ${target}`
}

const host = (bind: string) => (bind === '0.0.0.0' ? '0.0.0.0' : 'localhost')

/** "localhost:15432 → 127.0.0.1:5432 qua pw-ubuntu (root)". */
export function describe(tn: TunnelSpec, serverName: string) {
  if (tn.kind === 'socks') return t('SOCKS5 {addr} qua {server} ({user})', { addr: `${host(tn.bind)}:${tn.port}`, server: serverName, user: tn.user })
  if (tn.kind === 'remote') return t('{server}:{port} → {dest} trên máy bạn ({user})', { server: serverName, port: tn.port, dest: tn.dest, user: tn.user })
  return t('{addr} → {dest} qua {server} ({user})', { addr: `${host(tn.bind)}:${tn.port}`, dest: tn.dest, server: serverName, user: tn.user })
}

/** What "Copy" puts on the clipboard. */
export const addressOf = (tn: TunnelSpec) => (tn.kind === 'socks' ? `socks5://127.0.0.1:${tn.port}` : tn.kind === 'remote' ? `localhost:${tn.port}` : `localhost:${tn.port}`)

export const openTarget = (tn: TunnelSpec) => tn.openTemplate.split('{port}').join(String(tn.port))

/** A starting template for "Mở" from the destination port. */
export function templateFor(kind: 'url' | 'conn', dest: string, user: string) {
  if (kind === 'url') return 'http://localhost:{port}'
  const port = Number(dest.split(':').pop())
  if (port === 5432) return `postgres://${user}@localhost:{port}/postgres`
  if (port === 3306) return `mysql://${user}@localhost:{port}/`
  if (port === 6379) return 'redis://localhost:{port}'
  if (port === 27017) return 'mongodb://localhost:{port}/'
  return 'localhost:{port}'
}

export const isOn = (tn: Tunnel) => tn.run.state === 'running' || tn.run.state === 'connecting' || tn.run.state === 'retrying'

export function errorText(code: string, detail: string | null): string {
  switch (code) {
    case 'port_busy':
      return t('Cổng đang bị chiếm trên máy bạn')
    case 'bind_failed':
      return t('Không mở được cổng trên máy bạn')
    case 'needs_secret':
      return detail === 'passphrase'
        ? t('Cần passphrase của khoá: kết nối server một lần và chọn lưu vào Keychain')
        : t('Cần mật khẩu: kết nối server một lần và chọn lưu vào Keychain')
    case 'host_key_unknown':
      return t('Chưa tin khoá máy chủ: kết nối server này một lần trong Portway')
    case 'auth_failed':
      return t('Server từ chối đăng nhập')
    case 'key_missing':
      return t('Không thấy file khoá {path}', { path: detail ?? '' })
    case 'remote_forward_refused':
      return t('Server không cho mở cổng')
    case 'connection_lost':
      return t('Mất kết nối tới server')
    case 'refused':
      return t('Server từ chối kết nối (cổng SSH đóng?)')
    case 'timeout':
      return t('Hết thời gian chờ kết nối')
    case 'dns':
      return t('Không tìm thấy tên máy chủ')
    default:
      return detail ?? code
  }
}

export function status(tn: Tunnel, now: number): { label: string; sub: string; color: string } {
  const r = tn.run
  switch (r.state) {
    case 'running':
      return {
        label: t('Đang chạy'),
        color: 'var(--success)',
        sub: t('chạy {time} · {n} kết nối · ↓ {rx} ↑ {tx}', { time: spanText((now - r.since) / 1000), n: r.active, rx: formatBytes(r.rx), tx: formatBytes(r.tx) }),
      }
    case 'connecting':
      return { label: t('Đang kết nối…'), color: 'var(--warn)', sub: t('mở SSH và yêu cầu forward') }
    case 'retrying':
      return {
        label: t('Đang kết nối lại'),
        color: 'var(--warn)',
        sub: t('lần thử {n} · {error} · thử lại sau {s} giây', { n: r.attempt, error: r.error, s: Math.max(0, Math.ceil((r.nextAt - now) / 1000)) }),
      }
    case 'error':
      return { label: t('Lỗi · {error}', { error: errorText(r.code, r.detail) }), color: 'var(--danger)', sub: r.code === 'remote_forward_refused' || r.code === 'port_busy' ? (r.detail ?? '') : '' }
    default:
      return { label: t('Đã tắt'), color: 'var(--muted)', sub: tn.autoStart ? t('tự bật khi mở Portway') : '' }
  }
}

export const saveError = (e: AppError) =>
  ({
    name_required: t('Cần đặt tên'),
    invalid_port: t('Cổng không hợp lệ'),
    invalid_dest: t('Đích phải có dạng host:port'),
    port_taken: e.detail ? t('Cổng đã dùng cho tunnel {name}', { name: e.detail }) : t('Cổng đã dùng cho tunnel khác'),
  })[e.code] ?? e.detail ?? e.code
