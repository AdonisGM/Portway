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

export function commandFor(t: Pick<TunnelSpec, 'kind' | 'bind' | 'port' | 'dest' | 'autoReconnect'>, target: string) {
  const fwd = t.kind === 'local' ? `-L ${t.bind}:${t.port}:${t.dest}` : t.kind === 'socks' ? `-D ${t.bind}:${t.port}` : `-R ${t.port}:${t.dest}`
  const keep = t.autoReconnect ? ' -o ServerAliveInterval=15 -o ExitOnForwardFailure=yes' : ''
  return `ssh -N ${fwd}${keep} ${target}`
}

const host = (bind: string) => (bind === '0.0.0.0' ? '0.0.0.0' : 'localhost')

/** "localhost:15432 → 127.0.0.1:5432 qua pw-ubuntu (root)". */
export function describe(t: TunnelSpec, serverName: string) {
  if (t.kind === 'socks') return `SOCKS5 ${host(t.bind)}:${t.port} qua ${serverName} (${t.user})`
  if (t.kind === 'remote') return `${serverName}:${t.port} → ${t.dest} trên máy bạn (${t.user})`
  return `${host(t.bind)}:${t.port} → ${t.dest} qua ${serverName} (${t.user})`
}

/** What "Copy" puts on the clipboard. */
export const addressOf = (t: TunnelSpec) => (t.kind === 'socks' ? `socks5://127.0.0.1:${t.port}` : t.kind === 'remote' ? `localhost:${t.port}` : `localhost:${t.port}`)

export const openTarget = (t: TunnelSpec) => t.openTemplate.split('{port}').join(String(t.port))

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

export const isOn = (t: Tunnel) => t.run.state === 'running' || t.run.state === 'connecting' || t.run.state === 'retrying'

export function errorText(code: string, detail: string | null): string {
  switch (code) {
    case 'port_busy':
      return 'Cổng đang bị chiếm trên máy bạn'
    case 'bind_failed':
      return 'Không mở được cổng trên máy bạn'
    case 'needs_secret':
      return detail === 'passphrase'
        ? 'Cần passphrase của khoá: kết nối server một lần và chọn lưu vào Keychain'
        : 'Cần mật khẩu: kết nối server một lần và chọn lưu vào Keychain'
    case 'host_key_unknown':
      return 'Chưa tin khoá máy chủ: kết nối server này một lần trong Portway'
    case 'auth_failed':
      return 'Server từ chối đăng nhập'
    case 'key_missing':
      return `Không thấy file khoá ${detail ?? ''}`
    case 'remote_forward_refused':
      return 'Server không cho mở cổng'
    case 'connection_lost':
      return 'Mất kết nối tới server'
    case 'refused':
      return 'Server từ chối kết nối (cổng SSH đóng?)'
    case 'timeout':
      return 'Hết thời gian chờ kết nối'
    case 'dns':
      return 'Không tìm thấy tên máy chủ'
    default:
      return detail ?? code
  }
}

export function status(t: Tunnel, now: number): { label: string; sub: string; color: string } {
  const r = t.run
  switch (r.state) {
    case 'running':
      return {
        label: 'Đang chạy',
        color: 'var(--success)',
        sub: `chạy ${spanText((now - r.since) / 1000)} · ${r.active} kết nối · ↓ ${formatBytes(r.rx)} ↑ ${formatBytes(r.tx)}`,
      }
    case 'connecting':
      return { label: 'Đang kết nối…', color: 'var(--warn)', sub: 'mở SSH và yêu cầu forward' }
    case 'retrying':
      return {
        label: 'Đang kết nối lại',
        color: 'var(--warn)',
        sub: `lần thử ${r.attempt} · ${r.error} · thử lại sau ${Math.max(0, Math.ceil((r.nextAt - now) / 1000))} giây`,
      }
    case 'error':
      return { label: `Lỗi · ${errorText(r.code, r.detail)}`, color: 'var(--danger)', sub: r.code === 'remote_forward_refused' || r.code === 'port_busy' ? (r.detail ?? '') : '' }
    default:
      return { label: 'Đã tắt', color: 'var(--muted)', sub: t.autoStart ? 'tự bật khi mở Portway' : '' }
  }
}

export const saveError = (e: AppError) =>
  ({
    name_required: 'Cần đặt tên',
    invalid_port: 'Cổng không hợp lệ',
    invalid_dest: 'Đích phải có dạng host:port',
    port_taken: `Cổng đã dùng cho tunnel ${e.detail ?? 'khác'}`,
  })[e.code] ?? e.detail ?? e.code
