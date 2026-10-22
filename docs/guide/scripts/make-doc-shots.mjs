// Cuts the guide screenshots out of full-window PNGs of the real app.
// Usage: node scripts/make-doc-shots.mjs <dir with real/ and real2/, each holding en/ and vi/>
// Output: public/img/<lang>/<name>.webp
// A crop is [source, left, top, width, height]; a language-specific crop overrides the shared one.
import sharp from 'sharp';
import { existsSync, mkdirSync } from 'node:fs';

const root = process.argv[2];
if (!root) throw new Error('Pass the screenshot folder');

const FULL = [0, 0, 1600, 900];
const CROPS = {
  'add-server-1-list': ['real2/add-server-1-list.png', 296, 60, 1290, 250],
  'add-server-2-form': ['real2/add-server-2-form.png', 540, 36, 520, 732],
  'add-server-3-list': ['real2/add-server-3-list.png', 296, 60, 1290, 250],
  'add-server-4-account': ['real2/add-server-4-account.png', 296, 60, 1290, 250],
  'add-server-5-hostkey': ['real2/add-server-5-hostkey.png', 550, 36, 500, 345],
  'add-server-6-overview': ['real2/add-server-6-overview.png', ...FULL],
  overview: ['real/overview.png', ...FULL],
  'overview-deploy': ['real2/deploy-overview.png', 296, 120, 1280, 195],
  audit: ['real2/audit.png', 296, 585, 1280, 280],
  sudo: ['real2/sudo-dialog.png', 585, 36, 430, 340],
  servers: ['real2/servers.png', 296, 60, 1290, 320],
  keys: ['real2/keys.png', 296, 60, 1290, 530],
  'key-new': ['real2/key-new.png', 556, 36, 490, 595],
  files: ['real/files-sel.png', 296, 60, 1290, 800],
  'transfer-select': ['real/transfer-select.png', 296, 120, 1290, 360],
  'transfer-done': ['real/transfer-done.png', 1050, 665, 535, 200],
  'transfer-conflict': ['real2/transfer-conflict.png', 510, 36, 580, 475],
  tunnel: ['real/tunnel-monitor.png', 660, 0, 940, 700],
  'tunnel-form': ['real/tunnel-form.png', 490, 36, 620, 745],
  docker: ['real/docker-sel.png', 296, 125, 1290, 735],
  'docker-compose': ['real2/docker-compose.png', 296, 180, 1280, 165],
  'docker-volumes': ['real2/docker-volumes.png', 296, 180, 1280, 270],
  'docker-log': ['real2/docker-log.png', 370, 36, 860, 660],
  'docker-prune': ['real2/docker-prune.png', 530, 36, 540, 455],
  services: ['real/services.png', 296, 125, 1290, 560],
  'services-detail': ['real2/services-detail.png', 296, 125, 1290, 740],
  'services-confirm': ['real2/services-confirm.png', 550, 36, 500, 340],
  nginx: ['real/nginx.png', 296, 125, 1290, 740],
  firewall: ['real/firewall.png', 296, 125, 1290, 540],
  'firewall-open': ['real2/firewall-open.png', 510, 36, 580, 475],
  http: ['real/http-time.png', 296, 125, 1290, 640],
  settings: ['real2/settings.png', 296, 60, 790, 840],
  connect: ['real/connect.png', 296, 56, 1290, 160],
};
const BY_LANG = {
  vi: {
    audit: ['real2/audit.png', 296, 490, 1280, 375],
    'docker-prune': ['real2/docker-prune.png', 530, 36, 540, 440],
    'add-server-2-form': ['real2/add-server-2-form.png', 540, 36, 520, 722],
  },
};

for (const lang of ['en', 'vi']) {
  mkdirSync(`public/img/${lang}`, { recursive: true });
  for (const [name, shared] of Object.entries(CROPS)) {
    const [file, left, top, width, height] = BY_LANG[lang]?.[name] ?? shared;
    const src = `${root}/${file.replace('/', `/${lang}/`)}`;
    if (!existsSync(src)) {
      console.warn('missing', src);
      continue;
    }
    await sharp(src).extract({ left, top, width, height }).webp({ quality: 90, effort: 5 }).toFile(`public/img/${lang}/${name}.webp`);
  }
}
console.log('doc shots written');
