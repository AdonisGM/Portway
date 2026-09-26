import { useEffect, useState } from 'react'
import { Field, TextInput } from '../../components/ui/form-controls'
import { Modal } from '../../components/ui/modal'
import { Button, cx } from '../../components/ui/primitives'
import { t } from '../../i18n'
import { isAppError, type AppError, type DockerVolume } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import { formatBytes } from '../server/format'
import { Header, type DockerCtx } from './docker-screen'
import { volumeRemoveCommand } from './format'

const COLS = 'minmax(220px,1.5fr) 100px minmax(180px,1fr) 40px'

export function VolumesView({ ctx }: { ctx: DockerCtx }) {
  const { server, user, version } = ctx
  const [vols, setVols] = useState<DockerVolume[] | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  // Sizes come from `docker system df -v`, which can take long; the list shows first.
  const [sizes, setSizes] = useState<Record<string, number> | null>(null)
  const [sizeError, setSizeError] = useState<string | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const [removing, setRemoving] = useState<DockerVolume | null>(null)

  useEffect(() => {
    let stop = false
    ctx.api
      .dockerVolumes(server.id, user)
      .then((l) => !stop && (setVols(l), setError(null)))
      .catch((e) => !stop && setError(isAppError(e) ? e : { code: 'unknown', detail: String(e) }))
    ctx.api
      .dockerVolumeSizes(server.id, user)
      .then((m) => !stop && (setSizes(m), setSizeError(null)))
      .catch((e) => !stop && setSizeError(isAppError(e) ? (e.detail ?? e.code) : String(e)))
    return () => {
      stop = true
    }
  }, [ctx.api, server.id, user, version])

  const total = sizes && vols ? vols.reduce((a, v) => a + (sizes[v.name] ?? 0), 0) : null
  const sub = vols ? t('{n} volume', { n: vols.length }) + (total != null ? ` · ${formatBytes(total)}` : '') : error ? '' : t('Đang đọc…')

  return (
    <>
      <Header title="Docker · Volumes" sub={sub} />
      {error && <span className="font-mono text-[11.5px] text-danger select-text">{error.detail ?? error.code}</span>}
      <div className="flex min-h-[200px] flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface">
        <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
          <div className="sticky top-0 z-[1] grid items-center gap-3 bg-sunken px-3.5 py-2 text-[11px] text-muted" style={{ gridTemplateColumns: COLS }}>
            <span>Volume</span>
            <span className="text-right">{t('Dung lượng')}</span>
            <span>{t('Đang gắn vào')}</span>
            <span />
          </div>
          {(vols ?? []).map((v) => (
            <div key={v.name} className="grid items-center gap-3 border-t border-line px-3.5 py-2" style={{ gridTemplateColumns: COLS }}>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate font-semibold select-text">{v.name}</span>
                <span className="truncate font-mono text-[11px] text-muted select-text" title={v.mountpoint}>
                  {v.mountpoint}
                </span>
              </span>
              <span className="num text-right text-ink2">{sizes ? (sizes[v.name] != null ? formatBytes(sizes[v.name]) : '—') : sizeError ? '—' : t('đang tính…')}</span>
              <span className={cx('truncate', v.usedBy.length ? 'text-ink' : 'text-muted')}>{v.usedBy.length ? v.usedBy.join(', ') : t('Không gắn container nào')}</span>
              <span className="relative flex justify-end">
                <button
                  type="button"
                  title={t('Thêm thao tác')}
                  onClick={() => setMenu(menu === v.name ? null : v.name)}
                  className="flex size-[26px] cursor-pointer items-center justify-center rounded-md border border-line2 text-[14px] leading-none hover:border-muted"
                >
                  ⋯
                </button>
                {menu === v.name && (
                  <>
                    <div className="fixed inset-0 z-30" onClick={() => setMenu(null)} />
                    <div className="absolute top-[30px] right-0 z-40 flex min-w-[200px] flex-col rounded-lg border border-line bg-surface p-1 shadow-pop">
                      <button
                        type="button"
                        onClick={() => {
                          setMenu(null)
                          void copyText(v.mountpoint).then(() => ctx.toast({ title: t('Đã sao chép'), detail: v.mountpoint }))
                        }}
                        className="cursor-pointer rounded-md px-2.5 py-1.5 text-left hover:bg-raised"
                      >
                        {t('Sao chép đường dẫn')}
                      </button>
                      <button
                        type="button"
                        disabled={!!v.usedBy.length}
                        title={v.usedBy.length ? t('Đang gắn vào {containers}. Dừng và xoá container trước.', { containers: v.usedBy.join(', ') }) : undefined}
                        onClick={() => {
                          setMenu(null)
                          setRemoving(v)
                        }}
                        className="flex cursor-pointer flex-col rounded-md px-2.5 py-1.5 text-left text-danger hover:bg-danger-soft disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
                      >
                        {t('Xoá volume…')}
                        {v.usedBy.length > 0 && <span className="text-[10.5px] text-muted">{t('Đang gắn vào container')}</span>}
                      </button>
                    </div>
                  </>
                )}
              </span>
            </div>
          ))}
          {vols && !vols.length && <div className="p-7 text-center text-muted">{t('Chưa có volume nào.')}</div>}
        </div>
        {vols && vols.length > 0 && (
          <div className="flex-none border-t border-line bg-raised px-3.5 py-2 text-[11.5px] text-muted">
            {t('{n} volume', { n: vols.length })}
            {total != null ? ' · ' + t('tổng {size}', { size: formatBytes(total) }) : ''} · {t('chỉ xem, xoá qua menu ⋯')}
            {sizeError && <span className="text-danger"> · {t('không tính được dung lượng: {error}', { error: sizeError })}</span>}
          </div>
        )}
      </div>
      {removing && <RemoveVolume ctx={ctx} volume={removing} size={sizes?.[removing.name]} onClose={() => setRemoving(null)} />}
    </>
  )
}

/** Removing a volume destroys its data: type the name to confirm. */
function RemoveVolume({ ctx, volume, size, onClose }: { ctx: DockerCtx; volume: DockerVolume; size?: number; onClose: () => void }) {
  const [typed, setTyped] = useState('')
  const [pending, setPending] = useState(false)
  const [fail, setFail] = useState<string | null>(null)
  const command = (ctx.sudo && ctx.user !== 'root' ? 'sudo ' : '') + volumeRemoveCommand(volume.name)

  const go = async () => {
    setPending(true)
    setFail(null)
    try {
      await ctx.api.dockerVolumeRemove(ctx.server.id, ctx.user, volume.name)
      ctx.toast({ title: t('Đã xoá volume {name}', { name: volume.name }), detail: command })
      onClose()
      await ctx.reload()
    } catch (e) {
      setFail(isAppError(e) ? (e.detail ?? e.code) : String(e))
    } finally {
      setPending(false)
    }
  }

  return (
    <Modal
      open
      onClose={() => !pending && onClose()}
      width={460}
      title={t('Xoá volume {name}?', { name: volume.name })}
      subtitle={volume.mountpoint}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            {t('Huỷ')}
          </Button>
          <Button variant="danger" onClick={() => void go()} disabled={pending || typed !== volume.name}>
            {pending ? t('Đang xoá…') : t('Xoá volume')}
          </Button>
        </>
      }
    >
      <div className="rounded-lg bg-danger-soft px-3 py-2.5 leading-normal text-ink">
        {size != null
          ? t('Toàn bộ dữ liệu trong volume ({size}) bị xoá vĩnh viễn, không hoàn tác được.', { size: formatBytes(size) })
          : t('Toàn bộ dữ liệu trong volume bị xoá vĩnh viễn, không hoàn tác được.')}
      </div>
      <Field label={t('Gõ lại tên volume để xác nhận')}>
        <TextInput value={typed} onChange={setTyped} placeholder={volume.name} autoFocus />
      </Field>
      <span className="rounded-md bg-sunken px-2.5 py-2 font-mono text-[11.5px] select-text">{command}</span>
      {fail && <span className="rounded-md bg-danger-soft px-2 py-1.5 font-mono text-[11.5px] break-all text-danger select-text">{fail}</span>}
    </Modal>
  )
}
