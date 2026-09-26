/** A command as it runs through sudo: each step of an `a && b` chain gets
 *  sudo (the whole script runs as root), except `cd`, which only moves. */
export function withSudo(cmd: string, on: boolean) {
  if (!on) return cmd
  return cmd
    .split(' && ')
    .map((c) => (c.startsWith('cd ') ? c : `sudo ${c}`))
    .join(' && ')
}
