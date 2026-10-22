// Serves docs/site the way a static host would (directory index, 404.html).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = join(fileURLToPath(new URL('..', import.meta.url)), 'site');
const port = Number(process.env.PORT ?? 4173);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain', '.wasm': 'application/wasm' };

async function resolve(url) {
  const path = normalize(decodeURIComponent(new URL(url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(root, path);
  const s = await stat(file).catch(() => null);
  if (s?.isDirectory()) file = join(file, 'index.html');
  return file;
}

// Hashed bundles never change, so they are cached for good; everything else is revalidated with an ETag.
const immutable = /\/(assets|_astro)\//;
const compressible = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.json', '.xml', '.txt']);
const gzipped = new Map();

createServer(async (req, res) => {
  try {
    const file = await resolve(req.url ?? '/');
    const [body, info] = await Promise.all([readFile(file), stat(file)]);
    const ext = extname(file);
    const etag = `W/"${info.size}-${Math.floor(info.mtimeMs)}"`;
    const headers = {
      'content-type': types[ext] ?? 'application/octet-stream',
      etag,
      'cache-control': immutable.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache',
      vary: 'Accept-Encoding',
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    let out = body;
    if (compressible.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
      let hit = gzipped.get(file);
      if (hit?.etag !== etag) gzipped.set(file, (hit = { etag, body: gzipSync(body) }));
      out = hit.body;
      headers['content-encoding'] = 'gzip';
    }
    headers['content-length'] = out.length;
    res.writeHead(200, headers);
    res.end(out);
  } catch {
    const body = await readFile(join(root, '404.html')).catch(() => 'Not found');
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  }
}).listen(port, () => console.log(`Preview: http://localhost:${port}`));
