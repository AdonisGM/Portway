import { GROUP_IDS, GROUP_NAMES } from '@/data/groups'
import type { Host } from '@/data/types'
import { tokenizeQuery, type QualifierSpec } from './query'

/**
 * The Servers filter grammar.
 *
 * A bare word matches the **host name** only — that is the common case and the
 * one worth making cheap. Anything else is asked for explicitly:
 * `addr:10.20 user:deploy`. Several words are combined with AND.
 */

/** Values come from the live host list, so the suggestions reflect real data. */
export function hostQualifiers(hosts: Host[]): QualifierSpec[] {
  const unique = (values: string[]) => [...new Set(values)].sort()

  return [
    {
      key: 'addr',
      aliases: ['address', 'ip'],
      label: 'Address',
      hint: 'addr:10.20',
      values: unique(hosts.map((h) => h.address)),
    },
    {
      key: 'user',
      label: 'Username',
      hint: 'user:deploy',
      values: unique(hosts.map((h) => h.user)),
    },
    {
      key: 'group',
      aliases: ['env'],
      label: 'Group',
      hint: 'group:prod',
      values: GROUP_IDS.slice(),
    },
    {
      key: 'auth',
      label: 'Auth method',
      hint: 'auth:key',
      values: ['key', 'password', 'agent'],
    },
    {
      key: 'port',
      label: 'Port',
      hint: 'port:2222',
      values: unique(hosts.map((h) => String(h.port))),
    },
    {
      key: 'tag',
      aliases: ['tags'],
      label: 'Tag',
      hint: 'tag:backup',
      values: unique(hosts.flatMap((h) => h.tags)),
    },
    {
      key: 'host',
      aliases: ['name'],
      label: 'Host name',
      hint: 'the default',
      values: unique(hosts.map((h) => h.name)),
    },
  ]
}

/** The field a qualifier reads, lower-cased and ready for a substring test. */
function field(host: Host, key: string): string {
  switch (key) {
    case 'addr':
      return `${host.address}:${host.port}`.toLowerCase()
    case 'user':
      return host.user.toLowerCase()
    case 'group':
      // Both `group:prod` and `group:production` should work.
      return `${host.group} ${GROUP_NAMES[host.group]}`.toLowerCase()
    case 'auth':
      // The table prints `pass`, the data says `password`; accept either.
      return host.auth === 'password' ? 'password pass' : host.auth
    case 'port':
      return String(host.port)
    case 'tag':
      // Joined with a separator no tag can contain, so `tag:db` cannot be
      // satisfied by `web` and `data` sitting next to each other.
      return host.tags.join(',').toLowerCase()
    case 'host':
      return host.name.toLowerCase()
    default:
      return ''
  }
}

export interface HostFilterFn {
  (host: Host): boolean
}

/**
 * Builds a predicate from the raw query string. Unrecognised `foo:bar` falls
 * back to a plain term, matching the host name — the grammar stays forgiving
 * rather than erroring at the user.
 */
export function buildHostFilter(query: string, qualifiers: QualifierSpec[]): HostFilterFn {
  const tokens = tokenizeQuery(query, qualifiers)
  if (tokens.length === 0) return () => true

  const terms = tokens.filter((t) => t.kind === 'text').map((t) => t.value.toLowerCase())
  const pairs = tokens
    .filter((t) => t.kind === 'qualifier' && t.value !== '')
    .map((t) => ({ key: t.key!, value: t.value.toLowerCase() }))

  return (host) => {
    for (const term of terms) {
      if (!host.name.toLowerCase().includes(term)) return false
    }
    for (const pair of pairs) {
      if (!field(host, pair.key).includes(pair.value)) return false
    }
    return true
  }
}
