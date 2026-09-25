import type { AppError, SshKey } from '../../lib/api'

/** "ED25519", "RSA 4096", "ECDSA 256", or "Không rõ loại". */
export const keyTypeLabel = (k: Pick<SshKey, 'kind' | 'bits'>) =>
  k.kind ? (k.bits ? `${k.kind} ${k.bits}` : k.kind) : 'Không rõ loại'

/** Month/year the key file was created, as in the design ("tạo 02/2025"). */
export function createdLabel(ms: number | null) {
  if (!ms) return null
  const d = new Date(ms)
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
}

export function keyErrorMessage(e: AppError) {
  switch (e.code) {
    case 'invalid_key_name':
      return 'Tên chỉ gồm chữ không dấu, số, dấu chấm, gạch dưới, gạch ngang và không bắt đầu bằng dấu chấm'
    case 'key_exists':
      return 'Đã có tệp khoá trùng tên trong ~/.ssh'
    case 'no_public_key':
      return 'Không đọc được tệp .pub của khoá này'
    default:
      return e.detail ? `Lỗi: ${e.detail}` : 'Có lỗi xảy ra'
  }
}
