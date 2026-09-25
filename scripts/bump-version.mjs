#!/usr/bin/env node
// Set the app version in every place that carries it, so they never drift:
// package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml (and Cargo.lock).
//
// Usage: node scripts/bump-version.mjs <patch|minor|major|x.y.z>
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const root = new URL('..', import.meta.url)
const file = (p) => new URL(p, root)

const pkg = JSON.parse(readFileSync(file('package.json'), 'utf8'))
const arg = process.argv[2]
if (!arg) {
  console.error('Usage: node scripts/bump-version.mjs <patch|minor|major|x.y.z>')
  process.exit(1)
}

const current = pkg.version
const [major, minor, patch] = current.split('.').map(Number)
const next =
  arg === 'patch' ? `${major}.${minor}.${patch + 1}`
  : arg === 'minor' ? `${major}.${minor + 1}.0`
  : arg === 'major' ? `${major + 1}.0.0`
  : arg
if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error(`Invalid version: ${next}`)
  process.exit(1)
}

pkg.version = next
writeFileSync(file('package.json'), JSON.stringify(pkg, null, 2) + '\n')

const confPath = file('src-tauri/tauri.conf.json')
const conf = JSON.parse(readFileSync(confPath, 'utf8'))
conf.version = next
writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n')

const cargoPath = file('src-tauri/Cargo.toml')
const cargo = readFileSync(cargoPath, 'utf8')
// Only the [package] version: the first `version = "..."` line in the file.
writeFileSync(cargoPath, cargo.replace(/^version = ".*"$/m, `version = "${next}"`))

// Refresh Cargo.lock for the new package version without touching dependencies.
try {
  execSync('cargo update --workspace --offline', { cwd: file('src-tauri'), stdio: 'ignore' })
} catch {
  console.warn('Could not refresh Cargo.lock; it will update on the next cargo build.')
}

console.log(`${current} -> ${next}`)
