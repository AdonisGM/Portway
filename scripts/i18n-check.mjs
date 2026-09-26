#!/usr/bin/env node
// Checks that the UI is fully translated:
//  1. every Vietnamese string in src/ (string literals, templates, JSX text)
//     is the first argument of t(…), as a plain string literal;
//  2. every t(…) key has an English entry in src/i18n/en/*;
//  3. Vietnamese strings in src-tauri/src go through i18n::tr(…).
// A line containing `i18n-ignore` is skipped (e.g. the name "Tiếng Việt").
//
// Usage: node scripts/i18n-check.mjs [--unused]
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

const root = new URL('..', import.meta.url).pathname
const VI = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ]/

function walk(dir, exts) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return walk(p, exts)
    return exts.some((e) => n.endsWith(e)) ? [p] : []
  })
}

const problems = []
const keys = new Map() // key → first place used

function isTArg(node) {
  const call = node.parent
  return call && ts.isCallExpression(call) && call.arguments[0] === node && ts.isIdentifier(call.expression) && call.expression.text === 't'
}

for (const file of walk(join(root, 'src'), ['.ts', '.tsx'])) {
  if (file.includes('/src/i18n/')) continue
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const where = (node) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line
    return { at: `${relative(root, file)}:${line + 1}`, ignored: lines[line].includes('i18n-ignore') }
  }
  const visit = (node) => {
    // Keys: t('…') with a plain literal.
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't') {
      const a = node.arguments[0]
      if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) {
        if (!keys.has(a.text)) keys.set(a.text, where(a).at)
      } else if (a) {
        const w = where(a)
        if (!w.ignored) problems.push(`${w.at}  t() needs a plain string literal, not an expression`)
      }
    }
    const vi =
      ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && VI.test(node.text)) ||
      (ts.isTemplateExpression(node) && VI.test(node.getText(sf))) ||
      (ts.isJsxText(node) && VI.test(node.text))
    if (vi && !isTArg(node)) {
      const w = where(node)
      if (!w.ignored) problems.push(`${w.at}  untranslated: ${node.getText(sf).trim().slice(0, 90)}`)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

// English entries.
const en = new Map()
for (const file of walk(join(root, 'src/i18n/en'), ['.ts'])) {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && (ts.isStringLiteral(node.name) || ts.isIdentifier(node.name))) {
      const k = node.name.text
      if (en.has(k) && en.get(k) !== relative(root, file)) {
        // The same key in two areas is fine; the translations just have to agree.
      }
      en.set(k, relative(root, file))
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}
for (const [k, at] of keys) if (!en.has(k)) problems.push(`${at}  no English for: ${k}`)

// Rust: Vietnamese literals outside tr(…) and outside tests.
for (const file of walk(join(root, 'src-tauri/src'), ['.rs'])) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const testsAt = lines.findIndex((l) => l.trim() === '#[cfg(test)]')
  lines.slice(0, testsAt < 0 ? lines.length : testsAt).forEach((l, i) => {
    const code = l.replace(/\/\/.*$/, '')
    const strings = code.match(/"(?:[^"\\]|\\.)*"/g) ?? []
    if (strings.some((s) => VI.test(s)) && !/\btr\(|i18n-ignore/.test(l)) problems.push(`${relative(root, file)}:${i + 1}  untranslated (Rust): ${l.trim().slice(0, 90)}`)
  })
}

if (process.argv.includes('--unused')) {
  for (const [k, at] of en) if (!keys.has(k)) console.log(`unused: ${k}  (${at})`)
}
if (problems.length) {
  console.log(problems.join('\n'))
  console.log(`\n${problems.length} problem(s); ${keys.size} keys, ${en.size} English entries`)
  // exitCode, not exit(): exit() can cut output still being piped (e.g. into grep).
  process.exitCode = 1
} else {
  console.log(`i18n ok: ${keys.size} keys, all translated`)
}
