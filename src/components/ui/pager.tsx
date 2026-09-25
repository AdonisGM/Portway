// Ported from HomeUI (home/apps/web/src/components/ui/pager.tsx).
import { useMemo, type ReactNode } from 'react'
import { Button, cx } from './primitives'

export const pageCountOf = (total: number, size: number) => Math.max(1, Math.ceil(total / size))
export const clampPage = (page: number, total: number, size: number) => Math.min(Math.max(1, page), pageCountOf(total, size))

/** Shortened page list: first, last and a window around the current page, with
 *  gaps shown as an ellipsis. Zero-based. */
export function pageWindow(cur: number, pageCount: number): Array<number | '…'> {
  const near = new Set<number>([0, pageCount - 1, cur, cur - 1, cur + 1])
  if (cur <= 2) [1, 2, 3].forEach((n) => near.add(n))
  if (cur >= pageCount - 3) [2, 3, 4].forEach((n) => near.add(pageCount - n))
  const keep = [...near].filter((n) => n >= 0 && n < pageCount).sort((a, b) => a - b)
  const out: Array<number | '…'> = []
  for (const [i, n] of keep.entries()) {
    if (i > 0 && n - keep[i - 1] > 1) out.push('…')
    out.push(n)
  }
  return out
}

/** Table footer: what is showing, page size, then Previous / pages / Next.
 *  Pages count from 1. */
export function Pager({
  page,
  size,
  total,
  unit,
  onPage,
  onSize,
  sizes = [10, 20, 50],
  children,
}: {
  page: number
  size: number
  total: number
  /** What the table counts, e.g. "khoá", "server". */
  unit: string
  onPage: (p: number) => void
  /** Leave out for a fixed page size. */
  onSize?: (n: number) => void
  sizes?: number[]
  /** Replaces the text on the left. */
  children?: ReactNode
}) {
  const pageCount = pageCountOf(total, size)
  const cur = clampPage(page, total, size)
  const pages = useMemo(() => pageWindow(cur - 1, pageCount), [cur, pageCount])

  const from = total === 0 ? 0 : (cur - 1) * size + 1
  const to = Math.min(cur * size, total)

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line bg-raised px-4 py-2.5 first:border-t-0">
      <span className="mr-auto text-[11px] whitespace-nowrap text-muted">
        {children ?? `Hiển thị ${from} tới ${to} trong ${total} ${unit}`}
      </span>

      {/* Only offer page sizes when there is something to choose. */}
      {onSize && total > sizes[0] ? (
        <select
          value={size}
          onChange={(e) => onSize(Number(e.target.value))}
          title="Số dòng mỗi trang"
          className="h-7 cursor-pointer rounded-[7px] border border-line2 bg-surface px-1.5 text-[11.5px] text-ink2 outline-none"
        >
          {sizes.map((n) => (
            <option key={n} value={n}>
              {n} dòng
            </option>
          ))}
        </select>
      ) : null}

      <Button size="sm" disabled={cur === 1} onClick={() => onPage(cur - 1)}>
        Trước
      </Button>
      {pages.map((p, i) =>
        p === '…' ? (
          <span key={`gap${i}`} className="px-0.5 text-[12px] text-muted">
            …
          </span>
        ) : (
          <button
            key={p}
            type="button"
            onClick={() => onPage(p + 1)}
            className={cx(
              'num h-7 min-w-7 cursor-pointer rounded-[7px] border px-2 text-[12px] font-medium',
              p + 1 === cur ? 'border-accent bg-accent text-accent-fg' : 'border-line2 bg-surface text-ink2 hover:bg-sunken',
            )}
          >
            {p + 1}
          </button>
        ),
      )}
      <Button size="sm" disabled={cur === pageCount} onClick={() => onPage(cur + 1)}>
        Sau
      </Button>
    </div>
  )
}
