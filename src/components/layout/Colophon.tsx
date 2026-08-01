import { openUrl } from '@/lib/api'
import { useVersion } from '@/lib/version'

/**
 * Who made this and which build it is, at the foot of the rail.
 *
 * The link goes to the profile rather than the repository: the repository is
 * private, so a link to it is a 404 for everyone who is not signed in as its
 * owner — a broken link with an explanation nobody sees.
 *
 * A `<button>` and not an `<a href>`. In a webview an anchor navigates the app
 * itself, replacing the running window with a web page and no way back; the
 * URL has to go to the OS instead. The backend takes `https` and nothing else.
 */
const PROFILE = 'https://github.com/AdonisGM'

export function Colophon() {
  const version = useVersion()

  return (
    <span className="flex items-baseline gap-2">
      <span className="flex-none">©&nbsp;{new Date().getFullYear()}</span>
      <button
        type="button"
        onClick={() => void openUrl(PROFILE).catch(() => {})}
        title={PROFILE}
        className="cell-ellipsis text-left transition-colors hover:text-fg-2 hover:underline"
      >
        AdonisGM
      </button>
      {/* Absent until it arrives rather than a placeholder that shifts: this is
          two words of chrome, and a version that flickers in reads as a bug. */}
      {version ? <span className="ml-auto flex-none">v{version}</span> : null}
    </span>
  )
}
