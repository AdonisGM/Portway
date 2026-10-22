// Runs both dev servers. The landing dev server proxies /docs to the guide, so
// http://localhost:5180 behaves like the deployed site.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const procs = [
  spawn('pnpm', ['exec', 'vite'], { cwd: join(root, 'landing'), stdio: 'inherit' }),
  spawn('pnpm', ['exec', 'astro', 'dev', '--port', '5181'], { cwd: join(root, 'guide'), stdio: 'inherit' }),
];
const stop = () => procs.forEach((p) => p.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
procs.forEach((p) => p.on('exit', stop));
