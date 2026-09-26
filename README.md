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

## Server thử

Bốn server SSH chạy bằng Docker, chỉ mở trên `127.0.0.1`, dùng khoá `~/.ssh/id_ed25519.pub` của máy (đổi bằng biến `PORTWAY_TEST_PUBKEY`):

```sh
./scripts/test-servers.sh up      # dựng và chạy
./scripts/test-servers.sh down    # tắt
./scripts/test-servers.sh seed    # tạo container, image, volume mẫu trong Docker riêng của pw-debian
```

| Server | Cổng | Đăng nhập |
|---|---|---|
| Ubuntu 24.04 (`pw-ubuntu`) | 2201 | `root`, `deploy`, `viewer` bằng khoá; có Docker CLI dùng socket **thật** của máy (chỉ nên xem, đừng dừng/xoá) và UFW đang bật |
| Debian 12 (`pw-debian`) | 2202 | `root`, `deploy`, `viewer` bằng khoá; `deploy` còn đăng nhập được bằng mật khẩu; có Docker riêng (service `dind`), `deploy` thuộc group docker, thử dừng/xoá/dọn thoải mái |
| Debian 12 + systemd (`pw-systemd`) | 2204 | `root`, `deploy`, `viewer` bằng khoá; systemd thật với nginx, redis, một worker lỗi liên tục, timer và crontab mẫu |
| Alpine 3.20 (`pw-alpine`) | 2203 | `root`, `deploy`, `viewer` bằng khoá; không có Docker |

Mật khẩu của `deploy` và `viewer` là `portway`. `deploy` dùng được sudo (cần mật khẩu), `viewer` không có sudo.

`dev/test-servers/ssh_config` có sẵn các khối `Host` tương ứng để thử tính năng nhập.

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
