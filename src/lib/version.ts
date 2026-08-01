import { useEffect, useState } from 'react'
import { inTauri } from './tauri'

/**
 * The version the bundle was actually built with, asked of the app rather than
 * baked in at compile time — `tauri.conf.json` is the one place it is written,
 * and anything that copied it could disagree with the binary it labels.
 *
 * `null` until it arrives, and callers render nothing rather than a
 * placeholder that shifts: this is two words of chrome, and a version that
 * flickers in reads as a bug.
 */
export function useVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    if (!inTauri()) return
    let alive = true
    void import('@tauri-apps/api/app')
      .then(({ getVersion }) => getVersion())
      .then((v) => alive && setVersion(v))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  return version
}
