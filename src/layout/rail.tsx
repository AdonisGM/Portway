import { ArrowLeftRight, LayoutGrid, Server, type LucideIcon } from 'lucide-react'
import { useNav, type RailId } from '../app/nav'

const ITEMS: { id: RailId; label: string; icon: LucideIcon }[] = [
  { id: 'conn', label: 'Quản lý kết nối', icon: LayoutGrid },
  { id: 'server', label: 'Server đang kết nối', icon: Server },
  { id: 'tunnels', label: 'Tunnel', icon: ArrowLeftRight },
]

/** Leftmost column: switches between the three areas of the app. */
export function Rail() {
  const nav = useNav()

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
            className={`flex size-10 cursor-pointer items-center justify-center rounded-[11px] border hover:border-muted ${
              active ? 'border-ink2 bg-raised text-ink' : 'border-line2 text-ink2'
            }`}
          >
            <Icon size={18} strokeWidth={1.75} />
          </button>
        )
      })}
    </nav>
  )
}
