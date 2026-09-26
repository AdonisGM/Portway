/** Last data read for each open session, kept outside the screens so switching
 *  between sessions shows it at once instead of loading again. Cleared when a
 *  session is disconnected. Memory only. */

type Entry = { data: unknown; at: number }

const cache = new Map<string, Entry>()

const sessionPrefix = (serverId: string, user: string) => `${serverId}|${user}|`

export function readCache<T>(serverId: string, user: string, name: string): { data: T; at: Date } | null {
  const e = cache.get(sessionPrefix(serverId, user) + name)
  return e ? { data: e.data as T, at: new Date(e.at) } : null
}

export function writeCache(serverId: string, user: string, name: string, data: unknown, at: Date) {
  cache.set(sessionPrefix(serverId, user) + name, { data, at: at.getTime() })
}

export function clearSessionCache(serverId: string, user: string) {
  const prefix = sessionPrefix(serverId, user)
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k)
}
