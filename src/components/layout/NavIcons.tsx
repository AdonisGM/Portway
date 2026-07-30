import type { Screen } from '@/store/appStore'

/**
 * The five nav glyphs, traced verbatim from the recoloured handoff
 * (`SSH Client.dc.html`, the nav rail). The first handoff had no icon set at
 * all — "actions are text labels, status is coloured dots" — so these are the
 * one place the design asks for drawing rather than typography.
 *
 * `stroke="currentColor"` is what makes them free: the nav item already swaps
 * between `text-fg` when active and `text-fg-2` when not, and the icon follows
 * without a second rule. The `.85` opacity is the design's, and keeps the glyph
 * a shade quieter than the label beside it.
 *
 * 16-unit viewBox drawn at 15px, stroke 1.3 — all three are the handoff's and
 * none of them is arbitrary: at 15px a 1.3 stroke lands just off a whole pixel,
 * which is what stops the horizontal runs in Tunnels and Settings from going
 * hard-edged while the curves stay soft.
 */

const COMMON = {
  width: 15,
  height: 15,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.3,
  strokeLinecap: 'round',
  className: 'flex-none opacity-85',
  'aria-hidden': true,
} as const

/** Two stacked rack units, each with its status LED. */
function ServersIcon() {
  return (
    <svg {...COMMON}>
      <rect x="2" y="2.5" width="12" height="4.5" rx="1.2" />
      <rect x="2" y="9" width="12" height="4.5" rx="1.2" />
      <path d="M4.4 4.75h.01M4.4 11.25h.01" />
    </svg>
  )
}

/** A key: bow on the left, two teeth off the shaft. */
function KeysIcon() {
  return (
    <svg {...COMMON}>
      <circle cx="5.4" cy="5.4" r="2.9" />
      <path d="M7.5 7.5 13 13M10.4 10.4l-1.5 1.5M12 12l-1.2 1.2" />
    </svg>
  )
}

/** Two arrows passing in opposite directions — a forwarded port each way. */
function TunnelsIcon() {
  return (
    <svg {...COMMON} strokeLinejoin="round">
      <path d="M2 5h9l-2.2-2.2M14 11H5l2.2 2.2" />
    </svg>
  )
}

/** A shield with a check: a host key that has been seen and trusted. */
function KnownHostsIcon() {
  return (
    <svg {...COMMON} strokeLinejoin="round">
      <path d="M8 2.2 13 4v4.2c0 3-2.1 4.7-5 5.6-2.9-.9-5-2.6-5-5.6V4l5-1.8Z" />
      <path d="M6 8l1.6 1.6L10.2 7" />
    </svg>
  )
}

/** Two sliders at different positions. */
function SettingsIcon() {
  return (
    <svg {...COMMON}>
      <path d="M2 4.5h4M9 4.5h5M2 11.5h5M10 11.5h4" />
      <circle cx="7.6" cy="4.5" r="1.7" />
      <circle cx="8.6" cy="11.5" r="1.7" />
    </svg>
  )
}

export const NAV_ICONS: Record<Screen, (() => React.JSX.Element) | undefined> = {
  servers: ServersIcon,
  keys: KeysIcon,
  tunnels: TunnelsIcon,
  known: KnownHostsIcon,
  settings: SettingsIcon,
  // Reached from Servers rather than the rail, so they never draw an icon.
  session: undefined,
  form: undefined,
}
