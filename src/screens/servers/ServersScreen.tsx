import { useEffect, useMemo, useRef, useState } from 'react'
import { GROUP_IDS, GROUP_NAMES } from '@/data/groups'
import type { Host } from '@/data/types'
import { openSessionWindow } from '@/lib/api'
import { ELSEWHERE_KEY, opensElsewhere, useOpensElsewhere } from '@/lib/platform'
import { isRecent, relativeTime } from '@/lib/format'
import { buildHostFilter, hostQualifiers } from '@/lib/hostQuery'
import { Button } from '@/components/ui/Button'
import { Chip } from '@/components/ui/Chip'
import { QueryInput } from '@/components/ui/QueryInput'
import { Segmented } from '@/components/ui/Segmented'
import { StarToggle } from '@/components/ui/StarToggle'
import { DataTable, type Column, type SortState } from '@/components/layout/DataTable'
import {
  FooterBar,
  FooterRight,
  ScreenHeader,
  ScreenShell,
} from '@/components/layout/ScreenShell'
import { useApp, useSelectedHost, type HostFilter } from '@/store/appStore'
import { HostDrawer } from './HostDrawer'
import { DeleteHostDialog } from './DeleteHostDialog'

/** The eight tracks from README line 42. The host name gets the widest one. */
const GRID = '12px 2.1fr 1.5fr 96px 104px 100px 68px 118px'

const FILTERS: { value: HostFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'recent', label: 'Recent' },
  { value: 'favorites', label: 'Favorites' },
]

/** The mock only ever showed 70 hosts, so it never had to say "1 host". */
const plural = (n: number, word: string) => (n === 1 ? word : `${word}s`)

/**
 * Sorts addresses the way a person reads them: `10.20.4.9` before
 * `10.20.4.40`, which a plain string compare gets backwards.
 */
function compareNatural(a: string, b: string): number {
  const chunk = /(\d+|\D+)/g
  const left = a.match(chunk) ?? []
  const right = b.match(chunk) ?? []

  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const l = left[i]
    const r = right[i]
    const bothNumeric = /^\d/.test(l) && /^\d/.test(r)
    const diff = bothNumeric ? Number(l) - Number(r) : l.localeCompare(r)
    if (diff !== 0) return diff
  }
  return left.length - right.length
}

function compareHosts(a: Host, b: Host, key: string): number {
  switch (key) {
    case 'name':
      return compareNatural(a.name, b.name)
    case 'address':
      return compareNatural(a.address, b.address) || a.port - b.port
    case 'user':
      return a.user.localeCompare(b.user)
    case 'group':
      return GROUP_NAMES[a.group].localeCompare(GROUP_NAMES[b.group])
    // Never-used hosts sort as the oldest, so they collect at one end.
    case 'last':
      return (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0)
    case 'auth':
      return a.auth.localeCompare(b.auth)
    default:
      return 0
  }
}

export function ServersScreen() {
  const hosts = useApp((s) => s.hosts)
  const loading = useApp((s) => s.loading)
  const loadError = useApp((s) => s.loadError)
  const selectedId = useApp((s) => s.selectedId)
  const drawer = useApp((s) => s.drawer)
  const query = useApp((s) => s.query)
  const filter = useApp((s) => s.filter)
  const groupFilter = useApp((s) => s.groupFilter)
  const setQuery = useApp((s) => s.setQuery)
  const setFilter = useApp((s) => s.setFilter)
  const selectHost = useApp((s) => s.selectHost)
  const openSession = useApp((s) => s.openSession)
  const openNewForm = useApp((s) => s.openNewForm)
  const selected = useSelectedHost()
  const elsewhere = useOpensElsewhere()

  const searchRef = useRef<HTMLInputElement>(null)
  const [sort, setSort] = useState<SortState | null>(null)

  // Suggestion values come from the live list, so they only ever offer things
  // that actually exist.
  const qualifiers = useMemo(() => hostQualifiers(hosts), [hosts])

  const rows = useMemo<Host[]>(() => {
    const matches = buildHostFilter(query, qualifiers)
    const filtered = hosts.filter((host) => {
      if (groupFilter && host.group !== groupFilter) return false
      if (filter === 'recent' && !isRecent(host.lastUsedAt)) return false
      if (filter === 'favorites' && !host.favorite) return false
      return matches(host)
    })

    if (!sort) return filtered
    const direction = sort.dir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => direction * compareHosts(a, b, sort.key))
  }, [hosts, query, qualifiers, filter, groupFilter, sort])

  // asc → desc → unsorted, then round again.
  const toggleSort = (key: string) =>
    setSort((current) => {
      if (!current || current.key !== key) return { key, dir: 'asc' }
      return current.dir === 'asc' ? { key, dir: 'desc' } : null
    })

  // `/` focuses search; ↵ connects over SSH and ⇧↵ over SFTP, acting on the
  // selected row when it survived filtering, otherwise the first result
  // (README line 123, and the hint in the footer bar).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const typing = el?.tagName === 'INPUT' || el?.tagName === 'SELECT' || el?.tagName === 'TEXTAREA'

      if (e.key === '/' && !typing) {
        e.preventDefault()
        searchRef.current?.focus()
        return
      }
      if (e.key === 'Enter') {
        const target = rows.find((h) => h.id === selectedId) ?? rows[0]
        if (!target) return
        e.preventDefault()
        openSession(target)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rows, selectedId, openSession])

  const columns: Column<Host>[] = [
    { key: 'star', render: (host) => <FavoriteCell host={host} /> },
    {
      key: 'name',
      header: 'Host',
      sortable: true,
      className: 'cell-ellipsis',
      render: (host) => host.name,
    },
    {
      key: 'address',
      header: 'Address',
      sortable: true,
      className: 'cell-ellipsis font-mono text-cell text-fg-2',
      render: (host) => `${host.address}:${host.port}`,
    },
    {
      key: 'user',
      header: 'User',
      sortable: true,
      className: 'cell-ellipsis font-mono text-cell text-fg-2',
      render: (host) => host.user,
    },
    {
      key: 'group',
      header: 'Group',
      sortable: true,
      className: 'cell-ellipsis text-fg-2',
      render: (host) => GROUP_NAMES[host.group],
    },
    {
      key: 'last',
      header: 'Last used',
      sortable: true,
      className: 'cell-ellipsis text-cell text-muted',
      render: (host) => relativeTime(host.lastUsedAt),
    },
    {
      key: 'auth',
      header: 'Auth',
      sortable: true,
      className: 'font-mono text-mono text-muted',
      render: (host) => (host.auth === 'password' ? 'pass' : host.auth),
    },
    {
      key: 'actions',
      // Shown on hover or keyboard focus rather than always-on, per README
      // line 47. `stopPropagation` so it doesn't also select the row.
      className:
        'flex justify-end gap-1.25 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100',
      // The design draws SSH and SFTP as separate actions, but one connection
      // now carries both panes — two buttons doing the same thing was only
      // ever going to mislead. See the note in the store's `openSession`.
      render: (host) => (
        <Chip
          tone="strong"
          title={`Open a session — ${ELSEWHERE_KEY}-click for a new window`}
          onClick={(e) => {
            e.stopPropagation()
            // ⌘-click opens it in its own window, the way a browser would.
            // Plain click is unchanged.
            if (opensElsewhere(e)) return void openSessionWindow(host)
            openSession(host)
          }}
        >
          {/* The arrow keeps its space whether or not it shows, so holding the
              modifier changes what the chip says without moving it out from
              under the pointer that is hovering it. */}
          SSH<span className={elsewhere ? '' : 'invisible'}> ↗</span>
        </Chip>
      ),
    },
  ]

  const narrowed = rows.length !== hosts.length
  const groupsWithHosts = GROUP_IDS.filter((g) => hosts.some((h) => h.group === g)).length

  return (
    <ScreenShell
      header={
        <ScreenHeader>
          <QueryInput
            className="flex-1"
            value={query}
            onChange={setQuery}
            qualifiers={qualifiers}
            inputRef={searchRef}
            aria-label="Search hosts"
            placeholder="Search host… or addr: user: group:"
            prefix={
              <span aria-hidden className="font-mono text-cell text-faint">
                /
              </span>
            }
          />

          <Segmented
            aria-label="Filter hosts"
            options={FILTERS}
            value={filter}
            onChange={setFilter}
          />

          <Button variant="accent" onClick={openNewForm}>
            New server
          </Button>
        </ScreenHeader>
      }
      footer={
        <FooterBar>
          <span>
            {narrowed
              ? `${rows.length} of ${hosts.length} ${plural(hosts.length, 'host')}`
              : `${hosts.length} ${plural(hosts.length, 'host')}`}{' '}
            · {groupsWithHosts} {plural(groupsWithHosts, 'group')}
          </span>
          <FooterRight>click row → details · ↵ ssh</FooterRight>
        </FooterBar>
      }
      overlay={
        <>
          {selected ? <HostDrawer host={selected} /> : null}
          <DeleteHostDialog />
        </>
      }
    >
      {loadError ? (
        <div className="flex flex-1 items-center justify-center px-6">
          <div className="max-w-96 text-center">
            <div className="text-body text-fg">Could not open the host database.</div>
            <div className="mt-2 font-mono text-mono/cmd text-warn">{loadError}</div>
          </div>
        </div>
      ) : loading ? (
        <div className="flex flex-1 items-center justify-center font-mono text-mono text-faint">
          loading hosts…
        </div>
      ) : hosts.length === 0 ? (
        <EmptyServers onAdd={openNewForm} />
      ) : (
        <DataTable
          rows={rows}
          columns={columns}
          gridTemplate={GRID}
          rowKey={(host) => String(host.id)}
          sort={sort}
          onToggleSort={toggleSort}
          virtualized
          onRowClick={(host) => selectHost(host.id)}
          isSelected={(host) => drawer && host.id === selectedId}
          emptyMessage="No hosts match this search."
        />
      )}
    </ScreenShell>
  )
}

/**
 * The table's 12px first column. The design puts a group dot here, but the dot
 * carried no action and the group is already spelled out in the Group column,
 * so the column is now purely the Favorite control: empty at rest, a star on
 * row hover, and a filled star for a favourited host so favourites stay
 * visible without hovering every row.
 *
 * The button is always mounted and only fades on opacity — that keeps it
 * reachable by keyboard and stops the row shifting as it appears.
 */
function FavoriteCell({ host }: { host: Host }) {
  const toggleFavorite = useApp((s) => s.toggleFavorite)

  return (
    <StarToggle
      active={host.favorite}
      onToggle={() => void toggleFavorite(host)}
      label={
        host.favorite ? `Remove ${host.name} from favorites` : `Add ${host.name} to favorites`
      }
      className={`size-3 transition-opacity ${
        host.favorite
          ? 'opacity-100'
          : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
      }`}
    />
  )
}

/**
 * NOT IN THE HANDOFF — the design leaves empty states undesigned (README line
 * 126); this was designed on request. It stays inside the existing vocabulary:
 * body copy in `fg-2`, a mono footnote in `faint`, and the same accent button
 * the toolbar already uses, centred in the space the table would occupy.
 */
function EmptyServers({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6">
      <div className="text-body text-fg">No servers yet</div>
      <p className="max-w-96 text-center text-cell text-fg-2">
        Add a host and it is saved to <span className="font-mono">~/.portway/portway.db</span> on
        this machine.
      </p>
      <Button variant="accent" size="md" className="mt-1" onClick={onAdd}>
        Add your first server
      </Button>
      <p className="mt-2 font-mono text-mono text-faint">
        credentials are never written to the database
      </p>
    </div>
  )
}
