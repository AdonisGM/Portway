import type { GroupId, Host } from './types'

/** The four groups the design draws. Order matters — it is the sidebar order. */
export const GROUP_IDS: GroupId[] = ['prod', 'staging', 'dev', 'home']

export const GROUP_NAMES: Record<GroupId, string> = {
  prod: 'Production',
  staging: 'Staging',
  dev: 'Development',
  home: 'Homelab',
}

/** The form's Group control is only 74px wide, so it shows the short form —
 *  the mock renders `Prod ⌄` there (SSH Client.dc.html:230). */
export const GROUP_SHORT: Record<GroupId, string> = {
  prod: 'Prod',
  staging: 'Stg',
  dev: 'Dev',
  home: 'Home',
}

/**
 * Counts come from the live host list rather than a constant, so the sidebar
 * moves the moment a host is created, re-grouped or deleted.
 */
export function groupCounts(hosts: Host[]): { id: GroupId; name: string; count: number }[] {
  return GROUP_IDS.map((id) => ({
    id,
    name: GROUP_NAMES[id],
    count: hosts.filter((h) => h.group === id).length,
  }))
}
