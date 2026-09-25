# Portway

Ứng dụng desktop dùng Tauri 2 + React + TypeScript. Hiện tại chỉ build cho macOS.

## Yêu cầu

- Node.js 24+ và pnpm
- Rust stable (`rustup`)
- Xcode Command Line Tools (`xcode-select --install`)

## Phát triển

```sh
pnpm install
pnpm tauri dev
```

## Build

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin   # chỉ cần một lần
pnpm build:mac   # universal (Apple Silicon + Intel) → .app, .dmg
```

File cài đặt nằm trong `src-tauri/target/universal-apple-darwin/release/bundle/`.

## Cấu trúc

- `src/` — frontend React
- `src-tauri/` — backend Rust, cấu hình Tauri (`tauri.conf.json`), quyền (`capabilities/`)
