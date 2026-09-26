import { ArrowLeftRight, Bug, FolderSync, LayoutGrid, Server, Settings, type LucideIcon } from 'lucide-react'
import { useTrace } from '../app/trace'
import { useTransfers } from '../app/transfers'
import { useTunnels } from '../app/tunnels'
import { api } from '../lib/api'
import { useNav, type RailId } from '../app/nav'

const ITEMS: { id: RailId; label: string; icon: LucideIcon }[] = [
  { id: 'conn', label: 'Quản lý kết nối', icon: LayoutGrid },
  { id: 'server', label: 'Server đang kết nối', icon: Server },
  { id: 'transfer', label: 'Chuyển tệp', icon: FolderSync },
  { id: 'tunnels', label: 'Tunnel', icon: ArrowLeftRight },
]

/** Leftmost column: switches between the areas of the app. */
export function Rail() {
  const nav = useNav()
  const tunnels = useTunnels()
  const moving = useTransfers().list.filter((t) => t.status === 'running' || t.status === 'queued').length

  return (
    <nav className="flex w-[60px] flex-none flex-col items-center gap-2 border-r border-line bg-rail py-3">
      {ITEMS.map(({ id, label, icon: Icon }) => {
        const active = nav.rail === id
        return (
          <button
            key={id}
            type="button"
            title={label}
            aria-current={active ? 'page' : undefined}
            onClick={() => nav.goRail(id)}
            className={`relative flex size-10 cursor-pointer items-center justify-center rounded-[11px] border hover:border-muted ${
              active ? 'border-ink2 bg-raised text-ink' : 'border-line2 text-ink2'
            }`}
          >
            <Icon size={18} strokeWidth={1.75} />
            {id === 'transfer' && moving > 0 && (
              <span className="num absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] leading-none font-semibold text-accent-fg">
                {moving}
              </span>
            )}
            {id === 'tunnels' && tunnels.running > 0 && (
              <span className="num absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-success px-1 text-[10px] leading-none font-semibold text-bg">
                {tunnels.running}
              </span>
            )}
          </button>
        )
      })}
      <span className="flex-1" />
      <button
        type="button"
        title="Cài đặt"
        aria-current={nav.rail === 'settings' ? 'page' : undefined}
        onClick={() => nav.goRail('settings')}
        className={`flex size-10 cursor-pointer items-center justify-center rounded-[11px] border hover:border-muted ${
          nav.rail === 'settings' ? 'border-ink2 bg-raised text-ink' : 'border-line2 text-ink2'
        }`}
      >
        <Settings size={18} strokeWidth={1.75} />
      </button>
      <DebugButton />
    </nav>
  )
}

/** Bottom of the rail: opens the debug trace window; shows how many
 *  commands are running on servers right now. */
function DebugButton() {
  const { running } = useTrace()
  return (
    <button
      type="button"
      title={running ? `Nhật ký gỡ lỗi · ${running} việc đang chạy` : 'Nhật ký gỡ lỗi (mở cửa sổ riêng)'}
      onClick={() => void api.openDebugWindow()}
      className="relative flex size-10 cursor-pointer items-center justify-center rounded-[11px] border border-line2 text-ink2 hover:border-muted"
    >
      <Bug size={18} strokeWidth={1.75} />
      {running > 0 && (
        <span className="num absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] leading-none font-semibold text-accent-fg">
          {running > 99 ? '99+' : running}
        </span>
      )}
    </button>
  )
}
