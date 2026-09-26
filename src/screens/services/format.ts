import { TONES } from '../../components/ui/primitives'
import type { Server, ServiceAction, Unit, UnitBrief } from '../../lib/api'

type Tone = (typeof TONES)[keyof typeof TONES]

export const shortName = (unit: string) => unit.replace(/\.service$/, '')

/** The name the user gave the unit, else the unit without ".service". */
export const displayName = (server: Server, unit: string) => server.unitNames?.[unit] || shortName(unit)

export function unitStatus(u: Unit): { tone: Tone; label: string } {
  if (u.loadState === 'not-found') return { tone: TONES.danger, label: 'Không tìm thấy unit' }
  if (u.loadState === 'masked') return { tone: TONES.neutral, label: 'Bị chặn (masked)' }
  switch (u.activeState) {
    case 'active':
      if (u.subState === 'exited') return { tone: TONES.success, label: 'Đã chạy xong' }
      return { tone: TONES.success, label: 'Đang chạy' }
    case 'activating':
      if (u.subState === 'auto-restart') return { tone: TONES.warn, label: `Đang tự khởi động lại · ${u.restarts} lần` }
      return { tone: TONES.info, label: 'Đang khởi động' }
    case 'deactivating':
      return { tone: TONES.info, label: 'Đang dừng' }
    case 'reloading':
      return { tone: TONES.info, label: 'Đang nạp lại' }
    case 'failed':
      if (u.result === 'start-limit-hit') return { tone: TONES.danger, label: 'Lỗi · khởi động lại quá nhiều lần' }
      if (u.result === 'signal' || u.exitCode === 'killed') return { tone: TONES.danger, label: `Lỗi · bị kill${u.exitStatus ? ` (tín hiệu ${u.exitStatus})` : ''}` }
      if (u.result === 'timeout') return { tone: TONES.danger, label: 'Lỗi · quá thời gian' }
      return { tone: TONES.danger, label: u.exitStatus != null ? `Lỗi · exit ${u.exitStatus}` : 'Lỗi' }
    default:
      return { tone: TONES.neutral, label: 'Không chạy' }
  }
}

/** "Khi khởi động": whether `systemctl enable/disable` applies. */
export function bootOf(fileState: string): { on: boolean; toggleable: boolean; hint: string } {
  switch (fileState) {
    case 'enabled':
    case 'enabled-runtime':
      return { on: true, toggleable: true, hint: 'Tự bật khi server khởi động' }
    case 'disabled':
      return { on: false, toggleable: true, hint: 'Không tự bật khi server khởi động' }
    case 'static':
      return { on: false, toggleable: false, hint: 'static: không có [Install], chỉ chạy khi unit khác gọi tới' }
    case 'indirect':
      return { on: false, toggleable: false, hint: 'indirect: được bật qua unit khác (Also= hoặc socket/timer)' }
    case 'generated':
    case 'transient':
      return { on: true, toggleable: false, hint: `${fileState}: do systemd tự tạo, không bật/tắt được` }
    case 'masked':
    case 'masked-runtime':
      return { on: false, toggleable: false, hint: 'masked: bị chặn, không chạy được cho tới khi unmask' }
    case 'alias':
      return { on: false, toggleable: false, hint: 'alias: tên khác của một unit' }
    default:
      return { on: false, toggleable: false, hint: fileState || 'Không rõ' }
  }
}

/** Exactly what the Rust side runs (without sudo). */
export function serviceCommand(unit: string, action: ServiceAction) {
  const verb = action === 'resetFailed' ? 'reset-failed' : action
  return `systemctl ${verb} ${unit}`
}

const pad = (n: number) => String(n).padStart(2, '0')

/** dd/mm hh:mm in this Mac's time. */
export function localTime(ms: number | null) {
  if (!ms) return '—'
  const d = new Date(ms)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}${sameYear ? '' : `/${d.getFullYear()}`} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Units worth showing before the user picks any: whatever failed, plus the
 *  usual server software when it is installed. */
const COMMON = [
  /^nginx\.service$/,
  /^apache2\.service$/,
  /^httpd\.service$/,
  /^caddy\.service$/,
  /^traefik\.service$/,
  /^docker\.service$/,
  /^containerd\.service$/,
  /^postgresql(@.+)?\.service$/,
  /^mysql\.service$/,
  /^mariadb\.service$/,
  /^redis(-server)?\.service$/,
  /^mongod\.service$/,
  /^php[\d.]*-fpm\.service$/,
  /^ssh\.service$/,
  /^sshd\.service$/,
  /^cron\.service$/,
  /^crond\.service$/,
  /^fail2ban\.service$/,
  /^ufw\.service$/,
]

export function defaultWatch(all: UnitBrief[]): string[] {
  return all.filter((u) => u.active === 'failed' || COMMON.some((re) => re.test(u.name))).map((u) => u.name)
}

/** Stopping these can cut Portway (and you) off from the server. */
export const isSsh = (unit: string) => unit === 'ssh.service' || unit === 'sshd.service'

export function stopNote(unit: string): { body: string; note?: string } {
  if (unit === 'docker.service') return { body: 'Tất cả container trên server sẽ dừng theo.', note: 'Container có restart policy sẽ chạy lại khi Docker chạy lại.' }
  if (/^(nginx|apache2|httpd|caddy|traefik)\.service$/.test(unit)) return { body: 'Mọi website phục vụ qua dịch vụ này sẽ ngừng phản hồi.' }
  if (/^(postgresql|mysql|mariadb|mongod|redis(-server)?)(@.+)?\.service$/.test(unit)) return { body: 'Ứng dụng đang dùng database/cache này sẽ lỗi cho tới khi nó chạy lại.' }
  return { body: 'Dịch vụ sẽ dừng cho tới khi bạn chạy lại.' }
}
