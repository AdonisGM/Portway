import { ChevronDown, ChevronRight, KeyRound, Lock, Pin } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNav } from '../../app/nav'
import { useServers } from '../../app/servers'
import { OsBadge } from '../../components/os-badge'
import { Button, cx } from '../../components/ui/primitives'
import { SearchInput } from '../../components/ui/search-input'
import { SegmentedControl } from '../../components/ui/segmented'
import { useToast } from '../../components/toast'
import { isAppError, type Server } from '../../lib/api'
import { authLabel, errorMessage, groupLabel, hostPort } from './format'
import { ServerEditor } from './server-editor'

const ROW_COLS = 'minmax(80px,1fr) minmax(100px,1.2fr) 90px minmax(90px,1.3fr) 110px 16px'

/** "Server của bạn": every saved connection, searchable and filterable by group.
 *  A row opens the editor; the user button lists the accounts to connect with. */
export function ServerListScreen() {
  const { servers, loading, loadError, importSshConfig } = useServers()
  const nav = useNav()
  const toast = useToast()
  const [q, setQ] = useState('')
  const [group, setGroup] = useState('all')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  // undefined: closed, null: adding, Server: editing.
  const [editing, setEditing] = useState<Server | null | undefined>(undefined)
  const [importing, setImporting] = useState(false)

  const groups = useMemo(() => [...new Set(servers.map((s) => s.group))].sort((a, b) => (a ? (b ? a.localeCompare(b) : -1) : 1)), [servers])
  const activeGroup = group === 'all' || groups.includes(group) ? group : 'all'

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return servers.filter((s) => {
      if (activeGroup !== 'all' && s.group !== activeGroup) return false
      if (!needle) return true
      const hay = [s.name, s.host, s.group, s.note, ...s.tags, ...s.accounts.map((a) => a.user)].join(' ').toLowerCase()
      return hay.includes(needle)
    })
  }, [servers, q, activeGroup])

  const connect = (server: Server, user: string) => nav.connect(server.id, user)

  const runImport = async () => {
    setImporting(true)
    try {
      const r = await importSshConfig()
      if (r.added.length) {
        toast({ title: `Đã nhập ${r.added.length} server từ ~/.ssh/config`, detail: r.added.map((s) => s.name).join(', ') })
      } else if (r.found) {
        toast({ title: 'Đã đọc ~/.ssh/config', detail: `Tìm thấy ${r.found} host, tất cả đã có trong Portway` })
      } else {
        toast({ title: 'Không có host nào để nhập', detail: '~/.ssh/config không có khối Host cụ thể nào' })
      }
    } catch (e) {
      toast({ title: 'Không nhập được', detail: isAppError(e) ? errorMessage(e) : String(e) })
    } finally {
      setImporting(false)
    }
  }

  const groupCount = groups.length

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-2.5">
        <div className="flex min-w-[220px] flex-1 flex-col gap-[3px]">
          <h1 className="m-0 text-[23px] font-semibold">Server của bạn</h1>
          <span className="text-muted">
            {servers.length} server · {groupCount} nhóm · bấm một dòng để xem và sửa
          </span>
        </div>
        <Button size="sm" onClick={runImport} disabled={importing}>
          Nhập từ ~/.ssh/config
        </Button>
        <Button size="sm" variant="primary" onClick={() => setEditing(null)}>
          Thêm server
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={q} onChange={setQ} placeholder="Tìm tên, host, nhóm" className="w-[260px] min-w-0" />
        {groupCount > 0 && (
          <SegmentedControl
            value={activeGroup}
            onChange={setGroup}
            options={[{ id: 'all', label: 'Tất cả' }, ...groups.map((g) => ({ id: g, label: groupLabel(g) }))]}
          />
        )}
        <span className="flex-1" />
        <span className="num text-[11px] text-muted">
          {list.length}/{servers.length} server
        </span>
      </div>

      <div className="overflow-auto rounded-xl border border-line bg-surface">
        <div style={{ minWidth: 560 }}>
          <div className="grid gap-3 bg-sunken px-3.5 py-2 text-[11px] text-muted" style={{ gridTemplateColumns: ROW_COLS }}>
            <span>Tên</span>
            <span>Host</span>
            <span>User</span>
            <span>Tag</span>
            <span>Nhóm</span>
            <span />
          </div>

          {list.map((s, i) => {
            const open = !!expanded[s.id]
            const multi = s.accounts.length > 1
            const Chevron = open ? ChevronDown : ChevronRight
            return (
              <div key={s.id} className="border-t border-line">
                <div
                  onClick={() => setEditing(s)}
                  className={cx('grid cursor-pointer items-center gap-3 px-3.5 py-2 hover:bg-accent-soft', i % 2 === 1 && 'bg-raised')}
                  style={{ gridTemplateColumns: ROW_COLS }}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <OsBadge os={s.os} />
                    <span className="truncate font-semibold">{s.name}</span>
                  </span>
                  <span className="truncate font-mono text-[11.5px] text-ink2">{hostPort(s.host, s.port)}</span>
                  <span className="min-w-0">
                    <button
                      type="button"
                      title="Xem tài khoản đăng nhập"
                      onClick={(e) => {
                        e.stopPropagation()
                        setExpanded((x) => ({ ...x, [s.id]: !x[s.id] }))
                      }}
                      className="inline-flex max-w-full cursor-pointer items-center gap-1 rounded-md border border-line2 bg-surface py-px pr-1.5 pl-[7px] text-[11.5px] text-ink hover:border-muted"
                    >
                      <span className={cx('truncate', !multi && 'font-mono')}>{multi ? `${s.accounts.length} user` : s.accounts[0]?.user}</span>
                      <Chevron size={12} strokeWidth={2} className="flex-none" />
                    </button>
                  </span>
                  <span className="flex min-w-0 flex-wrap gap-1">
                    {s.tags.map((t) => (
                      <span key={t} className="rounded-full border border-line2 px-[7px] py-px text-[11px] whitespace-nowrap text-ink2">
                        {t}
                      </span>
                    ))}
                  </span>
                  <span className={cx('truncate', s.group ? 'text-ink2' : 'text-muted')}>{groupLabel(s.group)}</span>
                  <span className="flex justify-center text-muted" title={s.pinned ? 'Đã ghim' : undefined}>
                    {s.pinned && <Pin size={12} strokeWidth={2} />}
                  </span>
                </div>

                {open && (
                  <div className="bg-sunken">
                    {s.accounts.map((a) => (
                      <div key={a.user} className="flex items-center gap-3 border-t border-line py-1.5 pr-3.5 pl-10">
                        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink2">
                          {a.user}@{s.host}
                        </span>
                        <span className={cx('flex items-center gap-1.5 text-[11.5px]', a.auth.kind === 'password' ? 'text-warn' : 'text-ink2')}>
                          {a.auth.kind === 'password' ? <Lock size={12} strokeWidth={2} /> : <KeyRound size={12} strokeWidth={2} />}
                          <span className={a.auth.kind === 'key' ? 'font-mono' : undefined}>{authLabel(a.auth)}</span>
                        </span>
                        <Button size="xs" onClick={() => connect(s, a.user)}>
                          Kết nối
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}

          {!loading && list.length === 0 && (
            <div className="border-t border-line p-8 text-center text-muted">
              {loadError
                ? `Không đọc được danh sách server: ${loadError}`
                : servers.length
                  ? 'Không có server nào khớp bộ lọc'
                  : 'Chưa có server nào. Bấm “Thêm server” hoặc nhập từ ~/.ssh/config.'}
            </div>
          )}
        </div>
      </div>

      {editing !== undefined && (
        <ServerEditor key={editing?.id ?? 'new'} server={editing} onClose={() => setEditing(undefined)} onConnect={connect} />
      )}
    </div>
  )
}
