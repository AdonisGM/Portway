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

/** Where to save a download: the folder set in Cài đặt, or ask, opening at
 *  the folder picked last time (or ~/Downloads). Null when the user cancels. */
export async function chooseDownloadDir(count: number): Promise<string | null> {
  const fixed = (await api.settings().catch(() => null))?.downloadDir
  if (fixed) return fixed
  const picked = await open({
    directory: true,
    canCreateDirectories: true,
    title: count === 1 ? 'Chọn nơi lưu tệp tải xuống' : `Chọn nơi lưu ${count} mục tải xuống`,
    defaultPath: readLast() ?? (await downloadDir()),
  })
  if (typeof picked !== 'string') return null
  try {
    localStorage.setItem(LAST_KEY, picked)
  } catch {
    // Remembering the folder is a convenience only.
  }
  return picked
}
