/**
 * The favourite control that lives in the Servers table's 12px first column.
 *
 * The handoff uses plain glyphs for affordances and notes that substituting
 * icons is fine, so this is drawn as an SVG rather than a `★` character —
 * glyph metrics vary per font and this has to sit inside a 12px track.
 *
 * Visibility is the caller's business: the cell keeps it transparent until the
 * row is hovered, but a favourited host shows it at rest so favourites stay
 * identifiable without hovering every row.
 */
interface Props {
  active: boolean
  onToggle: () => void
  label: string
  className?: string
}

export function StarToggle({ active, onToggle, label, className = '' }: Props) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={(e) => {
        // Otherwise the click also selects the row and opens the drawer.
        e.stopPropagation()
        onToggle()
      }}
      className={`flex items-center justify-center transition-colors ${
        active ? 'text-accent hover:text-fg' : 'text-faint hover:text-fg'
      } ${className}`}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden>
        <path
          d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"
          fill={active ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth={active ? 0 : 2.4}
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}
