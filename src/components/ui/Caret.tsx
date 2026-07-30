/**
 * The solid triangle used wherever something points: a Select's trigger and a
 * sortable table header.
 *
 * Drawn rather than set as a `⌄` glyph — at this size a glyph is a thin stroke
 * that reads as punctuation, its metrics shift between fonts, and it cannot be
 * rotated cleanly. `direction` animates as a real 180° turn, so the motion has
 * a direction instead of flipping.
 */
export function Caret({
  direction = 'down',
  className = '',
}: {
  direction?: 'up' | 'down'
  className?: string
}) {
  return (
    <svg
      width="8"
      height="5"
      viewBox="0 0 8 5"
      aria-hidden
      className={`flex-none transition-all duration-180 ease-out ${
        direction === 'up' ? 'rotate-180' : ''
      } ${className}`}
    >
      <path d="M0 0h8L4 5z" fill="currentColor" />
    </svg>
  )
}
