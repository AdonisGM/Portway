/**
 * Where each session's SFTP pane was last looking.
 *
 * `SessionScreen` renders only the active tab and keys the pane on the session,
 * so switching tabs destroys the pane and coming back builds a new one. The
 * terminal survives that because `sshBus` remembers its output and replays it;
 * the pane's *place* had nothing of the kind, so every tab switch dropped the
 * user back at the directory login lands in — three levels up from wherever
 * they were working, on a tab they had left thirty seconds ago.
 *
 * So the folder is remembered here, beside the output buffer and for the same
 * reason: a pane is not a stable place to keep something that belongs to the
 * session.
 *
 * Only the path. Whether that listing took root to read is deliberately not
 * kept — restoring it would mean a `sudo` command firing from a tab click,
 * against the pane's own rule that navigation never raises a password box. A
 * folder that is refused on return says so, and offers `Browse as root`, which
 * is the way in the pane already draws.
 */

const places = new Map<string, string>()

/** Called on every listing that came back, so the memory is always the truth. */
export function remember(sessionId: string, path: string): void {
  if (path) places.set(sessionId, path)
}

/** Empty means "wherever login lands", which is what a first listing asks for. */
export function placeOf(sessionId: string): string {
  return places.get(sessionId) ?? ''
}

/** Dropped with the session, as `sshBus.forget` drops its buffer. */
export function forget(sessionId: string): void {
  places.delete(sessionId)
}
