import { getVersion } from '@tauri-apps/api/app'
import { isTauri } from '@tauri-apps/api/core'
import { downloadDir, homeDir } from '@tauri-apps/api/path'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { open, save } from '@tauri-apps/plugin-dialog'
import { useEffect, useState, type ReactNode } from 'react'
import { useServers } from '../../app/servers'
import { useEdits } from '../../app/edits'
import { asksDownload, useSettings } from '../../app/settings'
import { useToast } from '../../components/toast'
import { SelectField } from '../../components/ui/form-controls'
import { Button } from '../../components/ui/primitives'
import { SegmentedControl } from '../../components/ui/segmented'
import { api, isAppError, type Theme } from '../../lib/api'

/** Select value for "no app chosen" (the select treats '' as nothing chosen). */
const DEFAULT_EDITOR = 'default'

/** "~/Downloads" for a folder under the home folder. */
const shownDir = (dir: string, home: string) => (home && dir.startsWith(home + '/') ? '~' + dir.slice(home.length) : dir)

const errText = (e: unknown) => (isAppError(e) ? (e.code === 'not_a_dir' ? `${e.detail} không phải thư mục` : (e.detail ?? e.code)) : String(e))

/** "Cài đặt": downloads, appearance, the server list as a file, version. */
export function SettingsScreen() {
  const { settings, update } = useSettings()
  const { servers, refresh } = useServers()
  const { apps } = useEdits()
  const toast = useToast()
  const [dataPath, setDataPath] = useState('')
  const [version, setVersion] = useState('')
  // macOS's own Downloads folder, used while no default is chosen.
  const [systemDownloads, setSystemDownloads] = useState('')
  const [home, setHome] = useState('')
  const ask = asksDownload(settings)

  useEffect(() => {
    if (!isTauri()) return
    void api.appDataPath().then(setDataPath).catch(() => {})
    void getVersion().then(setVersion)
    void downloadDir().then((d) => setSystemDownloads(d.replace(/\/+$/, '')))
    void homeDir().then((d) => setHome(d.replace(/\/+$/, '')))
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
      const picked = await open({ directory: true, canCreateDirectories: true, title: 'Thư mục tải về mặc định', defaultPath: settings.downloadDir ?? (await downloadDir()) })
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
        <Row label="Thư mục tải về mặc định" hint={shownDir(settings.downloadDir ?? systemDownloads, home) || '…'} mono>
          <div className="flex gap-1.5">
            <Button size="sm" disabled={!(settings.downloadDir ?? systemDownloads)} onClick={() => void revealItemInDir(settings.downloadDir ?? systemDownloads)}>
              Mở trong Finder
            </Button>
            <Button size="sm" onClick={() => void pickDownloadDir()}>
              Chọn thư mục…
            </Button>
            {settings.downloadDir && (
              <Button size="sm" variant="ghost" title="Về thư mục Downloads của máy" onClick={() => void run(() => update({ downloadDir: null }), 'Không lưu được')}>
                Dùng Downloads
              </Button>
            )}
          </div>
        </Row>
        <Row
          label="Hỏi nơi lưu mỗi lần tải"
          hint={
            ask
              ? 'Mỗi lần tải sẽ mở hộp chọn thư mục, mở sẵn ở thư mục mặc định.'
              : 'Tệp được lưu thẳng vào thư mục mặc định, không hỏi. Tên trùng được thêm (1), (2)…'
          }
        >
          <SegmentedControl
            value={ask ? 'ask' : 'direct'}
            onChange={(v) => void run(() => update({ askDownload: v === 'ask' }), 'Không lưu được')}
            options={[
              { id: 'ask', label: 'Hỏi mỗi lần' },
              { id: 'direct', label: 'Lưu thẳng' },
            ]}
          />
        </Row>
      </Section>

      <Section id="editor" title="Sửa tệp">
        <Row
          label="Mở tệp của server bằng"
          hint="Tệp được tải về thư mục tạm riêng cho từng server và user; mỗi lần lưu trong app, Portway tải lên lại. Bấm đúp một tệp trong màn Tệp để mở."
        >
          <SelectField
            value={settings.editor ?? DEFAULT_EDITOR}
            onChange={(v) => void run(() => update({ editor: v === DEFAULT_EDITOR ? null : v }), 'Không lưu được')}
            options={[{ value: DEFAULT_EDITOR, label: 'Editor mặc định của macOS' }, ...apps.map((a) => ({ value: a.path, label: a.name }))]}
            className="w-56"
          />
        </Row>
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
