import { cx } from './primitives'

export type RowMenuItem = {
  label: string
  run: () => void
  /** Disabled with `why` shown under the label when false. */
  ok?: boolean
  why?: string
  danger?: boolean
}

/** The "⋯" button at the end of a table row and its menu. */
export function RowMenu({ open, setOpen, items }: { open: boolean; setOpen: (v: boolean) => void; items: RowMenuItem[] }) {
  return (
    <div className="relative">
      <button
        type="button"
        title="Thêm thao tác"
        onClick={() => setOpen(!open)}
        className="flex size-[26px] cursor-pointer items-center justify-center rounded-md border border-line2 text-[14px] leading-none hover:border-muted"
      >
        ⋯
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute top-[30px] right-0 z-40 flex min-w-[200px] flex-col rounded-lg border border-line bg-surface p-1 shadow-pop">
            {items.map((i) => {
              const ok = i.ok ?? true
              return (
                <button
                  key={i.label}
                  type="button"
                  disabled={!ok}
                  title={ok ? undefined : i.why}
                  onClick={() => {
                    setOpen(false)
                    i.run()
                  }}
                  className={cx(
                    'flex cursor-pointer flex-col rounded-md px-2.5 py-1.5 text-left hover:bg-raised disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent',
                    i.danger ? 'text-danger' : 'text-ink',
                  )}
                >
                  {i.label}
                  {!ok && i.why && <span className="text-[10.5px] text-muted">{i.why}</span>}
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
