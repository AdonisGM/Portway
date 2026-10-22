// Cuts the landing page images out of full-window screenshots of the real app.
// Usage: node scripts/make-shots.mjs <dir with en/ and vi/ folders of PNGs>
// Output: public/shots/<lang>/<name>.webp and src/shots.generated.json (sizes).
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';

const src = process.argv[2];
if (!src) throw new Error('Pass the screenshot folder');

// name: [source file, left, top, width, height]
const CROPS = {
  hero: ['overview.png', 0, 0, 1600, 900],
  tunnel: ['tunnel-monitor.png', 667, 80, 913, 620],
  files: ['files-sel.png', 1230, 209, 352, 526],
  nginx: ['nginx.png', 292, 120, 900, 525],
  docker: ['docker-sel.png', 296, 268, 384, 438],
  firewall: ['firewall.png', 292, 120, 736, 440],
  services: ['services.png', 292, 120, 546, 440],
  http: ['http-time.png', 545, 417, 1036, 289],
  connect: ['connect.png', 296, 56, 1288, 155],
};

const sizes = {};
for (const lang of ['en', 'vi']) {
  mkdirSync(`public/shots/${lang}`, { recursive: true });
  for (const [name, [file, left, top, width, height]] of Object.entries(CROPS)) {
    const out = `public/shots/${lang}/${name}.webp`;
    await sharp(`${src}/${lang}/${file}`).extract({ left, top, width, height }).webp({ quality: 90, effort: 5 }).toFile(out);
    sizes[name] = { width, height };
  }
}
writeFileSync('src/shots.generated.json', JSON.stringify(sizes, null, 2) + '\n');
console.log('shots written', Object.keys(sizes).join(', '));
