import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, type ImportReport, type Server, type ServerInput, type SshKey } from '../lib/api'

type Servers = {
  servers: Server[]
  keys: SshKey[]
  loading: boolean
  /** Set when the saved list could not be read. */
  loadError: string | null
  byId: (id: string) => Server | undefined
  save: (input: ServerInput) => Promise<Server>
  remove: (id: string) => Promise<void>
  importSshConfig: () => Promise<ImportReport>
  reloadKeys: () => Promise<void>
}

const ServersContext = createContext<Servers | null>(null)

/** Saved servers and SSH keys, loaded from the Rust side once at startup and
 *  kept in sync after every change. */
export function ServersProvider({ children }: { children: ReactNode }) {
  const [servers, setServers] = useState<Server[]>([])
  const [keys, setKeys] = useState<SshKey[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const reloadKeys = useCallback(async () => setKeys(await api.listKeys()), [])

  useEffect(() => {
    Promise.all([api.listServers(), api.listKeys()])
      .then(([s, k]) => {
        setServers(s)
        setKeys(k)
      })
      .catch((e) => setLoadError(String(e?.detail ?? e?.code ?? e)))
      .finally(() => setLoading(false))
  }, [])

  const save = async (input: ServerInput) => {
    const saved = await api.saveServer(input)
    setServers((list) => (list.some((s) => s.id === saved.id) ? list.map((s) => (s.id === saved.id ? saved : s)) : [...list, saved]))
    return saved
  }

  const remove = async (id: string) => {
    await api.deleteServer(id)
    setServers((list) => list.filter((s) => s.id !== id))
  }

  const importSshConfig = async () => {
    const report = await api.importSshConfig()
    if (report.added.length) setServers((list) => [...list, ...report.added])
    return report
  }

  return (
    <ServersContext.Provider
      value={{
        servers,
        keys,
        loading,
        loadError,
        byId: (id) => servers.find((s) => s.id === id),
        save,
        remove,
        importSshConfig,
        reloadKeys,
      }}
    >
      {children}
    </ServersContext.Provider>
  )
}

export function useServers() {
  const ctx = useContext(ServersContext)
  if (!ctx) throw new Error('useServers must be used inside <ServersProvider>')
  return ctx
}
