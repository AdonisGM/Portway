import type { HttpPair, HttpRequest } from '../../lib/api'

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const

export const METHOD_COLOR: Record<string, string> = {
  GET: 'var(--success)',
  POST: 'var(--warn)',
  PUT: 'var(--info)',
  PATCH: 'var(--info)',
  DELETE: 'var(--danger)',
  HEAD: 'var(--muted)',
  OPTIONS: 'var(--muted)',
}

/** Reason phrases for HTTP/2, which sends none. */
const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
}

export const reasonOf = (status: number, reason: string) => reason || REASONS[status] || ''

export const statusColor = (s: number) => (s === 0 ? 'var(--danger)' : s < 300 ? 'var(--success)' : s < 400 ? 'var(--info)' : s < 500 ? 'var(--warn)' : 'var(--danger)')

export function newRequest(url = ''): HttpRequest {
  return {
    method: 'GET',
    url,
    headers: [],
    body: { kind: 'none' },
    auth: { kind: 'none' },
    options: { followRedirects: true, insecure: false, timeoutSecs: 30, connectTo: '', compressed: true },
  }
}

/** Query string of a URL as rows, and back. The fragment stays where it is. */
export function paramsOf(url: string): HttpPair[] {
  const q = url.split('#')[0].split('?').slice(1).join('?')
  if (!q) return []
  return q.split('&').map((part) => {
    const [k, ...v] = part.split('=')
    const dec = (s: string) => {
      try {
        return decodeURIComponent(s.replace(/\+/g, ' '))
      } catch {
        return s
      }
    }
    return { name: dec(k), value: dec(v.join('=')), enabled: true }
  })
}

export function withParams(url: string, params: HttpPair[]): string {
  const [beforeHash, ...hash] = url.split('#')
  const base = beforeHash.split('?')[0]
  const q = params
    .filter((p) => p.enabled && p.name)
    .map((p) => `${encodeURIComponent(p.name)}${p.value !== '' ? `=${encodeURIComponent(p.value)}` : ''}`)
    .join('&')
  return base + (q ? `?${q}` : '') + (hash.length ? `#${hash.join('#')}` : '')
}

/** Path and query of a URL, for the history list. */
export function shortUrl(url: string) {
  const m = /^[a-z]+:\/\/([^/]+)(.*)$/i.exec(url)
  return m ? `${m[1]}${m[2] || '/'}` : url
}

export function prettyJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return null
  }
}

export const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`)
