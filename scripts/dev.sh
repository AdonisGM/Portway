#!/usr/bin/env bash
# Run Portway in dev mode (Vite + Tauri with hot reload).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Rust may be missing from PATH if the shell has not sourced ~/.cargo/env.
if ! command -v cargo >/dev/null 2>&1 && [ -f "$HOME/.cargo/env" ]; then
  source "$HOME/.cargo/env"
fi

for cmd in pnpm cargo node; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing command: $cmd" >&2; exit 1; }
done

# Tauri expects Vite on a fixed port; a leftover dev server would make it fail.
if lsof -iTCP:1420 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port 1420 is in use (another dev server still running?). Stop it first:" >&2
  lsof -iTCP:1420 -sTCP:LISTEN >&2
  exit 1
fi

# Install dependencies only when the lockfile changed since the last install.
if [ ! -d node_modules ] || [ pnpm-lock.yaml -nt node_modules/.modules.yaml ]; then
  pnpm install --frozen-lockfile
fi

exec pnpm tauri dev
