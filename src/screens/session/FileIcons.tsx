/**
 * File-type glyphs for the SFTP table.
 *
 * Same construction as the nav icons: a 16-unit viewBox drawn at 14px with a
 * 1.3 stroke in `currentColor`, so a row's hover and selection colours carry
 * the icon without a second rule.
 *
 * Deliberately monochrome. Colouring by file type is the obvious idea and the
 * wrong one here — this design says status in coloured dots and nothing else,
 * and a rainbow of extensions in a pane that already has a group dot, an accent
 * cursor and a transfer bar would be the loudest thing on the screen. The shape
 * does the distinguishing; the colour stays the row's.
 *
 * The set is small on purpose: what actually turns up on a server. Everything
 * unrecognised is a plain document, which is the honest answer.
 */

const COMMON = {
  width: 14,
  height: 14,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.3,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  className: 'flex-none',
  'aria-hidden': true,
} as const

function Folder() {
  return (
    <svg {...COMMON}>
      <path d="M2 12.5v-9h4l1.4 1.8H14v7.2a.8.8 0 0 1-.8.8H2.8a.8.8 0 0 1-.8-.8Z" />
    </svg>
  )
}

/** `..` — the way back up, drawn as a folder with the arrow inside it. */
function ParentFolder() {
  return (
    <svg {...COMMON}>
      <path d="M2 12.5v-9h4l1.4 1.8H14v7.2a.8.8 0 0 1-.8.8H2.8a.8.8 0 0 1-.8-.8Z" />
      <path d="M8 11V8M6.6 9.3 8 7.9l1.4 1.4" />
    </svg>
  )
}

/** The default: a sheet with a folded corner. */
function Document() {
  return (
    <svg {...COMMON}>
      <path d="M9.2 1.8H4.3a.8.8 0 0 0-.8.8v10.8a.8.8 0 0 0 .8.8h7.4a.8.8 0 0 0 .8-.8V5.2Z" />
      <path d="M9.2 1.8v3.4h3.3" />
    </svg>
  )
}

/** Config and text: a document with lines on it. */
function TextFile() {
  return (
    <svg {...COMMON}>
      <path d="M9.2 1.8H4.3a.8.8 0 0 0-.8.8v10.8a.8.8 0 0 0 .8.8h7.4a.8.8 0 0 0 .8-.8V5.2Z" />
      <path d="M9.2 1.8v3.4h3.3M5.6 8.4h4.8M5.6 10.8h3.2" />
    </svg>
  )
}

/** Anything meant to be run: a prompt chevron. */
function Script() {
  return (
    <svg {...COMMON}>
      <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.2" />
      <path d="M4.8 6.6 6.9 8.6l-2.1 2M8.8 11h2.6" />
    </svg>
  )
}

/** Archives: a box with a band down it. */
function Archive() {
  return (
    <svg {...COMMON}>
      <path d="M2 5.4 8 2.4l6 3v5.2l-6 3-6-3Z" />
      <path d="M8 8.4v5.2M2 5.4l6 3 6-3" />
    </svg>
  )
}

/** Images: a frame with a horizon and a sun. */
function Image() {
  return (
    <svg {...COMMON}>
      <rect x="2" y="3" width="12" height="10" rx="1.2" />
      <path d="m2.6 11 3.2-3.2 2.4 2.4 1.8-1.8 3.4 3.4" />
      <circle cx="10.4" cy="6" r="1.1" />
    </svg>
  )
}

/** Keys and certificates — the same glyph the nav uses for SSH Keys. */
function KeyFile() {
  return (
    <svg {...COMMON}>
      <circle cx="5.4" cy="5.4" r="2.9" />
      <path d="M7.5 7.5 13 13M10.4 10.4l-1.5 1.5M12 12l-1.2 1.2" />
    </svg>
  )
}

/** Logs: a document with a rule under a heading. */
function LogFile() {
  return (
    <svg {...COMMON}>
      <path d="M9.2 1.8H4.3a.8.8 0 0 0-.8.8v10.8a.8.8 0 0 0 .8.8h7.4a.8.8 0 0 0 .8-.8V5.2Z" />
      <path d="M9.2 1.8v3.4h3.3M5.6 8.4h1.6M8.4 8.4h2M5.6 10.8h1.2M8 10.8h2.4" />
    </svg>
  )
}

const BY_EXTENSION: Record<string, () => React.JSX.Element> = {
  // text and configuration
  txt: TextFile, md: TextFile, conf: TextFile, cfg: TextFile, ini: TextFile,
  yml: TextFile, yaml: TextFile, toml: TextFile, json: TextFile, xml: TextFile,
  env: TextFile, properties: TextFile,
  // things that run
  sh: Script, bash: Script, zsh: Script, fish: Script, py: Script, rb: Script,
  pl: Script, service: Script,
  // archives
  gz: Archive, tgz: Archive, zip: Archive, tar: Archive, bz2: Archive,
  xz: Archive, zst: Archive, rar: Archive, '7z': Archive,
  // images
  png: Image, jpg: Image, jpeg: Image, gif: Image, svg: Image, webp: Image,
  ico: Image, bmp: Image,
  // secrets
  pem: KeyFile, key: KeyFile, crt: KeyFile, cer: KeyFile, pub: KeyFile,
  p12: KeyFile, pfx: KeyFile,
  // logs
  log: LogFile,
}

/** Names that carry their type without an extension — common on a server. */
const BY_NAME: Record<string, () => React.JSX.Element> = {
  dockerfile: Script,
  makefile: Script,
  authorized_keys: KeyFile,
  known_hosts: KeyFile,
  id_rsa: KeyFile,
  id_ed25519: KeyFile,
  config: TextFile,
  readme: TextFile,
  license: TextFile,
  '.bashrc': Script,
  '.profile': Script,
  '.gitignore': TextFile,
}

export function FileIcon({ name, kind }: { name: string; kind: 'dir' | 'file' }) {
  if (name === '..') return <ParentFolder />
  if (kind === 'dir') return <Folder />

  const lower = name.toLowerCase()
  const byName = BY_NAME[lower]
  if (byName) return byName()

  // `.` in the last position, or a leading dot with nothing after it, is not an
  // extension — `archive.` and `.bashrc` must not resolve to `` and `bashrc`.
  const dot = lower.lastIndexOf('.')
  const ext = dot > 0 && dot < lower.length - 1 ? lower.slice(dot + 1) : ''
  const Icon = BY_EXTENSION[ext] ?? Document
  return <Icon />
}
