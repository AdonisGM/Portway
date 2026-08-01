import type { KnownHost, SftpFile } from './types'

/**
 * Everything the prototype's data script holds beyond the host list
 * (SSH Client.dc.html:840-890), with the accent hex stripped out in favour of
 * semantic status — see the note in types.ts.
 */

export const KNOWN_HOSTS: KnownHost[] = [
  { host: '10.20.4.11', type: 'ed25519', fingerprint: 'SHA256:Kd8s…pW2', firstSeen: 'Mar 2026', status: 'verified' },
  { host: '10.20.4.12', type: 'ed25519', fingerprint: 'SHA256:Lm4t…qX9', firstSeen: 'Mar 2026', status: 'verified' },
  { host: '10.20.4.20', type: 'ed25519', fingerprint: 'SHA256:Rt7y…vB3', firstSeen: 'Apr 2026', status: 'verified' },
  { host: '10.20.4.31', type: 'ed25519', fingerprint: 'SHA256:Wq2n…zK7', firstSeen: 'Apr 2026', status: 'verified' },
  { host: '10.30.1.14', type: 'rsa', fingerprint: 'SHA256:Bn5h…cM8', firstSeen: 'Jan 2026', status: 'changed' },
  { host: '203.0.113.7', type: 'ed25519', fingerprint: 'SHA256:Yu9k…dF1', firstSeen: 'Aug 2025', status: 'verified' },
  { host: '192.168.1.20', type: 'ed25519', fingerprint: 'SHA256:Hj3p…gT5', firstSeen: 'Nov 2025', status: 'verified' },
  { host: '192.168.1.31', type: 'ed25519', fingerprint: 'SHA256:Vc6r…xN4', firstSeen: 'Nov 2025', status: 'verified' },
]

/** Counts in the nav and the screen headers are the "real" library size, not
 *  the length of these sample arrays. */
export const KNOWN_HOSTS_TOTAL = 41

export const SFTP_PATH = ['var', 'lib', 'postgresql']

export const SFTP_FILES: SftpFile[] = [
  { name: '..', size: '', modified: '', kind: 'parent' },
  { name: 'base/', size: '—', modified: 'Jul 28 09:12', kind: 'dir' },
  { name: 'pg_wal/', size: '—', modified: 'Jul 30 11:40', kind: 'dir' },
  { name: 'global/', size: '—', modified: 'Jul 12 22:03', kind: 'dir' },
  { name: 'dump-2026-07-30.sql.gz', size: '412 MB', modified: 'Jul 30 11:38', kind: 'file' },
  { name: 'postgresql.conf', size: '28 KB', modified: 'Jul 24 15:02', kind: 'file' },
  { name: 'pg_hba.conf', size: '4.6 KB', modified: 'Jul 24 15:02', kind: 'file' },
  { name: 'postmaster.pid', size: '96 B', modified: 'Jul 30 06:00', kind: 'file' },
  { name: 'server.log', size: '81 MB', modified: 'Jul 30 11:41', kind: 'file' },
]

export const TRANSFER = {
  filename: 'dump-2026-07-30.sql.gz',
  progress: 62,
  rate: '3.1 MB/s',
}

/** Keys the ssh-agent reports, for the form's Agent auth method. */
/** Fake shell output, interpolated with the active host (SSH Client.dc.html:849-852). */
export function terminalText(user: string, host: string): string {
  return (
    'Last login: Thu Jul 30 11:22:04 2026 from 203.0.113.7\n' +
    `${user}@${host}:~$ systemctl is-active postgresql\nactive\n` +
    `${user}@${host}:~$ df -h /var/lib/postgresql\n` +
    'Filesystem      Size  Used Avail Use% Mounted on\n' +
    '/dev/nvme0n1p2   1.8T  1.1T  620G  64% /var/lib/postgresql\n' +
    `${user}@${host}:~$ `
  )
}
