// Mock data taken from the Claude Design prototype (Portway.dc.html), for the
// screens that do not have a real backend yet.

export type TunnelStatus = 'run' | 'connecting' | 'retry' | 'error' | 'off'

export const TUNNELS: { id: string; name: string; host: string; status: TunnelStatus }[] = [
  { id: 't1', name: 'Postgres portway', host: 'web-01', status: 'run' },
  { id: 't2', name: 'Umami', host: 'web-01', status: 'run' },
  { id: 't3', name: 'DB công ty', host: 'bastion', status: 'retry' },
  { id: 't4', name: 'Mạng nội bộ', host: 'bastion', status: 'off' },
  { id: 't5', name: 'Redis staging', host: 'staging', status: 'error' },
]

export const LOG_SOURCES = [
  { id: 'nginx-access', label: 'Nginx access' },
  { id: 'nginx-error', label: 'Nginx error' },
  { id: 'docker:portway-web', label: 'Container web' },
  { id: 'docker:portway-api', label: 'Container api' },
  { id: 'syslog', label: 'syslog' },
]

/** Menu counters for the server modules until each module has real data. */
export const MODULE_COUNTS = {
  containers: 8,
  compose: 2,
  images: 12,
  volumes: 3,
  services: 7,
  jobs: 5,
  failedServices: 2,
  firewallRules: 7,
}
