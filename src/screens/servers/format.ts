import type { Account, AppError, Auth, Server } from '../../lib/api'

/** Group shown for servers that were saved without one. */
export const NO_GROUP = 'Chưa phân nhóm'

export const groupLabel = (group: string) => group || NO_GROUP

export const keyName = (path: string) => path.split('/').pop() || path

export const authLabel = (auth: Auth) => (auth.kind === 'password' ? 'Mật khẩu' : keyName(auth.path))

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
      return e.field === 'name' ? 'Nhập tên hiển thị' : 'Nhập host hoặc IP'
    case 'name_taken':
      return 'Đã có server trùng tên này'
    case 'invalid_host':
      return 'Host không được có khoảng trắng'
    case 'invalid_port':
      return 'Cổng phải từ 1 đến 65535'
    case 'no_account':
      return 'Cần ít nhất một tài khoản có tên user'
    case 'duplicate_user':
      return `User ${e.detail ?? ''} bị lặp`
    case 'no_key':
      return 'Chọn khoá cho tài khoản'
    case 'not_found':
      return 'Server này không còn trong danh sách'
    case 'no_ssh_config':
      return 'Không tìm thấy ~/.ssh/config'
    case 'jump_missing':
      return 'Jump host này không còn trong danh sách hoặc không có user đó'
    case 'jump_loop':
      return 'Chuỗi jump host vòng lại chính server này'
    default:
      return e.detail ? `Lỗi: ${e.detail}` : 'Có lỗi xảy ra'
  }
}
