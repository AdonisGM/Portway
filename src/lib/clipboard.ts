import { isTauri } from '@tauri-apps/api/core'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'

/** Copy text through the Tauri clipboard plugin, or the browser API outside Tauri. */
export async function copyText(text: string) {
  if (isTauri()) await writeText(text)
  else await navigator.clipboard.writeText(text)
}
