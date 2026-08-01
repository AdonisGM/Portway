import type { SftpFile } from './types'

/**
 * Everything the prototype's data script holds beyond the host list
 * (SSH Client.dc.html:840-890), with the accent hex stripped out in favour of
 * semantic status — see the note in types.ts.
 *
 * The known-hosts sample that used to live here is gone: the screen reads
 * `~/.ssh/known_hosts` itself now, and the rail counts what is in it rather
 * than the 41 this file asserted.
 */

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
