import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'

type ToastAction = { label: string; run: () => void }
type Toast = { title: string; detail?: string; actions?: ToastAction[] }

const ToastContext = createContext<((t: Toast) => void) | null>(null)

/** One toast at a time in the bottom-right corner, as in the design: title plus
 *  a monospace detail line (usually a command or a path). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const show = useCallback((t: Toast) => {
    clearTimeout(timer.current)
    setToast(t)
    timer.current = setTimeout(() => setToast(null), t.actions?.length ? 6500 : 4200)
  }, [])

  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && (
        <div
          role="status"
          className="fixed right-5 bottom-5 z-[70] flex max-w-[440px] flex-col gap-1.5 rounded-xl bg-tip-bg px-3.5 py-3 text-[12.5px] text-tip-fg shadow-pop"
        >
          <span className="font-semibold">{toast.title}</span>
          {toast.detail && <span className="font-mono text-[11.5px] leading-normal [overflow-wrap:anywhere] opacity-85">{toast.detail}</span>}
          {!!toast.actions?.length && (
            <div className="mt-0.5 flex gap-1.5">
              {toast.actions.map((a) => (
                <button
                  key={a.label}
                  type="button"
                  onClick={() => {
                    setToast(null)
                    a.run()
                  }}
                  className="cursor-pointer rounded-md border border-current bg-transparent px-2.5 py-0.5 text-[11.5px] text-inherit opacity-90"
                >
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </ToastContext.Provider>
  )
}

export function useToast() {
  const show = useContext(ToastContext)
  if (!show) throw new Error('useToast must be used inside <ToastProvider>')
  return show
}
