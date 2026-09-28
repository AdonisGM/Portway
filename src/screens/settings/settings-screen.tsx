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
import { pickApp } from '../../lib/pick-app'
import { t } from '../../i18n'
import { isWindows, localBaseName } from '../../lib/platform'

/** Select value for "no app chosen" (the select treats '' as nothing chosen). */
const DEFAULT_EDITOR = 'default'
const PICK = 'pick'

/** "~/Downloads" for a folder under the home folder. */
/** "~/Downloads" for a folder under the home folder ("~\\Downloads" on Windows). */
const shownDir = (dir: string, home: string) => (home && (dir.startsWith(home + '/') || (isWindows && dir.startsWith(home + '\\'))) ? '~' + dir.slice(home.length) : dir)

const errText = (e: unknown) =>
  isAppError(e)
    ? e.code === 'not_a_dir'
      ? t('{path} không phải thư mục', { path: e.detail ?? '' })
      : e.code === 'invalid_ext'
        ? t('{ext} không phải đuôi tệp hợp lệ', { ext: e.detail ?? '' })
        : e.code === 'not_an_app'
          ? t('{path} không phải một ứng dụng (.app)', { path: e.detail ?? '' })
          : (e.detail ?? e.code)
    : String(e)

/** "Cài đặt": downloads, appearance, the server list as a file, version. */
export function SettingsScreen() {
  const { settings, update } = useSettings()
  const { servers, refresh } = useServers()
  const { apps, refreshApps } = useEdits()
  const systemEditor = apps.find((a) => a.default)
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
    void downloadDir().then((d) => setSystemDownloads(d.replace(/[\\/]+$/, '')))
    void homeDir().then((d) => setHome(d.replace(/[\\/]+$/, '')))
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
      const picked = await open({ directory: true, canCreateDirectories: true, title: t('Thư mục tải về mặc định'), defaultPath: settings.downloadDir ?? (await downloadDir()) })
      if (typeof picked === 'string') await update({ downloadDir: picked })
    }, t('Không lưu được thư mục'))

  const exportServers = () =>
    run(async () => {
      const day = new Date().toISOString().slice(0, 10)
      const path = await save({ title: t('Xuất danh sách server'), defaultPath: `portway-servers-${day}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] })
      if (!path) return
      const n = await api.exportServers(path)
      toast({ title: t('Đã xuất {n} server', { n }), detail: path })
    }, t('Không xuất được'))

  const importServers = () =>
    run(async () => {
      const path = await open({ title: t('Nhập danh sách server'), filters: [{ name: 'JSON', extensions: ['json'] }] })
      if (typeof path !== 'string') return
      const r = await api.importServersFile(path)
      refresh()
      toast({
        title: r.added.length ? t('Đã thêm {n} server', { n: r.added.length }) : t('Không có server mới'),
        detail: r.skipped.length
          ? t('Bỏ qua {n} server trùng tên: {names}', { n: r.skipped.length, names: r.skipped.join(', ') })
          : t('{n} server trong tệp', { n: r.found }),
      })
    }, t('Không nhập được'))

  return (
    <div className="flex max-w-[760px] flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-[23px] font-semibold">{t('Cài đặt')}</span>
        <span className="text-muted">{t('Lưu trên máy này, áp dụng ngay cho mọi cửa sổ của Portway.')}</span>
      </div>

      <Section id="language" title={t('Ngôn ngữ')}>
        <Row label={t('Ngôn ngữ giao diện')} hint={t('Áp dụng ngay cho mọi màn hình và thông báo, không ngắt các kết nối đang mở.')}>
          <SegmentedControl<'vi' | 'en'>
            value={settings.language}
            onChange={(language) => void run(() => update({ language }), t('Không lưu được'))}
            options={[
              { id: 'vi', label: 'Tiếng Việt' }, // i18n-ignore: a language's own name
              { id: 'en', label: 'English' },
            ]}
          />
        </Row>
      </Section>

      <Section id="download" title={t('Tải xuống#section')}>
        <Row label={t('Thư mục tải về mặc định')} hint={shownDir(settings.downloadDir ?? systemDownloads, home) || '…'} mono>
          <div className="flex gap-1.5">
            <Button size="sm" disabled={!(settings.downloadDir ?? systemDownloads)} onClick={() => void revealItemInDir(settings.downloadDir ?? systemDownloads)}>
              {t('Mở trong Finder')}
            </Button>
            <Button size="sm" onClick={() => void pickDownloadDir()}>
              {t('Chọn thư mục…')}
            </Button>
            {settings.downloadDir && (
              <Button size="sm" variant="ghost" title={t('Về thư mục Downloads của máy')} onClick={() => void run(() => update({ downloadDir: null }), t('Không lưu được'))}>
                {t('Dùng Downloads')}
              </Button>
            )}
          </div>
        </Row>
        <Row
          label={t('Hỏi nơi lưu mỗi lần tải')}
          hint={
            ask
              ? t('Mỗi lần tải sẽ mở hộp chọn thư mục, mở sẵn ở thư mục mặc định.')
              : t('Tệp được lưu thẳng vào thư mục mặc định, không hỏi. Tên trùng được thêm (1), (2)…')
          }
        >
          <SegmentedControl
            value={ask ? 'ask' : 'direct'}
            onChange={(v) => void run(() => update({ askDownload: v === 'ask' }), t('Không lưu được'))}
            options={[
              { id: 'ask', label: t('Hỏi mỗi lần') },
              { id: 'direct', label: t('Lưu thẳng') },
            ]}
          />
        </Row>
      </Section>

      <Section id="editor" title={t('Sửa tệp#section')}>
        <Row
          label={t('Tệp chữ')}
          hint={t('Tệp cấu hình, mã nguồn, log… mở bằng app này, trừ loại tệp đã có app riêng bên dưới. Tệp được tải về thư mục tạm riêng cho từng server và user; mỗi lần lưu trong app, Portway tải lên lại.')}
        >
          <SelectField
            value={settings.editor ?? DEFAULT_EDITOR}
            onChange={(v) =>
              void run(async () => {
                if (v !== PICK) return update({ editor: v === DEFAULT_EDITOR ? null : v })
                const app = await pickApp(t('Chọn app để sửa tệp của server'))
                if (app) {
                  await update({ editor: app })
                  refreshApps()
                }
              }, t('Không lưu được'))
            }
            options={[
              { value: DEFAULT_EDITOR, label: systemEditor ? t('Mặc định của macOS ({app})', { app: systemEditor.name }) : t('Mặc định của macOS') },
              ...apps.map((a) => ({ value: a.path, label: a.name })),
              { value: PICK, label: t('Chọn app khác…') },
            ]}
            className="!w-64"
          />
        </Row>
        <Row
          label={t('Theo loại tệp')}
          hint={t('Lần đầu mở một loại tệp khác (Word, Excel, PDF, ảnh…), Portway dùng app mặc định của máy cho loại đó rồi ghi nhớ ở đây. App chọn bằng "Mở bằng app khác…" cũng được ghi nhớ.')}
        >
          {!Object.keys(settings.openWith).length && <span className="text-[11.5px] text-muted">{t('Chưa có loại tệp nào')}</span>}
        </Row>
        {Object.entries(settings.openWith)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([ext, app]) => (
            <div key={ext} className="flex items-center gap-3 border-t border-line px-4 py-2">
              <span className="w-24 flex-none font-mono text-[12px]">.{ext}</span>
              <span className="min-w-0 flex-1 truncate" title={app}>
                {apps.find((a) => a.path === app)?.name ?? localBaseName(app).replace(/\.(app|exe)$/i, '')}
              </span>
              <Button
                size="xs"
                onClick={() =>
                  void run(async () => {
                    const picked = await pickApp(t('Mở tệp .{ext} bằng…', { ext }))
                    if (picked) await update({ openWith: { ...settings.openWith, [ext]: picked } })
                  }, t('Không lưu được'))
                }
              >
                {t('Đổi…')}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                title={t('Lần sau mở tệp .{ext}, Portway lại dùng app mặc định của máy', { ext })}
                onClick={() =>
                  void run(async () => {
                    const { [ext]: _gone, ...rest } = settings.openWith
                    await update({ openWith: rest })
                  }, t('Không lưu được'))
                }
              >
                {t('Bỏ')}
              </Button>
            </div>
          ))}
      </Section>

      <Section id="appearance" title={t('Giao diện')}>
        <Row label={t('Chế độ màu')} hint={settings.theme === 'system' ? t('Đổi theo cài đặt Sáng/Tối của macOS.') : undefined}>
          <SegmentedControl<Theme>
            value={settings.theme}
            onChange={(theme) => void run(() => update({ theme }), t('Không lưu được'))}
            options={[
              { id: 'dark', label: t('Tối') },
              { id: 'light', label: t('Sáng') },
              { id: 'system', label: t('Theo macOS') },
            ]}
          />
        </Row>
      </Section>

      <Section id="data" title={t('Dữ liệu')}>
        <Row
          label={t('Danh sách server')}
          hint={t('{n} server. Tệp xuất gồm host, cổng, user, nhóm, tag, ghi chú và đường dẫn khoá; mật khẩu và passphrase ở lại Keychain của máy này.', { n: servers.length })}
        >
          <div className="flex gap-1.5">
            <Button size="sm" onClick={() => void importServers()}>
              {t('Nhập từ tệp…')}
            </Button>
            <Button size="sm" onClick={() => void exportServers()} disabled={!servers.length}>
              {t('Xuất ra tệp…')}
            </Button>
          </div>
        </Row>
        <Row label={t('Thư mục dữ liệu')} hint={dataPath || '—'} mono>
          <Button size="sm" disabled={!dataPath} onClick={() => void revealItemInDir(dataPath)}>
            {t('Mở trong Finder')}
          </Button>
        </Row>
      </Section>

      <Section id="about" title={t('Giới thiệu')}>
        <Row label="Portway" hint={t('Quản lý server qua SSH · AdonisGM')}>
          <span className="num text-ink2">{version ? t('Phiên bản {version}', { version }) : ''}</span>
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
