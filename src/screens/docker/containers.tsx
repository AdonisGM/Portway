import { ChevronDown, ChevronRight, FileText, Play, RotateCw, Square, SquareTerminal, X, type LucideIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Button, Chip, cx } from '../../components/ui/primitives'
import { RowMenu } from '../../components/ui/row-menu'
import { locale, t } from '../../i18n'
import type { ComposeAction, Container, DockerStats } from '../../lib/api'
import { formatBytes } from '../server/format'
import type { DockerCtx } from './docker-screen'
import {
  composeCommand,
  containerCommand,
  dataRole,
  dateTime,
  isFinishedJob,
  portText,
  portTip,
  projectsOf,
  projectStatus,
  roleLabel,
  statusOf,
  upLabel,
  type Project,
} from './format'

const COLS = 'minmax(140px,1fr) 170px minmax(170px,1.2fr) 60px 70px 150px'

type Group = { key: string; project: Project | null; containers: Container[] }

/** Compose projects first, then containers started by hand. */
function groupsOf(containers: Container[]): Group[] {
  const groups: Group[] = projectsOf(containers).map((p) => ({ key: p.name, project: p, containers: p.containers }))
  const loose = containers.filter((c) => !c.project)
  if (loose.length) groups.push({ key: '', project: null, containers: loose })
  return groups
}

/** Finished jobs sink to the end of their group. */
const byRole = (a: Container, b: Container) => Number(isFinishedJob(a)) - Number(isFinishedJob(b)) || a.name.localeCompare(b.name)

export function ContainersView({
  ctx,
  containers,
  stats,
  query,
}: {
  ctx: DockerCtx
  containers: Container[]
  stats: DockerStats | null
  query: string
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const [closed, setClosed] = useState<Record<string, boolean>>({})
  const [menu, setMenu] = useState<string | null>(null)
  const q = query.trim().toLowerCase()
  const match = (c: Container) => !q || c.name.toLowerCase().includes(q) || c.image.toLowerCase().includes(q) || (c.project ?? '').includes(q)
  const groups = groupsOf(containers)
    .map((g) => ({ ...g, shown: g.containers.filter(match).sort(byRole) }))
    .filter((g) => g.shown.length || !q)
  const sel = containers.find((c) => c.id === selected) ?? null
  const stat = (c: Container) => stats?.rows.find((r) => r.id === c.id)

  return (
    <div className="flex min-h-[260px] flex-1 gap-3">
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface">
        <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
          <div className="min-w-[760px]">
            <div className="sticky top-0 z-[2] grid items-center gap-3 bg-sunken px-3.5 py-2 text-[11px] text-muted" style={{ gridTemplateColumns: COLS }}>
              <span>Container</span>
              <span>{t('Trạng thái')}</span>
              <span>{t('Cổng (host → container)')}</span>
              <span className="flex flex-col items-end leading-tight">
                CPU %{stats && <span className="text-[10px]">{t('của {n} nhân', { n: stats.cores })}</span>}
              </span>
              <span className="text-right">RAM</span>
              <span />
            </div>
            {groups.map((g) => {
              const open = !closed[g.key]
              const st = projectStatus(g.containers)
              const Chev = open ? ChevronDown : ChevronRight
              return (
                <div key={g.key} className="border-t border-line2 first:border-t-0">
                  <div className="flex flex-wrap items-center gap-2.5 bg-raised px-3.5 py-[9px]">
                    <button type="button" onClick={() => setClosed({ ...closed, [g.key]: open })} className="flex cursor-pointer items-center gap-2 font-semibold">
                      <Chev size={13} strokeWidth={1.8} />
                      {g.project?.name ?? t('Container lẻ')} ({g.containers.length})
                    </button>
                    {g.project && g.project.files.length > 0 && (
                      <span className="max-w-[45%] min-w-0 truncate font-mono text-[11px] text-muted select-text" title={g.project.files.join('\n')}>
                        {g.project.files.join(', ')}
                      </span>
                    )}
                    <Chip tone={st.tone}>{st.label}</Chip>
                    <span className="flex-1" />
                    {g.project && g.project.files.length > 0 && <ComposeButtons ctx={ctx} project={g.project} />}
                  </div>
                  {open &&
                    g.shown.map((c) => {
                      const status = statusOf(c)
                      const s = stat(c)
                      const running = c.state === 'running'
                      return (
                        <div
                          key={c.id}
                          onClick={() => setSelected(selected === c.id ? null : c.id)}
                          className={cx(
                            'grid cursor-pointer items-center gap-3 border-t border-line px-3.5 py-[9px]',
                            selected === c.id ? 'bg-accent-soft' : 'hover:bg-raised',
                            isFinishedJob(c) && 'opacity-60',
                          )}
                          style={{ gridTemplateColumns: COLS }}
                        >
                          <span className="flex min-w-0 flex-col gap-0.5">
                            <span className="truncate font-semibold">{c.name}</span>
                            <span className="truncate text-[11px] text-muted" title={c.image}>
                              {roleLabel(c)} · {c.image}
                            </span>
                          </span>
                          <span className="min-w-0">
                            <Chip tone={status.tone} className="max-w-full truncate">
                              {status.label}
                            </Chip>
                          </span>
                          <PortList c={c} />
                          <span className="num text-right">{running && s ? `${s.cpu.toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false })}%` : '—'}</span>
                          <span className="num text-right">{running && s ? formatBytes(s.mem) : '—'}</span>
                          <div onClick={(e) => e.stopPropagation()} className="flex items-center justify-end gap-1">
                            <Button variant="ghost" size="xs" onClick={() => ctx.openLogs(c)}>
                              Log
                            </Button>
                            <span title={running ? undefined : t('Container không chạy')}>
                              <Button variant="ghost" size="xs" disabled={!running} onClick={() => ctx.terminal('dockerExec', c.name)}>
                                Terminal
                              </Button>
                            </span>
                            <RowMenu
                              open={menu === c.id}
                              setOpen={(v) => setMenu(v ? c.id : null)}
                              items={[
                                { label: t('Xem chi tiết'), run: () => setSelected(c.id) },
                                ...(c.ports.length ? [{ label: t('Mở tunnel tới cổng {port}', { port: c.ports[0].hostPort }), run: () => ctx.openTunnel(c) }] : []),
                                { label: t('Khởi động lại'), run: () => askRestart(ctx, c, containers) },
                                running
                                  ? { label: t('Dừng'), run: () => askStop(ctx, c, containers), danger: true }
                                  : { label: isFinishedJob(c) ? t('Chạy lại') : t('Chạy'), run: () => startContainer(ctx, c) },
                              ]}
                            />
                          </div>
                        </div>
                      )
                    })}
                </div>
              )
            })}
            {q && !groups.some((g) => g.shown.length) && <div className="p-7 text-center text-muted">{t('Không có container nào khớp "{q}"', { q: query.trim() })}</div>}
            {!containers.length && <div className="p-7 text-center text-muted">{t('Chưa có container nào trên server này.')}</div>}
          </div>
        </div>
      </div>
      <Details ctx={ctx} c={sel} containers={containers} onClose={() => setSelected(null)} />
    </div>
  )
}

function PortList({ c }: { c: Container }) {
  if (!c.ports.length) return <span className="text-[12px] text-muted">{t('nội bộ')}</span>
  // Configured but not bound while the container is not running.
  const idle = c.state !== 'running' && c.state !== 'restarting'
  return (
    <span className="flex min-w-0 flex-col gap-1">
      {c.ports.map((p) => (
        <span key={`${p.hostIp}:${p.hostPort}/${p.proto}`} className="flex flex-wrap items-center gap-1.5">
          <span className={cx('font-mono text-[11.5px]', idle ? 'text-muted' : 'text-ink2')} title={idle ? t('Container không chạy nên cổng này đang đóng') : undefined}>
            {portText(p)}
          </span>
          {p.public && !idle && (
            <span
              title={portTip(c)}
              className="cursor-help rounded-[5px] px-1.5 py-px text-[10.5px] whitespace-nowrap"
              style={dataRole(c) ? { background: 'var(--danger-soft)', color: 'var(--danger)' } : { background: 'var(--warn-soft)', color: 'var(--warn)' }}
            >
              ⚠ {t('công khai')}
            </span>
          )}
        </span>
      ))}
    </span>
  )
}

/** Other containers of the same compose project, for the warnings. */
const siblings = (c: Container, all: Container[]) => all.filter((x) => x.project && x.project === c.project && x.id !== c.id).map((x) => x.name)

function dataNote(c: Container, all: Container[]): ReactNode {
  const role = dataRole(c)
  if (!role || !c.project) return undefined
  const others = siblings(c, all)
  return others.length ? t('Container cùng project {project}: {others}.', { project: c.project, others: others.join(', ') }) : undefined
}

export function askRestart(ctx: DockerCtx, c: Container, all: Container[]) {
  const role = dataRole(c)
  ctx.confirm({
    title: t('Khởi động lại {name}?', { name: c.name }),
    body: role
      ? t('{name} là {role}. Các container phụ thuộc có thể lỗi trong lúc nó khởi động lại.', { name: c.name, role })
      : t('Container sẽ ngừng phục vụ vài giây.'),
    note: dataNote(c, all),
    command: containerCommand('restart', c.name),
    confirm: t('Khởi động lại'),
    run: () => ctx.act(() => ctx.api.dockerContainer(ctx.server.id, ctx.user, c.name, 'restart')),
  })
}

export function askStop(ctx: DockerCtx, c: Container, all: Container[]) {
  const role = dataRole(c)
  ctx.confirm({
    title: t('Dừng {name}?', { name: c.name }),
    body: role
      ? t('{name} là {role}. Các container phụ thuộc có thể lỗi cho tới khi nó chạy lại.', { name: c.name, role })
      : t('Container sẽ dừng cho tới khi bạn chạy lại.'),
    note: dataNote(c, all),
    command: containerCommand('stop', c.name),
    confirm: t('Dừng container'),
    danger: true,
    run: () => ctx.act(() => ctx.api.dockerContainer(ctx.server.id, ctx.user, c.name, 'stop')),
  })
}

export function startContainer(ctx: DockerCtx, c: Container) {
  if (isFinishedJob(c)) {
    ctx.confirm({
      title: t('Chạy lại {name}?', { name: c.name }),
      body: t('Container này sẽ thực thi lại tác vụ của nó (ví dụ migration database).'),
      note: t('Tác vụ chạy với cùng image và biến môi trường như lần trước. Nếu nó không lặp lại được an toàn, kết quả có thể lỗi.'),
      command: containerCommand('start', c.name),
      confirm: t('Chạy lại'),
      run: () => ctx.act(() => ctx.api.dockerContainer(ctx.server.id, ctx.user, c.name, 'start')),
    })
    return
  }
  void ctx.runNow(t('Đã chạy {name}', { name: c.name }), containerCommand('start', c.name), () => ctx.api.dockerContainer(ctx.server.id, ctx.user, c.name, 'start'))
}

export function askCompose(ctx: DockerCtx, p: Project, action: ComposeAction) {
  const jobs = p.containers.filter(isFinishedJob)
  const volumes = [...new Set(p.containers.flatMap((c) => c.mounts.filter((m) => m.kind === 'volume' && m.name).map((m) => m.name!)))]
  const networks = [...new Set(p.containers.flatMap((c) => c.networks))]
  const run = () => ctx.act(() => ctx.api.dockerCompose(ctx.server.id, ctx.user, p.name, p.files, p.workingDir, action))
  const command = composeCommand(p.name, p.files, p.workingDir, action)
  const asks = {
    up: { title: `Up project ${p.name}?`, body: t('Tạo lại container nếu cấu hình thay đổi, chạy các container đang dừng.'), confirm: 'Up' },
    pullUp: {
      title: `Pull + Up project ${p.name}?`,
      body: t('Tải image mới nhất theo tag trong compose rồi tạo lại container nếu image thay đổi.'),
      confirm: 'Pull + Up',
    },
    restart: {
      title: `Restart project ${p.name}?`,
      body: t('Khởi động lại toàn bộ {n} container của project. Dịch vụ sẽ gián đoạn trong lúc khởi động lại.', { n: p.containers.length }),
      note: jobs.length
        ? t('Job {jobs} cũng được chạy lại (docker compose restart gồm cả container đã chạy xong).', { jobs: jobs.map((c) => c.name).join(', ') })
        : undefined,
      confirm: 'Restart',
    },
    down: {
      title: `Down project ${p.name}?`,
      body:
        t('Dừng và xoá {n} container: {names}.', { n: p.containers.length, names: p.containers.map((c) => c.name).join(', ') }) +
        (networks.length ? ' ' + t('Network {networks} cũng bị xoá.', { networks: networks.join(', ') }) : ''),
      note: volumes.length
        ? t('Volume được giữ lại ({volumes}), image không bị xoá. Chạy Up để tạo lại container.', { volumes: volumes.join(', ') })
        : t('Volume được giữ lại, image không bị xoá. Chạy Up để tạo lại container.'),
      confirm: 'Down',
      danger: true,
    },
  }
  ctx.confirm({ ...asks[action], command, run })
}

export function ComposeButtons({ ctx, project }: { ctx: DockerCtx; project: Project }) {
  if (!project.found) {
    return (
      <span className="text-[11.5px] text-muted" title={t('Không tìm thấy trên server: {files}. Project có thể đã được chạy từ máy khác hoặc file đã bị chuyển đi.', { files: project.files.join(', ') })}
      >
        {t('File compose không có trên server')}
      </span>
    )
  }
  return (
    <div className="flex gap-1">
      <Button variant="ghost" size="xs" onClick={() => askCompose(ctx, project, 'up')}>
        Up
      </Button>
      <Button variant="ghost" size="xs" onClick={() => askCompose(ctx, project, 'pullUp')}>
        Pull + Up
      </Button>
      <Button variant="ghost" size="xs" onClick={() => askCompose(ctx, project, 'restart')}>
        Restart
      </Button>
      <Button variant="danger" size="xs" onClick={() => askCompose(ctx, project, 'down')}>
        Down
      </Button>
    </div>
  )
}

function Details({ ctx, c, containers, onClose }: { ctx: DockerCtx; c: Container | null; containers: Container[]; onClose: () => void }) {
  const [shown, setShown] = useState<Record<string, boolean>>({})
  if (!c) {
    return (
      <div className="flex w-[340px] flex-none flex-col gap-1.5 rounded-xl border border-line bg-surface p-3.5">
        <span className="font-semibold">{t('Chưa chọn container')}</span>
        <span className="leading-relaxed text-muted">{t('Bấm vào một dòng để xem trạng thái, health check, cổng, volume và biến môi trường.')}</span>
      </div>
    )
  }
  const status = statusOf(c)
  const running = c.state === 'running'
  const rows: [string, ReactNode, boolean?, string?][] = [
    [
      'Health check',
      c.health ? (c.health === 'unhealthy' ? t('unhealthy · {n} lần kiểm tra lỗi liên tiếp', { n: c.healthFailures }) : c.health) : t('Không có'),
      false,
      c.health === 'healthy' ? 'var(--success)' : c.health === 'unhealthy' ? 'var(--warn)' : 'var(--muted)',
    ],
    [t('Số lần restart'), t('{n} lần', { n: c.restarts }), false, c.restarts > 5 ? 'var(--danger)' : undefined],
    ['Restart policy', c.policy, true],
    ['Image', c.image, true],
    [t('Lệnh'), c.command || '—', true],
    [t('Ngày tạo'), dateTime(c.created)],
    ['Network', c.networks.join(', ') || '—', true],
    ['Project', c.project ? `${c.project}${c.service ? ` · service ${c.service}` : ''}` : t('Container lẻ (docker run)')],
  ]
  const acts: { label: string; icon: LucideIcon; run: () => void; ok: boolean; why?: string; meta?: string; danger?: boolean }[] = [
    { label: t('Xem log'), icon: FileText, run: () => ctx.openLogs(c), ok: true, meta: 'docker logs' },
    { label: t('Mở Terminal trong container'), icon: SquareTerminal, run: () => ctx.terminal('dockerExec', c.name), ok: running, why: t('Container không chạy'), meta: 'exec' },
    { label: t('Khởi động lại'), icon: RotateCw, run: () => askRestart(ctx, c, containers), ok: true, meta: 'restart' },
    running
      ? { label: t('Dừng container'), icon: Square, run: () => askStop(ctx, c, containers), ok: true, meta: 'stop', danger: true }
      : { label: isFinishedJob(c) ? t('Chạy lại') : t('Chạy'), icon: Play, run: () => startContainer(ctx, c), ok: true, meta: 'start' },
  ]

  return (
    <div className="flex w-[340px] flex-none flex-col gap-3 overflow-y-auto overscroll-contain rounded-xl border border-line bg-surface p-3.5 [&>*]:shrink-0">
      <div className="flex items-start gap-2.5">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-[14px] font-semibold">{c.name}</span>
          <span className="flex flex-wrap items-center gap-1.5">
            <Chip tone={status.tone}>{status.label}</Chip>
            <span className="text-[11px] text-muted">{upLabel(c)}</span>
          </span>
        </div>
        <button type="button" title={t('Đóng')} onClick={onClose} className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-sunken">
          <X size={14} strokeWidth={1.8} />
        </button>
      </div>

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
          <div key={k} className="grid items-baseline gap-2.5 border-t border-line px-2.5 py-1.5 first:border-t-0" style={{ gridTemplateColumns: '100px minmax(0,1fr)' }}>
            <span className="text-[11.5px] text-muted">{k}</span>
            <span className={cx('text-[12px] [overflow-wrap:anywhere] select-text', mono && 'font-mono')} style={{ color: color ?? 'var(--ink)' }}>
              {v}
            </span>
          </div>
        ))}
      </div>

      <Section title={t('Cổng#ports')}>
        {c.ports.length ? <PortList c={c} /> : <span className="text-muted">{t('Không publish cổng nào (nội bộ)')}</span>}
      </Section>

      <Section title="Volume">
        {c.mounts.length ? (
          c.mounts.map((m) => (
            <span key={m.destination} className="font-mono text-[11.5px] [overflow-wrap:anywhere] text-ink2 select-text">
              {m.name ?? m.source} → {m.destination}
              {m.rw ? '' : ' (' + t('chỉ đọc') + ')'}
              <span className="text-muted"> · {m.kind}</span>
            </span>
          ))
        ) : (
          <span className="text-muted">{t('Không gắn volume')}</span>
        )}
      </Section>

      <Section title={t('Biến môi trường')} hint={c.env.length ? t('bấm để hiện giá trị') : undefined}>
        {c.env.length ? (
          <div className="flex flex-col overflow-hidden rounded-lg border border-line">
            {c.env.map((e) => {
              const key = `${c.id}.${e.key}`
              const on = !!shown[key]
              return (
                <button
                  key={e.key}
                  type="button"
                  onClick={() => setShown({ ...shown, [key]: !on })}
                  className="grid cursor-pointer items-baseline gap-2.5 border-t border-line px-2.5 py-1.5 text-left first:border-t-0 hover:bg-raised"
                  style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.2fr)' }}
                >
                  <span className="truncate font-mono text-[11.5px]" title={e.key}>
                    {e.key}
                  </span>
                  <span className={cx('font-mono text-[11.5px] [overflow-wrap:anywhere]', on ? 'text-ink select-text' : 'text-muted')}>
                    {on ? e.value || t('(trống)') : '••••••••'}
                  </span>
                </button>
              )
            })}
          </div>
        ) : (
          <span className="text-muted">{t('Không có')}</span>
        )}
      </Section>
    </div>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline">
        <span className="flex-1 text-[11px] tracking-[.06em] text-muted uppercase">{title}</span>
        {hint && <span className="text-[10.5px] text-muted">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

