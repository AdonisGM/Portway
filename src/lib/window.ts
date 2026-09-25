import { invoke, isTauri } from '@tauri-apps/api/core'

/** Show or hide the native macOS traffic lights. No-op outside the Tauri window
 *  (e.g. when the UI is opened in a plain browser during development). */
export function setWindowControlsVisible(visible: boolean) {
  if (!isTauri()) return
  invoke('set_window_controls_visible', { visible }).catch(() => {})
}
