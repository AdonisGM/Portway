// Builds the landing page and the guide, then merges them into docs/site:
//   site/        landing page (Vietnamese at /, English at /en/)
//   site/docs/   Starlight guide (Vietnamese at /docs/, English at /docs/en/)
// docs/site is the folder to deploy for portway.nmtung.dev.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = (dir, args) => {
  const r = spawnSync('pnpm', args, { cwd: join(root, dir), stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run('landing', ['run', 'build']);
run('guide', ['run', 'build']);

const site = join(root, 'site');
rmSync(site, { recursive: true, force: true });
cpSync(join(root, 'landing/dist'), site, { recursive: true });
cpSync(join(root, 'guide/dist'), join(site, 'docs'), { recursive: true });
if (!existsSync(join(site, 'docs/index.html'))) throw new Error('guide build produced no docs/index.html');
console.log('\nMerged site ready in docs/site');
