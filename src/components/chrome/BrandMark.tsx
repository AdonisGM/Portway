/**
 * The app's mark, the same drawing `src-tauri/app-icon.svg` generates every
 * platform icon from: a prompt chevron and a block cursor on the 4px grid.
 *
 * Inline rather than an `<img>` because it is in the first paint — the titlebar
 * is drawn before anything has been fetched, and a mark that arrives a frame
 * late is a mark that visibly pops in.
 *
 * The gradient id is fixed rather than generated. One titlebar exists per
 * window, and a duplicate id would only matter if two of these were on screen
 * at once, which the layout does not allow.
 */
export function BrandMark({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={className} shapeRendering="crispEdges">
      <defs>
        <linearGradient id="portway-mark" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="32" y2="32">
          {/* Literal rather than `var(--color-accent)`: `stop-color` is a
              presentation attribute, and custom properties do not resolve in
              those. The middle stop is the default accent's exact value, and
              the mark stays that green when the accent is changed — a logo is
              not chrome, and the platform icons cannot follow a setting
              either. */}
          <stop offset="0" stopColor="#8CE6A8" />
          <stop offset="0.55" stopColor="#5EC8B0" />
          <stop offset="1" stopColor="#2C8F76" />
        </linearGradient>
      </defs>
      <g fill="url(#portway-mark)">
        <rect x="2" y="4" width="8" height="4" />
        <rect x="6" y="8" width="8" height="4" />
        <rect x="10" y="12" width="8" height="8" />
        <rect x="6" y="20" width="8" height="4" />
        <rect x="2" y="24" width="8" height="4" />
        <rect x="22" y="8" width="8" height="16" />
      </g>
    </svg>
  )
}
