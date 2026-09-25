#!/usr/bin/env bash
# Build Portway for macOS (universal: Apple Silicon + Intel) and collect the output in release/<version>/.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TARGET="universal-apple-darwin"
BUNDLE_DIR="src-tauri/target/$TARGET/release/bundle"

# Rust may be missing from PATH if the shell has not sourced ~/.cargo/env.
if ! command -v cargo >/dev/null 2>&1 && [ -f "$HOME/.cargo/env" ]; then
  source "$HOME/.cargo/env"
fi

for cmd in pnpm cargo rustup node; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing command: $cmd" >&2; exit 1; }
done

rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null

VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
PRODUCT="$(node -p "require('./src-tauri/tauri.conf.json').productName")"
OUT_DIR="$ROOT/release/$VERSION"

echo "==> Build $PRODUCT $VERSION ($TARGET)"
pnpm install --frozen-lockfile
pnpm tauri build --target "$TARGET"

echo "==> Collecting output in release/$VERSION"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
ditto "$BUNDLE_DIR/macos/$PRODUCT.app" "$OUT_DIR/$PRODUCT.app"
cp "$BUNDLE_DIR/dmg/"*.dmg "$OUT_DIR/"

echo
echo "Done. Files are in: $OUT_DIR"
ls -lh "$OUT_DIR"

if [ "${1:-}" = "--open" ]; then
  open "$OUT_DIR"
fi
