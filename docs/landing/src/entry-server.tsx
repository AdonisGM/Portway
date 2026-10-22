import { renderToString } from 'react-dom/server';
import { App } from './App';
import { copy, type Lang } from './content';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function render(lang: Lang) {
  const m = copy[lang].meta;
  const url = lang === 'vi' ? 'https://portway.nmtung.dev/vi/' : 'https://portway.nmtung.dev/';
  const head = [
    `<title>${esc(m.title)}</title>`,
    `<meta name="description" content="${esc(m.description)}" />`,
    `<link rel="canonical" href="${url}" />`,
    `<link rel="alternate" hreflang="en" href="https://portway.nmtung.dev/" />`,
    `<link rel="alternate" hreflang="vi" href="https://portway.nmtung.dev/vi/" />`,
    `<link rel="alternate" hreflang="x-default" href="https://portway.nmtung.dev/" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${esc(m.title)}" />`,
    `<meta property="og:description" content="${esc(m.description)}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta name="theme-color" content="#0b0c0d" />`,
  ].join('\n    ');
  return { html: renderToString(<App lang={lang} />), head };
}
