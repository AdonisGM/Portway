/**
 * A host's tags, as the row of chips the handoff draws (README §Drawer: `3px
 * 8px`, radius 4, mono 12.5 on `rgba(255,255,255,.13)`).
 *
 * One component for the table cell and the drawer, because they are the same
 * object seen twice and a tag that looks like a chip in one place and like text
 * in the other reads as two different things.
 *
 * `onPick` is what makes a chip a control. Without it these are labels — which
 * is what they are in a context with nothing to filter.
 */
export function TagChips({
  tags,
  onPick,
  className = '',
}: {
  tags: string[]
  /** Given a tag, narrows the list to it. Omit for a read-only row. */
  onPick?: (tag: string) => void
  className?: string
}) {
  if (tags.length === 0) {
    return <span className="text-faint">—</span>
  }

  return (
    <span className={`flex min-w-0 flex-wrap items-center gap-1.5 ${className}`}>
      {tags.map((tag) =>
        onPick ? (
          <button
            key={tag}
            type="button"
            // The chip sits inside a row that opens the drawer on click, and
            // filtering is not opening — the row must not also fire.
            onClick={(e) => {
              e.stopPropagation()
              onPick(tag)
            }}
            title={`Filter by ${tag}`}
            className="max-w-full cell-ellipsis rounded-chip bg-w13 px-2 py-0.75 font-mono text-mono text-fg-2 transition-colors hover:bg-w15 hover:text-fg"
          >
            {tag}
          </button>
        ) : (
          <span
            key={tag}
            className="max-w-full cell-ellipsis rounded-chip bg-w13 px-2 py-0.75 font-mono text-mono text-fg-2"
          >
            {tag}
          </span>
        ),
      )}
    </span>
  )
}
