# Portway

Ứng dụng desktop dùng Tauri 2 + React + TypeScript. Hiện tại chỉ build cho macOS.

## Yêu cầu

- Node.js 24+ và pnpm
- Rust stable (`rustup`)
- Xcode Command Line Tools (`xcode-select --install`)

## Phát triển

```sh
./scripts/dev.sh
```

Script tự nạp Rust vào PATH, cài dependency khi lockfile thay đổi, báo lỗi nếu cổng 1420 đang bị chiếm, rồi chạy `pnpm tauri dev`.

## Build

```sh
./scripts/build-mac.sh          # build universal (Apple Silicon + Intel)
./scripts/build-mac.sh --open   # build xong mở luôn thư mục kết quả
```

Kết quả (`Portway.app` và file `.dmg`) được gom vào `release/<version>/`, version lấy từ `src-tauri/tauri.conf.json`. Thư mục `release/` không được commit.

## Version

Mỗi commit tăng version một bậc, bằng `pnpm version:bump <patch|minor|major|x.y.z>`. Lệnh này sửa cùng lúc `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` và `Cargo.lock`.

- `0.0.x`: đang dựng giao diện với dữ liệu mẫu, mỗi commit tăng patch.
- `0.1.0`: xong giao diện toàn bộ màn hình theo thiết kế.
- Sau `0.1.0`: tính năng mới tăng minor, sửa lỗi hoặc chỉnh nhỏ tăng patch.
- `1.0.0`: kết nối SSH thật, dùng được hằng ngày.

## Cấu trúc

- `src/` — frontend React
- `src-tauri/` — backend Rust, cấu hình Tauri (`tauri.conf.json`), quyền (`capabilities/`)
