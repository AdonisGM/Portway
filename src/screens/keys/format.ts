import { t } from '../../i18n'
import type { AppError, SshKey } from '../../lib/api'
import { monthYear } from '../../i18n/dates'

/** "ED25519", "RSA 4096", "ECDSA 256", or "Không rõ loại". */
export const keyTypeLabel = (k: Pick<SshKey, 'kind' | 'bits'>) =>
  k.kind ? (k.bits ? `${k.kind} ${k.bits}` : k.kind) : t('Không rõ loại')

/** Month/year the key file was created, as in the design ("tạo 02/2025"). */
export function createdLabel(ms: number | null) {
  if (!ms) return null
  const d = new Date(ms)
  return monthYear(d)
}

export function keyErrorMessage(e: AppError) {
  switch (e.code) {
    case 'invalid_key_name':
      return t('Tên chỉ gồm chữ không dấu, số, dấu chấm, gạch dưới, gạch ngang và không bắt đầu bằng dấu chấm')
    case 'key_exists':
      return t('Đã có tệp khoá trùng tên trong ~/.ssh')
    case 'no_public_key':
      return t('Không đọc được tệp .pub của khoá này')
    default:
      return e.detail ? t('Lỗi: {detail}', { detail: e.detail }) : t('Có lỗi xảy ra')
  }
}
