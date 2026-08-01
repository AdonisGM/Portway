import { useCallback, useState } from 'react'

/**
 * Which columns the SFTP table shows, and how wide each one is.
 *
 * The grid template and the column list are derived from one array on purpose.
 * They were two independent strings, and a hidden column has to be dropped from
 * both in lockstep — miss one and every header sits over the wrong cell, which
 * looks like a data bug rather than a layout one.
 *
 * Name has no toggle. A file browser with the filenames turned off is not a
 * state worth being able to reach.
 */

export type SftpColumnId = 'name' | 'size' | 'modified' | 'owner' | 'mode'

interface Spec {
  id: SftpColumnId
  label: string
  /** Grid track. Only Name flexes; the rest are sized to their content. */
  track: string
  /** Name is the table, not a column of it. */
  fixed?: boolean
}

export const SFTP_COLUMNS: Spec[] = [
  { id: 'name', label: 'Name', track: '1.7fr', fixed: true },
  { id: 'size', label: 'Size', track: '78px' },
  { id: 'modified', label: 'Modified', track: '100px' },
  // Wider than the numbers needed: `deployment-svc:longgroupname12` is a real
  // pair, and a column sized for `0:0` would ellipsize almost every named one.
  { id: 'owner', label: 'Owner', track: '138px' },
  { id: 'mode', label: 'Permissions', track: '104px' },
]

/** What the handoff's `1.7fr 78px 100px` showed, so nothing moves by default. */
const DEFAULT: SftpColumnId[] = ['name', 'size', 'modified']

const STORAGE_KEY = 'portway.sftpColumns'

function stored(): SftpColumnId[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (!Array.isArray(raw)) return DEFAULT
    // Filtered against the current spec, so a column removed in a later version
    // cannot resurrect itself from an old preference and break the grid.
    const known = raw.filter((id): id is SftpColumnId =>
      SFTP_COLUMNS.some((c) => c.id === id),
    )
    return known.includes('name') ? known : ['name', ...known]
  } catch {
    return DEFAULT
  }
}

export function useSftpColumns() {
  const [visible, setVisible] = useState<SftpColumnId[]>(stored)

  const toggle = useCallback((id: SftpColumnId) => {
    setVisible((current) => {
      const spec = SFTP_COLUMNS.find((c) => c.id === id)
      if (spec?.fixed) return current
      const next = current.includes(id)
        ? current.filter((c) => c !== id)
        : // Re-inserted in spec order rather than appended, so toggling a column
          // off and on again does not move it to the end of the table.
          SFTP_COLUMNS.filter((c) => current.includes(c.id) || c.id === id).map((c) => c.id)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      return next
    })
  }, [])

  const shown = SFTP_COLUMNS.filter((c) => visible.includes(c.id))
  return { shown, visible, toggle, gridTemplate: shown.map((c) => c.track).join(' ') }
}
