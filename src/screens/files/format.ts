import { t } from '../../i18n'
import { dateOnly, dayMonth, hm, hms } from '../../i18n/dates'
import type { AppError, FileEntry } from '../../lib/api'

/** "24/09 14:05" this year, "24/09/2024" before ("Sep 24 14:05" / "Sep 24, 2024"
 *  in English). Local time of this Mac. */
export function shortTime(secs: number | null) {
  if (secs == null) return '—'
  const d = new Date(secs * 1000)
  return d.getFullYear() === new Date().getFullYear() ? `${dayMonth(d)} ${hm(d)}` : dateOnly(d)
}

export function fullTime(secs: number | null) {
  if (secs == null) return '—'
  const d = new Date(secs * 1000)
  return `${dateOnly(d)} ${hms(d)}`
}

/** "rwxr-xr-x" from permission bits, with setuid/setgid/sticky shown like ls. */
export function modeString(mode: number) {
  const out: string[] = []
  for (let i = 0; i < 3; i++) {
    const bits = (mode >> ((2 - i) * 3)) & 7
    let x = bits & 1 ? 'x' : '-'
    const special = (mode >> 9) & (4 >> i)
    if (special) x = i === 2 ? (bits & 1 ? 't' : 'T') : bits & 1 ? 's' : 'S'
    out.push(bits & 4 ? 'r' : '-', bits & 2 ? 'w' : '-', x)
  }
  return out.join('')
}

export const typeChar = (e: FileEntry) => (e.kind === 'dir' ? 'd' : e.kind === 'link' ? 'l' : '-')

export const octal = (mode: number) => (mode & 0o7777).toString(8).padStart(3, '0')

/** Short tag shown before a name: DIR, LINK, or the extension (up to 4 letters). */
export function tagOf(e: FileEntry) {
  if (e.kind === 'dir') return 'DIR'
  if (e.kind === 'link') return e.targetKind === 'dir' ? 'LDIR' : 'LINK'
  const dot = e.name.lastIndexOf('.')
  if (dot > 0 && dot < e.name.length - 1) return e.name.slice(dot + 1, dot + 5).toUpperCase()
  return 'FILE'
}

export const isDirLike = (e: FileEntry) => e.kind === 'dir' || (e.kind === 'link' && e.targetKind === 'dir')

/** `*.log`, `app-?.txt` as glob; anything else as a plain substring. Case-insensitive. */
export function matcher(q: string): (name: string) => boolean {
  const s = q.trim().toLowerCase()
  if (!s) return () => true
  if (/[*?]/.test(s)) {
    const re = new RegExp('^' + s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
    return (n) => re.test(n.toLowerCase())
  }
  return (n) => n.toLowerCase().includes(s)
}

/** Split an absolute path into breadcrumbs: [{label:'/', path:'/'}, {label:'var', path:'/var'}…]. */
export function crumbs(path: string) {
  const parts = path.split('/').filter(Boolean)
  return [{ label: '/', path: '/' }, ...parts.map((p, i) => ({ label: p, path: '/' + parts.slice(0, i + 1).join('/') }))]
}

export const parentOf = (path: string) => path.replace(/\/[^/]+\/?$/, '') || '/'

/** Shell-quoted like the Rust side, for the command previews. */
export const q = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

export const joinPath = (dir: string, name: string) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`)

export function fileError(e: AppError): string {
  switch (e.code) {
    case 'not_found':
      return t('Không tìm thấy {what}', { what: e.detail ?? '' })
    case 'permission_denied':
      return t('Không có quyền: {what}', { what: e.detail ?? '' })
    case 'not_a_dir':
      return t('{path} không phải thư mục', { path: e.detail ?? '' })
    case 'invalid_name':
      return t('Tên không hợp lệ (không được trống, chứa / hoặc là . ..)')
    case 'name_exists':
      return t('Đã có mục trùng tên trong thư mục này')
    case 'needs_root':
      return t('Chỉ root mới đổi được owner. Bật sudo hoặc kết nối bằng root.')
    case 'invalid_owner':
      return t('Tên owner hoặc group không hợp lệ')
    case 'sftp_server_missing':
      return t('Server không có sftp-server để chạy bằng sudo (SFTP được cấu hình internal-sftp?)')
    case 'sftp_root_failed':
      return t('Không mở được SFTP bằng sudo: {detail}', { detail: e.detail ?? '' })
    case 'sudo_off':
      return t('Cần bật sudo cho phiên này trước')
    case 'sftp_unavailable':
      return t('Server không mở được SFTP (subsystem sftp bị tắt?)')
    case 'exists':
      return e.detail ? t('Đã có {name} trên server', { name: e.detail }) : t('Đã có tệp trên server')
    default:
      return e.detail ? `${e.code}: ${e.detail}` : e.code
  }
}
