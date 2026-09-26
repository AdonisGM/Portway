import { Server } from 'lucide-react'
import { t } from '../i18n'
import {
  siAlmalinux,
  siAlpinelinux,
  siArchlinux,
  siCentos,
  siDebian,
  siFedora,
  siFreebsd,
  siKalilinux,
  siLinux,
  siLinuxmint,
  siOpensuse,
  siRaspberrypi,
  siRedhat,
  siRockylinux,
  siUbuntu,
  type SimpleIcon,
} from 'simple-icons'

/** Distro logos from Simple Icons: the one exception to lucide, since lucide has
 *  no brand logos. Matched on the start of the detected OS name, e.g. "Ubuntu 24.04". */
const LOGOS: Array<[string, SimpleIcon]> = [
  ['ubuntu', siUbuntu],
  ['debian', siDebian],
  ['alpine', siAlpinelinux],
  ['centos', siCentos],
  ['rocky', siRockylinux],
  ['almalinux', siAlmalinux],
  ['fedora', siFedora],
  ['arch', siArchlinux],
  ['opensuse', siOpensuse],
  ['red hat', siRedhat],
  ['linux mint', siLinuxmint],
  ['kali', siKalilinux],
  ['raspbian', siRaspberrypi],
  ['freebsd', siFreebsd],
]

/** Relative luminance of a hex colour, 0 (black) to 1 (white). */
function luminance(hex: string) {
  const c = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

function logoFor(os: string | null | undefined): SimpleIcon | null {
  if (!os) return null
  const name = os.toLowerCase()
  // Any other detected OS still is Linux as far as Portway can tell.
  return LOGOS.find(([prefix]) => name.startsWith(prefix))?.[1] ?? siLinux
}

/** OS badge: the distro logo on its brand colour; a neutral server icon until
 *  the OS is detected on the first connection. */
export function OsBadge({ os, size = 18 }: { os: string | null | undefined; size?: 16 | 18 | 22 | 28 }) {
  const logo = logoFor(os)
  const glyph = Math.round(size * 0.62)
  const box = { width: size, height: size, borderRadius: size >= 22 ? 6 : 5 }

  if (!logo) {
    return (
      <span title={t('Chưa rõ hệ điều hành, sẽ tự nhận khi kết nối')} className="flex flex-none items-center justify-center bg-sunken text-muted" style={box}>
        <Server size={glyph} strokeWidth={2} />
      </span>
    )
  }

  // Very dark brand colours (AlmaLinux is black) would vanish on the dark
  // theme, and light ones (Tux yellow) need a dark glyph.
  const lum = luminance(logo.hex)
  const bg = lum < 0.02 ? 'var(--raised)' : `#${logo.hex}`
  const fg = lum > 0.5 ? '#111315' : '#ffffff'
  return (
    <span title={os ?? logo.title} className="flex flex-none items-center justify-center" style={{ ...box, background: bg }}>
      <svg viewBox="0 0 24 24" width={glyph} height={glyph} fill={fg} aria-hidden="true">
        <path d={logo.path} />
      </svg>
    </span>
  )
}
