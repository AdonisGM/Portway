import { getVersion } from '@tauri-apps/api/app'
import { isTauri } from '@tauri-apps/api/core'
import { downloadDir } from '@tauri-apps/api/path'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { open, save } from '@tauri-apps/plugin-dialog'
import { useEffect, useState, type ReactNode } from 'react'
import { useServers } from '../../app/servers'
import { useSettings } from '../../app/settings'
import { useToast } from '../../components/toast'
import { Button } from '../../components/ui/primitives'
import { SegmentedControl } from '../../components/ui/segmented'
import { api, isAppError, type Theme } from '../../lib/api'

const errText = (e: unknown) => (isAppError(e) ? (e.code === 'not_a_dir' ? `${e.detail} không phải thư mục` : (e.detail ?? e.code)) : String(e))

/** "Cài đặt": downloads, appearance, the server list as a file, version. */
export function SettingsScreen() {
  const { settings, update } = useSettings()
  const { servers, refresh } = useServers()
  const toast = useToast()
  const [dataPath, setDataPath] = useState('')
  const [version, setVersion] = useState('')

  useEffect(() => {
    if (!isTauri()) return
    void api.appDataPath().then(setDataPath).catch(() => {})
    void getVersion().then(setVersion)
  }, [])

  const run = async (what: () => Promise<unknown>, fail: string) => {
    try {
      await what()
    } catch (e) {
      toast({ title: fail, detail: errText(e) })
    }
  }

  const pickDownloadDir = () =>
    run(async () => {
      const picked = await open({ directory: true, canCreateDirectories: true, title: 'Thư mục lưu tệp tải xuống', defaultPath: settings.downloadDir ?? (await downloadDir()) })
      if (typeof picked === 'string') await update({ downloadDir: picked })
    }, 'Không lưu được thư mục')

  const exportServers = () =>
    run(async () => {
      const day = new Date().toISOString().slice(0, 10)
      const path = await save({ title: 'Xuất danh sách server', defaultPath: `portway-servers-${day}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] })
      if (!path) return
      const n = await api.exportServers(path)
      toast({ title: `Đã xuất ${n} server`, detail: path })
    }, 'Không xuất được')

  const importServers = () =>
    run(async () => {
      const path = await open({ title: 'Nhập danh sách server', filters: [{ name: 'JSON', extensions: ['json'] }] })
      if (typeof path !== 'string') return
      const r = await api.importServersFile(path)
      refresh()
      toast({
        title: r.added.length ? `Đã thêm ${r.added.length} server` : 'Không có server mới',
        detail: r.skipped.length ? `Bỏ qua ${r.skipped.length} server trùng tên: ${r.skipped.join(', ')}` : `${r.found} server trong tệp`,
      })
    }, 'Không nhập được')

  return (
    <div className="flex max-w-[760px] flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-[23px] font-semibold">Cài đặt</span>
        <span className="text-muted">Lưu trên máy này, áp dụng ngay cho mọi cửa sổ của Portway.</span>
      </div>

      <Section id="download" title="Tải xuống">
        <Row
          label="Khi tải tệp từ server"
          hint={settings.downloadDir ? 'Tệp được lưu thẳng vào thư mục bên dưới, không hỏi lại. Tên trùng được thêm (1), (2)…' : 'Mỗi lần tải sẽ hỏi nơi lưu, mở sẵn ở thư mục chọn lần trước.'}
        >
          <SegmentedControl
            value={settings.downloadDir ? 'fixed' : 'ask'}
            onChange={(v) => (v === 'ask' ? void run(() => update({ downloadDir: null }), 'Không lưu được') : void pickDownloadDir())}
            options={[
              { id: 'ask', label: 'Hỏi mỗi lần' },
              { id: 'fixed', label: 'Luôn lưu vào một thư mục' },
            ]}
          />
        </Row>
        {settings.downloadDir && (
          <Row label="Thư mục lưu" hint={settings.downloadDir} mono>
            <div className="flex gap-1.5">
              <Button size="sm" onClick={() => void revealItemInDir(settings.downloadDir!)}>
                Mở trong Finder
              </Button>
              <Button size="sm" onClick={() => void pickDownloadDir()}>
                Đổi thư mục…
              </Button>
            </div>
          </Row>
        )}
      </Section>

      <Section id="appearance" title="Giao diện">
        <Row label="Chế độ màu" hint={settings.theme === 'system' ? 'Đổi theo cài đặt Sáng/Tối của macOS.' : undefined}>
          <SegmentedControl<Theme>
            value={settings.theme}
            onChange={(theme) => void run(() => update({ theme }), 'Không lưu được')}
            options={[
              { id: 'dark', label: 'Tối' },
              { id: 'light', label: 'Sáng' },
              { id: 'system', label: 'Theo macOS' },
            ]}
          />
        </Row>
      </Section>

      <Section id="data" title="Dữ liệu">
        <Row
          label="Danh sách server"
          hint={`${servers.length} server. Tệp xuất gồm host, cổng, user, nhóm, tag, ghi chú và đường dẫn khoá; mật khẩu và passphrase ở lại Keychain của máy này.`}
        >
          <div className="flex gap-1.5">
            <Button size="sm" onClick={() => void importServers()}>
              Nhập từ tệp…
            </Button>
            <Button size="sm" onClick={() => void exportServers()} disabled={!servers.length}>
              Xuất ra tệp…
            </Button>
          </div>
        </Row>
        <Row label="Thư mục dữ liệu" hint={dataPath || '—'} mono>
          <Button size="sm" disabled={!dataPath} onClick={() => void revealItemInDir(dataPath)}>
            Mở trong Finder
          </Button>
        </Row>
      </Section>

      <Section id="about" title="Giới thiệu">
        <Row label="Portway" hint="Quản lý server qua SSH · AdonisGM">
          <span className="num text-ink2">{version ? `Phiên bản ${version}` : ''}</span>
        </Row>
      </Section>
    </div>
  )
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={`settings-${id}`} className="flex scroll-mt-2 flex-col gap-2">
      <span className="text-[11px] tracking-[.06em] text-muted uppercase">{title}</span>
      <div className="flex flex-col rounded-xl border border-line bg-surface">{children}</div>
    </section>
  )
}

function Row({ label, hint, mono, children }: { label: string; hint?: string; mono?: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3 first:border-t-0">
      <div className="flex min-w-[240px] flex-1 flex-col gap-0.5">
        <span className="font-medium">{label}</span>
        {hint && <span className={`text-[11.5px] leading-normal text-muted [overflow-wrap:anywhere] ${mono ? 'font-mono' : ''}`}>{hint}</span>}
      </div>
      {children}
    </div>
  )
}
