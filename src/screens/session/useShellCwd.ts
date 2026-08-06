import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { sshCwd } from '@/lib/api'

/**
 * The directory the session's shell is in, when the shell says so.
 *
 * Read out of the shell's own output rather than asked for. There is no way to
 * learn an interactive shell's working directory without its cooperation, and
 * every form of asking is worse than listening: typing a command lands it in
 * whatever program happens to be running — `vim`, `less`, a password prompt —
 * and rewriting `PROMPT_COMMAND` behind the user's back changes their shell to
 * suit the app.
 *
 * So the backend watches for OSC 7, the sequence a shell uses to announce where
 * it is, and this carries it to the pane. `null` means the shell has not said,
 * which is a state the UI has to show rather than paper over: it is the
 * difference between "the terminal is at /var/log" and "this shell does not
 * announce, and here is how to make it".
 */
export function useShellCwd(sessionId: string): string | null {
  const [cwd, setCwd] = useState<string | null>(null)

  useEffect(() => {
    // A session id is not reused, but a pane can be rebuilt onto a different
    // one — starting from null keeps the previous shell's folder from being
    // shown as this one's.
    setCwd(null)
    let live = true

    const unsub = listen<{ sessionId: string; path: string }>('ssh://cwd', (e) => {
      if (e.payload.sessionId !== sessionId) return
      setCwd(e.payload.path)
    })

    // Then ask what was announced before this pane existed. Switching tabs
    // destroys the SFTP pane and builds a new one, and the announcements it
    // missed do not come again: a shell says the same directory before every
    // prompt and only a change is emitted, so a pane that only listened would
    // sit at "the shell has not said" until the user happened to `cd`
    // somewhere new — and would offer to install a hook they already have.
    // Same shape as `sshBus`: replay what was missed, then stream.
    void sshCwd(sessionId)
      .then((found) => {
        if (!live || found === null) return
        // Never over an announcement that has already arrived: this answer was
        // true when it was asked for, and that one is true now.
        setCwd((current) => current ?? found)
      })
      .catch(() => {})

    return () => {
      live = false
      void unsub.then((un) => un())
    }
  }, [sessionId])

  return cwd
}
