import { downloadDir } from '@tauri-apps/api/path'
import { open } from '@tauri-apps/plugin-dialog'
import { api } from './api'

const LAST_KEY = 'portway.lastDownloadDir'

function readLast(): string | null {
  try {
    return localStorage.getItem(LAST_KEY)
  } catch {
    return null
  }
}

/** Where to save a download: the default folder from Cài đặt (~/Downloads
 *  if none), or, when set to ask, the folder the user picks, opening at the
 *  default one (or the one picked last). Null when the user cancels. */
export async function chooseDownloadDir(count: number): Promise<string | null> {
  const s = await api.settings().catch(() => null)
  const base = s?.downloadDir ?? (await downloadDir())
  const ask = s ? (s.askDownload ?? s.downloadDir === null) : true
  if (!ask) return base
  const picked = await open({
    directory: true,
    canCreateDirectories: true,
    title: count === 1 ? 'Chọn nơi lưu tệp tải xuống' : `Chọn nơi lưu ${count} mục tải xuống`,
    defaultPath: s?.downloadDir ?? readLast() ?? base,
  })
  if (typeof picked !== 'string') return null
  try {
    localStorage.setItem(LAST_KEY, picked)
  } catch {
    // Remembering the folder is a convenience only.
  }
  return picked
}
