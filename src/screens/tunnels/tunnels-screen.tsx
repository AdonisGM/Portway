import { openUrl } from '@tauri-apps/plugin-opener'
import { ArrowLeftRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useServers } from '../../app/servers'
import { useTunnels } from '../../app/tunnels'
import { OsBadge } from '../../components/os-badge'
import { useToast } from '../../components/toast'
import { Button, cx } from '../../components/ui/primitives'
import { RowMenu } from '../../components/ui/row-menu'
import { SearchInput } from '../../components/ui/search-input'
import { api, isAppError, type Tunnel } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import { addressOf, describe, isOn, KIND_LABELS, openTarget, status } from './format'
import { TunnelDialog } from './tunnel-dialog'

/** Tick every second while something is live, for uptime and retry countdowns. */
function useNow(on: boolean) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [on])
  return now
}

export function TunnelsScreen() {
  const { list, start, stop, remove, save, draft, setDraft } = useTunnels()
  const { byId } = useServers()
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [dialog, setDialog] = useState<{ editing: Tunnel | null } | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const now = useNow(list.some(isOn))

  // "Mở tunnel" from Firewall or Docker lands here with a draft.
  useEffect(() => {
    if (draft) setDialog({ editing: null })
  }, [draft])

  const q = query.trim().toLowerCase()
  const shown = list.filter((t) => !q || `${t.name} ${t.dest} ${t.port} ${byId(t.serverId)?.name ?? ''}`.toLowerCase().includes(q))
  const groups = [...new Set(shown.map((t) => t.serverId))].map((id) => ({ id, server: byId(id), items: shown.filter((t) => t.serverId === id) }))
  const fail = (title: string) => (e: unknown) => toast({ title, detail: isAppError(e) ? (e.detail ?? e.code) : String(e) })

  const toggle = (t: Tunnel) => (isOn(t) ? stop(t.id).catch(fail('Không tắt được')) : start(t.id).catch(fail('Không bật được')))
  const openIt = (t: Tunnel) => {
    if (t.run.state !== 'running') return toast({ title: 'Tunnel chưa chạy', detail: 'Bật tunnel trước khi mở' })
    const target = openTarget(t)
    if (t.openKind === 'url') void openUrl(target).catch(fail('Không mở được'))
    else void copyText(target).then(() => toast({ title: 'Đã sao chép chuỗi kết nối', detail: target }))
  }
  const duplicate = async (t: Tunnel) => {
    try {
      const port = t.kind === 'remote' ? t.port + 1 : await api.freePort(t.port + 1)
      const { run: _run, command: _cmd, ...spec } = t
      await save({ ...spec, id: '', name: `${t.name} (bản sao)`, port, autoStart: false })
    } catch (e) {
      fail('Không nhân bản được')(e)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-[260px] flex-1 flex-col gap-0.5">
          <span className="text-[23px] font-semibold">Tunnel</span>
          <span className="text-muted">Chuyển tiếp cổng qua SSH để dùng dịch vụ trên server (database, dashboard nội bộ) như đang chạy trên máy bạn.</span>
        </div>
        <SearchInput value={query} onChange={setQuery} placeholder="Tìm tunnel, cổng, host" className="w-60 min-w-0" />
        <Button variant="primary" size="sm" onClick={() => setDialog({ editing: null })}>
          + Tunnel mới
        </Button>
      </div>

      {!list.length && (
        <div className="flex flex-col items-center gap-2.5 rounded-xl border border-line bg-surface px-6 py-12 text-center">
          <ArrowLeftRight size={22} strokeWidth={1.8} className="text-muted" />
          <span className="text-[14px] font-semibold">Chưa có tunnel nào</span>
          <span className="max-w-[520px] leading-normal text-muted">
            Ví dụ: mở localhost:15432 trên máy bạn để kết nối tới Postgres chỉ lắng nghe 127.0.0.1 trên server, không cần mở cổng ra internet.
          </span>
          <Button variant="primary" size="xs" onClick={() => setDialog({ editing: null })}>
            + Tunnel mới
          </Button>
        </div>
      )}
      {!!list.length && !shown.length && <div className="p-6 text-center text-muted">Không có tunnel nào khớp "{query.trim()}"</div>}

      {groups.map((g) => (
        <div key={g.id} className="rounded-xl border border-line bg-surface">
          <div className="flex items-center gap-2.5 rounded-t-xl border-b border-line bg-raised px-3.5 py-2.5">
            <OsBadge os={g.server?.os} size={18} />
            <span className="font-semibold">{g.server?.name ?? 'Server đã xoá'}</span>
            <span className="font-mono text-[11.5px] text-muted">{g.server?.host}</span>
            <span className="flex-1" />
            <span className="text-[11.5px] text-muted">
              {g.items.filter((t) => t.run.state === 'running').length}/{g.items.length} đang chạy
            </span>
          </div>
          {g.items.map((t) => {
            const on = isOn(t)
            const st = status(t, now)
            return (
              <div key={t.id} className="grid items-center gap-3.5 border-t border-line px-3.5 py-2.5 first-of-type:border-t-0" style={{ gridTemplateColumns: '36px minmax(0,1.3fr) minmax(0,1fr) auto' }}>
                <button
                  type="button"
                  title={on ? 'Tắt tunnel' : 'Bật tunnel'}
                  onClick={() => void toggle(t)}
                  className={cx('flex h-5 w-9 cursor-pointer items-center rounded-full border p-px transition-colors', on ? 'justify-end border-accent bg-accent' : 'justify-start border-line2 bg-sunken')}
                >
                  <span className={cx('size-4 rounded-full', on ? 'bg-accent-fg' : 'bg-muted')} />
                </button>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-semibold">{t.name}</span>
                    <span className="rounded-[4px] bg-sunken px-1.5 py-px text-[10.5px] text-ink2">{KIND_LABELS[t.kind]}</span>
                  </span>
                  <span className="truncate font-mono text-[11.5px] text-ink2" title={t.command}>
                    {describe(t, g.server?.name ?? t.serverId)}
                  </span>
                </div>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 truncate font-medium" style={{ color: st.color }}>
                    <span className="size-1.5 flex-none rounded-full" style={{ background: st.color }} />
                    <span className="truncate" title={st.label}>
                      {st.label}
                    </span>
                  </span>
                  {st.sub && (
                    <span className="truncate text-[11px] text-muted" title={st.sub}>
                      {st.sub}
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => void copyText(addressOf(t)).then(() => toast({ title: 'Đã sao chép', detail: addressOf(t) }))}
                  >
                    Copy
                  </Button>
                  {t.openKind !== 'none' && (
                    <Button size="xs" onClick={() => openIt(t)}>
                      {t.openKind === 'url' ? 'Mở' : 'Chuỗi kết nối'}
                    </Button>
                  )}
                  <RowMenu
                    open={menu === t.id}
                    setOpen={(v) => setMenu(v ? t.id : null)}
                    items={[
                      { label: 'Sửa', run: () => setDialog({ editing: t }) },
                      { label: 'Nhân bản', run: () => void duplicate(t) },
                      { label: 'Sao chép lệnh ssh', run: () => void copyText(t.command).then(() => toast({ title: 'Đã sao chép lệnh', detail: t.command })) },
                      { label: 'Xoá', danger: true, run: () => void remove(t.id).then(() => toast({ title: 'Đã xoá tunnel', detail: t.name })) },
                    ]}
                  />
                </div>
              </div>
            )
          })}
        </div>
      ))}

      {!!list.length && (
        <span className="text-[11.5px] leading-relaxed text-muted">
          Mỗi tunnel có kết nối SSH riêng, chạy tiếp khi bạn đóng tab server; tunnel dừng khi thoát Portway. Mật khẩu hoặc passphrase phải đã lưu trong Keychain (hoặc server đang
          được kết nối) thì tunnel mới tự mở được.
        </span>
      )}

      {dialog && (
        <TunnelDialog
          editing={dialog.editing}
          initial={draft ?? undefined}
          onClose={() => {
            setDialog(null)
            setDraft(null)
          }}
        />
      )}
    </div>
  )
}
