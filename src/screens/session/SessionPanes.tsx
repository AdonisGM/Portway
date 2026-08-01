import { useRef } from 'react'
import type { Session } from '@/data/types'
import { TerminalPane } from './TerminalPane'
import { SftpPane } from './SftpPane'
import { useSplit } from './useSplit'

/**
 * One session's two halves: terminal on the left, SFTP browser on the right,
 * with the draggable divider between them.
 *
 * Separate from `SessionScreen` because the tab strip is not part of a session
 * — it is part of *this* window having several. A session opened in a window of
 * its own has exactly one and draws no strip at all, and would otherwise
 * inherit a row of chrome offering to switch to tabs that cannot exist there.
 */
export function SessionPanes({ session, hint }: { session: Session; hint?: string }) {
  const body = useRef<HTMLDivElement>(null)
  const split = useSplit(body)

  return (
    <div ref={body} className="flex min-h-0 flex-1">
      {/* Keyed on the session so switching tabs gives each its own terminal
          instance rather than replaying one pane's scrollback into another. */}
      <TerminalPane key={session.id} session={session} hint={hint} />

      {/* The divider. Four pixels wide with a negative right margin, so it
          overlaps the SFTP pane's border and stays a hairline to look at
          while being a real target to hit. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the SFTP pane"
        tabIndex={0}
        onPointerDown={split.onPointerDown}
        onPointerMove={split.onPointerMove}
        onPointerUp={split.onPointerUp}
        onKeyDown={split.onKeyDown}
        // Three states, loudest last: accent while dragging, a quieter accent
        // once focused — WebKit treats the explicit focus() as focus-visible,
        // so a full-strength bar would linger after every click — and a plain
        // overlay on hover. `outline-none` because global.css only clears the
        // native ring for input/select/button, and a focusable div otherwise
        // gets WebKit's blue one straight through the app's own palette.
        className={`z-10 -mr-1 w-1 flex-none cursor-col-resize outline-none transition-colors focus-visible:bg-accent-27 ${
          split.dragging ? 'bg-accent' : 'hover:bg-w15'
        }`}
      />

      <SftpPane
        key={`${session.id}-sftp`}
        session={session}
        width={split.width}
        resizing={split.dragging}
      />
    </div>
  )
}
