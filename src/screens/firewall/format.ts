import { t } from '../../i18n'
import type { FwRule, FwRuleInput, Listen } from '../../lib/api'

/** "22" / "80,443" / "6000:6010" → ranges. */
export function ranges(ports: string): [number, number][] {
  return ports
    .split(',')
    .map((p) => p.trim().split(':').map(Number))
    .filter((p) => p.every((n) => Number.isInteger(n) && n > 0))
    .map((p) => [p[0], p[1] ?? p[0]] as [number, number])
}

/** Ports and protocol a rule opens, from its own port or its app profile. */
export function ruleTarget(r: FwRule): { ranges: [number, number][]; proto: string | null } | null {
  if (r.port) return { ranges: ranges(r.port), proto: r.proto }
  if (r.appPorts) {
    // "80,443/tcp" or "OpenSSH|22/tcp" style lists separated by "|".
    const parts = r.appPorts.split('|').map((x) => x.split('/'))
    return { ranges: parts.flatMap(([p]) => ranges(p)), proto: parts.every(([, pr]) => pr === parts[0][1]) ? (parts[0][1] ?? null) : null }
  }
  return null
}

const inRanges = (rs: [number, number][], port: number) => rs.some(([a, b]) => port >= a && port <= b)

/** An incoming rule letting traffic to this port through. */
export function allows(r: FwRule, port: number, proto: string) {
  if (r.route || r.direction !== 'in' || (r.action !== 'allow' && r.action !== 'limit') || r.to !== 'any') return false
  const target = ruleTarget(r)
  if (!target) return r.port == null && r.app == null // "allow from X": every port
  return inRanges(target.ranges, port) && (!target.proto || target.proto === proto)
}

/** Whether any rule opens the port to everyone (not just some sources). */
export const openToAll = (rules: FwRule[], port: number, proto: string) => rules.some((r) => allows(r, port, proto) && r.from === 'any')

export const isPublicBind = (l: Listen) => l.scope !== 'loopback'

export function ruleLabel(r: FwRule) {
  if (r.app) return r.app
  if (!r.port) return t('Mọi cổng')
  return `${r.port}${r.proto ? `/${r.proto}` : ''}`
}

/** Second line under the port: protocol, or what a UFW app profile / firewalld service opens. */
export function protoLabel(r: FwRule) {
  const kind = r.zone != null ? 'service' : 'app profile'
  if (r.app) return r.appPorts ? `${kind} → ${r.appPorts.split('|').join(', ')}` : kind
  return r.proto ? r.proto : r.port ? 'tcp+udp' : ''
}

// Labels are getters so they follow the current language.
export const ACTIONS: Record<FwRule['action'], { readonly label: string; fg: string; bg: string }> = {
  allow: {
    get label() {
      return t('Cho phép')
    },
    fg: 'var(--success)',
    bg: 'var(--success-soft)',
  },
  limit: {
    get label() {
      return t('Giới hạn')
    },
    fg: 'var(--info)',
    bg: 'var(--info-soft)',
  },
  deny: {
    get label() {
      return t('Chặn')
    },
    fg: 'var(--danger)',
    bg: 'var(--danger-soft)',
  },
  reject: {
    get label() {
      return t('Từ chối')
    },
    fg: 'var(--warn)',
    bg: 'var(--warn-soft)',
  },
  other: {
    get label() {
      return t('Khác')
    },
    fg: 'var(--ink2)',
    bg: 'var(--sunken)',
  },
}

export const BACKEND_LABELS = { ufw: 'UFW', firewalld: 'firewalld' } as const

export const sourceLabel = (from: string) => (from === 'any' ? t('Mọi nơi') : from)

/** The rule as the form edits it. */
export function toInput(r: FwRule): FwRuleInput {
  return {
    action: r.action === 'reject' || r.action === 'other' ? 'deny' : r.action,
    port: r.port ?? '',
    proto: r.proto === 'tcp' || r.proto === 'udp' ? r.proto : 'any',
    from: r.from === 'any' ? null : r.from,
    comment: r.comment,
  }
}

/** Form checks matching the Rust ones, with the message to show. */
export function portError(port: string, proto: string): string | undefined {
  const p = port.replace(/\s/g, '')
  if (!p) return undefined
  const ok = /^\d{1,5}(:\d{1,5})?(,\d{1,5}(:\d{1,5})?)*$/.test(p) && ranges(p).every(([a, b]) => a <= b && b <= 65535)
  if (!ok) return t('Cổng không hợp lệ (1–65535, dải dạng 6000:6010, nhiều cổng cách nhau bằng dấu phẩy)')
  if (proto === 'any' && /[:,]/.test(p)) return t('Dải cổng hoặc nhiều cổng cần chọn TCP hoặc UDP')
  return undefined
}

export function sourceError(from: string): string | undefined {
  const f = from.trim()
  if (!f) return undefined
  const [addr, prefix] = f.split('/')
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr)
  const isV4 = !!v4 && v4.slice(1).every((n) => Number(n) <= 255)
  const isV6 = !isV4 && /^[0-9a-fA-F:]+$/.test(addr) && addr.includes(':')
  if (!isV4 && !isV6) return t('Địa chỉ IP không hợp lệ')
  if (prefix != null && !(/^\d+$/.test(prefix) && Number(prefix) <= (isV4 ? 32 : 128))) return t('Độ dài mạng (sau dấu /) không hợp lệ')
  return undefined
}

const plain = (r: FwRule) => !r.route && r.direction === 'in' && !r.interface && r.to === 'any'

/** The earlier rule that already matches every connection this one would:
 *  UFW stops at the first match, so this rule never applies. */
export function shadowedBy(rules: FwRule[], i: number): number | null {
  const r = rules[i]
  const target = ruleTarget(r)
  if (!plain(r)) return null
  for (let j = 0; j < i; j++) {
    const e = rules[j]
    if (!plain(e) || e.from !== 'any') continue
    const et = ruleTarget(e)
    // "deny from X" style rules without ports cover every port.
    if (!et) {
      if (e.port == null && e.app == null) return j
      continue
    }
    if (!target) continue
    if (et.proto && et.proto !== target.proto) continue
    if (target.ranges.every(([a, b]) => et.ranges.some(([x, y]) => x <= a && b <= y))) return j
  }
  return null
}
