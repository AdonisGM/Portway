// Renders the page to static HTML for both languages so crawlers and first paint see real content.
// Output: dist/index.html (English, the default) and dist/vi/index.html (Vietnamese).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const template = readFileSync('dist/index.html', 'utf8');
const { render } = await import(pathToFileURL(process.cwd() + '/dist-ssr/entry-server.js').href);

for (const lang of ['en', 'vi']) {
  const { html, head } = render(lang);
  const page = template
    .replace('<html lang="en"', `<html lang="${lang}"`)
    .replace('<!--head-->', head)
    .replace('<!--app-->', html);
  const out = lang === 'en' ? 'dist/index.html' : 'dist/vi/index.html';
  if (lang !== 'en') mkdirSync('dist/vi', { recursive: true });
  writeFileSync(out, page);
  console.log('prerendered', out);
}
rmSync('dist-ssr', { recursive: true, force: true });
