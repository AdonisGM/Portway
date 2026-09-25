import { useEffect, useRef, useState } from 'react'
import { AdonisLockup, BUILD_DURATION_MS } from '@adonisgm/logo'

/** Splash shown on every app launch, modelled on home's: the logo builds once,
 *  holds for a beat, then fades out to reveal the UI.
 *
 *  It is removed at the later of two moments — the logo build finishing and the
 *  app being ready — plus a short hold. BUILD_DURATION_MS comes from the logo
 *  package so the timing stays in sync if the logo changes. */

const FADE_MS = 650
const HOLD_MS = 300

export function SplashScreen({ ready }: { ready: boolean }) {
  const [fading, setFading] = useState(false)
  const [gone, setGone] = useState(false)
  const startedAt = useRef(performance.now())

  useEffect(() => {
    if (!ready) return
    const waited = performance.now() - startedAt.current
    const hold = setTimeout(
      () => setFading(true),
      Math.max(0, BUILD_DURATION_MS - waited) + HOLD_MS,
    )
    return () => clearTimeout(hold)
  }, [ready])

  useEffect(() => {
    if (!fading) return
    const off = setTimeout(() => setGone(true), FADE_MS + 60)
    return () => clearTimeout(off)
  }, [fading])

  if (gone) return null

  return (
    <div
      aria-hidden={fading}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-bg"
      style={{
        transition: `opacity ${FADE_MS}ms ease`,
        opacity: fading ? 0 : 1,
        pointerEvents: fading ? 'none' : 'auto',
      }}
    >
      <div className="grain pointer-events-none absolute inset-0" style={{ opacity: 'var(--grain)' }} />

      <div className="relative flex w-full max-w-[320px] flex-col items-center gap-6.5 px-6">
        <AdonisLockup size={104} orientation="vertical" animate className="text-ink" />

        <div className="flex w-full flex-col items-center gap-0.5 border-t border-line pt-2.5">
          <span className="pt-1 text-[13px] font-semibold tracking-[0.02em] text-ink2">Portway</span>
          <span className="font-mono text-[11px] text-muted">Phiên bản {__APP_VERSION__}</span>
          <span className="font-mono text-[10px] text-muted">Bản dựng {__BUILD_ID__}</span>
          <span className="mt-2 text-[11px] text-muted">© 2026 AdonisGM</span>
        </div>
      </div>
    </div>
  )
}
