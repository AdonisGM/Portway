import { locale, t } from '../../i18n'
import type { AppError } from '../../lib/api'

const num = (max: number) => new Intl.NumberFormat(locale(), { maximumFractionDigits: max })

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
  if (days >= 1) return t('{n} ngày', { n: days })
  const hours = Math.floor(secs / 3600)
  if (hours >= 1) return t('{n} giờ', { n: hours })
  return t('{n} phút', { n: Math.max(1, Math.floor(secs / 60)) })
}

/** Title and explanation for a failed connection. */
export function connectError(e: AppError, host: string, port: number): { title: string; message: string } {
  const title = t('Không kết nối được tới {host}:{port}', { host, port })
  switch (e.code) {
    case 'timeout':
      return { title, message: t('Máy chủ không phản hồi sau 10 giây. Kiểm tra máy có đang bật, có cùng mạng không, hoặc cổng SSH có bị chặn không.') }
    case 'refused':
      return { title, message: t('Máy chủ từ chối kết nối ở cổng {port}. SSH có thể chưa chạy hoặc đang nghe ở cổng khác.', { port }) }
    case 'dns':
      return { title, message: t('Không tìm thấy địa chỉ {host}. Kiểm tra lại tên miền.', { host }) }
    case 'network':
      return { title, message: t('Lỗi mạng khi mở kết nối.') }
    case 'auth_failed':
      return { title: t('Server không nhận khoá'), message: t('Kiểm tra public key của khoá này đã nằm trong ~/.ssh/authorized_keys của user trên server chưa.') }
    case 'auth_prompt':
      return {
        title: t('Server hỏi thêm một bước xác thực'),
        message: t('Sau mật khẩu, server còn hỏi "{prompt}" (xác thực 2 bước). Portway chưa trả lời được bước này; dùng khoá SSH cho tài khoản này, hoặc kết nối bằng Terminal.', { prompt: e.detail ?? '' }),
      }
    case 'key_missing':
      return { title: t('Không thấy tệp khoá'), message: t('Tệp {file} không có trên máy này. Sửa tài khoản để chọn khoá khác.', { file: e.detail ?? '' }) }
    case 'key_unreadable':
      return { title: t('Không đọc được tệp khoá'), message: t('Tệp khoá hỏng hoặc có định dạng Portway chưa hỗ trợ.') }
    case 'connection_lost':
    case 'not_connected':
      return { title: t('Mất kết nối'), message: t('Phiên SSH tới server đã đóng.') }
    case 'cancelled':
      return { title: t('Chưa kết nối'), message: t('Bạn đã huỷ lúc đang kết nối.') }
    case 'jump_needs_secret':
      return {
        title: t('Chưa có mật khẩu cho jump host {host}', { host: e.detail ?? '' }),
        message: t('Kết nối thẳng tới jump host một lần và chọn lưu mật khẩu (hoặc passphrase) vào Keychain, rồi thử lại.'),
      }
    case 'jump_host_key':
      return {
        title: t('Chưa tin khoá máy chủ của jump host {host}', { host: e.detail ?? '' }),
        message: t('Kết nối thẳng tới jump host một lần để xác nhận khoá máy chủ, rồi thử lại.'),
      }
    case 'jump_forward':
      return { title, message: t('{detail}. Kiểm tra host, cổng có đúng như jump host nhìn thấy không, và sshd trên jump host có cho AllowTcpForwarding không.', { detail: e.detail ?? '' }) }
    case 'jump_failed':
      return { title: t('Không vào được jump host'), message: e.detail ?? t('Lỗi khi kết nối tới jump host.') }
    case 'jump_loop':
      return { title: t('Chuỗi jump host quá dài hoặc vòng lại'), message: t('Kiểm tra mục "Kết nối qua" của {servers}.', { servers: e.detail ?? t('các server') }) }
    case 'needs_app':
      return { title: t('Chỉ chạy trong app Portway'), message: t('Kết nối SSH cần phần Rust của app, không chạy khi mở giao diện bằng trình duyệt.') }
    default:
      return { title, message: t('Có lỗi khi kết nối SSH.') }
  }
}
