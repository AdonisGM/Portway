/** Distro badge: first letter on the distro's brand colour; "?" until the OS is
 *  detected on the first connection. */
const BADGES: Record<string, [string, string]> = {
  Ubuntu: ['U', '#E95420'],
  Debian: ['D', '#A81D33'],
  CentOS: ['C', '#932279'],
  Rocky: ['R', '#10B981'],
  AlmaLinux: ['A', '#0F4266'],
  Fedora: ['F', '#51A2DA'],
  Alpine: ['A', '#0D597F'],
  Arch: ['A', '#1793D1'],
}

export function osBadge(os: string | null | undefined) {
  const name = Object.keys(BADGES).find((n) => os?.startsWith(n))
  return name ? { letter: BADGES[name][0], bg: BADGES[name][1] } : { letter: '?', bg: 'var(--muted)' }
}

export function OsBadge({ os, size = 18 }: { os: string | null | undefined; size?: 18 | 22 }) {
  const b = osBadge(os)
  return (
    <span
      title={os ?? 'Chưa rõ hệ điều hành, sẽ tự nhận khi kết nối'}
      className="flex flex-none items-center justify-center leading-none font-bold text-white"
      style={{
        width: size,
        height: size,
        borderRadius: 5,
        fontSize: size === 22 ? 12 : 10,
        background: b.bg,
      }}
    >
      {b.letter}
    </span>
  )
}
