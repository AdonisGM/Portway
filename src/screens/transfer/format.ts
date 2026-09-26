import type { PaneSource } from '../../app/nav'
import { t } from '../../i18n'
import type { FileEntry, Server, TransferEnd } from '../../lib/api'

export const LOCAL_KEY = 'local'

export const sourceKey = (s: PaneSource) => (s.kind === 'local' ? LOCAL_KEY : `${s.serverId}|${s.user}`)

export function sourceOf(key: string): PaneSource {
  if (key === LOCAL_KEY) return { kind: 'local' }
  const i = key.indexOf('|')
  return { kind: 'remote', serverId: key.slice(0, i), user: key.slice(i + 1) }
}

export const sameSource = (a: PaneSource, b: PaneSource) => sourceKey(a) === sourceKey(b)

/** "Máy này" or "deploy@web-01". */
export function sourceName(s: PaneSource, byId: (id: string) => Server | undefined) {
  if (s.kind === 'local') return t('Máy này')
  return `${s.user}@${byId(s.serverId)?.name ?? s.serverId}`
}

/** Host part only, for the relay note: "Máy này" or "web-01". */
export function hostName(s: PaneSource, byId: (id: string) => Server | undefined) {
  return s.kind === 'local' ? t('Máy này') : (byId(s.serverId)?.name ?? s.serverId)
}

export function endOf(s: PaneSource, byId: (id: string) => Server | undefined): TransferEnd {
  return s.kind === 'local' ? { kind: 'local' } : { kind: 'remote', serverId: s.serverId, user: s.user, name: byId(s.serverId)?.name ?? s.serverId }
}

/** `name (1).ext`, `name (2).ext`… whichever is not taken; like the Rust side. */
export function uniqueName(name: string, taken: Set<string>) {
  if (!taken.has(name)) return name
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let n = 1; ; n++) {
    const next = `${stem} (${n})${ext}`
    if (!taken.has(next)) return next
  }
}

/** Breadcrumbs; a local path under the home folder starts at "~". */
export function crumbsOf(path: string, home: string | null) {
  if (home && (path === home || path.startsWith(home + '/'))) {
    const parts = path.slice(home.length).split('/').filter(Boolean)
    return [{ label: '~', path: home }, ...parts.map((p, i) => ({ label: p, path: `${home}/${parts.slice(0, i + 1).join('/')}` }))]
  }
  const parts = path.split('/').filter(Boolean)
  return [{ label: '/', path: '/' }, ...parts.map((p, i) => ({ label: p, path: '/' + parts.slice(0, i + 1).join('/') }))]
}

/** "~/Downloads" for a local path under the home folder. */
export function shortPath(path: string, home: string | null) {
  if (home && path === home) return '~'
  if (home && path.startsWith(home + '/')) return '~' + path.slice(home.length)
  return path
}

export const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p

/** What a copy of this entry would read: a file, a folder, or what a link points to. */
export const copyKind = (e: FileEntry) => (e.kind === 'link' ? e.targetKind : e.kind)
