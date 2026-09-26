import type { AppError } from '../../lib/api'

const num = (max: number) => new Intl.NumberFormat('vi-VN', { maximumFractionDigits: max })

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/** Unit index that shows `bytes` with a small number (1024-based, like df -h). */
export const unitOf = (bytes: number) => Math.min(UNITS.length - 1, Math.max(0, Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024))))

/** "4,9" in the given unit index, one decimal under 10. */
export const inUnit = (bytes: number, unit: number) => {
  const v = bytes / 1024 ** unit
  return num(v < 10 && unit > 0 ? 1 : 0).format(v)
}

export const formatBytes = (bytes: number) => {
  const u = unitOf(bytes)
  return `${inUnit(bytes, u)} ${UNITS[u]}`
}

export const unitName = (u: number) => UNITS[u]

export const formatPercent = (v: number) => `${Math.round(v)}%`

export const formatDecimal = (v: number, digits = 2) => num(digits).format(v)

/** "41 ngày", "3 giờ", "12 phút". */
export function formatUptime(secs: number) {
  const days = Math.floor(secs / 86400)
  if (days >= 1) return `${days} ngày`
  const hours = Math.floor(secs / 3600)
  if (hours >= 1) return `${hours} giờ`
  return `${Math.max(1, Math.floor(secs / 60))} phút`
}

/** Title and explanation for a failed connection. */
export function connectError(e: AppError, host: string, port: number): { title: string; message: string } {
  const title = `Không kết nối được tới ${host}:${port}`
  switch (e.code) {
    case 'timeout':
      return { title, message: 'Máy chủ không phản hồi sau 10 giây. Kiểm tra máy có đang bật, có cùng mạng không, hoặc cổng SSH có bị chặn không.' }
    case 'refused':
      return { title, message: `Máy chủ từ chối kết nối ở cổng ${port}. SSH có thể chưa chạy hoặc đang nghe ở cổng khác.` }
    case 'dns':
      return { title, message: `Không tìm thấy địa chỉ ${host}. Kiểm tra lại tên miền.` }
    case 'network':
      return { title, message: 'Lỗi mạng khi mở kết nối.' }
    case 'auth_failed':
      return { title: 'Server không nhận khoá', message: 'Kiểm tra public key của khoá này đã nằm trong ~/.ssh/authorized_keys của user trên server chưa.' }
    case 'key_missing':
      return { title: 'Không thấy tệp khoá', message: `Tệp ${e.detail ?? ''} không có trên máy này. Sửa tài khoản để chọn khoá khác.` }
    case 'key_unreadable':
      return { title: 'Không đọc được tệp khoá', message: 'Tệp khoá hỏng hoặc có định dạng Portway chưa hỗ trợ.' }
    case 'connection_lost':
    case 'not_connected':
      return { title: 'Mất kết nối', message: 'Phiên SSH tới server đã đóng.' }
    case 'cancelled':
      return { title: 'Chưa kết nối', message: 'Bạn đã huỷ lúc đang kết nối.' }
    case 'jump_needs_secret':
      return {
        title: `Chưa có mật khẩu cho jump host ${e.detail ?? ''}`,
        message: 'Kết nối thẳng tới jump host một lần và chọn lưu mật khẩu (hoặc passphrase) vào Keychain, rồi thử lại.',
      }
    case 'jump_host_key':
      return {
        title: `Chưa tin khoá máy chủ của jump host ${e.detail ?? ''}`,
        message: 'Kết nối thẳng tới jump host một lần để xác nhận khoá máy chủ, rồi thử lại.',
      }
    case 'jump_forward':
      return { title, message: `${e.detail ?? ''}. Kiểm tra host, cổng có đúng như jump host nhìn thấy không, và sshd trên jump host có cho AllowTcpForwarding không.` }
    case 'jump_failed':
      return { title: 'Không vào được jump host', message: e.detail ?? 'Lỗi khi kết nối tới jump host.' }
    case 'jump_loop':
      return { title: 'Chuỗi jump host quá dài hoặc vòng lại', message: `Kiểm tra mục "Kết nối qua" của ${e.detail ?? 'các server'}.` }
    case 'needs_app':
      return { title: 'Chỉ chạy trong app Portway', message: 'Kết nối SSH cần phần Rust của app, không chạy khi mở giao diện bằng trình duyệt.' }
    default:
      return { title, message: 'Có lỗi khi kết nối SSH.' }
  }
}
