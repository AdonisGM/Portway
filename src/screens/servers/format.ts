import { t } from '../../i18n'
import type { Account, AppError, Auth, Server } from '../../lib/api'

/** A server's group, or the label shown for servers saved without one. */
export const groupLabel = (group: string) => group || t('Chưa phân nhóm')

export const keyName = (path: string) => path.split('/').pop() || path

export const authLabel = (auth: Auth) => (auth.kind === 'password' ? t('Mật khẩu') : keyName(auth.path))

export const hostPort = (host: string, port: number) => (port !== 22 ? `${host}:${port}` : host)

/** The equivalent `ssh` command line for an account, shown in the editor.
 *  `jump` is the jump host as `user@host[:port]`. */
export function sshCommand(host: string, port: number, account: Account | undefined, jump?: string) {
  const parts = ['ssh']
  if (port && port !== 22) parts.push(`-p ${port}`)
  if (account?.auth.kind === 'key') parts.push(`-i ${account.auth.path}`)
  if (jump) parts.push(`-J ${jump}`)
  parts.push(`${account?.user || '…'}@${host}`)
  return parts.join(' ')
}

/** `user@host[:port]` of a server's jump host, as `ssh -J` takes it. */
export function jumpSpec(server: Server, byId: (id: string) => Server | undefined) {
  const via = server.jump ? byId(server.jump.serverId) : undefined
  return via && `${server.jump!.user}@${hostPort(via.host, via.port)}`
}

export const parseTags = (text: string) =>
  text
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)

/** Messages for the error codes returned by the Rust side. */
export function errorMessage(e: AppError): string {
  switch (e.code) {
    case 'required':
      return e.field === 'name' ? t('Nhập tên hiển thị') : t('Nhập host hoặc IP')
    case 'name_taken':
      return t('Đã có server trùng tên này')
    case 'invalid_host':
      return t('Host chỉ gồm chữ, số và . - _ : [ ], không bắt đầu bằng dấu -')
    case 'invalid_user':
      return t('User {user} không hợp lệ: chỉ gồm chữ, số và . _ - @, không bắt đầu bằng dấu -', { user: e.detail ?? '' })
    case 'invalid_port':
      return t('Cổng phải từ 1 đến 65535')
    case 'no_account':
      return t('Cần ít nhất một tài khoản có tên user')
    case 'duplicate_user':
      return t('User {user} bị lặp', { user: e.detail ?? '' })
    case 'no_key':
      return t('Chọn khoá cho tài khoản')
    case 'not_found':
      return t('Server này không còn trong danh sách')
    case 'no_ssh_config':
      return t('Không tìm thấy ~/.ssh/config')
    case 'jump_missing':
      return t('Jump host này không còn trong danh sách hoặc không có user đó')
    case 'jump_loop':
      return t('Chuỗi jump host vòng lại chính server này')
    default:
      return e.detail ? t('Lỗi: {detail}', { detail: e.detail }) : t('Có lỗi xảy ra')
  }
}
