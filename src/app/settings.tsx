import { isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, type Settings } from '../lib/api'
import { applyTheme } from '../lib/theme'
import { getLang, setLang } from '../i18n'

type Ctx = {
  settings: Settings
  /** Save a change; rejects with the app error when it is not valid. */
  update: (patch: Partial<Settings>) => Promise<Settings>
}

const DEFAULTS: Settings = { language: getLang(), downloadDir: null, askDownload: null, theme: 'dark', editor: null, openWith: {} }

/** Whether downloads ask for a folder, with older settings files read as they worked. */
export const asksDownload = (s: Settings) => s.askDownload ?? s.downloadDir === null
const SettingsContext = createContext<Ctx | null>(null)

/** App preferences, kept in settings.json by the Rust side. */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULTS)

  useEffect(() => {
    void api.settings().then(setSettings).catch(() => {})
    if (!isTauri()) return
    const off = listen<Settings>('settings', (e) => setSettings(e.payload))
    return () => {
      void off.then((f) => f())
    }
  }, [])

  const update = async (patch: Partial<Settings>) => {
    const next = await api.setSettings({ ...settings, ...patch })
    setSettings(next)
    applyTheme(next.theme)
    setLang(next.language)
    return next
  }

  return <SettingsContext.Provider value={{ settings, update }}>{children}</SettingsContext.Provider>
}

export function useSettings() {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings must be used inside <SettingsProvider>')
  return ctx
}
