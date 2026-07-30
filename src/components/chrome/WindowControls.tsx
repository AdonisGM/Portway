import { useEffect, useState } from 'react'
import { appWindow, inTauri } from '@/lib/tauri'

/**
 * Windows caption buttons. 46x32 each (w-11.5) is the OS convention, so the
 * hit targets feel native even though the frame is ours — tauri.conf.json sets
 * decorations:false.
 *
 * These sit inside the titlebar's `data-tauri-drag-region`, the classic place
 * for clicks to be swallowed by the drag handler. It works because Tauri tests
 * the event target itself for the attribute, and a <button> child never
 * carries it.
 */

function Minimize() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

function Maximize() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

function Restore() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <path d="M2.5 2.5V0.5h7v7h-2" fill="none" stroke="currentColor" strokeWidth="1" />
      <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

function Close() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

export function WindowControls() {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!inTauri()) return
    let alive = true

    const sync = async () => {
      const win = await appWindow()
      const value = await win?.isMaximized()
      if (alive && value !== undefined) setMaximized(value)
    }
    void sync()

    // The window can also be maximised by snapping or by double-clicking the
    // bar, so track resize rather than only our own button.
    const pending = appWindow().then((win) => win?.onResized(() => void sync()))
    return () => {
      alive = false
      void pending.then((un) => un?.())
    }
  }, [])

  const base =
    'flex h-titlebar w-11.5 flex-none items-center justify-center text-muted transition-colors'

  const act = (fn: (win: NonNullable<Awaited<ReturnType<typeof appWindow>>>) => unknown) => () => {
    void appWindow().then((win) => win && fn(win))
  }

  return (
    <div className="flex flex-none items-stretch">
      <button
        type="button"
        aria-label="Minimize"
        onClick={act((w) => w.minimize())}
        className={`${base} hover:bg-w06 hover:text-fg`}
      >
        <Minimize />
      </button>
      <button
        type="button"
        aria-label={maximized ? 'Restore' : 'Maximize'}
        onClick={act((w) => w.toggleMaximize())}
        className={`${base} hover:bg-w06 hover:text-fg`}
      >
        {maximized ? <Restore /> : <Maximize />}
      </button>
      <button
        type="button"
        aria-label="Close"
        onClick={act((w) => w.close())}
        className={`${base} hover:bg-danger hover:text-ink`}
      >
        <Close />
      </button>
    </div>
  )
}
