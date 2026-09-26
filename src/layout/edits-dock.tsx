import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { ChevronDown, ChevronUp, ExternalLink, FilePen, FolderOpen, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useEdits } from '../app/edits'
import { ConfirmModal } from '../components/ui/modal'
import { Button, cx } from '../components/ui/primitives'
import type { Edit } from '../lib/api'
import { t } from '../i18n'

const pad = (n: number) => String(n).padStart(2, '0')
const clock = (ms: number) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
const baseName = (p: string) => p.split('/').pop() || p

function statusOf(e: Edit): { text: string; color: string } {
  switch (e.status) {
    case 'synced':
      return {
        text: e.uploads ? t('Đã tải lên lúc {time} · {n} lần', { time: clock(e.syncedAt), n: e.uploads }) : t('Chưa sửa · lưu trong editor là tự tải lên'),
        color: 'var(--success)',
      }
    case 'uploading':
      return { text: t('Đang tải lên…'), color: 'var(--ink2)' }
    case 'pending':
      return { text: e.error ?? t('Chờ tải lên'), color: 'var(--warn)' }
    case 'conflict':
      return { text: t('Tệp trên server đã đổi từ lúc mở'), color: 'var(--danger)' }
    case 'error':
      return { text: e.error ?? t('Lỗi khi tải lên'), color: 'var(--danger)' }
  }
}

/** "Đang sửa trên máy": files open in an app on this Mac, floating over the
 *  bottom-left of the content area on every screen while any is open. */
export function EditsDock() {
  const { list, stop, resolve, reopen } = useEdits()
  const [open, setOpen] = useState(true)
  const [asking, setAsking] = useState<{ edit: Edit; kind: 'stop' | 'take' } | null>(null)
  if (!list.length) return null
  const problems = list.filter((e) => e.status === 'conflict' || e.status === 'error' || e.status === 'pending').length
  const Chev = open ? ChevronDown : ChevronUp

  return (
    <div className="pointer-events-none absolute bottom-3 left-6 z-[7] flex w-[460px] max-w-[calc(100%-3rem)]">
      <div className="pointer-events-auto w-full overflow-hidden rounded-xl border border-line2 bg-surface shadow-pop">
        {open && (
          <div className="max-h-[300px] overflow-auto overscroll-contain">
            {list.map((e) => {
              const st = statusOf(e)
              return (
                <div key={e.id} className="flex flex-col gap-1.5 border-b border-line px-3.5 py-2">
                  <div className="flex items-center gap-2">
                    <FilePen size={14} strokeWidth={1.8} className="flex-none text-ink2" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-medium" title={e.localPath}>
                        {baseName(e.remotePath)}
                        {e.sudo && <span className="ml-1.5 rounded px-1 text-[10px] text-warn" style={{ background: 'var(--warn-soft)' }}>sudo</span>}
                      </span>
                      <span className="truncate font-mono text-[10.5px] text-muted" title={`${e.user}@${e.serverName}:${e.remotePath}`}>
                        {e.user}@{e.serverName}:{e.remotePath}
                      </span>
                    </span>
                    <IconButton title={e.app ? t('Mở lại bằng {app}', { app: e.app }) : t('Mở lại trong editor')} onClick={() => reopen(e.id)}>
                      <ExternalLink size={13} strokeWidth={1.8} />
                    </IconButton>
                    <IconButton title={t('Hiện bản trên máy trong Finder')} onClick={() => void revealItemInDir(e.localPath)}>
                      <FolderOpen size={13} strokeWidth={1.8} />
                    </IconButton>
                    <IconButton
                      title={t('Thôi sửa: ngừng tải lên và xoá bản trên máy')}
                      onClick={() => (e.status === 'synced' ? stop(e.id) : setAsking({ edit: e, kind: 'stop' }))}
                    >
                      <X size={13} strokeWidth={1.8} />
                    </IconButton>
                  </div>
                  <span className="pl-[22px] text-[11px]" style={{ color: st.color }}>
                    {st.text}
                  </span>
                  {e.status === 'conflict' && (
                    <div className="flex flex-wrap gap-1.5 pl-[22px]">
                      <Button size="xs" variant="danger" onClick={() => void resolve(e.id, true)}>
                        {t('Ghi đè lên server')}
                      </Button>
                      <Button size="xs" onClick={() => setAsking({ edit: e, kind: 'take' })}>
                        {t('Lấy bản trên server')}
                      </Button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
        <button type="button" onClick={() => setOpen(!open)} className="flex w-full cursor-pointer items-center gap-2.5 px-3.5 py-2 text-left">
          <FilePen size={14} strokeWidth={1.8} className="flex-none text-ink2" />
          <span className="font-semibold">{t('Đang sửa trên máy')}</span>
          <span className={cx('text-[11.5px]', problems ? 'text-danger' : 'text-muted')}>{problems ? t('{n} cần xem', { n: problems }) : t('{n} tệp', { n: list.length })}</span>
          <span className="flex-1" />
          <Chev size={14} strokeWidth={1.8} className="text-muted" />
        </button>
      </div>

      {asking && (
        <ConfirmModal
          open
          onClose={() => setAsking(null)}
          title={
            asking.kind === 'stop'
              ? t('Thôi sửa {name}?', { name: baseName(asking.edit.remotePath) })
              : t('Lấy bản trên server của {name}?', { name: baseName(asking.edit.remotePath) })
          }
          confirm={asking.kind === 'stop' ? t('Thôi sửa') : t('Lấy bản trên server')}
          danger
          onConfirm={() => {
            const a = asking
            setAsking(null)
            if (a.kind === 'stop') stop(a.edit.id)
            else void resolve(a.edit.id, false)
          }}
        >
          {asking.kind === 'stop'
            ? t('Thay đổi chưa tải lên server sẽ mất: bản trên máy bị xoá và Portway không theo dõi tệp này nữa.')
            : t('Bản trên máy được thay bằng nội dung hiện tại trên server; những gì bạn sửa mà chưa tải lên sẽ mất. Editor sẽ hiện nội dung mới.')}
        </ConfirmModal>
      )}
    </div>
  )
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" title={title} onClick={onClick} className="flex size-[26px] flex-none cursor-pointer items-center justify-center rounded-md text-ink2 hover:bg-sunken">
      {children}
    </button>
  )
}
