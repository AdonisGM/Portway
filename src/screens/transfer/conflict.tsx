import { useState } from 'react'
import { Modal } from '../../components/ui/modal'
import { Button, cx } from '../../components/ui/primitives'
import type { FileEntry } from '../../lib/api'
import { isDirLike, shortTime } from '../files/format'
import { formatBytes } from '../server/format'

export type Choice = 'overwrite' | 'keep' | 'skip'
export type Clash = { name: string; src?: FileEntry; dest: FileEntry }

/** A file and a folder with the same name cannot replace each other. */
export const mixedKinds = (c: Clash) => !!c.src && isDirLike(c.src) !== isDirLike(c.dest)

const describe = (e: FileEntry) => (isDirLike(e) ? `Thư mục · ${shortTime(e.mtime)}` : `${formatBytes(e.size)} · ${shortTime(e.mtime)}`)

/** Asks what to do with items that already exist at the destination; one choice for all of them. */
export function ConflictDialog({
  where,
  clashes,
  total,
  onCancel,
  onChoose,
}: {
  /** "deploy@web-01:/var/www" */
  where: string
  clashes: Clash[]
  /** Items in the copy, clashing or not. */
  total: number
  onCancel: () => void
  onChoose: (c: Choice) => void
}) {
  const rest = total - clashes.length
  const [choice, setChoice] = useState<Choice>('keep')
  const mixed = clashes.filter(mixedKinds)
  const options: { id: Choice; label: string; text: string; off?: boolean }[] = [
    { id: 'keep', label: 'Giữ cả hai', text: `Chép thành tên mới, ví dụ ${example(clashes[0].name)}.` },
    {
      id: 'overwrite',
      label: 'Ghi đè',
      text:
        'Thay bản ở đích, không hoàn tác được. Thư mục trùng tên được gộp: tệp trùng bên trong bị thay, tệp khác giữ nguyên.' +
        (mixed.length ? ` ${mixed.map((c) => c.name).join(', ')} khác loại (tệp và thư mục) nên vẫn giữ cả hai.` : ''),
    },
    {
      id: 'skip',
      label: 'Bỏ qua mục trùng',
      text: rest ? `Chỉ chép ${rest} mục không trùng.` : 'Mọi mục đều trùng, sẽ không chép gì.',
      off: !rest,
    },
  ]

  return (
    <Modal
      open
      onClose={onCancel}
      width={580}
      title={clashes.length === 1 ? `Đã có ${clashes[0].name} ở đích` : `${clashes.length} mục đã có ở đích`}
      subtitle={where}
      footer={
        <>
          <Button onClick={onCancel}>Huỷ</Button>
          <Button variant={choice === 'overwrite' ? 'danger' : 'primary'} onClick={() => onChoose(choice)}>
            {choice === 'overwrite' ? 'Ghi đè' : choice === 'keep' ? 'Chép, giữ cả hai' : `Chép ${rest} mục`}
          </Button>
        </>
      }
    >
      <div className="flex max-h-48 flex-col overflow-auto rounded-lg border border-line">
        <div className="sticky top-0 grid gap-3 bg-sunken px-2.5 py-1.5 text-[11px] text-muted" style={{ gridTemplateColumns: 'minmax(0,1fr) 150px 150px' }}>
          <span>Tên</span>
          <span>Bản đang chép</span>
          <span>Bản ở đích</span>
        </div>
        {clashes.map((c) => {
          // Within a minute counts as the same time: that is all the list shows.
          const diff = c.src?.mtime != null && c.dest.mtime != null ? c.src.mtime - c.dest.mtime : 0
          const newer = diff >= 60 ? 'src' : diff <= -60 ? 'dest' : null
          return (
            <div key={c.name} className="grid items-baseline gap-3 border-t border-line px-2.5 py-1.5" style={{ gridTemplateColumns: 'minmax(0,1fr) 150px 150px' }}>
              <span className="truncate font-mono text-[11.5px]" title={c.name}>
                {c.name}
              </span>
              <span className={cx('num text-[11.5px]', newer === 'src' ? 'text-ink' : 'text-muted')}>
                {c.src ? describe(c.src) : 'từ Finder'}
                {newer === 'src' && ' · mới hơn'}
              </span>
              <span className={cx('num text-[11.5px]', newer === 'dest' ? 'text-ink' : 'text-muted')}>
                {describe(c.dest)}
                {newer === 'dest' && ' · mới hơn'}
              </span>
            </div>
          )
        })}
      </div>
      <div className="flex flex-col gap-1.5">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            disabled={o.off}
            onClick={() => setChoice(o.id)}
            className={cx(
              'flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left',
              choice === o.id ? 'border-ink2 bg-raised' : 'border-line2',
              o.off ? 'cursor-not-allowed opacity-45' : 'cursor-pointer hover:border-muted',
            )}
          >
            <span className={cx('mt-[3px] flex size-3.5 flex-none items-center justify-center rounded-full border', choice === o.id ? 'border-accent' : 'border-line2')}>
              {choice === o.id && <span className="size-2 rounded-full bg-accent" />}
            </span>
            <span className="flex flex-col gap-0.5">
              <span className={cx('font-semibold', o.id === 'overwrite' && 'text-danger')}>{o.label}</span>
              <span className="text-[11.5px] leading-normal text-ink2">{o.text}</span>
            </span>
          </button>
        ))}
      </div>
    </Modal>
  )
}

function example(name: string) {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${name.slice(0, dot)} (1)${name.slice(dot)}` : `${name} (1)`
}
