import { useNav } from '../app/nav'
import { MODULE_LABELS, serverById } from '../layout/meta'

/** Stand-in content for each screen until it is built from the design. */
export function PlaceholderScreen() {
  const { screen } = useNav()

  const [title, sub] =
    screen.kind === 'servers'
      ? ['Server của bạn', 'Danh sách server, nhóm và tài khoản đăng nhập']
      : screen.kind === 'keys'
        ? ['Khoá SSH', 'Khoá riêng nằm trong Keychain của hệ điều hành. Portway chỉ lưu đường dẫn và vân tay.']
        : screen.kind === 'tunnels'
          ? ['Tunnel', 'Chuyển tiếp cổng qua SSH để dùng dịch vụ trên server như đang chạy trên máy bạn.']
          : [
              screen.serverId,
              `${screen.user}@${serverById(screen.serverId)?.host ?? ''} · ${MODULE_LABELS[screen.module]}`,
            ]

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="m-0 text-[23px] font-semibold">{title}</h1>
        <span className="text-[12.5px] text-muted">{sub}</span>
      </div>
      <div className="flex h-60 items-center justify-center rounded-xl border border-dashed border-line2 text-[12.5px] text-muted">
        Nội dung màn hình này sẽ làm ở bước sau
      </div>
    </div>
  )
}
