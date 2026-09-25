import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNav } from '../../app/nav'
import { useServers } from '../../app/servers'
import { OsBadge } from '../../components/os-badge'
import { useToast } from '../../components/toast'
import { Pager, clampPage } from '../../components/ui/pager'
import { Button, cx } from '../../components/ui/primitives'
import { SearchInput } from '../../components/ui/search-input'
import { SegmentedControl } from '../../components/ui/segmented'
import { api, isAppError, type Server, type SshKey } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import { groupLabel, hostPort, keyName } from '../servers/format'
import { createdLabel, keyErrorMessage, keyTypeLabel } from './format'
import { KeyGenerator } from './key-generator'

type Usage = { server: Server; user: string }
/** A key found in ~/.ssh, or a key path used by an account whose file is missing. */
type Row = { key: SshKey; missing: boolean; usage: Usage[] }

const USAGE_PAGE = 10

/** "Khoá SSH": keys in ~/.ssh with type, fingerprint and the accounts using them. */
export function KeyListScreen() {
  const { keys, servers, reloadKeys } = useServers()
  const nav = useNav()
  const toast = useToast()
  const [q, setQ] = useState('')
  const [type, setType] = useState('all')
  const [use, setUse] = useState<'all' | 'used' | 'unused'>('all')
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(10)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [usagePage, setUsagePage] = useState<Record<string, number>>({})
  const [generating, setGenerating] = useState(false)
  const [scanning, setScanning] = useState(false)

  const rows = useMemo<Row[]>(() => {
    const usageOf = (path: string) =>
      servers.flatMap((server) =>
        server.accounts.filter((a) => a.auth.kind === 'key' && a.auth.path === path).map((a) => ({ server, user: a.user })),
      )
    const found = keys.map((key) => ({ key, missing: false, usage: usageOf(key.path) }))
    // Key paths on accounts that are not in ~/.ssh (moved, deleted, or elsewhere).
    const missingPaths = [
      ...new Set(servers.flatMap((s) => s.accounts.flatMap((a) => (a.auth.kind === 'key' ? [a.auth.path] : [])))),
    ].filter((p) => !keys.some((k) => k.path === p))
    const missing = missingPaths.map((path) => ({
      key: { name: keyName(path), path, kind: null, bits: null, fingerprint: null, comment: null, createdAt: null },
      missing: true,
      usage: usageOf(path),
    }))
    return [...found, ...missing]
  }, [keys, servers])

  const kinds = useMemo(() => [...new Set(keys.map((k) => k.kind).filter((k): k is string => !!k))].sort(), [keys])
  const activeType = type === 'all' || kinds.includes(type) ? type : 'all'

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return rows.filter((r) => {
      if (activeType !== 'all' && r.key.kind !== activeType) return false
      if (use === 'used' && !r.usage.length) return false
      if (use === 'unused' && r.usage.length) return false
      if (!needle) return true
      return [r.key.name, r.key.path, r.key.fingerprint, r.key.comment].join(' ').toLowerCase().includes(needle)
    })
  }, [rows, q, activeType, use])

  const cur = clampPage(page, list.length, size)
  const shown = list.slice((cur - 1) * size, cur * size)

  const copyPublic = async (k: SshKey) => {
    try {
      await copyText(await api.publicKey(k.path))
      toast({ title: `Đã sao chép public key ${k.name}`, detail: 'Dán vào ~/.ssh/authorized_keys trên server để đăng nhập bằng khoá này' })
    } catch (e) {
      toast({ title: 'Không sao chép được', detail: isAppError(e) ? keyErrorMessage(e) : String(e) })
    }
  }

  const rescan = async () => {
    setScanning(true)
    try {
      const { total, added, removed } = await reloadKeys()
      const changes = [
        added.length && `thêm ${added.map((k) => k.name).join(', ')}`,
        removed.length && `không còn ${removed.map((k) => k.name).join(', ')}`,
      ].filter(Boolean)
      toast({
        title: 'Đã quét lại ~/.ssh',
        detail: `Tìm thấy ${total} khoá${changes.length ? ` · ${changes.join(' · ')}` : ', không có gì thay đổi'}`,
      })
    } finally {
      setScanning(false)
    }
  }

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-end gap-2.5">
        <div className="flex min-w-[220px] flex-1 flex-col gap-[3px]">
          <h1 className="m-0 text-[23px] font-semibold">Khoá SSH</h1>
          <span className="text-muted">Khoá riêng nằm trong ~/.ssh trên máy bạn. Portway chỉ đọc public key để lấy loại khoá và vân tay.</span>
        </div>
        <Button size="sm" onClick={rescan} disabled={scanning}>
          Quét lại ~/.ssh
        </Button>
        <Button size="sm" variant="primary" onClick={() => setGenerating(true)}>
          Tạo khoá mới
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={q} onChange={(v) => { setQ(v); setPage(1) }} placeholder="Tìm tên khoá, đường dẫn, vân tay" className="w-[260px] min-w-0" />
        <SegmentedControl
          value={activeType}
          onChange={(v) => { setType(v); setPage(1) }}
          options={[{ id: 'all', label: 'Tất cả' }, ...kinds.map((k) => ({ id: k, label: k }))]}
        />
        <SegmentedControl
          value={use}
          onChange={(v) => { setUse(v); setPage(1) }}
          options={[
            { id: 'all', label: 'Mọi khoá' },
            { id: 'used', label: 'Đang dùng' },
            { id: 'unused', label: 'Chưa dùng' },
          ]}
        />
        <span className="flex-1" />
        <span className="num text-[11px] text-muted">
          {list.length}/{rows.length} khoá
        </span>
      </div>

      <div className="flex flex-col gap-2.5">
        {list.length === 0 && (
          <div className="rounded-xl border border-line bg-surface p-8 text-center text-muted">
            {rows.length ? 'Không có khoá nào khớp bộ lọc' : 'Chưa có khoá nào trong ~/.ssh. Bấm “Tạo khoá mới” để tạo.'}
          </div>
        )}

        {shown.map(({ key: k, missing, usage }) => {
          const expanded = !!open[k.path]
          const Chevron = expanded ? ChevronDown : ChevronRight
          const serverCount = new Set(usage.map((u) => u.server.id)).size
          const up = clampPage(usagePage[k.path] ?? 1, usage.length, USAGE_PAGE)
          const created = createdLabel(k.createdAt)
          return (
            <div key={k.path} className="overflow-hidden rounded-xl border border-line bg-surface">
              <div className="grid items-center gap-4 px-4 py-3.5" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.3fr) auto' }}>
                <div className="flex min-w-0 flex-col gap-[3px]">
                  <span className="truncate text-[13px] font-semibold">{k.name}</span>
                  <span className="truncate font-mono text-[11px] text-muted select-text">{k.path}</span>
                </div>
                {missing ? (
                  <div className="flex min-w-0 items-center gap-2 text-warn">
                    <AlertTriangle size={14} strokeWidth={2} className="flex-none" />
                    <span className="text-[12px]">Không thấy tệp khoá này. Server dùng nó sẽ không đăng nhập được.</span>
                  </div>
                ) : (
                  <div className="flex min-w-0 flex-col gap-[3px]">
                    <span className="text-[11px] text-muted">
                      {keyTypeLabel(k)}
                      {created && ` · tạo ${created}`}
                      {k.comment && ` · ${k.comment}`}
                    </span>
                    <span className="truncate font-mono text-[11.5px] text-ink2 select-text">{k.fingerprint ?? 'Không đọc được public key'}</span>
                  </div>
                )}
                {!missing && (
                  <Button size="xs" onClick={() => copyPublic(k)}>
                    Sao chép public key
                  </Button>
                )}
              </div>

              <button
                type="button"
                onClick={() => setOpen((o) => ({ ...o, [k.path]: !o[k.path] }))}
                className="flex w-full cursor-pointer items-center gap-2 border-t border-line bg-raised px-4 py-[9px] text-left text-[12.5px] hover:bg-accent-soft"
              >
                <Chevron size={14} strokeWidth={1.75} className="flex-none text-muted" />
                <span className="flex-1">Tài khoản dùng khoá này</span>
                <span className="num text-[11px] text-muted">
                  {usage.length} tài khoản · {serverCount} server
                </span>
              </button>

              {expanded && (
                <div className="border-t border-line">
                  {usage.length === 0 && <div className="px-4 py-3.5 text-muted">Chưa có server nào dùng khoá này.</div>}
                  {usage.slice((up - 1) * USAGE_PAGE, up * USAGE_PAGE).map((u, i) => (
                    <button
                      key={`${u.server.id}|${u.user}`}
                      type="button"
                      title={`Kết nối ${u.user}@${u.server.name}`}
                      onClick={() => nav.connect(u.server.id, u.user)}
                      className={cx(
                        'grid w-full cursor-pointer items-center gap-3.5 border-t border-line py-2 pr-4 pl-[38px] text-left first:border-t-0 hover:bg-accent-soft',
                        i % 2 === 1 && 'bg-raised',
                      )}
                      style={{ gridTemplateColumns: 'minmax(90px,1fr) minmax(0,1.4fr) 90px 120px' }}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <OsBadge os={u.server.os} />
                        <span className="truncate font-semibold">{u.server.name}</span>
                      </span>
                      <span className="truncate font-mono text-[11.5px] text-ink2">{hostPort(u.server.host, u.server.port)}</span>
                      <span className="truncate font-mono text-[11.5px] text-ink2">{u.user}</span>
                      <span className={cx('truncate', u.server.group ? 'text-ink2' : 'text-muted')}>{groupLabel(u.server.group)}</span>
                    </button>
                  ))}
                  {usage.length > USAGE_PAGE && (
                    <Pager
                      page={up}
                      size={USAGE_PAGE}
                      total={usage.length}
                      unit="tài khoản"
                      onPage={(p) => setUsagePage((x) => ({ ...x, [k.path]: p }))}
                    />
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {list.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          <Pager page={cur} size={size} total={list.length} unit="khoá" onPage={setPage} onSize={(n) => { setSize(n); setPage(1) }} />
        </div>
      )}

      {generating && (
        <KeyGenerator
          onClose={() => setGenerating(false)}
          onCreated={(k) =>
            toast({
              title: `Đã tạo khoá ${k.name}`,
              detail: `${k.path} · ${k.fingerprint ?? ''}`,
              actions: [{ label: 'Sao chép public key', run: () => copyPublic(k) }],
            })
          }
        />
      )}
    </div>
  )
}
