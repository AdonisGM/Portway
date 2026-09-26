import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, type GenerateKeyInput, type ImportReport, type Server, type ServerInput, type SshKey } from '../lib/api'

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
  /** Re-read ~/.ssh and report what changed since the last read. */
  reloadKeys: () => Promise<{ total: number; added: SshKey[]; removed: SshKey[] }>
  generateKey: (input: GenerateKeyInput) => Promise<SshKey>
  setPinned: (id: string, pinned: boolean) => Promise<void>
  setWatchedUnits: (id: string, units: string[]) => Promise<void>
  /** An empty name removes the display name. */
  setUnitName: (id: string, unit: string, name: string) => Promise<void>
  /** Re-read the saved list (e.g. after the Rust side recorded a detected OS). */
  refresh: () => Promise<void>
}

const ServersContext = createContext<Servers | null>(null)

/** Saved servers and SSH keys, loaded from the Rust side once at startup and
 *  kept in sync after every change. */
export function ServersProvider({ children }: { children: ReactNode }) {
  const [servers, setServers] = useState<Server[]>([])
  const [keys, setKeys] = useState<SshKey[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Latest key list for reloadKeys, which compares against it after an await.
  const keysRef = useRef(keys)
  keysRef.current = keys

  const reloadKeys = useCallback(async () => {
    const next = await api.listKeys()
    const prev = keysRef.current
    const added = next.filter((k) => !prev.some((p) => p.path === k.path))
    const removed = prev.filter((p) => !next.some((k) => k.path === p.path))
    setKeys(next)
    return { total: next.length, added, removed }
  }, [])

  const refresh = useCallback(async () => setServers(await api.listServers()), [])

  const setPinned = async (id: string, pinned: boolean) => {
    const saved = await api.setPinned(id, pinned)
    setServers((list) => list.map((s) => (s.id === id ? saved : s)))
  }

  const setWatchedUnits = async (id: string, units: string[]) => {
    const saved = await api.setWatchedUnits(id, units)
    setServers((list) => list.map((s) => (s.id === id ? saved : s)))
  }

  const setUnitName = async (id: string, unit: string, name: string) => {
    const saved = await api.setUnitName(id, unit, name)
    setServers((list) => list.map((s) => (s.id === id ? saved : s)))
  }

  const generateKey = async (input: GenerateKeyInput) => {
    const key = await api.generateKey(input)
    setKeys((list) => [...list, key].sort((a, b) => a.name.localeCompare(b.name)))
    return key
  }

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
        generateKey,
        setPinned,
        setWatchedUnits,
        setUnitName,
        refresh,
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
