/**
 * A small GitHub-style filter grammar: bare words plus `key:value` qualifiers.
 *
 * Deliberately domain-agnostic — it knows nothing about hosts. Callers hand it
 * a set of `QualifierSpec`s and get back positioned tokens, which is what both
 * the highlight overlay and the suggestion list need. The host-specific half
 * (which field each key reads, how a row is matched) lives in `hostQuery.ts`.
 */

export interface QualifierSpec {
  /** Canonical key, the one written back into the query. */
  key: string
  /** Alternative spellings accepted while typing. */
  aliases?: string[]
  label: string
  hint?: string
  /** Concrete values to offer after `key:`. The caller computes these. */
  values?: string[]
}

export interface QueryToken {
  start: number
  end: number
  kind: 'qualifier' | 'text'
  /** Canonical key — qualifier tokens only. */
  key?: string
  /** The literal `addr:` as typed, including the colon — qualifier tokens only. */
  prefix?: string
  /** Text after the colon, or the whole word for a plain term. */
  value: string
}

/** Maps every accepted spelling to its canonical key. */
export function keyLookup(specs: QualifierSpec[]): Map<string, QualifierSpec> {
  const map = new Map<string, QualifierSpec>()
  for (const spec of specs) {
    map.set(spec.key.toLowerCase(), spec)
    for (const alias of spec.aliases ?? []) map.set(alias.toLowerCase(), spec)
  }
  return map
}

/**
 * Splits on whitespace, keeping offsets so the overlay can paint the original
 * string. A `foo:bar` whose key is not in `specs` stays a plain term — the
 * grammar is forgiving, and an unrecognised prefix simply isn't highlighted.
 */
export function tokenizeQuery(text: string, specs: QualifierSpec[]): QueryToken[] {
  const lookup = keyLookup(specs)
  const tokens: QueryToken[] = []
  const word = /\S+/g
  let match: RegExpExecArray | null

  while ((match = word.exec(text)) !== null) {
    const raw = match[0]
    const start = match.index
    const end = start + raw.length
    const colon = raw.indexOf(':')

    if (colon > 0) {
      const spec = lookup.get(raw.slice(0, colon).toLowerCase())
      if (spec) {
        tokens.push({
          start,
          end,
          kind: 'qualifier',
          key: spec.key,
          prefix: raw.slice(0, colon + 1),
          value: raw.slice(colon + 1),
        })
        continue
      }
    }

    tokens.push({ start, end, kind: 'text', value: raw })
  }

  return tokens
}

/**
 * The token the caret sits in. `end` is inclusive so that typing at the end of
 * a word still counts as being inside it; a caret in whitespace returns null,
 * which callers read as "offer the full key list".
 */
export function tokenAt(tokens: QueryToken[], caret: number): QueryToken | null {
  return tokens.find((t) => caret >= t.start && caret <= t.end) ?? null
}

export interface Replacement {
  text: string
  caret: number
}

/** Swaps the span a token occupies (or inserts at the caret) for new text. */
export function replaceRange(
  text: string,
  start: number,
  end: number,
  insert: string,
): Replacement {
  return { text: text.slice(0, start) + insert + text.slice(end), caret: start + insert.length }
}
