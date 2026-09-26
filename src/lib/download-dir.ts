import { downloadDir } from '@tauri-apps/api/path'
import { open } from '@tauri-apps/plugin-dialog'

const LAST_KEY = 'portway.lastDownloadDir'

function readLast(): string | null {
  try {
    return localStorage.getItem(LAST_KEY)
  } catch {
    return null
  }
}

/** Ask where to save a download. Opens at the folder picked last time (or
 *  ~/Downloads). Returns null when the user cancels. A default folder from
 *  the settings screen will be able to skip this question later. */
export async function chooseDownloadDir(count: number): Promise<string | null> {
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
