import { useEffect, useState } from 'react'
import { readCache, writeCache } from '../../app/session-cache'
import { Modal } from '../../components/ui/modal'
import { Button, Chip, TONES } from '../../components/ui/primitives'
import { api, type AuditEntry, type Server } from '../../lib/api'
import { t } from '../../i18n'
import { dayMonth, hm, hms } from '../../i18n/dates'

/** Label of an audit action; a function so it follows the current language. */
export const auditActions = (): Record<string, string> => ({
  connect: t('Kết nối'),
  reconnect: t('Kết nối lại'),
  disconnect: t('Ngắt kết nối'),
  trustHostKey: t('Tin tưởng khoá máy chủ'),
  openTerminal: t('Mở Terminal'),
  sudoOn: t('Bật sudo'),
  sudoOff: t('Tắt sudo'),
  mkdir: t('Tạo thư mục'),
  touch: t('Tạo tệp'),
  rename: t('Đổi tên'),
  remove: t('Xoá'),
  chmod: t('Sửa quyền'),
  chown: t('Đổi owner'),
  download: t('Tải xuống'),
  upload: t('Tải lên'),
  copy: t('Chép giữa server'),
  dockerStart: t('Chạy container'),
  dockerStop: t('Dừng container'),
  dockerRestart: t('Khởi động lại container'),
  composeUp: 'Compose up',
  composePullUp: 'Compose pull + up',
  composeRestart: 'Compose restart',
  composeDown: 'Compose down',
  dockerDaemonStart: t('Khởi động Docker'),
  imagePrune: t('Dọn image Docker'),
  volumeRemove: t('Xoá volume'),
  serviceStart: t('Chạy dịch vụ'),
  serviceStop: t('Dừng dịch vụ'),
  serviceRestart: t('Khởi động lại dịch vụ'),
  serviceEnable: t('Bật tự khởi động'),
  serviceDisable: t('Tắt tự khởi động'),
  serviceResetFailed: t('Xoá trạng thái lỗi'),
  ufwAdd: t('Thêm rule firewall'),
  ufwDelete: t('Xoá rule firewall'),
  ufwReplace: t('Sửa rule firewall'),
  ufwEnable: t('Bật firewall'),
  ufwDisable: t('Tắt firewall'),
  fwAdd: t('Thêm rule firewall'),
  fwDelete: t('Xoá rule firewall'),
  fwReplace: t('Sửa rule firewall'),
  fwEnable: t('Bật firewall'),
  fwDisable: t('Tắt firewall'),
  tunnelStart: t('Bật tunnel'),
  logTail: t('Theo dõi log'),
  tunnelStop: t('Tắt tunnel'),
})

export function auditTime(ms: number, withSeconds = false) {
  const d = new Date(ms)
  return `${dayMonth(d)} ${withSeconds ? hms(d) : hm(d)}`
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
    const timer = setInterval(load, 3000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [server.id, user])

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-[15px] font-semibold">{t('Thao tác qua Portway')}</span>
        <span className="text-[11px] text-muted">{t('Chỉ gồm lệnh Portway chạy thay bạn, không bao gồm lệnh gõ trực tiếp trong Terminal.')}</span>
      </div>
      {entries?.length === 0 && <span className="border-t border-line pt-2.5 text-muted">{t('Chưa có thao tác nào trên server này.')}</span>}
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
            {auditActions()[a.action] ?? a.action}
            {a.user && <span className="text-muted"> · {a.user}</span>}
          </span>
          <span className="truncate font-mono text-[11.5px] text-ink2">{a.command}</span>
          <span className="flex justify-end">
            <Chip tone={a.ok ? TONES.success : TONES.danger}>{a.ok ? t('Thành công') : t('Thất bại')}</Chip>
          </span>
        </button>
      ))}

      {open && (
        <Modal
          open
          onClose={() => setOpen(null)}
          width={520}
          title={auditActions()[open.action] ?? open.action}
          subtitle={`${open.user}@${server.name} · ${auditTime(open.at, true)}`}
          footer={<Button onClick={() => setOpen(null)}>{t('Đóng')}</Button>}
        >
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted">{t('Kết quả')}</span>
            <Chip tone={open.ok ? TONES.success : TONES.danger}>{open.ok ? t('Thành công') : t('Thất bại')}</Chip>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-muted">{t('Lệnh')}</span>
            <span className="rounded-md bg-sunken px-2 py-1.5 font-mono text-[11.5px] break-all text-ink2 select-text">{open.command}</span>
          </div>
          {open.detail && (
            <div className="flex flex-col gap-1">
              <span className="text-[11px] text-muted">{open.ok ? t('Chi tiết') : t('Lỗi')}</span>
              <span className="rounded-md bg-sunken px-2 py-1.5 font-mono text-[11.5px] break-all whitespace-pre-wrap text-ink2 select-text">{open.detail}</span>
            </div>
          )}
        </Modal>
      )}
    </div>
  )
}
