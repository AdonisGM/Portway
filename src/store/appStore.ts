import { create } from 'zustand'
import * as api from '@/lib/api'
import * as ssh from '@/lib/sshBus'
import type { KeyFile } from '@/lib/api'
import type { AuthMethod, GroupId, Host, HostInput, Session, SessionStatus } from '@/data/types'

export type Screen = 'servers' | 'session' | 'form' | 'keys' | 'tunnels' | 'known' | 'settings'
export type HostFilter = 'all' | 'recent' | 'favorites'

/**
 * Which host the form is editing, if any. `new` with a `prefill` is what
 * Duplicate uses — a fresh row that starts as a copy.
 */
export type FormMode =
  | { kind: 'new'; prefill: Host | null }
  | { kind: 'edit'; host: Host }

/**
 * The four swatches in Settings › Appearance (README §Design tokens).
 *
 * The only literal colours outside styles/: these are values, not styling —
 * they get written into `--color-accent` at runtime and painted into the
 * swatches, so they have to exist as strings on the JS side.
 */
export const ACCENTS = ['#5ec8b0', '#c9a15f', '#9b8fd6', '#e8e8e6'] as const

interface Settings {
  accent: string
  /** Off renders every group dot in `faint` — the prototype's `envColorMode:
   *  'mono'` (SSH Client.dc.html:763-765), surfaced as this toggle. */
  colourHostsByGroup: boolean
  bell: boolean
  storeSecretsInKeychain: boolean
  confirmProd: boolean
  agentForwarding: boolean
  keepAlive: boolean
}

interface AppState {
  screen: Screen

  hosts: Host[]
  /** Real keys from `~/.ssh`. The rail's count, the Keys screen and the form's
   *  picker all read this, so they cannot disagree about what is on the disk. */
  keys: KeyFile[]
  loading: boolean
  /** Set when the database itself is unreachable, not for form validation. */
  loadError: string | null

  /** Selected by id, not list position — a row index breaks on delete. */
  selectedId: number | null
  drawer: boolean

  /** The host awaiting delete confirmation, or null when no dialog is open. */
  pendingDelete: Host | null

  formMode: FormMode

  sessions: Session[]
  tab: number

  query: string
  filter: HostFilter
  groupFilter: GroupId | null

  settings: Settings

  loadHosts: () => Promise<void>
  loadKeys: () => Promise<void>
  copyPublicKey: (key: KeyFile) => Promise<boolean>
  createHost: (input: HostInput) => Promise<Host>
  updateHost: (id: number, input: HostInput) => Promise<Host>
  deleteHost: (id: number) => Promise<void>
  toggleFavorite: (host: Host) => Promise<void>

  goScreen: (screen: Screen) => void
  selectHost: (id: number) => void
  closeDrawer: () => void
  openNewForm: () => void
  openEditForm: (host: Host) => void
  openDuplicateForm: (host: Host) => void
  requestDelete: (host: Host) => void
  cancelDelete: () => void
  openSession: (host: Host) => void
  /** Always a new tab, even if this host already has one. */
  openSessionTab: (host: Host) => void
  setSessionStatus: (id: string, status: SessionStatus) => void
  activateTab: (tab: number) => void
  closeTab: (tab: number) => void
  setQuery: (query: string) => void
  setFilter: (filter: HostFilter) => void
  toggleGroup: (group: GroupId) => void
  setSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void
}

/**
 * Session ids have to be unique across *windows*, not just within one.
 *
 * A session opened in its own window runs a second copy of this module with its
 * own counter, so a bare `s0` would be handed out twice — and the Rust session
 * map is keyed by this exact string, which would point one window's terminal at
 * the other's bytes. The per-window tag is what keeps them apart.
 */
const WINDOW_TAG = crypto.randomUUID().slice(0, 4)
let sessionSeq = 0

/** Replaces one host in the list without disturbing the order. */
const replace = (hosts: Host[], host: Host) => hosts.map((h) => (h.id === host.id ? host : h))

export const useApp = create<AppState>((set, get) => ({
  screen: 'servers',

  hosts: [],
  keys: [],
  loading: true,
  loadError: null,

  selectedId: null,
  drawer: false,
  pendingDelete: null,

  formMode: { kind: 'new', prefill: null },

  sessions: [],
  tab: 0,

  query: '',
  filter: 'all',
  groupFilter: null,

  settings: {
    accent: ACCENTS[0],
    colourHostsByGroup: true,
    bell: false,
    storeSecretsInKeychain: true,
    confirmProd: true,
    agentForwarding: true,
    keepAlive: false,
  },

  loadHosts: async () => {
    try {
      const hosts = await api.listHosts()
      set({ hosts, loading: false, loadError: null })
    } catch (error) {
      set({ loading: false, loadError: api.message(error) })
    }
  },

  /**
   * Scans `~/.ssh` and asks the agent what it is holding. Failures leave the
   * list empty rather than surfacing: the rail would otherwise show an error
   * for a directory the user may simply not have, and the Keys screen has its
   * own empty state for that.
   */
  loadKeys: async () => {
    try {
      set({ keys: await api.listSshKeys() })
    } catch {
      set({ keys: [] })
    }
  },

  /**
   * Public half to the clipboard — what you paste into a host's
   * `authorized_keys`. Returns whether it landed, so the row can say "Copied"
   * only when it actually did.
   */
  copyPublicKey: async (key) => {
    try {
      await navigator.clipboard.writeText(await api.readPublicKey(key.name))
      return true
    } catch {
      return false
    }
  },

  // Create/update/delete return the saved row and patch it into the list, so
  // the table, the sidebar counts and the footer total all move together
  // without a full refetch. Errors propagate — the form shows them.
  createHost: async (input) => {
    const host = await api.createHost(input)
    set((state) => ({ hosts: [...state.hosts, host], selectedId: host.id }))
    return host
  },

  updateHost: async (id, input) => {
    const host = await api.updateHost(id, input)
    set((state) => ({ hosts: replace(state.hosts, host) }))
    return host
  },

  deleteHost: async (id) => {
    await api.deleteHost(id)

    // Any session pointing at the deleted host goes with it — but dropping the
    // tab is not the same as ending the connection. Left alone these keep a
    // shell running on a host the app no longer lists, and keep filling a
    // replay buffer nothing will ever attach to.
    for (const session of get().sessions.filter((s) => s.hostId === id)) {
      void api.sshDisconnect(session.id).catch(() => {})
      ssh.forget(session.id)
    }

    set((state) => ({
      hosts: state.hosts.filter((h) => h.id !== id),
      sessions: state.sessions.filter((s) => s.hostId !== id),
      selectedId: state.selectedId === id ? null : state.selectedId,
      drawer: state.selectedId === id ? false : state.drawer,
      pendingDelete: null,
    }))
  },

  // Optimistic: the star flips immediately and reverts if the write fails, so
  // a click in a dense table never feels laggy.
  toggleFavorite: async (host) => {
    const next = !host.favorite
    set((state) => ({ hosts: replace(state.hosts, { ...host, favorite: next }) }))
    try {
      const updated = await api.setHostFavorite(host.id, next)
      set((state) => ({ hosts: replace(state.hosts, updated) }))
    } catch {
      set((state) => ({ hosts: replace(state.hosts, host) }))
    }
  },

  // Switching screens always dismisses the drawer, per README line 120.
  goScreen: (screen) => set({ screen, drawer: false }),
  selectHost: (selectedId) => set({ selectedId, drawer: true }),
  closeDrawer: () => set({ drawer: false }),

  openNewForm: () => set({ screen: 'form', drawer: false, formMode: { kind: 'new', prefill: null } }),
  openEditForm: (host) => set({ screen: 'form', drawer: false, formMode: { kind: 'edit', host } }),
  openDuplicateForm: (host) =>
    set({ screen: 'form', drawer: false, formMode: { kind: 'new', prefill: host } }),

  requestDelete: (host) => set({ pendingDelete: host }),
  cancelDelete: () => set({ pendingDelete: null }),

  /**
   * Opens one SSH connection, which carries both the terminal and the SFTP
   * pane. The design had separate SSH and SFTP actions; SFTP turned out to be
   * a second channel on the same connection, so a second button would have
   * opened an identical session.
   */
  openSession: (host) => {
    // Re-use a live tab for this host rather than stacking duplicates. This
    // button means "get me to this server", and being taken to the one already
    // open is the helpful answer. `openSessionTab` is the other intent.
    const existing = get().sessions.findIndex(
      (s) => s.hostId === host.id && s.status !== 'closed',
    )
    if (existing !== -1) {
      set({ screen: 'session', selectedId: host.id, tab: existing, drawer: false })
      return
    }
    get().openSessionTab(host)
  },

  openSessionTab: (host) => {
    const session: Session = {
      id: `${WINDOW_TAG}${sessionSeq++}`,
      hostId: host.id,
      name: host.name,
      status: 'connecting',
    }

    set((state) => ({
      screen: 'session',
      selectedId: host.id,
      drawer: false,
      sessions: [...state.sessions, session],
      tab: state.sessions.length,
    }))

    // The tab exists before the handshake starts, so the terminal can show
    // progress rather than appearing only once connected — and the handshake
    // waits for this window to be receiving SSH events, so the shell cannot
    // greet an audience that has not arrived yet.
    void ssh
      .ready()
      .then(() => api.sshConnect(host.id, session.id))
      .then((info) => {
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === session.id
              ? {
                  ...s,
                  status: 'open' as const,
                  info: { user: info.user, serverKey: info.serverKey, startedAt: info.startedAt },
                }
              : s,
          ),
        }))
        // The backend stamps `last_used_at` on a successful connect; mirror it
        // here so the table updates without a refetch.
        void api.listHosts().then((hosts) => set({ hosts })).catch(() => {})
      })
      .catch((error) => {
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === session.id
              ? { ...s, status: 'error' as const, error: api.message(error) }
              : s,
          ),
        }))
      })
  },

  setSessionStatus: (id, status) =>
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, status } : s)),
    })),

  activateTab: (tab) => {
    const session = get().sessions[tab]
    if (!session) return
    set({ screen: 'session', tab, selectedId: session.hostId })
  },

  closeTab: (tab) => {
    // Tear the connection down before dropping the tab, or the shell would be
    // left running on the host with nothing reading it.
    const closing = get().sessions[tab]
    if (closing) {
      void api.sshDisconnect(closing.id).catch(() => {})
      ssh.forget(closing.id)
    }

    set((state) => {
      const sessions = state.sessions.filter((_, i) => i !== tab)
      // Closing the last tab drops back to the host list; otherwise keep the
      // selection anchored to whatever now sits at that position.
      if (sessions.length === 0) return { ...state, sessions, tab: 0, screen: 'servers' }
      return { ...state, sessions, tab: Math.min(tab, sessions.length - 1) }
    })
  },

  setQuery: (query) => set({ query }),
  setFilter: (filter) => set({ filter }),
  // Clicking the active group clears the filter, so the sidebar acts as a toggle.
  toggleGroup: (group) =>
    set((state) => ({ groupFilter: state.groupFilter === group ? null : group })),

  setSetting: (key, value) =>
    set((state) => ({ settings: { ...state.settings, [key]: value } })),
}))

/** Convenience selector — the currently selected host, or null. */
export const useSelectedHost = (): Host | null => {
  const id = useApp((s) => s.selectedId)
  const hosts = useApp((s) => s.hosts)
  return hosts.find((h) => h.id === id) ?? null
}

export type { AuthMethod }
