import { useEffect, useState } from 'react'
import { Modal } from '../../components/ui/modal'
import { Button, Chip, cx, TONES } from '../../components/ui/primitives'
import { isAppError, type AppError, type DockerImage } from '../../lib/api'
import { formatBytes } from '../server/format'
import { Header, type DockerCtx } from './docker-screen'
import { imageDate, pruneCommand } from './format'

const COLS = 'minmax(200px,1.4fr) 120px 90px 100px minmax(170px,1fr)'

const shortId = (id: string) => id.replace(/^sha256:/, '').slice(0, 12)
const refOf = (i: DockerImage) => (i.repo === '<none>' ? '<none>:<none>' : `${i.repo}:${i.tag}`)

/** One image can carry several tags; count its size once. */
function totalSize(list: DockerImage[]) {
  const seen = new Map<string, number>()
  for (const i of list) seen.set(i.id, i.size)
  return [...seen.values()].reduce((a, b) => a + b, 0)
}

const dangling = (list: DockerImage[]) => list.filter((i) => i.repo === '<none>' && !i.usedBy.length)
const unused = (list: DockerImage[]) => list.filter((i) => !i.usedBy.length)

function useImages(ctx: DockerCtx) {
  const [images, setImages] = useState<DockerImage[] | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const { server, user, version } = ctx
  useEffect(() => {
    let stop = false
    ctx.api
      .dockerImages(server.id, user)
      .then((l) => !stop && (setImages(l), setError(null)))
      .catch((e) => !stop && setError(isAppError(e) ? e : { code: 'unknown', detail: String(e) }))
    return () => {
      stop = true
    }
  }, [ctx.api, server.id, user, version])
  return { images, error }
}

export function ImagesView({ ctx, onPrune }: { ctx: DockerCtx; onPrune: () => void }) {
  const { images, error } = useImages(ctx)
  const ids = new Set(images?.map((i) => i.id))
  const sub = images ? `${ids.size} image · ${formatBytes(totalSize(images))}` : error ? '' : 'Đang đọc…'

  return (
    <>
      <Header title="Docker · Images" sub={sub}>
        <Button size="sm" onClick={onPrune} disabled={!images}>
          Dọn image thừa
        </Button>
      </Header>
      {error && <span className="font-mono text-[11.5px] text-danger select-text">{error.detail ?? error.code}</span>}
      <div className="flex min-h-[200px] flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface">
        <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
          <div className="sticky top-0 z-[1] grid items-center gap-3 bg-sunken px-3.5 py-2 text-[11px] text-muted" style={{ gridTemplateColumns: COLS }}>
            <span>Image</span>
            <span>ID</span>
            <span className="text-right">Dung lượng</span>
            <span>Ngày tạo</span>
            <span>Đang dùng</span>
          </div>
          {(images ?? []).map((i) => {
            const none = i.repo === '<none>'
            return (
              <div key={`${i.id}|${refOf(i)}`} className="grid items-center gap-3 border-t border-line px-3.5 py-2" style={{ gridTemplateColumns: COLS }}>
                <span className={cx('truncate font-mono text-[12px] select-text', none ? 'text-muted' : 'text-ink')} title={refOf(i)}>
                  {refOf(i)}
                </span>
                <span className="font-mono text-[11.5px] text-ink2 select-text">{shortId(i.id)}</span>
                <span className="num text-right">{formatBytes(i.size)}</span>
                <span className="num text-muted">{imageDate(i.created)}</span>
                <span className="min-w-0">
                  <Chip tone={none && !i.usedBy.length ? TONES.warn : i.usedBy.length ? TONES.success : TONES.neutral} className="max-w-full truncate">
                    {i.usedBy.length ? `đang dùng bởi ${i.usedBy.join(', ')}` : none ? 'lơ lửng' : 'không dùng'}
                  </Chip>
                </span>
              </div>
            )
          })}
          {images && !images.length && <div className="p-7 text-center text-muted">Chưa có image nào.</div>}
        </div>
        {images && images.length > 0 && (
          <div className="flex flex-none flex-wrap items-center gap-3 border-t border-line bg-raised px-3.5 py-2 text-[11.5px] text-muted">
            <span className="flex-1">
              {ids.size} image · tổng {formatBytes(totalSize(images))}
            </span>
            <span>
              Lơ lửng {formatBytes(totalSize(dangling(images)))} · không dùng {formatBytes(totalSize(unused(images).filter((i) => i.repo !== '<none>')))}
            </span>
          </div>
        )}
      </div>
    </>
  )
}

/** "Dọn image thừa": dangling images only, or every image no container uses. */
export function PruneDialog({ ctx, onClose }: { ctx: DockerCtx; onClose: () => void }) {
  const { images, error } = useImages(ctx)
  const [all, setAll] = useState(false)
  const [pending, setPending] = useState(false)
  const [fail, setFail] = useState<string | null>(null)
  const list = images ? (all ? unused(images) : dangling(images)) : []
  const count = new Set(list.map((i) => i.id)).size
  const example = images ? unused(images).find((i) => i.repo !== '<none>') : undefined
  const command = (ctx.sudo && ctx.user !== 'root' ? 'sudo ' : '') + pruneCommand(all)

  const go = async () => {
    setPending(true)
    setFail(null)
    try {
      const reclaimed = await ctx.api.dockerImagePrune(ctx.server.id, ctx.user, all)
      ctx.toast({ title: `Đã thu hồi ${reclaimed}`, detail: command })
      onClose()
      await ctx.reload()
    } catch (e) {
      setFail(isAppError(e) ? (e.detail ?? e.code) : String(e))
    } finally {
      setPending(false)
    }
  }

  const options: { id: boolean; label: string; desc: string; warn?: boolean }[] = [
    { id: false, label: 'Chỉ image lơ lửng (an toàn)', desc: 'Image không có tag, thường là bản build cũ bị ghi đè. Không container nào dùng.' },
    {
      id: true,
      label: 'Tất cả image không dùng',
      desc: `Kể cả image còn tag mà không container nào dùng, có thể là bản cần để rollback${example ? ` (ví dụ ${refOf(example)})` : ''}.`,
      warn: true,
    },
  ]

  return (
    <Modal
      open
      onClose={() => !pending && onClose()}
      width={540}
      title="Dọn image thừa"
      subtitle={`docker image prune trên ${ctx.server.name}`}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Huỷ
          </Button>
          <Button variant="danger" onClick={() => void go()} disabled={pending || !count}>
            {pending ? 'Đang xoá…' : `Xoá ${count} image`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        {options.map((o) => {
          const on = o.id === all
          return (
            <button
              key={o.label}
              type="button"
              onClick={() => setAll(o.id)}
              className={cx('flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left', on ? 'border-accent bg-accent-soft' : 'border-line2')}
            >
              <span className={cx('mt-0.5 flex size-3.5 flex-none items-center justify-center rounded-full border', on ? 'border-accent' : 'border-line2')}>
                {on && <span className="size-1.5 rounded-full bg-accent" />}
              </span>
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">{o.label}</span>
                <span className={cx('text-[11.5px] leading-normal', o.warn ? 'text-warn' : 'text-ink2')}>{o.desc}</span>
              </span>
            </button>
          )
        })}
      </div>
      <div className="flex max-h-44 flex-col overflow-auto rounded-lg border border-line">
        {!images && !error && <span className="px-2.5 py-2 text-muted">Đang đọc danh sách image…</span>}
        {error && <span className="px-2.5 py-2 text-danger">{error.detail ?? error.code}</span>}
        {images && !list.length && <span className="px-2.5 py-2 text-muted">Không có image nào để xoá.</span>}
        {list.map((i) => (
          <div key={`${i.id}|${refOf(i)}`} className="flex items-center gap-3 border-t border-line px-2.5 py-1.5 first:border-t-0">
            <span className="flex-1 truncate font-mono text-[11.5px]">
              {refOf(i)}
              {i.repo === '<none>' ? ` · ${shortId(i.id)}` : ''}
            </span>
            <span className="num text-[11.5px] text-ink2">{formatBytes(i.size)}</span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
        <span className="flex-1 font-medium">
          Xoá {count} image · thu hồi khoảng {formatBytes(totalSize(list))}
        </span>
        <span className="text-muted">Không xoá volume.</span>
      </div>
      <span className="rounded-md bg-sunken px-2.5 py-2 font-mono text-[11.5px] select-text">{command}</span>
      {fail && <span className="rounded-md bg-danger-soft px-2 py-1.5 font-mono text-[11.5px] break-all text-danger select-text">{fail}</span>}
    </Modal>
  )
}
