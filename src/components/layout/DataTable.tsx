import { useState, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { tv } from '@/lib/tv'
import { Caret } from '@/components/ui/Caret'
import { useApp } from '@/store/appStore'

/**
 * Servers, SSH Keys, Tunnels, Known hosts and the SFTP file list are the same
 * table with different grid templates. One component drives all five, so the
 * header style, row dividers, hover and selected states have a single
 * definition instead of five copies that drift.
 *
 * Only Servers is virtualised (70 rows, README line 48). The others are 4-9
 * rows and don't earn the machinery.
 */

export interface Column<T> {
  key: string
  header?: ReactNode
  /** Cell classes — colour, font, alignment. */
  className?: string
  /**
   * Header classes. Kept separate from `className` on purpose: a cell's font
   * and colour must not leak into the heading, which gets its look from
   * `table-head` on the row.
   */
  headerClassName?: string
  /** Clicking the heading cycles this column: asc → desc → unsorted. */
  sortable?: boolean
  render: (row: T, index: number) => ReactNode
}

export interface SortState {
  key: string
  dir: 'asc' | 'desc'
}

const rowStyles = tv({
  base: 'group grid w-full items-center gap-2.5 border-b border-w03 text-left transition-colors',
  variants: {
    density: {
      default: 'px-5 py-2.75 text-body', // 11px 20px — Servers, Known hosts
      relaxed: 'px-5 py-3 text-body', // 12px 20px — SSH Keys, Tunnels
      compact: 'px-3 py-1.5 font-mono text-cell text-fg-2', // 6px 12px — SFTP files
    },
    interactive: { true: 'cursor-pointer hover:bg-w04', false: '' },
    selected: { true: 'bg-w07', false: '' },
    /**
     * Settings › Row density, on top of whatever the screen asked for.
     *
     * A second axis rather than more `density` values: the three above say
     * what *kind* of table this is — a file list is tighter than a host list
     * for a reason, and that relationship has to survive the preference. So
     * this axis holds no padding of its own; each pairing is spelled out
     * below, and each one is a step up from where that table already was.
     */
    roomy: { true: '', false: '' },
  },
  compoundVariants: [
    // One step of air per table, not one height for all of them. A flat
    // `py-4` would have made the SFTP list, the host list and the tunnel
    // list identical — which is the distinction this is meant to keep.
    { density: 'compact', roomy: true, class: 'py-2.5' },
    { density: 'default', roomy: true, class: 'py-4' },
    { density: 'relaxed', roomy: true, class: 'py-4.25' },
  ],
  defaultVariants: { density: 'default', interactive: true, selected: false, roomy: false },
})

const headStyles = tv({
  base: 'table-head grid flex-none gap-2.5 border-b border-w06',
  variants: {
    density: {
      default: 'px-5 py-2.5', // 10px 20px
      relaxed: 'px-5 py-2.5',
      compact: 'px-3 py-1.5', // 6px 12px
    },
  },
  defaultVariants: { density: 'default' },
})

type Density = 'default' | 'relaxed' | 'compact'

interface Props<T> {
  rows: T[]
  columns: Column<T>[]
  /** e.g. `12px 2.1fr 1.5fr 96px 104px 100px 68px 118px` */
  gridTemplate: string
  rowKey: (row: T, index: number) => string
  density?: Density
  virtualized?: boolean
  onRowClick?: (row: T, index: number) => void
  /** Right-click on a row. The event carries the point the menu opens at. */
  onRowContextMenu?: (row: T, event: React.MouseEvent) => void
  isSelected?: (row: T, index: number) => boolean
  /**
   * Extra classes for one row. The `selected` variant above is shared with
   * every table in the app, so a screen that needs its own emphasis — the
   * tunnel map's selected line and its row have to look like the same thing —
   * adds it here instead of changing what selection means everywhere.
   */
  rowClassName?: (row: T, index: number) => string
  /** Approximate row height; the virtualiser measures the real one after mount. */
  estimateRowHeight?: number
  emptyMessage?: string
  /** Current sort, or null when unsorted. Sorting itself is the caller's job. */
  sort?: SortState | null
  onToggleSort?: (key: string) => void
}

export function DataTable<T>({
  rows,
  columns,
  gridTemplate,
  rowKey,
  density = 'default',
  virtualized = false,
  onRowClick,
  onRowContextMenu,
  isSelected,
  rowClassName,
  estimateRowHeight = 38,
  emptyMessage,
  sort,
  onToggleSort,
}: Props<T>) {
  // State rather than a ref: the virtualiser has to re-run once the scroll
  // container exists, and a ref assignment alone doesn't trigger a render.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)

  // Read here rather than passed in by each of the five screens: a preference
  // that four tables honour and the fifth forgets is a bug waiting to be
  // filed, and there is nothing a caller could usefully decide about it.
  const roomy = useApp((s) => s.settings.density) === 'cozy'

  const cells = (row: T, index: number) =>
    columns.map((column) => (
      <span key={column.key} className={column.className}>
        {column.render(row, index)}
      </span>
    ))

  const rowProps = (row: T, index: number) => ({
    style: { gridTemplateColumns: gridTemplate },
    className: rowStyles({
      density,
      roomy,
      interactive: !!onRowClick,
      selected: isSelected?.(row, index) ?? false,
      className: rowClassName?.(row, index),
    }),
    onClick: onRowClick ? () => onRowClick(row, index) : undefined,
    onContextMenu: onRowContextMenu
      ? (e: React.MouseEvent) => {
          // The app suppresses the native menu globally; this stops the row's
          // own handler from also being read as a plain click.
          e.preventDefault()
          e.stopPropagation()
          // WebKit selects the word under a right-click even through
          // `user-select: none`, which leaves the filename highlighted behind
          // the menu as though it were being edited.
          window.getSelection()?.removeAllRanges()
          onRowContextMenu(row, e)
        }
      : undefined,
  })

  return (
    <>
      <div style={{ gridTemplateColumns: gridTemplate }} className={headStyles({ density })}>
        {columns.map((column) => {
          const sorted = sort?.key === column.key ? sort : null

          if (!column.sortable || !onToggleSort) {
            return (
              <span key={column.key} className={column.headerClassName}>
                {column.header}
              </span>
            )
          }

          return (
            <button
              key={column.key}
              type="button"
              onClick={() => onToggleSort(column.key)}
              aria-sort={sorted ? (sorted.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
              // The UA stylesheet resets `text-transform` and `letter-spacing`
              // on form controls, so a <button> does not inherit `table-head`
              // the way the plain <span> headings do. Restate them here.
              className={`group/sort flex items-center gap-1 text-label font-medium tracking-head uppercase transition-colors hover:text-fg-2 ${
                sorted ? 'text-fg-2' : ''
              } ${column.headerClassName ?? ''}`}
            >
              {column.header}
              {/* Only the sorted column shows its caret at rest; the others
                  surface one on hover so the header stays quiet. */}
              <Caret
                direction={sorted?.dir === 'asc' ? 'up' : 'down'}
                className={
                  sorted ? 'text-accent' : 'opacity-0 group-hover/sort:opacity-60'
                }
              />
            </button>
          )
        })}
      </div>

      <div ref={setScrollEl} className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 && emptyMessage ? (
          <div className="px-4 py-6 font-mono text-mono text-faint">{emptyMessage}</div>
        ) : virtualized && scrollEl ? (
          <VirtualRows
            scrollEl={scrollEl}
            rows={rows}
            rowKey={rowKey}
            estimateRowHeight={estimateRowHeight}
            renderRow={(row, index) => (
              <div {...rowProps(row, index)}>{cells(row, index)}</div>
            )}
          />
        ) : (
          rows.map((row, index) => (
            <div key={rowKey(row, index)} {...rowProps(row, index)}>
              {cells(row, index)}
            </div>
          ))
        )}
      </div>
    </>
  )
}

function VirtualRows<T>({
  scrollEl,
  rows,
  rowKey,
  estimateRowHeight,
  renderRow,
}: {
  scrollEl: HTMLDivElement
  rows: T[]
  rowKey: (row: T, index: number) => string
  estimateRowHeight: number
  renderRow: (row: T, index: number) => ReactNode
}) {
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => estimateRowHeight,
    overscan: 8,
  })

  return (
    <div style={{ height: virtualizer.getTotalSize() }} className="relative w-full">
      {virtualizer.getVirtualItems().map((item) => (
        <div
          key={rowKey(rows[item.index], item.index)}
          ref={virtualizer.measureElement}
          data-index={item.index}
          className="absolute top-0 left-0 w-full"
          style={{ transform: `translateY(${item.start}px)` }}
        >
          {renderRow(rows[item.index], item.index)}
        </div>
      ))}
    </div>
  )
}
