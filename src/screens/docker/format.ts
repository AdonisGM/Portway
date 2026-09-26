import { TONES } from '../../components/ui/primitives'
import type { ComposeAction, Container, DockerPort } from '../../lib/api'
import { q } from '../files/format'

type Tone = (typeof TONES)[keyof typeof TONES]

const DATA_IMAGES: Record<string, 'database' | 'cache'> = {
  postgres: 'database',
  postgis: 'database',
  mysql: 'database',
  mariadb: 'database',
  mongo: 'database',
  clickhouse: 'database',
  'clickhouse-server': 'database',
  redis: 'cache',
  valkey: 'cache',
  keydb: 'cache',
  memcached: 'cache',
}

/** "postgres" from "docker.io/library/postgres:16-alpine@sha256:…". */
export const imageBase = (image: string) => image.split('@')[0].split('/').pop()!.split(':')[0]

/** Database or cache, told from the image name (a guess, shown as such). */
export const dataRole = (c: Container) => DATA_IMAGES[imageBase(c.image)] ?? null

/** One-shot compose containers (migrations…) that finished fine. */
export const isFinishedJob = (c: Container) => c.policy === 'no' && !!c.project && c.state === 'exited' && c.exitCode === 0

/** Exit codes of a process stopped by a signal (docker stop, Ctrl+C). */
const STOPPED_CODES = [0, 130, 137, 143]

/** Exited without being a failure: a clean or signal exit, or a container
 *  Docker would have restarted had it crashed (always / unless-stopped), so
 *  someone stopped it. */
const stoppedOnPurpose = (c: Container) => STOPPED_CODES.includes(c.exitCode) || c.policy === 'always' || c.policy === 'unless-stopped'

export function statusOf(c: Container): { tone: Tone; label: string } {
  switch (c.state) {
    case 'running':
      if (c.health === 'unhealthy') return { tone: TONES.warn, label: 'Đang chạy · unhealthy' }
      if (c.health === 'healthy') return { tone: TONES.success, label: 'Đang chạy · healthy' }
      if (c.health === 'starting') return { tone: TONES.info, label: 'Đang chạy · đang kiểm tra' }
      return { tone: TONES.success, label: 'Đang chạy' }
    case 'restarting':
      return { tone: TONES.danger, label: `Khởi động lại liên tục · ${c.restarts} lần` }
    case 'paused':
      return { tone: TONES.neutral, label: 'Tạm dừng' }
    case 'created':
      return { tone: TONES.neutral, label: 'Đã tạo, chưa chạy' }
    case 'dead':
      return { tone: TONES.danger, label: 'Hỏng (dead)' }
    default:
      if (isFinishedJob(c)) return { tone: TONES.neutral, label: 'Đã chạy xong' }
      if (stoppedOnPurpose(c)) return { tone: TONES.neutral, label: c.exitCode ? `Đã dừng · exit ${c.exitCode}` : 'Đã dừng' }
      return { tone: TONES.danger, label: `Lỗi · exit ${c.exitCode}` }
  }
}

export function roleLabel(c: Container) {
  const role = dataRole(c)
  if (role) return role
  if (isFinishedJob(c)) return 'job · chạy một lần'
  return `restart: ${c.policy}`
}

const ago = (iso: string | null) => (iso ? Math.max(0, (Date.now() - Date.parse(iso)) / 1000) : null)

export function spanText(secs: number) {
  if (secs < 60) return `${Math.floor(secs)} giây`
  if (secs < 3600) return `${Math.floor(secs / 60)} phút`
  if (secs < 86400) return `${Math.floor(secs / 3600)} giờ`
  return `${Math.floor(secs / 86400)} ngày`
}

/** "chạy 3 giờ" or "dừng 2 ngày trước". */
export function upLabel(c: Container) {
  if (c.state === 'running') {
    const s = ago(c.startedAt)
    return s == null ? '' : `chạy ${spanText(s)}`
  }
  const s = ago(c.finishedAt)
  return s == null ? '' : `dừng ${spanText(s)} trước`
}

export const portText = (p: DockerPort) => `${p.hostIp || '0.0.0.0'}:${p.hostPort} → ${p.containerPort}${p.proto === 'tcp' ? '' : `/${p.proto}`}`

export function portTip(c: Container) {
  const base = 'Mở trên mọi địa chỉ của server nên truy cập được từ ngoài. Docker tự thêm rule iptables nên UFW không chặn được cổng này.'
  return dataRole(c) ? `${base} Database/cache không nên mở ra ngoài, nên bind 127.0.0.1.` : base
}

const pad = (n: number) => String(n).padStart(2, '0')

export function dateTime(iso: string | null) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** `docker image ls` prints "2026-09-01 10:00:00 +0000 UTC". */
export function imageDate(created: string) {
  const m = created.match(/^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) ([+-]\d{4})/)
  if (!m) return created
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7].slice(0, 3)}:${m[7].slice(3)}`)
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`
}

// Commands, built exactly like the Rust side builds them.
export const containerCommand = (verb: 'start' | 'stop' | 'restart', name: string) => `docker ${verb} ${q(name)}`

export function composeCommand(project: string, files: string[], workingDir: string | null, action: ComposeAction) {
  const base = `docker compose -p ${project}${files.map((f) => ` -f ${q(f)}`).join('')}`
  const run = { up: `${base} up -d`, pullUp: `${base} pull && ${base} up -d`, restart: `${base} restart`, down: `${base} down` }[action]
  return workingDir ? `cd ${q(workingDir)} && ${run}` : run
}

export const pruneCommand = (all: boolean) => (all ? 'docker image prune -a -f' : 'docker image prune -f')

export const volumeRemoveCommand = (name: string) => `docker volume rm ${q(name)}`

/** Compose projects from their containers' labels. */
export type Project = {
  name: string
  files: string[]
  /** The compose files are on the server, so compose commands can run. */
  found: boolean
  workingDir: string | null
  containers: Container[]
}

export function projectsOf(containers: Container[]): Project[] {
  const map = new Map<string, Project>()
  for (const c of containers) {
    if (!c.project) continue
    const p = map.get(c.project) ?? { name: c.project, files: c.configFiles, found: c.configFound, workingDir: c.workingDir, containers: [] }
    p.containers.push(c)
    map.set(c.project, p)
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Group chip: "4/4 đang chạy · 1 job xong", red when something failed. */
export function projectStatus(list: Container[]): { tone: Tone; label: string } {
  const jobs = list.filter(isFinishedJob)
  const svc = list.filter((c) => !isFinishedJob(c))
  const running = svc.filter((c) => c.state === 'running').length
  const bad = svc.some((c) => c.state === 'restarting' || c.state === 'dead' || (c.state === 'exited' && !stoppedOnPurpose(c)))
  const warn = svc.some((c) => c.health === 'unhealthy') || running < svc.length
  const label = `${running}/${svc.length} đang chạy${jobs.length ? ` · ${jobs.length} job xong` : ''}`
  return { tone: bad ? TONES.danger : warn ? TONES.warn : TONES.success, label }
}

/** Log level told from the words in a line; none when it says nothing. */
export function logLevel(text: string): 'ERROR' | 'WARN' | null {
  if (/\b(error|err|fatal|panic|crit(ical)?|emerg(ency)?|exception)\b/i.test(text)) return 'ERROR'
  if (/\b(warn(ing)?)\b/i.test(text)) return 'WARN'
  return null
}
