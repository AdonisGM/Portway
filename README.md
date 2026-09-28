<div align="center">

# Portway

**Ứng dụng quản lý server Linux qua SSH dành cho macOS và Windows**

Kết nối, duyệt tệp, truyền dữ liệu, mở tunnel và quản trị dịch vụ trên nhiều server trong một cửa sổ duy nhất.

![macOS](https://img.shields.io/badge/macOS-11%2B-111315?logo=apple&logoColor=white)
![Windows](https://img.shields.io/badge/Windows-10%2B-0078D4?logo=windows&logoColor=white)
![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![Rust](https://img.shields.io/badge/Rust-stable-B7410E?logo=rust&logoColor=white)

</div>

---

## Mục lục

- [Giới thiệu](#giới-thiệu)
- [Tính năng](#tính-năng)
- [Bảo mật và dữ liệu](#bảo-mật-và-dữ-liệu)
- [Yêu cầu hệ thống](#yêu-cầu-hệ-thống)
- [Phát triển](#phát-triển)
- [Server thử nghiệm](#server-thử-nghiệm)
- [Đóng gói](#đóng-gói)
- [Quy ước của dự án](#quy-ước-của-dự-án)
- [Cấu trúc thư mục](#cấu-trúc-thư-mục)
- [Công nghệ sử dụng](#công-nghệ-sử-dụng)

## Giới thiệu

Portway là ứng dụng desktop giúp quản trị các server Linux thông qua SSH mà không cần cài thêm agent nào trên server. Mọi thao tác đều được thực hiện bằng các lệnh chuẩn (`sftp`, `systemctl`, `docker`, `nginx`, `ufw`, `firewall-cmd`, `curl`…), và mỗi lệnh được ghi lại trong nhật ký để người dùng có thể kiểm tra lại Portway đã làm gì trên server.

Ứng dụng được xây dựng bằng Tauri 2: phần giao diện viết bằng React, phần kết nối SSH, SFTP và tunnel viết bằng Rust (thư viện `russh`). Portway chạy trên macOS và Windows. Giao diện có hai ngôn ngữ, tiếng Việt và tiếng Anh.

## Tính năng

### Quản lý kết nối

- Lưu danh sách server theo nhóm và thẻ; mỗi server có thể có nhiều tài khoản đăng nhập, bằng mật khẩu hoặc khoá SSH.
- Nhập server từ `~/.ssh/config`, bao gồm cả cấu hình `ProxyJump`.
- Kết nối qua **jump host** (bastion) cho các server không mở SSH ra ngoài.
- Kiểm tra khoá máy chủ theo `~/.ssh/known_hosts` giống OpenSSH; khoá lạ hoặc khoá bị thay đổi đều phải được người dùng xác nhận.
- Xuất và nhập danh sách server dưới dạng tệp JSON.
- Mở Terminal của macOS với lệnh `ssh` tương ứng chỉ bằng một cú nhấp.

### Tổng quan server

- Thông tin hệ điều hành, thời gian hoạt động, CPU, bộ nhớ và ổ đĩa.
- Danh sách tiến trình tốn tài nguyên nhất.
- Nhật ký thao tác: mọi lệnh làm thay đổi server (khởi động lại dịch vụ, sửa rule firewall, lưu tệp…) đều được ghi lại kèm kết quả.

### Tệp (SFTP)

- Duyệt thư mục, sắp xếp, lọc, chọn nhiều tệp; đổi tên, phân quyền, đổi chủ sở hữu.
- **Thao tác bằng quyền root qua sudo** khi đăng nhập bằng user thường: Portway mở thêm một kênh SFTP chạy `sudo sftp-server`, nhờ đó mọi thao tác duyệt, tải lên, tải xuống, sửa và xoá đều được thực hiện với quyền root.
- Tải lên và tải xuống cả tệp lẫn thư mục; hỗ trợ kéo thả trực tiếp từ Finder.
- **Sửa tệp bằng ứng dụng trên máy** (VS Code, Sublime Text, TextEdit…): tệp được tải về một thư mục tạm riêng cho từng server và tài khoản, và được tự động tải lại lên server mỗi khi lưu. Portway phát hiện xung đột khi tệp trên server bị thay đổi trong lúc đang sửa.
- Tệp Word, Excel, PDF, ảnh… mở bằng app mặc định của máy cho loại tệp đó; Portway ghi nhớ app theo từng đuôi tệp và cho đổi trong Cài đặt. Tệp chữ mở bằng editor đã chọn. Các loại tệp chạy được (`.sh`, `.command`, `.bat`, `.exe`…) không bao giờ được để hệ thống tự mở.
- Theo dõi log theo thời gian thực, tương tự `tail -f`.
- Hàng đợi truyền tệp hiển thị tiến độ, tốc độ và các mục bị bỏ qua.

### Truyền tệp giữa hai máy

- Giao diện hai khung, mỗi khung là máy Mac hoặc một server bất kỳ.
- Sao chép từ server này sang server khác; dữ liệu được chuyển tiếp qua máy Mac.
- Hộp thoại xử lý trùng tên (ghi đè, bỏ qua, giữ cả hai), kiểm tra quyền ghi trước khi sao chép và phím tắt đầy đủ.

### Dịch vụ và ứng dụng

- **Docker**: container, image, volume; xem log, khởi động, dừng, xoá container và dọn image thừa.
- **Dịch vụ systemd**: trạng thái, bật/tắt khi khởi động, khởi động lại, xem journal và tệp unit.
- **Nginx**: danh sách site cùng đích của từng site (reverse proxy, web tĩnh, chuyển hướng), thời hạn chứng chỉ SSL, kiểm tra upstream còn phản hồi hay không; kiểm tra cấu hình, reload, bật hoặc tắt site. Nếu việc bật hoặc tắt site làm `nginx -t` báo lỗi, thay đổi được hoàn tác ngay.
- **Firewall**: đọc và sửa rule của `ufw` hoặc `firewalld`; đối chiếu với các cổng đang lắng nghe để chỉ ra cổng đang mở ra internet, rule thừa, và các cổng Docker vượt qua firewall.

### HTTP (curl trên server)

- Gửi request HTTP **từ chính server đang kết nối**, theo phong cách Postman: method, header, query, body, xác thực, tuỳ chọn chuyển hướng và timeout.
- Hiển thị status, header, body (tự định dạng JSON) và thời gian của từng giai đoạn (DNS, kết nối, TLS, phản hồi).
- Lưu request và lịch sử; token và mật khẩu được lưu trong Keychain, không nằm trong tệp lưu trữ.

### Tunnel

- Ba loại chuyển tiếp: **Local** (`ssh -L`), **SOCKS5** (`ssh -D`) và **Remote** (`ssh -R`).
- Tự khởi động khi mở ứng dụng và tự kết nối lại khi mất mạng.
- Cho phép mở tunnel ra mạng LAN; khi đó tunnel SOCKS bắt buộc có user và mật khẩu (RFC 1929).
- **Màn hình theo dõi**: tốc độ tải lên và tải xuống theo thời gian thực, độ trễ SSH, biểu đồ 1/5/15 phút, danh sách kết nối đang mở kèm **ứng dụng trên máy Mac** đã tạo ra kết nối, đích thật của từng kết nối SOCKS và lý do của các kết nối thất bại.

### Khác

- Cửa sổ Debug log liệt kê mọi lệnh Portway chạy trên server, kèm thời gian chờ, thời gian chạy và kết quả.
- Cài đặt: ngôn ngữ, giao diện sáng/tối, thư mục tải xuống mặc định, ứng dụng sửa tệp mặc định, xuất và nhập dữ liệu.

## Bảo mật và dữ liệu

- Mật khẩu đăng nhập, passphrase của khoá, mật khẩu SOCKS và bí mật trong request HTTP đều được lưu trong kho bí mật của hệ điều hành: **Keychain** trên macOS, **Credential Manager** trên Windows. Credential Manager giới hạn mỗi mục khoảng 1.280 ký tự, nên giá trị dài hơn được Portway tự chia thành nhiều mục.
- Mật khẩu `sudo` được truyền qua stdin (`sudo -S`), không xuất hiện trong dòng lệnh hay trong nhật ký.
- Khi mở Terminal cho một tài khoản đăng nhập bằng mật khẩu (hoặc khoá có passphrase), `ssh` lấy bí mật đã lưu qua một script `SSH_ASKPASS` tạm thời trên macOS. Script không chứa mật khẩu, chỉ biết mục nào trong Keychain trả lời câu hỏi nào; `security` đọc mục đó sau khi macOS hỏi người dùng cho phép. Bí mật chưa được lưu thì Terminal hỏi như bình thường.
- Cấu hình được lưu tại `~/Library/Application Support/com.portway.app/` trên macOS và `%APPDATA%\com.portway.app\` trên Windows:

  | Tệp | Nội dung |
  |---|---|
  | `servers.json` | Danh sách server và tài khoản (không chứa mật khẩu) |
  | `tunnels.json` | Cấu hình tunnel |
  | `http.json` | Request đã lưu và lịch sử (bí mật đã được lược bỏ) |
  | `settings.json` | Cài đặt ứng dụng |
  | `audit.jsonl` | Nhật ký thao tác |

- Webview chạy với Content Security Policy chặt chẽ và chỉ được cấp những quyền cần thiết (`src-tauri/capabilities/`).

## Yêu cầu hệ thống

- macOS 11 (Big Sur) trở lên, chạy trên Apple Silicon hoặc Intel.
- Windows 10 (bản 1809 trở lên) hoặc Windows 11, 64-bit. Cần WebView2 (có sẵn trên Windows 11; bộ cài tự tải về nếu máy chưa có). Tính năng mở Terminal dùng OpenSSH Client có sẵn của Windows.
- Server đích: Linux có OpenSSH. Các tính năng quản trị dựa trên công cụ sẵn có của server như `systemd`, `docker`, `nginx`, `ufw` hoặc `firewalld`.

## Phát triển

### Chuẩn bị

- Node.js 24 trở lên và pnpm
- Rust stable (cài bằng `rustup`)
- macOS: Xcode Command Line Tools (`xcode-select --install`)
- Windows: Visual Studio Build Tools với gói "Desktop development with C++", và [NASM](https://www.nasm.us) (thư viện mã hoá của `russh` cần khi biên dịch)
- Quyền truy cập registry riêng `https://npm.nmtung.dev` cho gói `@adonisgm/logo` (đã khai báo trong `.npmrc`)

### Chạy ứng dụng

```sh
./scripts/dev.sh
```

Script tự nạp Rust vào `PATH`, cài lại dependency khi lockfile thay đổi, báo lỗi nếu cổng 1420 đang bị chiếm, sau đó chạy `pnpm tauri dev`. Trên Windows, chạy trực tiếp `pnpm install` rồi `pnpm tauri dev`.

### Kiểm tra

```sh
pnpm exec tsc --noEmit            # kiểm tra kiểu TypeScript
pnpm i18n:check                   # mọi chuỗi giao diện đều có bản tiếng Anh
cd src-tauri && cargo test        # unit test của phần Rust
cd src-tauri && cargo test -- --ignored   # test chạy trên các server thử nghiệm
```

## Server thử nghiệm

Dự án kèm một bộ server SSH chạy bằng Docker để thử mọi tính năng mà không đụng đến server thật. Các server chỉ mở trên `127.0.0.1` và dùng khoá `~/.ssh/id_ed25519.pub` của máy (có thể đổi bằng biến môi trường `PORTWAY_TEST_PUBKEY`).

```sh
./scripts/test-servers.sh up      # dựng và chạy
./scripts/test-servers.sh down    # tắt
./scripts/test-servers.sh seed    # tạo container, image, volume mẫu trong Docker riêng của pw-debian
```

| Server | Cổng | Đặc điểm |
|---|---|---|
| Ubuntu 24.04 (`pw-ubuntu`) | 2201 | Có Docker CLI dùng socket **thật** của máy (chỉ nên xem, không nên dừng hay xoá); UFW đang bật |
| Debian 12 (`pw-debian`) | 2202 | `deploy` đăng nhập được bằng mật khẩu; có Docker riêng (service `dind`) để thử dừng, xoá, dọn dẹp |
| Alpine 3.20 (`pw-alpine`) | 2203 | Không có Docker |
| Debian 12 + systemd (`pw-systemd`) | 2204 | systemd thật với nginx (site proxy có SSL, web tĩnh có chứng chỉ sắp hết hạn, site chuyển hướng đang tắt, proxy tới cổng không hoạt động), redis, một worker lỗi liên tục, timer và crontab mẫu |
| Oracle Linux 9 + firewalld (`pw-oracle`) | 2205 | firewalld đang chạy với port, dải port và rich rule mẫu |

Mỗi server có ba tài khoản `root`, `deploy`, `viewer` đăng nhập bằng khoá. Mật khẩu của `deploy` và `viewer` là `portway`; `deploy` dùng được `sudo` (cần mật khẩu), `viewer` không có quyền `sudo`.

Tệp `dev/test-servers/ssh_config` có sẵn các khối `Host` tương ứng để thử tính năng nhập từ `~/.ssh/config`. Để thử jump host, thêm một server có host `debian`, cổng 22, kết nối qua `pw-ubuntu`: các container dùng chung mạng Docker nên `pw-ubuntu` truy cập được `debian`.

## Đóng gói

```sh
./scripts/build-mac.sh          # build universal (Apple Silicon + Intel)
./scripts/build-mac.sh --open   # build xong mở thư mục kết quả
```

Kết quả (`Portway.app` và tệp `.dmg`) được đặt trong `release/<version>/`, với version lấy từ `src-tauri/tauri.conf.json`. Thư mục `release/` không được đưa vào git.

Trên Windows, bộ cài NSIS (cài cho người dùng hiện tại, không cần quyền quản trị) được tạo bằng:

```powershell
.\scripts\build-windows.ps1
```

### Kiểm tra bản Windows từ macOS

Phần Rust có thể được biên dịch cho Windows ngay trên máy Mac để phát hiện lỗi sớm:

```sh
brew install mingw-w64 nasm
rustup target add x86_64-pc-windows-gnu
cd src-tauri && cargo check --target x86_64-pc-windows-gnu --lib --tests
```

## Khác biệt giữa macOS và Windows

| | macOS | Windows |
|---|---|---|
| Lưu bí mật | Keychain | Credential Manager |
| Thanh tiêu đề | Vẽ bằng HTML, giữ ba nút của macOS | Thanh tiêu đề gốc của Windows |
| Mở Terminal | Terminal.app | Cửa sổ console (Windows Terminal trên Windows 11) chạy `ssh.exe` hoặc PowerShell |
| Ứng dụng sửa tệp mặc định | Trình soạn văn bản mặc định của macOS | Notepad; có thể chọn VS Code, Notepad++… hoặc bất kỳ tệp `.exe` nào |
| Đường dẫn trong khung "Máy này" | `/Users/…` | `/c/Users/…`, thư mục gốc `/` liệt kê các ổ đĩa |
| Tìm ứng dụng tạo kết nối qua tunnel | `lsof` | Bảng kết nối TCP của Windows |

Khi tải tệp từ server về Windows, những tên Linux cho phép nhưng Windows không cho (chứa `\ : * ? " < > |`, kết thúc bằng dấu chấm, hoặc trùng tên thiết bị như `CON`) được bỏ qua và tính vào số mục bị bỏ qua.

## Quy ước của dự án

### Version

Mỗi commit đều tăng version và được gắn tag `vX.Y.Z`. Lệnh sau cập nhật đồng thời `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` và `Cargo.lock`:

```sh
pnpm version:bump <patch|minor|major|x.y.z>
```

Tính năng mới tăng `minor`; sửa lỗi và chỉnh sửa nhỏ tăng `patch`.

### Ngôn ngữ

- Mã nguồn, chú thích và commit viết bằng tiếng Anh.
- Chuỗi giao diện viết bằng tiếng Việt và đặt trong `t('…')`; chính chuỗi tiếng Việt là khoá tra cứu. Bản tiếng Anh nằm trong `src/i18n/en/<khu-vực>.ts`.
- Phía Rust dùng `i18n::tr(vi, en)` cho các thông báo hiển thị cho người dùng.
- `pnpm i18n:check` báo lỗi nếu có chuỗi tiếng Việt chưa qua `t()` hoặc chưa có bản tiếng Anh.

### Giao diện

- Biểu tượng lấy từ `lucide-react`; riêng logo của các bản phân phối Linux lấy từ `simple-icons`.
- Màn hình danh sách luôn vừa khít cửa sổ; bảng và panel tự cuộn bên trong, trang không cuộn.
- Mỗi dòng của bảng là một grid riêng, vì vậy các cột chỉ dùng kích thước cố định hoặc `minmax(0, …)`, không dùng `auto`, để các cột luôn thẳng hàng.

## Cấu trúc thư mục

```text
portway/
├── src/                    # Giao diện React
│   ├── app/                # State dùng chung (server, phiên, tunnel, cài đặt…)
│   ├── components/         # Thành phần giao diện dùng lại
│   ├── i18n/               # Hàm t(), bản dịch tiếng Anh, định dạng ngày
│   ├── layout/             # Khung ứng dụng, thanh bên, menu
│   ├── lib/                # Lớp gọi API sang Rust và tiện ích
│   ├── screens/            # Từng màn hình: servers, files, transfer, docker,
│   │                       # services, nginx, firewall, http, tunnels, settings…
│   └── debug/              # Cửa sổ Debug log
├── src-tauri/              # Backend Rust và cấu hình Tauri
│   ├── src/                # SSH, SFTP, tunnel, truyền tệp, các module quản trị
│   ├── capabilities/       # Quyền của webview
│   └── tauri.conf.json
├── scripts/                # dev, build, bump version, kiểm tra i18n, server thử
└── dev/test-servers/       # Dockerfile và cấu hình của server thử nghiệm
```

## Công nghệ sử dụng

| Thành phần | Công nghệ |
|---|---|
| Ứng dụng desktop | [Tauri 2](https://tauri.app) |
| Giao diện | React 19, TypeScript, Tailwind CSS 4, Ark UI, Lucide |
| Backend | Rust, Tokio |
| SSH, SFTP | [russh](https://github.com/Eugeny/russh), russh-sftp |
| Tích hợp macOS | Keychain, NSWorkspace (qua `objc2`) |
