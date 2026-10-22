import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource/roboto-mono/400.css';
import '@fontsource/roboto-mono/500.css';
import './styles.css';
import { App } from './App';
import type { Lang } from './content';

// The language comes from the URL: "/vi/" is Vietnamese, everything else English.
const lang: Lang = window.location.pathname.startsWith('/vi') ? 'vi' : 'en';
document.documentElement.lang = lang;

const root = document.getElementById('root')!;
const tree = (
  <StrictMode>
    <App lang={lang} />
  </StrictMode>
);
// Production pages are prerendered and hydrated; the dev server serves an empty root.
if (root.hasChildNodes()) hydrateRoot(root, tree);
else createRoot(root).render(tree);
