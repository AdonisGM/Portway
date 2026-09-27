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
import { t } from '../../i18n'
import { api, isAppError, type Tunnel } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import { addressOf, describe, isOn, KIND_LABELS, openTarget, status } from './format'
import { TunnelDialog } from './tunnel-dialog'

/** Every row is its own grid: all tracks are fixed or minmax(0,…) so the
 *  columns line up whatever a row holds (the last one fits Copy, the longest
 *  "Mở"/"Chuỗi kết nối" label in either language, and the ⋯ menu). */
const ROW_COLS = '36px minmax(0,1.3fr) minmax(0,1fr) 220px'

/** Tick every second while something is live, for uptime and retry countdowns. */
function useNow(on: boolean) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!on) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
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
  const shown = list.filter((tn) => !q || `${tn.name} ${tn.dest} ${tn.port} ${byId(tn.serverId)?.name ?? ''}`.toLowerCase().includes(q))
  const groups = [...new Set(shown.map((tn) => tn.serverId))].map((id) => ({ id, server: byId(id), items: shown.filter((tn) => tn.serverId === id) }))
  const fail = (title: string) => (e: unknown) => toast({ title, detail: isAppError(e) ? (e.detail ?? e.code) : String(e) })

  const toggle = (tn: Tunnel) => (isOn(tn) ? stop(tn.id).catch(fail(t('Không tắt được'))) : start(tn.id).catch(fail(t('Không bật được'))))
  const openIt = (tn: Tunnel) => {
    if (tn.run.state !== 'running') return toast({ title: t('Tunnel chưa chạy'), detail: t('Bật tunnel trước khi mở') })
    const target = openTarget(tn)
    if (tn.openKind === 'url') void openUrl(target).catch(fail(t('Không mở được')))
    else void copyText(target).then(() => toast({ title: t('Đã sao chép chuỗi kết nối'), detail: target }))
  }
  const duplicate = async (tn: Tunnel) => {
    try {
      const port = tn.kind === 'remote' ? tn.port + 1 : await api.freePort(tn.port + 1)
      const { run: _run, command: _cmd, ...spec } = tn
      await save({ ...spec, id: '', name: t('{name} (bản sao)', { name: tn.name }), port, autoStart: false })
    } catch (e) {
      fail(t('Không nhân bản được'))(e)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-[260px] flex-1 flex-col gap-0.5">
          <span className="text-[23px] font-semibold">Tunnel</span>
          <span className="text-muted">{t('Chuyển tiếp cổng qua SSH để dùng dịch vụ trên server (database, dashboard nội bộ) như đang chạy trên máy bạn.')}</span>
        </div>
        <SearchInput value={query} onChange={setQuery} placeholder={t('Tìm tunnel, cổng, host')} className="w-60 min-w-0" />
        <Button variant="primary" size="sm" onClick={() => setDialog({ editing: null })}>
          {t('+ Tunnel mới')}
        </Button>
      </div>

      {!list.length && (
        <div className="flex flex-col items-center gap-2.5 rounded-xl border border-line bg-surface px-6 py-12 text-center">
          <ArrowLeftRight size={22} strokeWidth={1.8} className="text-muted" />
          <span className="text-[14px] font-semibold">{t('Chưa có tunnel nào')}</span>
          <span className="max-w-[520px] leading-normal text-muted">
            {t('Ví dụ: mở localhost:15432 trên máy bạn để kết nối tới Postgres chỉ lắng nghe 127.0.0.1 trên server, không cần mở cổng ra internet.')}
          </span>
          <Button variant="primary" size="xs" onClick={() => setDialog({ editing: null })}>
            {t('+ Tunnel mới')}
          </Button>
        </div>
      )}
      {!!list.length && !shown.length && <div className="p-6 text-center text-muted">{t('Không có tunnel nào khớp "{query}"', { query: query.trim() })}</div>}

      {groups.map((g) => (
        <div key={g.id} className="rounded-xl border border-line bg-surface">
          <div className="flex items-center gap-2.5 rounded-t-xl border-b border-line bg-raised px-3.5 py-2.5">
            <OsBadge os={g.server?.os} size={18} />
            <span className="font-semibold">{g.server?.name ?? t('Server đã xoá')}</span>
            <span className="font-mono text-[11.5px] text-muted">{g.server?.host}</span>
            <span className="flex-1" />
            <span className="text-[11.5px] text-muted">
              {t('{n}/{total} đang chạy', { n: g.items.filter((tn) => tn.run.state === 'running').length, total: g.items.length })}
            </span>
          </div>
          {g.items.map((tn) => {
            const on = isOn(tn)
            const st = status(tn, now)
            return (
              <div key={tn.id} className="grid items-center gap-3.5 border-t border-line px-3.5 py-2.5 first-of-type:border-t-0" style={{ gridTemplateColumns: ROW_COLS }}>
                <button
                  type="button"
                  title={on ? t('Tắt tunnel') : t('Bật tunnel')}
                  onClick={() => void toggle(tn)}
                  className={cx('flex h-5 w-9 cursor-pointer items-center rounded-full border p-px transition-colors', on ? 'justify-end border-accent bg-accent' : 'justify-start border-line2 bg-sunken')}
                >
                  <span className={cx('size-4 rounded-full', on ? 'bg-accent-fg' : 'bg-muted')} />
                </button>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-semibold">{tn.name}</span>
                    <span className="rounded-[4px] bg-sunken px-1.5 py-px text-[10.5px] text-ink2">{KIND_LABELS[tn.kind]}</span>
                    {tn.kind !== 'remote' && tn.bind !== '127.0.0.1' && (
                      <span
                        title={tn.socksLogin ? t('Máy khác trong mạng dùng được tunnel này, bằng user và mật khẩu SOCKS') : t('Mọi máy trong cùng mạng (LAN) với máy bạn đều dùng được tunnel này.')}
                        className="rounded-[4px] px-1.5 py-px text-[10.5px] text-warn"
                        style={{ background: 'var(--warn-soft)' }}
                      >
                        LAN
                      </span>
                    )}
                  </span>
                  <span className="truncate font-mono text-[11.5px] text-ink2" title={tn.command}>
                    {describe(tn, g.server?.name ?? tn.serverId)}
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
                {/* Fixed slots (Copy | Mở | ⋯) so each button sits at the same place on every row. */}
                <div className="grid items-center gap-1" style={{ gridTemplateColumns: '52px minmax(0,1fr) 26px' }}>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => void copyText(addressOf(tn)).then(() => toast({ title: t('Đã sao chép'), detail: addressOf(tn) }))}
                  >
                    Copy
                  </Button>
                  {tn.openKind !== 'none' ? (
                    <Button size="xs" className="justify-self-start" onClick={() => openIt(tn)}>
                      {tn.openKind === 'url' ? t('Mở') : t('Chuỗi kết nối')}
                    </Button>
                  ) : (
                    <span />
                  )}
                  <RowMenu
                    open={menu === tn.id}
                    setOpen={(v) => setMenu(v ? tn.id : null)}
                    items={[
                      { label: t('Sửa'), run: () => setDialog({ editing: tn }) },
                      { label: t('Nhân bản'), run: () => void duplicate(tn) },
                      { label: t('Sao chép lệnh ssh'), run: () => void copyText(tn.command).then(() => toast({ title: t('Đã sao chép lệnh'), detail: tn.command })) },
                      ...(tn.socksLogin
                        ? [
                            {
                              label: t('Sao chép user và mật khẩu SOCKS'),
                              run: () => {
                                const [u, p] = tn.socksLogin!
                                void copyText('socks5://' + u + ':' + p + '@' + t('IP-của-máy-này') + ':' + tn.port).then(() =>
                                  toast({ title: t('Đã sao chép thông tin SOCKS'), detail: t('User {user} · mật khẩu trong clipboard', { user: u }) }),
                                )
                              },
                            },
                          ]
                        : []),
                      { label: t('Xoá'), danger: true, run: () => void remove(tn.id).then(() => toast({ title: t('Đã xoá tunnel'), detail: tn.name })) },
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
          {t(
            'Mỗi tunnel có kết nối SSH riêng, chạy tiếp khi bạn đóng tab server; tunnel dừng khi thoát Portway. Mật khẩu hoặc passphrase phải đã lưu trong Keychain (hoặc server đang được kết nối) thì tunnel mới tự mở được.',
          )}
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
