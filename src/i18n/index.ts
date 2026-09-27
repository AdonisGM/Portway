/**
 * UI language. Vietnamese is the source: every string is written in
 * Vietnamese at its call site and doubles as the key of its English
 * translation in `./en/*`. A key may carry a context after `#`
 * (`t('Tắt#firewall')`) when one Vietnamese word needs two English ones;
 * the context is never shown.
 *
 * `t` reads a module-level language, so it also works outside components
 * (format helpers, error messages). The root component re-renders the whole
 * tree when the language changes; see `src/App.tsx`.
 */
import { platformWords } from '../lib/platform'
import en from './en'

export type Lang = 'vi' | 'en'
export type Vars = Record<string, string | number>
/** A translation: text with `{name}` slots, or a function for plurals and grammar. */
export type Entry = string | ((v: Vars) => string)
export type Dict = Record<string, Entry>

const CACHE_KEY = 'portway.lang'

function cached(): Lang {
  try {
    return localStorage.getItem(CACHE_KEY) === 'en' ? 'en' : 'vi'
  } catch {
    return 'vi'
  }
}

let current: Lang = cached()
const listeners = new Set<() => void>()

export const getLang = () => current

export function setLang(lang: Lang) {
  if (lang === current) return
  current = lang
  document.documentElement.lang = lang
  try {
    localStorage.setItem(CACHE_KEY, lang)
  } catch {
    // Only saves a flash of the other language at the next launch.
  }
  listeners.forEach((l) => l())
}

/** For code that must re-run when the language changes (see useLang). */
export function onLangChange(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

const fill = (text: string, v?: Vars) => (v ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m)) : text)

/** The text for `vi` in the current language, with `{name}` slots filled from
 *  `v`. The words that differ on Windows (Keychain, Finder, ⌘…) are swapped in
 *  the text itself, never in the slot values. */
export function t(vi: string, v?: Vars): string {
  if (current === 'en') {
    const e = (en as Dict)[vi]
    if (e !== undefined) return typeof e === 'function' ? platformWords(e(v ?? {})) : fill(platformWords(e), v)
    if (import.meta.env.DEV) console.warn('[i18n] missing English for:', vi)
  }
  const hash = vi.indexOf('#')
  return fill(platformWords(hash > 0 ? vi.slice(0, hash) : vi), v)
}

/** Locale for numbers, dates and times. */
export const locale = () => (current === 'en' ? 'en-US' : 'vi-VN')

/** English plural helper: plural(n, 'item') → "1 item", "3 items". */
export const plural = (n: number | string, one: string, many = `${one}s`) => `${n} ${Number(n) === 1 ? one : many}`
