#!/usr/bin/env node
// Build the app icon source (src-tauri/icons/app-icon.svg): the AdonisGM mark,
// rendered from @adonisgm/logo itself, white on a dark gray rounded square
// laid out on Apple's macOS icon grid (824 px body on a 1024 px canvas).
//
// Then render it to a 1024 px PNG with any browser and let Tauri make every size:
//   node scripts/app-icon.mjs
//   <render src-tauri/icons/app-icon.svg to app-icon.png, 1024x1024, transparent>
//   pnpm tauri icon app-icon.png
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AdonisMark } from '@adonisgm/logo'

const CANVAS = 1024
const BODY = 824 // Apple's icon body on a 1024 grid
const INSET = (CANVAS - BODY) / 2
const RADIUS = 185 // ≈ 22.4 % of the body, the macOS corner

// The mark draws inside x 10–90, y 22–96 of its 100 box: centre that shape,
// not the box, and make it about half the body wide.
const MARK = 520
const markX = CANVAS / 2 - 0.5 * MARK
const markY = CANVAS / 2 - 0.59 * MARK

const mark = renderToStaticMarkup(createElement(AdonisMark, { size: MARK, color: '#ffffff', idPrefix: 'appicon', title: '' }))
  // Position it on the canvas.
  .replace('<svg ', `<svg x="${markX}" y="${markY}" `)
  .replace(' style="display:block"', '')

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3a3c40"/>
      <stop offset="1" stop-color="#1e1f22"/>
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="125%">
      <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000" flood-opacity="0.35"/>
    </filter>
  </defs>
  <rect x="${INSET}" y="${INSET}" width="${BODY}" height="${BODY}" rx="${RADIUS}" fill="url(#bg)" filter="url(#shadow)"/>
  <rect x="${INSET + 1}" y="${INSET + 1}" width="${BODY - 2}" height="${BODY - 2}" rx="${RADIUS - 1}" fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="2"/>
  ${mark}
</svg>
`

const out = fileURLToPath(new URL('../src-tauri/icons/app-icon.svg', import.meta.url))
writeFileSync(out, svg)
console.log(`wrote ${out}`)
