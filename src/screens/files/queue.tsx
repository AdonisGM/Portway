import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { ArrowDownToLine, ArrowLeftRight, ArrowUpDown, ArrowUpFromLine, ChevronDown, ChevronUp, FolderOpen, RotateCw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTransfers } from '../../app/transfers'
import { Button } from '../../components/ui/primitives'
import type { Transfer } from '../../lib/api'
import { formatBytes } from '../server/format'
import { t } from '../../i18n'

const pct = (tr: Transfer) => (tr.size > 0 ? Math.min(100, (100 * tr.done) / tr.size) : tr.status === 'done' ? 100 : 0)

/** Full route, shown as the tooltip. */
const route = (tr: Transfer) => `${tr.from} → ${tr.to}`

/** Uploads come from long local paths; "Máy này" says the same in the row. */
const shortRoute = (tr: Transfer) => (tr.direction === 'up' ? t('Máy này → {to}', { to: tr.to }) : route(tr))

function subText(tr: Transfer) {
  if (tr.status === 'error') return tr.error ?? t('Lỗi')
  if (tr.status === 'cancelled') return t('Đã huỷ')
  if (tr.status === 'queued') return t('Đang chờ · {route}', { route: shortRoute(tr) })
  return shortRoute(tr)
}

function pctLabel(tr: Transfer) {
  if (tr.status === 'done') return t('Xong · {size}', { size: formatBytes(tr.size) })
  if (tr.status === 'queued') return t('Đang chờ')
  if (tr.counting) return t('Đang đếm…')
  return `${formatBytes(tr.done)} / ${formatBytes(tr.size)} · ${Math.floor(pct(tr))}%`
}

/** "Hàng đợi chuyển tệp": a card floating over the bottom-right corner of the
 *  files and transfer screens. It takes no room in the layout; the parent must be `relative`. */
export function TransferQueue() {
  const { list, cancel, retry, clearDone } = useTransfers()
  const [open, setOpen] = useState(false)
  const active = list.filter((tr) => tr.status === 'running' || tr.status === 'queued')
  const failed = list.filter((tr) => tr.status === 'error')

  // Open while something is moving; fold away shortly after it all went well.
  const busy = active.length > 0
  const clean = failed.length === 0
  useEffect(() => {
    if (busy) return setOpen(true)
    if (!clean) return
    const timer = setTimeout(() => setOpen(false), 3000)
    return () => clearTimeout(timer)
  }, [busy, clean])

  if (!list.length) return null

  const total = active.reduce((a, tr) => a + tr.size, 0)
  const done = active.reduce((a, tr) => a + tr.done, 0)
  const overall = active.length ? (total ? (100 * done) / total : 0) : 100
  const speed = active.reduce((a, tr) => a + tr.speed, 0)
  const Chev = open ? ChevronDown : ChevronUp

  return (
    <div className="pointer-events-none absolute right-0 bottom-0 z-[6] flex w-[520px] max-w-full justify-end">
      <div className="pointer-events-auto w-full overflow-hidden rounded-xl border border-line2 bg-surface shadow-pop">
        {open && (
          <>
            <div className="flex items-center gap-2 border-b border-line px-3.5 py-2">
              <span className="flex-1 font-semibold">{t('Hàng đợi chuyển tệp')}</span>
              <Button variant="ghost" size="xs" onClick={clearDone}>
                {t('Xoá mục đã xong')}
              </Button>
            </div>
            <div className="max-h-[260px] overflow-auto overscroll-contain">
              {[...list].reverse().map((tr) => {
                const Icon = tr.direction === 'up' ? ArrowUpFromLine : tr.direction === 'copy' ? ArrowLeftRight : ArrowDownToLine
                const bar = tr.status === 'error' ? 'var(--danger)' : tr.status === 'done' ? 'var(--success)' : 'var(--ink2)'
                return (
                  <div key={tr.id} className="grid items-center gap-3 border-t border-line px-3.5 py-2 first:border-t-0" style={{ gridTemplateColumns: '18px minmax(0,1fr) 128px auto' }}>
                    <Icon size={15} strokeWidth={1.8} className={tr.status === 'error' ? 'text-danger' : 'text-ink2'} />
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate font-medium">{tr.name}</span>
                      <span className={`truncate text-[11px] ${tr.status === 'error' ? 'text-danger' : 'text-muted'}`} title={tr.status === 'error' ? (tr.error ?? t('Lỗi')) + '\n' + route(tr) : route(tr)}>
                        {subText(tr)}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="num truncate text-[11px] text-ink2">
                        {pctLabel(tr)}
                        {tr.status === 'running' && tr.speed > 0 ? ` · ${formatBytes(tr.speed)}/s` : ''}
                      </span>
                      <span className="block h-1 overflow-hidden rounded-sm bg-sunken">
                        <span className="block h-full transition-[width] duration-500" style={{ width: `${pct(tr)}%`, background: bar }} />
                      </span>
                    </div>
                    <div className="flex gap-0.5">
                      {(tr.status === 'running' || tr.status === 'queued') && (
                        <IconButton title={t('Huỷ')} onClick={() => cancel(tr.id)}>
                          <X size={14} strokeWidth={1.8} />
                        </IconButton>
                      )}
                      {(tr.status === 'error' || tr.status === 'cancelled') && (
                        <IconButton title={t('Thử lại')} onClick={() => retry(tr.id)}>
                          <RotateCw size={14} strokeWidth={1.8} />
                        </IconButton>
                      )}
                      {tr.status === 'done' && tr.direction === 'down' && tr.target && (
                        <IconButton title={t('Hiện trong Finder')} onClick={() => void revealItemInDir(tr.target)}>
                          <FolderOpen size={14} strokeWidth={1.8} />
                        </IconButton>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
        <div className="flex items-center border-t border-line first:border-t-0">
          <button type="button" onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-[9px] pr-2 pl-3.5 text-left">
            <ArrowUpDown size={15} strokeWidth={1.8} className="flex-none text-ink2" />
            <span className="font-semibold whitespace-nowrap">{active.length ? t('Đang chuyển {n} mục', { n: active.length }) : t('Đã chuyển xong')}</span>
            <span className={`truncate text-[11.5px] ${failed.length ? 'text-danger' : 'text-muted'}`}>
              {failed.length ? t('{n} lỗi', { n: failed.length }) : active.length && speed > 0 ? `${formatBytes(speed)}/s` : ''}
            </span>
            <span className="flex-1" />
            <span className="block h-1 w-24 flex-none overflow-hidden rounded-sm bg-sunken">
              <span className="block h-full bg-ink2 transition-[width] duration-500" style={{ width: `${overall}%` }} />
            </span>
            <span className="num w-9 flex-none text-right text-[11.5px] text-muted">{Math.floor(overall)}%</span>
            <Chev size={14} strokeWidth={1.8} className="flex-none text-muted" />
          </button>
          {!busy && (
            <span className="pr-2">
              <IconButton title={t('Đóng và xoá danh sách')} onClick={clearDone}>
                <X size={14} strokeWidth={1.8} />
              </IconButton>
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" title={title} onClick={onClick} className="flex size-[26px] cursor-pointer items-center justify-center rounded-md text-ink2 hover:bg-sunken">
      {children}
    </button>
  )
}
