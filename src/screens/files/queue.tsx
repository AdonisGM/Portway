import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { ArrowDownToLine, ArrowUpDown, ArrowUpFromLine, ChevronDown, ChevronUp, FolderOpen, RotateCw, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTransfers } from '../../app/transfers'
import { Button } from '../../components/ui/primitives'
import type { Transfer } from '../../lib/api'
import { formatBytes } from '../server/format'

const pct = (t: Transfer) => (t.size > 0 ? Math.min(100, (100 * t.done) / t.size) : t.status === 'done' ? 100 : 0)

/** Full route, shown as the tooltip. */
const route = (t: Transfer) => `${t.from} → ${t.to}`

/** Uploads come from long local paths; "Máy này" says the same in the row. */
const shortRoute = (t: Transfer) => (t.direction === 'up' ? `Máy này → ${t.to}` : route(t))

function subText(t: Transfer) {
  if (t.status === 'error') return t.error ?? 'Lỗi'
  if (t.status === 'cancelled') return 'Đã huỷ'
  if (t.status === 'queued') return `Đang chờ · ${shortRoute(t)}`
  return shortRoute(t)
}

function pctLabel(t: Transfer) {
  if (t.status === 'done') return `Xong · ${formatBytes(t.size)}`
  if (t.status === 'queued') return 'Đang chờ'
  return `${formatBytes(t.done)} / ${formatBytes(t.size)} · ${Math.floor(pct(t))}%`
}

/** "Hàng đợi chuyển tệp" docked at the bottom of the files screen. */
export function TransferQueue() {
  const { list, cancel, retry, clearDone } = useTransfers()
  const [open, setOpen] = useState(false)
  const active = list.filter((t) => t.status === 'running' || t.status === 'queued')
  const failed = list.filter((t) => t.status === 'error')

  // Open while something is moving; fold away shortly after it all went well,
  // so the dock does not keep covering the list and the details panel.
  const busy = active.length > 0
  const clean = failed.length === 0
  useEffect(() => {
    if (busy) return setOpen(true)
    if (!clean) return
    const t = setTimeout(() => setOpen(false), 3000)
    return () => clearTimeout(t)
  }, [busy, clean])

  if (!list.length) return null

  const total = active.reduce((a, t) => a + t.size, 0)
  const done = active.reduce((a, t) => a + t.done, 0)
  const overall = active.length ? (total ? (100 * done) / total : 0) : 100
  const speed = active.reduce((a, t) => a + t.speed, 0)
  const Chev = open ? ChevronDown : ChevronUp

  return (
    <div className="sticky bottom-0 z-[6] mt-auto pt-1.5">
      <div className="overflow-hidden rounded-xl border border-line2 bg-surface shadow-pop">
        {open && (
          <>
            <div className="flex items-center gap-2 border-b border-line px-3.5 py-2">
              <span className="flex-1 font-semibold">Hàng đợi chuyển tệp</span>
              <Button variant="ghost" size="xs" onClick={clearDone}>
                Xoá mục đã xong
              </Button>
            </div>
            <div className="max-h-[260px] overflow-auto">
              {[...list].reverse().map((t) => {
                const Icon = t.direction === 'up' ? ArrowUpFromLine : ArrowDownToLine
                const bar = t.status === 'error' ? 'var(--danger)' : t.status === 'done' ? 'var(--success)' : 'var(--ink2)'
                return (
                  <div key={t.id} className="grid items-center gap-3 border-t border-line px-3.5 py-2 first:border-t-0" style={{ gridTemplateColumns: '22px minmax(0,1fr) 80px 170px auto' }}>
                    <Icon size={15} strokeWidth={1.8} className={t.status === 'error' ? 'text-danger' : 'text-ink2'} />
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate font-medium">{t.name}</span>
                      <span className={`truncate text-[11px] ${t.status === 'error' ? 'text-danger' : 'text-muted'}`} title={t.status === 'error' ? `${t.error ?? 'Lỗi'}\n${route(t)}` : route(t)}>
                        {subText(t)}
                      </span>
                    </div>
                    <span className="num text-right text-[11.5px] text-muted">{t.status === 'running' && t.speed > 0 ? `${formatBytes(t.speed)}/s` : ''}</span>
                    <div className="flex flex-col gap-1">
                      <span className="num text-[11px] text-ink2">{pctLabel(t)}</span>
                      <span className="block h-1 overflow-hidden rounded-sm bg-sunken">
                        <span className="block h-full transition-[width] duration-500" style={{ width: `${pct(t)}%`, background: bar }} />
                      </span>
                    </div>
                    <div className="flex gap-0.5">
                      {(t.status === 'running' || t.status === 'queued') && (
                        <IconButton title="Huỷ" onClick={() => cancel(t.id)}>
                          <X size={14} strokeWidth={1.8} />
                        </IconButton>
                      )}
                      {(t.status === 'error' || t.status === 'cancelled') && (
                        <IconButton title="Thử lại" onClick={() => retry(t.id)}>
                          <RotateCw size={14} strokeWidth={1.8} />
                        </IconButton>
                      )}
                      {t.status === 'done' && t.direction === 'down' && t.target && (
                        <IconButton title="Hiện trong Finder" onClick={() => void revealItemInDir(t.target)}>
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
        <button type="button" onClick={() => setOpen(!open)} className="flex w-full cursor-pointer items-center gap-3 border-t border-line px-3.5 py-[9px] text-left first:border-t-0">
          <ArrowUpDown size={15} strokeWidth={1.8} className="text-ink2" />
          <span className="font-semibold">{active.length ? `Đang chuyển ${active.length} mục` : 'Đã chuyển xong'}</span>
          <span className={`text-[11.5px] ${failed.length ? 'text-danger' : 'text-muted'}`}>
            {failed.length ? `${failed.length} lỗi` : active.length && speed > 0 ? `${formatBytes(speed)}/s` : ''}
          </span>
          <span className="flex-1" />
          <span className="block h-1 w-40 overflow-hidden rounded-sm bg-sunken">
            <span className="block h-full bg-ink2 transition-[width] duration-500" style={{ width: `${overall}%` }} />
          </span>
          <span className="num w-9 text-right text-[11.5px] text-muted">{Math.floor(overall)}%</span>
          <Chev size={14} strokeWidth={1.8} className="text-muted" />
        </button>
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
