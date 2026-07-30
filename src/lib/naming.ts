/**
 * Labels are unique — enforced by a unique index on `hosts.name`. Duplicate
 * therefore has to pick a name that is free rather than blindly appending.
 *
 * `web-01.prod` → `web-01.prod 2`, and duplicating that gives `web-01.prod 3`
 * rather than `web-01.prod 2 2`. Mirrors `next_free_name` in `db.rs`, which the
 * migration uses to renumber databases written before the constraint existed.
 */
export function nextCopyName(name: string, taken: Set<string>): string {
  const { base, start } = splitTrailingNumber(name)
  let n = start
  while (taken.has(`${base} ${n}`)) n += 1
  return `${base} ${n}`
}

function splitTrailingNumber(name: string): { base: string; start: number } {
  const trimmed = name.trim()
  const match = /^(.*\S)\s+(\d+)$/.exec(trimmed)
  if (match) {
    const parsed = Number(match[2])
    if (Number.isSafeInteger(parsed)) {
      return { base: match[1], start: Math.max(parsed + 1, 2) }
    }
  }
  return { base: trimmed, start: 2 }
}
