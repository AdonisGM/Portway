import { formatSize } from '@/lib/bytes'
import type { Transfer } from './useTransfer'

/**
 * The transfer footer, from the handoff (README §SFTP pane): filename on the
 * left, `62% · 3.1 MB/s` on the right, and a 3px accent track under both.
 *
 * A folder gets a second bar above that one. The design only ever drew a single
 * file, but a drop of four hundred is the case where a progress bar earns its
 * place, and a bar that restarts from zero four hundred times says nothing
 * about how long is left. The upper bar counts files, the lower one bytes of
 * the file currently moving.
 */
export function TransferFooter({ transfer }: { transfer: Transfer }) {
  const many = transfer.filesTotal > 1
  const deleting = transfer.verb === 'delete'
  // A delete moves no bytes, so the item line has a name and a word and no bar
  // under it. Only the count above means anything, and for a single file not
  // even that — which is exactly when the word is the whole message.
  const weighed = transfer.total > 0

  return (
    <div className="flex flex-none flex-col gap-1.5 border-t border-w06 px-3 py-2.25">
      {many ? (
        <Line
          left={
            deleting
              ? `deleting ${transfer.filesTotal} items`
              : `uploading ${transfer.filesTotal} files`
          }
          right={`${transfer.filesDone} / ${transfer.filesTotal}`}
          fraction={transfer.filesDone / transfer.filesTotal}
        />
      ) : null}

      <Line
        left={transfer.name}
        right={
          weighed
            ? `${percent(transfer.bytes, transfer.total)} · ${formatSize(Math.round(transfer.rate))}/s`
            : deleting
              ? 'deleting'
              : 'uploading'
        }
        fraction={weighed ? transfer.bytes / transfer.total : 0}
        bar={weighed}
        // Moving to another file resets this bar, and a reset has to be
        // instant. Animating one back down from 100% takes as long as the whole
        // of a small file, so the bar spends a folder upload showing the wrong
        // number — measured at 74% drawn against 28% written beside it.
        resetOn={transfer.name}
        // The file's own bar is the quieter of the two once there are both:
        // which file is moving matters less than how much is left.
        dim={many}
      />
    </div>
  )
}

function Line({
  left,
  right,
  fraction,
  resetOn,
  bar = true,
  dim = false,
}: {
  left: string
  right: string
  fraction: number
  /** Off when there is no quantity behind the number — see the delete case. */
  bar?: boolean
  /** Changing this replaces the fill, which starts at its width instead of
   *  animating to it — a new element has no previous value to travel from. */
  resetOn?: string
  dim?: boolean
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className={`flex items-baseline justify-between gap-3 font-mono text-mono ${
          dim ? 'text-faint' : 'text-fg-2'
        }`}
      >
        <span className="cell-ellipsis" title={left}>
          {left}
        </span>
        <span className="flex-none tabular-nums">{right}</span>
      </div>
      {/* 3px on a 2px radius — the handoff's track, and `--radius-bar` has been
          sitting in the tokens waiting for it. */}
      {bar ? (
      <div className="h-0.75 overflow-hidden rounded-bar bg-w08">
        <div
          key={resetOn}
          // Width rather than a transform: the track is three pixels tall and
          // scaling it would scale the rounding on its ends with it.
          style={{ width: `${Math.min(100, Math.max(0, fraction * 100))}%` }}
          // Linear, and exactly the interval the backend reports on, so each
          // step finishes as the next arrives. A longer curve never catches up:
          // it restarts from wherever it got to, and with four hundred files a
          // quarter of a percent apart the bar converges on standing still.
          className={`h-full transition-[width] duration-[120ms] ease-linear ${
            dim ? 'bg-accent-27' : 'bg-accent'
          }`}
        />
      </div>
      ) : null}
    </div>
  )
}

/** `62%`. Rounded down, so nothing reads 100% until it is. */
function percent(bytes: number, total: number): string {
  if (total === 0) return '100%'
  return `${Math.min(100, Math.floor((bytes / total) * 100))}%`
}
