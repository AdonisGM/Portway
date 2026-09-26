import { EyeOff, FileText, Play, RotateCw, Square, X, type LucideIcon } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { RowMenu } from '../../components/ui/row-menu'
import { useServers } from '../../app/servers'
import { useToast } from '../../components/toast'
import { TextInput } from '../../components/ui/form-controls'
import { Button, Chip, cx } from '../../components/ui/primitives'
import { t } from '../../i18n'
import { api, isAppError, type JournalLine, type Server, type ServiceAction, type Unit } from '../../lib/api'
import type { ActionAsk } from '../server/action-confirm'
import { formatBytes } from '../server/format'
import { JournalDialog, StopSsh, UnitFile } from './dialogs'
import { bootOf, displayName, isSsh, localTime, serviceCommand, stopNote, unitStatus } from './format'

const COLS = 'minmax(160px,1fr) minmax(180px,1.3fr) 170px 96px 70px 96px'

const errText = (e: unknown) => (isAppError(e) ? (e.detail ?? e.code) : String(e))

export function UnitsView({
  server,
  user,
  sudo,
  units,
  watched,
  query,
  onAsk,
  onPick,
  reload,
}: {
  server: Server
  user: string
  sudo: boolean
  units: Unit[] | null
  watched: string[] | null
  query: string
  onAsk: (a: ActionAsk) => void
  onPick: () => void
  reload: () => Promise<void>
}) {
  const toast = useToast()
  const { setWatchedUnits } = useServers()
  const priv = user === 'root' || sudo
  const viaSudo = sudo && user !== 'root' ? 'sudo ' : ''
  const [selected, setSelected] = useState<string | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const [journal, setJournal] = useState<string | null>(null)
  const [file, setFile] = useState<string | null>(null)
  const [sshStop, setSshStop] = useState<string | null>(null)

  const q = query.trim().toLowerCase()
  // The server answers with each unit's real name (an alias like sshd.service
  // comes back as ssh.service), so show what it returned.
  const rows = (units ?? []).filter((u) => !q || `${u.name} ${displayName(server, u.name)} ${u.description}`.toLowerCase().includes(q))
  const sel = rows.find((u) => u.name === selected) ?? (units ?? []).find((u) => u.name === selected) ?? null

  /** Run at once (start, enable…): toast the exact command, read again. */
  const runNow = async (unit: string, action: ServiceAction, title: string) => {
    try {
      await api.servicesAction(server.id, user, unit, action)
      toast({ title, detail: viaSudo + serviceCommand(unit, action) })
    } catch (e) {
      toast({ title: t('Không chạy được lệnh'), detail: errText(e) })
    }
    await reload()
  }

  const restart = (u: Unit) =>
    onAsk({
      title: t('Khởi động lại {name}?', { name: u.name }),
      body: isSsh(u.name)
        ? t('Phiên SSH đang mở vẫn giữ. Nếu cấu hình sshd đang lỗi, bạn có thể không kết nối lại được.')
        : u.name === 'docker.service'
          ? t('Tất cả container sẽ dừng rồi chạy lại theo restart policy.')
          : t('Dịch vụ gián đoạn trong lúc khởi động lại.'),
      command: serviceCommand(u.name, 'restart'),
      confirm: t('Khởi động lại'),
      run: async () => {
        await api.servicesAction(server.id, user, u.name, 'restart')
        await reload()
      },
    })

  const stop = (u: Unit) => {
    if (isSsh(u.name)) return setSshStop(u.name)
    const n = stopNote(u.name)
    onAsk({
      title: t('Dừng {name}?', { name: u.name }),
      body: n.body,
      note: n.note,
      command: serviceCommand(u.name, 'stop'),
      confirm: t('Dừng'),
      danger: true,
      run: async () => {
        await api.servicesAction(server.id, user, u.name, 'stop')
        await reload()
      },
    })
  }

  const start = (u: Unit) => void runNow(u.name, 'start', t('Đã chạy {name}', { name: u.name }))
  const unwatch = (u: Unit) => {
    if (selected === u.name) setSelected(null)
    // Drop the unit and any alias of it that was watched under that name.
    void setWatchedUnits(server.id, (watched ?? []).filter((x) => x !== u.name && !u.aliases.includes(x)))
  }
  const toggleBoot = (u: Unit) => {
    const b = bootOf(u.fileState)
    if (!b.toggleable) return toast({ title: t('Không bật/tắt được'), detail: b.hint })
    if (!priv) return toast({ title: t('Cần quyền root'), detail: t('Dùng sudo hoặc kết nối bằng root để bật/tắt khi khởi động') })
    void runNow(u.name, b.on ? 'disable' : 'enable', b.on ? t('Đã tắt tự khởi động') : t('Đã bật tự khởi động'))
  }

  return (
    <div className="flex min-h-[260px] flex-1 gap-3">
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface">
        <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
          <div className="min-w-[760px]">
            <div className="sticky top-0 z-[2] grid items-center gap-3 bg-sunken px-3.5 py-2 text-[11px] text-muted" style={{ gridTemplateColumns: COLS }}>
              <span>Unit</span>
              <span>{t('Mô tả')}</span>
              <span>{t('Trạng thái')}</span>
              <span>{t('Khi khởi động')}</span>
              <span className="text-right">RAM</span>
              <span />
            </div>
            {!units &&
              watched?.length !== 0 &&
              ['55%', '40%', '65%', '45%'].map((w, i) => (
                <div key={i} className="flex items-center gap-4 border-t border-line px-3.5 py-3">
                  <span className="h-3 rounded-[5px] bg-sunken" style={{ width: w }} />
                  <span className="h-2.5 w-24 rounded-[5px] bg-sunken" />
                </div>
              ))}
            {rows.map((u) => {
              const st = unitStatus(u)
              const boot = bootOf(u.fileState)
              const running = u.activeState === 'active' || u.activeState === 'activating' || u.activeState === 'reloading'
              return (
                <div
                  key={u.name}
                  onClick={() => setSelected(selected === u.name ? null : u.name)}
                  className={cx('grid cursor-pointer items-center gap-3 border-t border-line px-3.5 py-[9px]', selected === u.name ? 'bg-accent-soft' : 'hover:bg-raised')}
                  style={{ gridTemplateColumns: COLS }}
                >
                  <span className="truncate font-mono text-[12px] font-semibold" title={u.name}>
                    {u.name}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    {server.unitNames?.[u.name] && <span className="truncate font-medium">{server.unitNames[u.name]}</span>}
                    <span className={cx('truncate', server.unitNames?.[u.name] ? 'text-[11.5px] text-muted' : 'text-ink2')} title={u.description}>
                      {u.description || '—'}
                    </span>
                  </span>
                  <span className="min-w-0">
                    <Chip tone={st.tone} className="max-w-full truncate">
                      {st.label}
                    </Chip>
                  </span>
                  <span onClick={(e) => e.stopPropagation()} className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => toggleBoot(u)}
                      title={
                        !boot.toggleable
                          ? boot.hint
                          : !priv
                            ? t('Cần quyền root')
                            : boot.on
                              ? t('Đang tự bật khi khởi động · bấm để tắt')
                              : t('Không tự bật · bấm để bật')
                      }
                      className={cx(
                        'flex h-[18px] w-8 flex-none items-center rounded-full border p-px transition-colors',
                        boot.on ? 'justify-end border-accent bg-accent' : 'justify-start border-line2 bg-sunken',
                        boot.toggleable && priv ? 'cursor-pointer' : 'cursor-not-allowed opacity-45',
                      )}
                    >
                      <span className={cx('size-3.5 rounded-full', boot.on ? 'bg-accent-fg' : 'bg-muted')} />
                    </button>
                    <span className="truncate text-[11px] text-muted">{boot.toggleable ? (boot.on ? t('tự bật') : t('tắt#boot')) : u.fileState}</span>
                  </span>
                  <span className="num text-right">{u.memory != null ? formatBytes(u.memory) : '—'}</span>
                  <div onClick={(e) => e.stopPropagation()} className="flex items-center justify-end gap-1">
                    <Button variant="ghost" size="xs" onClick={() => setJournal(u.name)}>
                      Log
                    </Button>
                    <RowMenu
                      open={menu === u.name}
                      setOpen={(v) => setMenu(v ? u.name : null)}
                      items={[
                        { label: t('Khởi động lại'), run: () => restart(u), ok: priv, why: t('Cần quyền root') },
                        running
                          ? { label: t('Dừng'), run: () => stop(u), ok: priv, why: t('Cần quyền root'), danger: true }
                          : { label: t('Chạy'), run: () => start(u), ok: priv, why: t('Cần quyền root') },
                        { label: t('Xem file unit'), run: () => setFile(u.name), ok: u.loadState !== 'not-found' },
                        { label: t('Bỏ theo dõi'), run: () => unwatch(u), ok: true },
                      ]}
                    />
                  </div>
                </div>
              )
            })}
            {units && !rows.length && (
              <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
                <span className="text-[14px] font-semibold">{q ? t('Không có unit nào khớp "{q}"', { q: query.trim() }) : t('Chưa theo dõi unit nào')}</span>
                <span className="text-muted">{t('Chọn các unit bạn muốn thấy ở đây.')}</span>
                <Button size="xs" onClick={onPick}>
                  + {t('Theo dõi unit')}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>

      <Details
        server={server}
        user={user}
        priv={priv}
        unit={sel}
        onClose={() => setSelected(null)}
        actions={{
          journal: () => sel && setJournal(sel.name),
          file: () => sel && setFile(sel.name),
          restart: () => sel && restart(sel),
          stop: () => sel && stop(sel),
          start: () => sel && start(sel),
          unwatch: () => sel && unwatch(sel),
          resetFailed: () => sel && void runNow(sel.name, 'resetFailed', t('Đã xoá trạng thái lỗi')),
        }}
      />

      {journal && <JournalDialog server={server} user={user} sudo={sudo} unit={journal} onClose={() => setJournal(null)} />}
      {file && <UnitFile server={server} user={user} unit={file} onClose={() => setFile(null)} />}
      {sshStop && (
        <StopSsh
          server={server}
          user={user}
          sudo={sudo}
          unit={sshStop}
          onClose={() => setSshStop(null)}
          onDone={() => {
            toast({ title: t('Đã dừng {name}', { name: sshStop }), detail: viaSudo + serviceCommand(sshStop, 'stop') })
            setSshStop(null)
            void reload()
          }}
        />
      )}
    </div>
  )
}

type Acts = Record<'journal' | 'file' | 'restart' | 'stop' | 'start' | 'unwatch' | 'resetFailed', () => void>

function Details({ server, user, priv, unit, onClose, actions }: { server: Server; user: string; priv: boolean; unit: Unit | null; onClose: () => void; actions: Acts }) {
  const { setUnitName } = useServers()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  // undefined: reading; null: this user may not read the journal.
  const [tail, setTail] = useState<JournalLine[] | null | undefined>(undefined)
  const failed = unit?.activeState === 'failed'
  const name = unit?.name

  // The last journal lines explain a failure; read them when one is selected.
  useEffect(() => {
    setEditing(false)
    setTail(undefined)
    if (!name || !failed) return
    let stop = false
    api.servicesJournal(server.id, user, name, 12, null).then(
      (p) => !stop && setTail(p.lines.length || !p.limited ? p.lines : null),
      () => !stop && setTail([]),
    )
    return () => {
      stop = true
    }
  }, [server.id, user, name, failed])

  if (!unit) {
    return (
      <div className="flex w-[340px] flex-none flex-col gap-1.5 rounded-xl border border-line bg-surface p-3.5">
        <span className="font-semibold">{t('Chưa chọn unit')}</span>
        <span className="leading-relaxed text-muted">{t('Bấm vào một dòng để xem trạng thái, PID, log lỗi và file unit.')}</span>
      </div>
    )
  }

  const st = unitStatus(unit)
  const boot = bootOf(unit.fileState)
  const running = unit.activeState === 'active' || unit.activeState === 'activating' || unit.activeState === 'reloading'
  const since =
    unit.activeState === 'active'
      ? t('chạy từ {time}', { time: localTime(unit.activeSince) })
      : unit.inactiveSince
        ? failed
          ? t('lỗi lúc {time}', { time: localTime(unit.inactiveSince) })
          : t('dừng lúc {time}', { time: localTime(unit.inactiveSince) })
        : ''
  const rows: [string, ReactNode, boolean?, string?][] = [
    [t('Chạy từ'), unit.activeState === 'active' ? t('{time} (giờ máy bạn)', { time: localTime(unit.activeSince) }) : '—'],
    ['PID', unit.mainPid ?? '—', true],
    ['RAM', unit.memory != null ? formatBytes(unit.memory) : '—'],
    [t('Số lần restart'), t('{n} lần', { n: unit.restarts }), false, unit.restarts > 3 ? 'var(--danger)' : undefined],
    [t('Khi khởi động'), (unit.fileState || '—') + (boot.toggleable ? ' · ' + (boot.on ? t('tự bật') : t('không tự bật')) : '')],
    [t('Chạy bằng user'), unit.runAs ?? 'root', true],
  ]
  const acts: { label: string; icon: LucideIcon; run: () => void; ok: boolean; why?: string; meta?: string; danger?: boolean }[] = [
    { label: t('Xem log'), icon: FileText, run: actions.journal, ok: true, meta: 'journalctl' },
    { label: t('Khởi động lại'), icon: RotateCw, run: actions.restart, ok: priv, why: t('Cần quyền root'), meta: 'restart' },
    running
      ? { label: t('Dừng'), icon: Square, run: actions.stop, ok: priv, why: t('Cần quyền root'), meta: 'stop', danger: true }
      : { label: t('Chạy'), icon: Play, run: actions.start, ok: priv, why: t('Cần quyền root'), meta: 'start' },
    { label: t('Bỏ theo dõi'), icon: EyeOff, run: actions.unwatch, ok: true },
  ]

  return (
    <div className="flex w-[340px] flex-none flex-col gap-3 overflow-y-auto overscroll-contain rounded-xl border border-line bg-surface p-3.5 [&>*]:shrink-0">
      <div className="flex items-start gap-2.5">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate font-mono text-[13.5px] font-semibold">{unit.name}</span>
          <span className="flex flex-wrap items-center gap-1.5">
            <Chip tone={st.tone}>{st.label}</Chip>
            <span className="text-[11px] text-muted">{since}</span>
          </span>
        </div>
        <button type="button" title={t('Đóng')} onClick={onClose} className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-sunken">
          <X size={14} strokeWidth={1.8} />
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[11px] text-muted">{t('Tên hiển thị')}</span>
        {editing ? (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault()
              void setUnitName(server.id, unit.name, draft).then(() => setEditing(false))
            }}
          >
            <TextInput value={draft} onChange={setDraft} placeholder={unit.name.replace(/\.service$/, '')} autoFocus />
            <Button size="xs" variant="primary" type="submit">
              {t('Lưu')}
            </Button>
          </form>
        ) : (
          <div className="flex items-center gap-1.5">
            <span className="flex-1 font-medium">{displayName(server, unit.name)}</span>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setDraft(server.unitNames?.[unit.name] ?? '')
                setEditing(true)
              }}
            >
              {t('Sửa')}
            </Button>
          </div>
        )}
        {unit.description && <span className="text-[11.5px] leading-normal text-muted">{unit.description}</span>}
      </div>

      {failed && (
        <div className="flex flex-col gap-1.5 rounded-lg bg-danger-soft px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="flex-1 font-semibold text-danger">
              {st.label} · {localTime(unit.inactiveSince)}
            </span>
            <Button size="xs" onClick={actions.resetFailed} disabled={!priv} title={priv ? 'systemctl reset-failed' : t('Cần quyền root')}>
              {t('Xoá trạng thái lỗi')}
            </Button>
          </div>
          <pre className="m-0 max-h-48 overflow-auto rounded-md bg-surface/60 px-2 py-1.5 font-mono text-[11px] leading-[1.5] break-all whitespace-pre-wrap text-ink2 select-text">
            {tail === undefined
              ? t('Đang đọc journal…')
              : tail === null
                ? t('User {user} không được đọc journal hệ thống. Bật sudo để xem log lỗi.', { user })
                : tail.length
                  ? tail.map((l) => l.message).join('\n')
                  : t('Journal chưa có dòng nào.')}
          </pre>
        </div>
      )}

      <div className="flex flex-col gap-px">
        {acts.map((a) => (
          <button
            key={a.label}
            type="button"
            onClick={a.ok ? a.run : undefined}
            title={a.ok ? undefined : a.why}
            className={cx(
              'flex items-center gap-2.5 rounded-[7px] px-2 py-[7px] text-left',
              a.ok ? cx('cursor-pointer', a.danger ? 'hover:bg-danger-soft' : 'hover:bg-raised') : 'cursor-not-allowed opacity-45',
              a.danger ? 'text-danger' : 'text-ink',
            )}
          >
            <a.icon size={15} strokeWidth={1.8} className={a.danger ? 'text-danger' : 'text-ink2'} />
            <span className="flex flex-1 flex-col gap-px">
              <span>{a.label}</span>
              {!a.ok && a.why && <span className="text-[10.5px] text-muted">{a.why}</span>}
            </span>
            {a.meta && <span className="text-[11px] text-muted">{a.meta}</span>}
          </button>
        ))}
      </div>

      <div className="flex flex-col overflow-hidden rounded-lg border border-line">
        {rows.map(([k, v, mono, color]) => (
          <div key={k} className="grid items-baseline gap-2.5 border-t border-line px-2.5 py-1.5 first:border-t-0" style={{ gridTemplateColumns: '104px minmax(0,1fr)' }}>
            <span className="text-[11.5px] text-muted">{k}</span>
            <span className={cx('text-[12px] [overflow-wrap:anywhere] select-text', mono && 'font-mono')} style={{ color: color ?? 'var(--ink)' }}>
              {v}
            </span>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[11px] tracking-[.06em] text-muted uppercase">{t('File unit')}</span>
        <div className="flex items-center gap-2">
          <span className="flex-1 truncate font-mono text-[11.5px] text-ink2 select-text" title={unit.fragmentPath}>
            {unit.fragmentPath || '—'}
          </span>
          <Button size="xs" variant="ghost" onClick={actions.file} disabled={!unit.fragmentPath}>
            {t('Xem file')}
          </Button>
        </div>
      </div>
    </div>
  )
}
