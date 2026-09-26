import { useConnections, type Connection } from '../../app/connections'
import { useNav, type ModuleId } from '../../app/nav'
import { useServers } from '../../app/servers'
import { OsBadge } from '../../components/os-badge'
import { useToast } from '../../components/toast'
import { Button, Chip, cx, TONES } from '../../components/ui/primitives'
import { MODULE_LABELS } from '../../layout/meta'
import { isAppError, api, type Server } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import { hostPort, sshCommand } from '../servers/format'
import { ConnectPrompt } from './connect-prompt'
import { connectError, formatUptime } from './format'
import { FilesScreen } from '../files/files-screen'
import { Overview } from './overview'
import { SudoBanner, SudoPrompt } from './sudo'

/** One open session: header, connection state, then the selected module. */
export function ServerScreen({ serverId, user, module }: { serverId: string; user: string; module: ModuleId }) {
  const { byId } = useServers()
  const conns = useConnections()
  const server = byId(serverId)
  const conn = conns.get(serverId, user)

  if (!server) {
    return <div className="rounded-xl border border-line bg-surface p-8 text-center text-muted">Server này không còn trong danh sách.</div>
  }

  // Modules that manage their own scrolling (the file browser) get exactly the
  // height left under the header instead of growing the page.
  const fill = module === 'files'

  return (
    <div className={cx('flex flex-col gap-4', fill && 'min-h-0 flex-1')}>
      <ServerHeader server={server} user={user} conn={conn} />

      {(!conn || conn.status === 'failed') && <Failed server={server} user={user} conn={conn} />}
      {(conn?.status === 'connecting' || conn?.status === 'prompt') && <Connecting server={server} />}
      {conn?.status === 'prompt' && (
        <ConnectPrompt server={server} user={user} prompt={conn.prompt} onCancel={() => conns.markLost(serverId, user, { code: 'cancelled' })} />
      )}
      {(conn?.status === 'connected' || conn?.status === 'reconnecting') && (
        <>
          {conn.status === 'reconnecting' && <Reconnecting server={server} user={user} conn={conn} />}
          <SudoBanner server={server} user={user} sudo={conn.sudo} />
          {/* Last numbers stay on screen, dimmed, while reconnecting. */}
          <div className={cx('flex flex-col gap-4 transition-opacity duration-200', fill && 'min-h-0 flex-1')} style={{ opacity: conn.status === 'reconnecting' ? 0.55 : 1 }}>
            {module === 'overview' ? (
              <Overview server={server} user={user} />
            ) : module === 'files' ? (
              <FilesScreen server={server} user={user} />
            ) : (
              <div className="flex h-60 items-center justify-center rounded-xl border border-dashed border-line2 text-muted">
                Mục {MODULE_LABELS[module]} sẽ làm ở bước sau
              </div>
            )}
          </div>
        </>
      )}
      {conns.sudoAsked(serverId, user) && conn?.status === 'connected' && <SudoPrompt server={server} user={user} />}
    </div>
  )
}

function ServerHeader({ server, user, conn }: { server: Server; user: string; conn: Connection | undefined }) {
  const { setPinned } = useServers()
  const toast = useToast()
  const account = server.accounts.find((a) => a.user === user)
  const command = sshCommand(server.host, server.port, account)
  const status =
    conn?.status === 'connected'
      ? { label: 'Đã kết nối', tone: TONES.success }
      : conn?.status === 'reconnecting'
        ? { label: 'Đang kết nối lại', tone: TONES.warn }
      : conn?.status === 'connecting' || conn?.status === 'prompt'
        ? { label: 'Đang kết nối', tone: TONES.warn }
        : !conn || conn.error.code === 'cancelled'
          ? { label: 'Chưa kết nối', tone: TONES.neutral }
          : conn.error.code === 'connection_lost' || conn.error.code === 'not_connected'
            ? { label: 'Mất kết nối', tone: TONES.danger }
            : { label: 'Lỗi kết nối', tone: TONES.danger }

  const line = [
    `${user}@${hostPort(server.host, server.port)}`,
    server.os ?? 'chưa rõ hệ điều hành',
    conn?.status === 'connected' && `chạy ${formatUptime(conn.info.uptimeSecs + (Date.now() - conn.since) / 1000)}`,
  ]
    .filter(Boolean)
    .join(' · ')

  const run = async (what: () => Promise<void>, fail: string) => {
    try {
      await what()
    } catch (e) {
      toast({ title: fail, detail: isAppError(e) ? (e.detail ?? e.code) : String(e) })
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-2.5">
      <div className="flex min-w-[260px] flex-1 flex-col gap-1">
        <div className="flex items-center gap-2.5">
          <OsBadge os={server.os} size={28} />
          <h1 className="m-0 text-[23px] font-semibold">{server.name}</h1>
          <Chip tone={status.tone}>{status.label}</Chip>
        </div>
        <span className="font-mono text-[11.5px] text-muted select-text">{line}</span>
      </div>
      <Button variant="ghost" size="sm" onClick={() => run(() => setPinned(server.id, !server.pinned), 'Không lưu được')}>
        {server.pinned ? 'Bỏ ghim' : 'Ghim'}
      </Button>
      <Button size="sm" onClick={() => run(() => copyText(command).then(() => toast({ title: 'Đã sao chép lệnh SSH', detail: command })), 'Không sao chép được')}>
        Sao chép lệnh SSH
      </Button>
      <Button
        variant="primary"
        size="sm"
        onClick={() => run(() => api.openTerminal(server.id, user).then(() => toast({ title: 'Đã mở Terminal', detail: command })), 'Không mở được Terminal')}
      >
        Mở Terminal
      </Button>
    </div>
  )
}

function Reconnecting({ server, user, conn }: { server: Server; user: string; conn: Extract<Connection, { status: 'reconnecting' }> }) {
  const conns = useConnections()
  const lost = new Date(conn.lostAt).toLocaleTimeString('vi-VN')
  return (
    <div className="flex items-center gap-3 rounded-[10px] border border-line bg-warn-soft px-3.5 py-2.5">
      <span className="size-2 flex-none rounded-full bg-warn" />
      <div className="flex flex-1 flex-col gap-0.5">
        <span className="font-semibold text-ink">
          Mất kết nối tới {server.name}, đang kết nối lại{conn.attempt > 0 ? ` (lần ${conn.attempt})` : ''}…
        </span>
        <span className="text-[11.5px] text-ink2">
          Số liệu bên dưới là bản cuối lúc {lost}, chưa được cập nhật.
          {conn.error.detail && <span className="font-mono"> {conn.error.detail}</span>}
        </span>
      </div>
      <Button size="xs" onClick={() => conns.retryNow(server.id, user)}>
        Thử ngay
      </Button>
    </div>
  )
}

function Connecting({ server }: { server: Server }) {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <div className="grid grid-cols-4 gap-px overflow-hidden rounded-xl border border-line bg-line">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex flex-col gap-2 bg-surface p-3.5">
            <span className="block h-2.5 w-2/5 rounded-md bg-sunken" />
            <span className="block h-5 w-3/5 rounded-md bg-sunken" />
            <span className="block h-2 w-1/2 rounded-md bg-sunken" />
          </div>
        ))}
      </div>
      <span className="text-[11px] text-muted">
        Đang kết nối tới {hostPort(server.host, server.port)} qua SSH…
      </span>
    </div>
  )
}

function Failed({ server, user, conn }: { server: Server; user: string; conn: Connection | undefined }) {
  const conns = useConnections()
  const nav = useNav()
  const error = conn?.status === 'failed' ? conn.error : { code: 'cancelled' }
  const { title, message } = connectError(error, server.host, server.port)
  return (
    <div className="flex flex-col items-center gap-2.5 rounded-xl border border-line bg-surface px-6 py-10 text-center">
      <span className="text-[15px] font-semibold">{title}</span>
      <span className="max-w-[460px] leading-normal text-muted">{message}</span>
      {error.detail && error.code !== 'key_missing' && (
        <span className="max-w-[560px] rounded-md bg-danger-soft px-2 py-1 font-mono text-[11.5px] break-all text-danger select-text">{error.detail}</span>
      )}
      <div className="mt-1 flex gap-2">
        {error.code === 'key_missing' || error.code === 'auth_failed' ? (
          <Button size="sm" onClick={() => nav.go({ kind: 'servers' })}>
            Về danh sách server
          </Button>
        ) : null}
        <Button size="sm" variant="primary" onClick={() => conns.connect(server.id, user)}>
          {error.code === 'cancelled' ? 'Kết nối' : 'Thử kết nối lại'}
        </Button>
      </div>
    </div>
  )
}
