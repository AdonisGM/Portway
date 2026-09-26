import { useEffect, useState } from 'react'
import { readCache, writeCache } from '../../app/session-cache'
import { Modal } from '../../components/ui/modal'
import { Button, Chip, TONES } from '../../components/ui/primitives'
import { api, type AuditEntry, type Server } from '../../lib/api'

export const AUDIT_ACTIONS: Record<string, string> = {
  connect: 'Kết nối',
  reconnect: 'Kết nối lại',
  disconnect: 'Ngắt kết nối',
  trustHostKey: 'Tin tưởng khoá máy chủ',
  openTerminal: 'Mở Terminal',
  sudoOn: 'Bật sudo',
  sudoOff: 'Tắt sudo',
  mkdir: 'Tạo thư mục',
  touch: 'Tạo tệp',
  rename: 'Đổi tên',
  remove: 'Xoá',
  chmod: 'Sửa quyền',
  chown: 'Đổi owner',
  download: 'Tải xuống',
  upload: 'Tải lên',
  copy: 'Chép giữa server',
  dockerStart: 'Chạy container',
  dockerStop: 'Dừng container',
  dockerRestart: 'Khởi động lại container',
  composeUp: 'Compose up',
  composePullUp: 'Compose pull + up',
  composeRestart: 'Compose restart',
  composeDown: 'Compose down',
  dockerDaemonStart: 'Khởi động Docker',
  imagePrune: 'Dọn image Docker',
  volumeRemove: 'Xoá volume',
  serviceStart: 'Chạy dịch vụ',
  serviceStop: 'Dừng dịch vụ',
  serviceRestart: 'Khởi động lại dịch vụ',
  serviceEnable: 'Bật tự khởi động',
  serviceDisable: 'Tắt tự khởi động',
  serviceResetFailed: 'Xoá trạng thái lỗi',
  ufwAdd: 'Thêm rule firewall',
  ufwDelete: 'Xoá rule firewall',
  ufwReplace: 'Sửa rule firewall',
  ufwEnable: 'Bật firewall',
  ufwDisable: 'Tắt firewall',
  fwAdd: 'Thêm rule firewall',
  fwDelete: 'Xoá rule firewall',
  fwReplace: 'Sửa rule firewall',
  fwEnable: 'Bật firewall',
  fwDisable: 'Tắt firewall',
  tunnelStart: 'Bật tunnel',
  logTail: 'Theo dõi log',
  tunnelStop: 'Tắt tunnel',
}

const pad = (n: number) => String(n).padStart(2, '0')
export function auditTime(ms: number, withSeconds = false) {
  const d = new Date(ms)
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}${withSeconds ? `:${pad(d.getSeconds())}` : ''}`
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${time}`
}

const COLS = '90px minmax(0,1fr) minmax(0,1.4fr) 96px'

/** "Thao tác qua Portway": what Portway did on this server for the user. */
export function AuditCard({ server, user }: { server: Server; user: string }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(() => readCache<AuditEntry[]>(server.id, user, 'audit')?.data ?? null)
  const [open, setOpen] = useState<AuditEntry | null>(null)

  useEffect(() => {
    let alive = true
    const load = () =>
      api
        .auditList(server.id, 8)
        .then((e) => {
          if (!alive) return
          setEntries(e)
          writeCache(server.id, user, 'audit', e, new Date())
        })
        .catch(() => alive && setEntries([]))
    void load()
    // Local and cheap: follow new entries (connects, sudo, terminal…) quickly.
    const t = setInterval(load, 3000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [server.id, user])

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-[15px] font-semibold">Thao tác qua Portway</span>
        <span className="text-[11px] text-muted">Chỉ gồm lệnh Portway chạy thay bạn, không bao gồm lệnh gõ trực tiếp trong Terminal.</span>
      </div>
      {entries?.length === 0 && <span className="border-t border-line pt-2.5 text-muted">Chưa có thao tác nào trên server này.</span>}
      {entries?.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => setOpen(a)}
          className="grid w-full cursor-pointer items-center gap-3 border-t border-line px-0.5 py-[7px] text-left hover:bg-raised"
          style={{ gridTemplateColumns: COLS }}
        >
          <span className="num text-muted">{auditTime(a.at)}</span>
          <span className="truncate">
            {AUDIT_ACTIONS[a.action] ?? a.action}
            {a.user && <span className="text-muted"> · {a.user}</span>}
          </span>
          <span className="truncate font-mono text-[11.5px] text-ink2">{a.command}</span>
          <span className="flex justify-end">
            <Chip tone={a.ok ? TONES.success : TONES.danger}>{a.ok ? 'Thành công' : 'Thất bại'}</Chip>
          </span>
        </button>
      ))}

      {open && (
        <Modal
          open
          onClose={() => setOpen(null)}
          width={520}
          title={AUDIT_ACTIONS[open.action] ?? open.action}
          subtitle={`${open.user}@${server.name} · ${auditTime(open.at, true)}`}
          footer={<Button onClick={() => setOpen(null)}>Đóng</Button>}
        >
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted">Kết quả</span>
            <Chip tone={open.ok ? TONES.success : TONES.danger}>{open.ok ? 'Thành công' : 'Thất bại'}</Chip>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-muted">Lệnh</span>
            <span className="rounded-md bg-sunken px-2 py-1.5 font-mono text-[11.5px] break-all text-ink2 select-text">{open.command}</span>
          </div>
          {open.detail && (
            <div className="flex flex-col gap-1">
              <span className="text-[11px] text-muted">{open.ok ? 'Chi tiết' : 'Lỗi'}</span>
              <span className="rounded-md bg-sunken px-2 py-1.5 font-mono text-[11.5px] break-all whitespace-pre-wrap text-ink2 select-text">{open.detail}</span>
            </div>
          )}
        </Modal>
      )}
    </div>
  )
}
