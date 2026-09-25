import { useNav } from '../app/nav'
import { TUNNELS } from '../mock/data'
import { screenTitle } from './meta'

/** Title bar drawn in HTML over the hidden native one (titleBarStyle: Overlay).
 *  The native traffic lights stay, so the left edge is left empty for them.
 *  Every non-interactive piece carries data-tauri-drag-region: the attribute only
 *  applies to the element it is on, not to its children. */
export function Titlebar() {
  const nav = useNav()
  const running = TUNNELS.filter((t) => t.status === 'run').length

  return (
    <header
      data-tauri-drag-region
      className="relative flex h-[38px] flex-none items-center gap-3.5 border-b border-line bg-rail pr-3.5 pl-[84px]"
    >
      <span data-tauri-drag-region className="flex items-center gap-1.5 text-[13px] font-semibold tracking-[-0.01em]">
        AdonisGM <span data-tauri-drag-region className="font-normal text-muted">|</span> Portway
      </span>
      <span data-tauri-drag-region className="truncate text-[12px] text-muted">
        {screenTitle(nav.screen)}
      </span>
      <span data-tauri-drag-region className="flex-1 self-stretch" />

      <span data-tauri-drag-region className="flex items-center gap-1.5 text-[11px] text-muted">
        <span className="size-1.5 rounded-full bg-success" />
        {nav.sessions.length} kết nối đang mở
      </span>
      <button
        type="button"
        title="Tunnel đang chạy"
        onClick={() => nav.go({ kind: 'tunnels' })}
        className="flex cursor-pointer items-center gap-1.5 rounded-md border border-line2 px-2 py-0.5 text-[11px] text-ink2 hover:bg-accent-soft"
      >
        <span className={`size-1.5 rounded-full ${running ? 'bg-success' : 'bg-muted'}`} />
        {running} tunnel
      </button>
    </header>
  )
}
