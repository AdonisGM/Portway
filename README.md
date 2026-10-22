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
- [Ghi chú khi làm Portway Connect](#ghi-chú-khi-làm-portway-connect)
- [Trang web (docs/)](#trang-web-docs)
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

### Connect (hai Portway trong cùng mạng)

Connect dành cho **một người dùng hai máy tính của mình trong cùng một mạng LAN** (ví dụ một máy Mac và một máy Windows trên cùng bàn làm việc), để chuyển tệp, chia sẻ clipboard, đánh thức máy kia và đo mạng giữa hai máy cho thuận tiện. Đây không phải công cụ để chia sẻ giữa những người khác nhau và không hoạt động qua internet.

- Tắt mặc định. Khi bật, Portway mở một cổng (mặc định 47615) và thông báo một ID ngẫu nhiên qua mDNS (`_portway._tcp`); tên máy và thông tin khác chỉ gửi cho máy đã ghép đôi.
- **Ghép đôi** một lần: Noise XX (khoá công khai trao qua kênh mã hoá), sau đó hai màn hình hiện cùng mã 6 số và cả hai người bấm Khớp. Mã chỉ hiện sau khi hai bên đã trao số ngẫu nhiên theo kiểu cam kết rồi mới tiết lộ, để máy ở giữa không dò được mã. Khoá riêng nằm trong Keychain hoặc Credential Manager.
- **Trang chi tiết của từng máy** (bấm vào dòng máy, hoặc bấm Kết nối; danh sách chỉ còn dòng gọn): bảng thông số "Máy này" cạnh "Máy kia" (hệ điều hành, mẫu máy, CPU, GPU, RAM, ổ đĩa, card mạng kèm tốc độ card, thời gian đã bật, phiên bản Portway; CPU và RAM đang dùng cập nhật mỗi vài giây khi đang kết nối, vẽ thành thanh). Mẫu máy và GPU đọc một lần mỗi lần chạy: macOS bằng `system_profiler`, Windows từ registry (khoá lớp card đồ hoạ, cho VRAM 64-bit thật, bỏ các adapter ảo như Remote/Parsec/Basic Display). Tải CPU, RAM và tốc độ mạng đi riêng bằng tin `Stats` (không lưu, không ghi nhật ký), vẽ thành biểu đồ khoảng vài phút cho cả hai máy (lịch sử giữ ở giao diện, không ghi ra đĩa); GPU có tên, VRAM, số nhân và (chỉ khi đang kết nối, vì tốn một lần chạy `ioreg` mỗi 5 giây trên macOS) mức dùng của engine bận nhất: macOS đọc `Device Utilization %` của `IOAccelerator`, Windows đọc bộ đếm PDH `\\GPU Engine(*)\\Utilization Percentage` theo tên tiếng Anh, cộng các tiến trình trong cùng một engine rồi lấy engine lớn nhất như Task Manager (phần Windows chưa chạy thử), phần Mạng (độ trễ hiện tại, trung bình, dao động, biểu đồ khoảng một phút, các đường tới máy kia, nút Đo tốc độ) và phần Tính năng (mỗi tính năng ghi sẵn sàng hay chưa dùng được và lý do; các công tắc clipboard ở đây). Thông số của máy kia gửi một lần khi liên kết lên (tin `Info`, chỉ sau khi đã tin nhau, không ghi vào nhật ký) và được lưu để máy tắt vẫn hiện lần cuối. Máy chạy Portway cũ không gửi `Info` thì cột của nó để trống và trang nói rõ phải cập nhật.
- **Đo tốc độ**: kết nối mã hoá riêng (`Intent::Speed`), gửi dữ liệu thử khoảng 1,5 giây mỗi chiều (tối đa 200 MB), con số là tốc độ Portway thực sự đạt được, đã tính mã hoá. Chỉ bật khi máy kia báo hỗ trợ (`features` trong `Info`). Các thư viện mã hoá được tối ưu cả trong bản dev (`[profile.dev.package.*]` trong `Cargo.toml`), nếu không bản dev chỉ đạt vài MB/s và số đo chẳng nói gì về mạng.
- **Kết nối** tới máy đã ghép đôi qua đường nhanh nhất trong các đường tìm được (cáp, Wi-Fi hoặc IP nhập tay), đo độ trễ mỗi 5 giây. Mỗi máy một kết nối.
- Khi lỗi, Portway chỉ gợi ý cách xử lý theo loại lỗi (xem bên dưới), không tự sửa tường lửa.
- **Đánh thức (WOL)**: sau khi ghép đôi (hoặc kết nối lần đầu với máy đã ghép từ bản cũ), hai máy trao cho nhau địa chỉ MAC của các card cáp và Wi-Fi thật. Nút "Đánh thức" gửi magic packet (UDP broadcast cổng 9 và 7, qua từng card đang có địa chỉ), rồi đợi tối đa 2 phút để máy kia hiện lại trong mạng. Máy kia cần bật Wake-on-LAN (BIOS/UEFI, card mạng, tắt Fast Startup trên Windows); Mac chỉ dậy từ trạng thái ngủ qua cáp.
- **Gửi tệp** tới máy đã ghép đôi (nút "Gửi tệp…" ở dòng máy đang thấy trong mạng). Mỗi lần gửi mở một kết nối mã hoá riêng, không cần đang "Kết nối". Người nhận luôn được hỏi Nhận hay Từ chối; tệp lưu vào thư mục tải xuống mặc định, không ghi đè tệp trùng tên (thêm " (1)"), được ghi dưới tên tạm và chỉ đổi tên sau khi BLAKE2s khớp. Tên tệp từ máy kia được làm sạch (không có đường dẫn, không có ký tự Windows cấm). Gửi được cả thư mục (menu ⋯ › "Gửi thư mục…"): cả cây được gửi, nhận về nằm gọn trong một thư mục (đổi tên "Tên (1)" nếu trùng, không gộp vào thư mục có sẵn), thư mục rỗng và liên kết (symlink) bị bỏ qua, tối đa 20.000 tệp một lần. Đường dẫn từ máy kia bị từ chối nếu có `..`. Chưa tiếp tục được khi đứt giữa chừng.
- **Clipboard văn bản** giữa hai máy đang kết nối (card riêng trên trang chi tiết của máy đã ghép: hình hai máy với một mũi tên mỗi chiều, chỉ để xem, gồm cả việc máy kia đang bật Nhận/Tự gửi hay không; công tắc và nút Gửi ngay nằm riêng bên dưới). Máy nhận trả lời mỗi lần nhận (`ClipAck`): máy gửi biết đã nhận, hay máy kia chưa bật Nhận (`off`). Mỗi bên báo cài đặt của mình cho bên kia bằng `ClipPrefs` khi liên kết lên và mỗi khi đổi; máy cũ không trả lời thì hiện "Đã gửi" không xác nhận: nút "Gửi clipboard" gửi ngay văn bản đang copy; "Nhận clipboard từ máy này" cho phép máy kia ghi vào clipboard ở đây; "Tự gửi clipboard sang máy này" gửi mỗi khi bạn copy. Cả hai công tắc tắt mặc định và theo từng máy. Văn bản được đánh dấu nhạy cảm bởi ứng dụng đã copy (trình quản lý mật khẩu: `org.nspasteboard.ConcealedType` trên macOS, `ExcludeClipboardContentFromMonitorProcessing` trên Windows) không bao giờ được tự gửi. Nội dung không được ghi vào nhật ký; văn bản dài quá khoảng 40.000 ký tự bị từ chối kèm thông báo, không cắt âm thầm. Tin nhắn mà bản này chưa biết được bỏ qua thay vì làm đứt kết nối, nên thêm loại tin mới không cần tăng `VERSION`.
- **Tệp trong clipboard**: copy tệp hoặc thư mục ở một máy (Finder, Explorer) thì máy kia thấy "đã copy N mục" và dán được. Copy chỉ gửi tên và kích thước (một "lease": mã ngẫu nhiên, danh sách mục) qua kết nối đang có; thân tệp chỉ đi khi máy kia dán hoặc bấm **Lưu vào Downloads**, trên một kết nối riêng (`Intent::Fetch` + `Want`), dùng lại đường truyền tệp có băm BLAKE2s. Máy gửi chỉ phục vụ lease đang còn trên clipboard của nó, chỉ cho máy đã được báo, chỉ theo số thứ tự mục (không bao giờ nhận đường dẫn từ máy kia); đổi clipboard thì lease bị thu hồi (`ClipFilesGone`). Máy nhận làm sạch mọi tên tệp như khi nhận tệp thường. Cần máy kia báo `clipfiles` trong `Info.features`. Bật "Tự gửi" thì copy tệp tự báo; còn lại có nút "Gửi tệp đang copy". Máy nhận phải bật Nhận clipboard từ máy gửi, nếu không bên gửi thấy cảnh báo như với văn bản.
  - **macOS nhận**: Portway đặt lên clipboard các mục `public.file-url` chưa có dữ liệu (`NSPasteboardItemDataProvider`); Cmd+V trong Finder gọi nó lúc dán và Finder chờ tới khi tệp về (thử với trễ 95 giây vẫn dán được). Phần chờ chạy ngay trong lúc dán nên có thể làm cửa sổ Portway đứng hình tới khi xong.
  - **Windows nhận** (`win_paste.rs`, **chưa chạy thử**): một `IDataObject` COM đặt lên clipboard, mô tả tệp bằng `FileGroupDescriptorW` (tên, kích thước, có `FD_PROGRESSUI` để Explorer tự hiện tiến độ) và trả thân từng tệp qua `FileContents` (`IStream` mở trên tệp vừa tải về) chỉ khi Explorer hỏi, tức lúc Ctrl+V. OLE chỉ giữ clipboard kiểu này sống khi luồng đã đặt nó còn chạy ở apartment đơn luồng và bơm message, nên đối tượng nằm trên một luồng riêng. Chưa dán được thư mục (mỗi tệp trong đó phải liệt kê trước), thư mục dùng nút Lưu vào Downloads.
  - Chống vòng lặp: thay đổi clipboard do chính Portway ghi (các mục chờ dán) không bị xem là tệp người dùng vừa copy.

### Chạy nền và mở cùng máy

Connect chỉ trả lời các máy khác khi Portway đang chạy, nên **Cài đặt › Khởi động** có hai công tắc:

- **Mở Portway khi đăng nhập**: dùng `tauri-plugin-autostart` (LaunchAgent trên macOS, khoá `Run` của người dùng trên Windows) với cờ `--hidden`, nên Portway mở ẩn, chỉ có biểu tượng ở khay (thanh menu trên macOS). Trạng thái lấy từ hệ điều hành, không từ `settings.json`. Không dùng được ở bản dev (nó sẽ đăng ký `target/debug/portway`); cần bản đã cài.
- **Giữ chạy nền khi đóng cửa sổ**: nút đóng chỉ ẩn cửa sổ; thoát bằng "Thoát Portway" ở biểu tượng khay (hoặc Cmd+Q). Tự bật khi mở cùng máy đang bật, vì không thì Portway mở ra mà không thấy đâu.
- Khay có "Mở Portway" và "Thoát Portway" (theo ngôn ngữ đang chọn). Trên Windows bấm trái vào biểu tượng mở cửa sổ; trên macOS bấm là mở menu và bấm vào Dock khi cửa sổ đang ẩn thì hiện lại.
- Chỉ một bản chạy một lúc (`tauri-plugin-single-instance`): mở lần hai chỉ đưa cửa sổ đầu lên. Bản chạy với `PORTWAY_PROFILE` bỏ qua việc này để chạy cạnh bản thật.
- **Windows mở lúc đăng nhập, không phải lúc bật máy.** Sau khi đánh thức bằng Wake-on-LAN, máy dừng ở màn hình đăng nhập nên Portway chưa trả lời, và "Máy đã lên" chưa hiện, cho tới khi có người đăng nhập (hoặc bật tự đăng nhập Windows). Chạy trước đăng nhập cần một dịch vụ Windows, chưa làm.
- **Báo hiệu trước khi đăng nhập (Windows, `beacon.rs`, chưa chạy thử)**: Cài đặt › Khởi động › "Báo hiệu khi chưa đăng nhập" cài một dịch vụ Windows `PortwayBeacon` (chạy bằng `NT AUTHORITY\LocalService`, tự khởi động cùng máy). Nó chỉ làm được một việc: thông báo qua mDNS (cùng id với máy, `v`, thêm `s=login`) rằng PC đã bật khi chưa ai đăng nhập, nên sau Wake-on-LAN máy Mac thấy "Máy đã lên" và dòng máy hiện "Đã bật · chờ đăng nhập" thay vì chờ hết giờ. Nó **không** nghe TCP, không kết nối, không truyền tệp, không có clipboard: khoá của Connect nằm trong Credential Manager của người dùng đăng nhập mà dịch vụ không đọc được, và dịch vụ không có cửa sổ hay clipboard. Làm cho mọi thứ chạy trước đăng nhập cần thiết kế lại chỗ lưu khoá, chưa làm. Dịch vụ tự ngừng báo khi có phiên người dùng (`WTSEnumerateSessions`), để ứng dụng đảm nhận.
  - Cài/gỡ khởi chạy lại chính exe với quyền quản trị (hộp UAC, `ShellExecuteEx runas`, `--install-beacon` / `--uninstall-beacon`): chép exe vào `Program Files\Portway Beacon` (không bao giờ trỏ dịch vụ vào thư mục cài của người dùng, nơi họ ghi được), tạo dịch vụ, thêm quy tắc tường lửa cho UDP 5353 của exe đó (dịch vụ không tự bấm được hộp hỏi tường lửa) rồi khởi động. Gỡ làm ngược lại.
  - Ứng dụng ghi `%ProgramData%\Portway\beacon.json` (id, phiên bản giao thức, cổng) mỗi lần Connect bật để dịch vụ biết báo hiệu là ai.
  - Phía máy nhận tin (Mac): `Nearby.login` từ TXT `s`; máy ở màn hình đăng nhập không được dò TCP, không được xem là online, và nút Kết nối bị khoá với lý do rõ ràng.
- Kiểm tra thật cần bản release đã cài: bật công tắc, đăng xuất rồi đăng nhập lại; trên macOS có thể xem `~/Library/LaunchAgents/`, trên Windows xem `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.

### Khác

- Cửa sổ Debug log liệt kê mọi lệnh Portway chạy trên server, kèm thời gian chờ, thời gian chạy và kết quả.
- Cài đặt: ngôn ngữ, giao diện sáng/tối, thư mục tải xuống mặc định, ứng dụng sửa tệp mặc định, xuất và nhập dữ liệu.

## Bảo mật và dữ liệu

- Mật khẩu đăng nhập, passphrase của khoá, mật khẩu SOCKS và bí mật trong request HTTP đều được lưu trong kho bí mật của hệ điều hành: **Keychain** trên macOS, **Credential Manager** trên Windows. Credential Manager giới hạn mỗi mục khoảng 1.280 ký tự, nên giá trị dài hơn được Portway tự chia thành nhiều mục.
- Mật khẩu `sudo` được truyền qua stdin (`sudo -S`), không xuất hiện trong dòng lệnh hay trong nhật ký.
- Khi mở Terminal cho một tài khoản đăng nhập bằng mật khẩu (hoặc khoá có passphrase), `ssh` lấy bí mật đã lưu qua một script `SSH_ASKPASS` tạm thời trên macOS. Script không chứa mật khẩu, chỉ biết mục nào trong Keychain trả lời câu hỏi nào; `security` đọc mục đó sau khi macOS hỏi người dùng cho phép. Bí mật chưa được lưu thì Terminal hỏi như bình thường.
- Trên Windows, chính `portway.exe` làm `SSH_ASKPASS` cho `ssh.exe` và đọc mục tương ứng trong Credential Manager. Mỗi bí mật chỉ được điền một lần cho mỗi lần mở Terminal; nếu sai, `ssh` hỏi lại ngay trên console thay vì thử lại cùng một mật khẩu.
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

### Ký bản build trên Mac

Mặc định bản build chỉ được ký tạm (`adhoc`), mà chữ ký tạm đổi theo từng bản build. macOS coi mỗi bản là một app mới: Keychain hỏi lại quyền đọc từng mục của `com.portway.app` (mật khẩu server, khoá của Connect) và bấm "Always Allow" chỉ có tác dụng cho đúng bản đó.

Để chữ ký giữ nguyên qua các lần build trên máy của bạn, tạo một chứng chỉ ký mã tự ký rồi đặt tên nó vào `APPLE_SIGNING_IDENTITY`:

1. Keychain Access › Certificate Assistant › Create a Certificate: tên `Portway Local Signing`, Identity Type là Self Signed Root, Certificate Type là Code Signing.
2. Build: `APPLE_SIGNING_IDENTITY="Portway Local Signing" ./scripts/build-mac.sh`.
3. Kiểm tra: `codesign -dr - release/<version>/Portway.app` phải in `identifier "com.portway.app" and certificate leaf = …`.

Bản dev (`./scripts/dev.sh`) cũng được ký bằng chứng chỉ này: `scripts/dev-sign-run.sh` là runner của Cargo (đặt qua biến môi trường trong `dev.sh`, nên `cargo test` không đi qua nó) ký lại `target/debug/portway` với `--identifier com.portway.app` trước mỗi lần chạy. Nhờ đó danh tính giống bản release và giống giữa các lần build, Keychain chỉ hỏi một lượt sau khi đổi sang cách này (mỗi mục một lần: khoá Connect, khoá `@b`, mật khẩu server), rồi thôi. Máy không có chứng chỉ thì chạy như cũ, không ký. Kiểm tra: `codesign -dr - src-tauri/target/debug/portway`.

Biến môi trường được dùng thay cho `tauri.conf.json`, để máy không có chứng chỉ vẫn build được. Chứng chỉ tự ký chỉ có tác dụng trên máy tạo ra nó; phát hành cho người khác cần chứng chỉ Developer ID của Apple và công chứng (notarize).

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

## Ghi chú khi làm Portway Connect

Portway Connect cho hai bản Portway trong cùng LAN tự nhận ra nhau, ghép đôi rồi gửi tệp, đồng bộ clipboard và đánh thức nhau (WOL). Mới có phát hiện, ghép đôi, kết nối, đánh thức, gửi tệp và clipboard văn bản (code ở `src-tauri/src/connect/`); phần còn lại chưa làm. Các điều dưới đây rút ra từ bản thử `scripts/connect-probe` trên một Mac và một PC Windows nối cả cáp Ethernet lẫn Wi-Fi (16/10/2026).

### Chạy probe

Probe là một crate Rust riêng, vứt đi được, không nằm trong app. Chạy cùng một binary trên cả hai máy:

```sh
cd scripts/connect-probe
cargo run --release -- [--peer <ip>] [--port <n>]
```

Nó in các card mạng (trên Windows kèm profile mạng Public/Private), mở một cổng TCP, quảng bá và dò mDNS rồi đo kết nối TCP tới từng địa chỉ của máy kia mỗi 4 giây. Không ghi gì ra đĩa.

### Phát hiện và đường mạng

- mDNS thấy nhau trong vài giây trên cả cáp lẫn Wi-Fi, không cần hộp thoại nào.
- Một máy hiện với 6 đến 13 địa chỉ (IPv4 của từng card, cộng nhiều IPv6 link-local gắn scope lẫn lộn). Định danh máy bằng ID cố định, gom địa chỉ về một dòng, bản đầu chỉ dùng IPv4.
- Cáp trễ 0,5 đến 1,1 ms, Wi-Fi 2,5 đến 4 ms, thỉnh thoảng một lần vọt lên hàng trăm ms. Đo nhiều lần rồi mới chọn đường.
- Thấy nhau qua mDNS không có nghĩa là kết nối được. Phải thử kết nối TCP thật.

### Windows

- Windows xếp cả card cáp nối thẳng lẫn Wi-Fi vào mạng **Public**.
- Lần đầu mở cổng có hộp thoại tường lửa, mặc định chỉ tích Private. Chỉ cho Private thì kết nối vào bị bỏ gói và **timeout** trên cả hai đường, trong khi mDNS vẫn thấy nhau.
- Cách sửa (chỉ gợi ý, không tự làm): Allow cho cả Public, hoặc đổi card sang Private: `Set-NetConnectionProfile -InterfaceAlias "Ethernet" -NetworkCategory Private` (cần quyền quản trị).

### macOS: quyền Mạng cục bộ (Local Network)

- Kiểm tra ở Cài đặt hệ thống › Privacy & Security › Local Network. Mỗi app một công tắc, danh sách chỉ có app đã từng được hỏi.
- Chưa có quyền thì kết nối tới máy khác trong LAN lỗi ngay `No route to host` (errno 65), không timeout. Lỗi này nằm ở máy gọi, không liên quan đến máy kia. mDNS của hệ thống (`dns-sd`) vẫn thấy máy kia.
- **macOS nhận diện app bằng UUID của file chạy** (Mach-O `LC_UUID`), không phải bundle ID, tên file hay đường dẫn. Nhiều bản build từ cùng một binary có chung UUID, nên macOS chỉ hỏi một lần rồi chặn im lặng các bản còn lại, không có hộp thoại nào. Build với UUID khác (ví dụ `-C link-arg=-Wl,-random_uuid`) thì hộp thoại hiện lại. Kiểm tra bằng `dwarfdump --uuid <file chạy>`.
- Các khoá `NSLocalNetworkUsageDescription` và `NSBonjourServices` không quyết định việc hộp thoại có hiện hay không. Vẫn nên khai để câu chữ trong hộp thoại có nghĩa.
- `tccutil reset` không đặt lại được quyền này. Muốn thử lại phải đổi UUID.
- UUID của file chạy đổi theo nội dung mỗi bản build (đã thấy: hai bản build liên tiếp có hai UUID khác nhau), và Info.plist có `NSLocalNetworkUsageDescription` cùng `NSBonjourServices` được Tauri gộp vào bản `.app`. Chưa kiểm chứng: quyền Mạng cục bộ có phải cấp lại sau cập nhật không. Apple khuyên ký bằng Developer ID để danh tính ổn định.

### Địa chỉ MAC trên macOS

Tiến trình chưa có quyền Mạng cục bộ chỉ nhận MAC giả `02:00:00:00:00:00` từ `getifaddrs` và cả `ifconfig` (đã gặp khi chạy test từ shell). Vì vậy trên macOS Portway đọc MAC thật bằng `networksetup -listallhardwareports`, thứ vẫn trả đúng. Windows không bị hạn chế này.

### Phiên bản giao thức

Mỗi lần byte trên đường truyền đổi (ví dụ mỗi tin nhắn có thêm một byte loại từ 0.10.0), `wire::VERSION` phải tăng: bản cũ không đọc được tin của bản mới, nên nếu không tăng thì lỗi hiện ra như "timeout" và dễ bị đổ cho tường lửa. Phiên bản được báo qua mDNS (`v`) nên dòng máy hiện "Khác phiên bản Portway" và khoá các nút trước khi ai bấm. Hiện là 3. Thêm loại tin mới thì không cần tăng, miễn bản cũ bỏ qua được (`Unknown`); riêng một `Intent` mới (như `Speed`) bản cũ chỉ từ chối bằng `version`, nên tính năng đó chỉ được bật khi máy kia báo nó trong `features`. Kết nối bị cắt sau khi đã bắt tay xong mà không có trả lời được báo là `no_reply`, còn `connect_timeout` chỉ dành cho TCP không nối được.

### Chạy hai bản Portway trên một máy

Đặt `PORTWAY_PROFILE=b` khi chạy bản thứ hai (`PORTWAY_PROFILE=b src-tauri/target/debug/portway`, khi `./scripts/dev.sh` đang chạy) để nó dùng thư mục dữ liệu `profiles/b` và các mục Keychain riêng (`tên@b`). Nhờ đó thử được ghép đôi, kết nối và gửi tệp giữa hai bản ngay trên một Mac. Bản thứ hai chiếm cổng ngẫu nhiên vì 47615 đã có bản đầu giữ.

### Khi kết nối lỗi

Portway chỉ chẩn đoán và gợi ý, không tự sửa tường lửa hay profile mạng.

| Dấu hiệu | Có thể là | Gợi ý |
|---|---|---|
| Thấy qua mDNS, TCP timeout | Tường lửa máy kia chặn (thường là Windows, mạng Public) | Allow cho đúng loại mạng, hoặc đổi sang Private |
| `No route to host` ngay trên Mac | Mac chưa cho Portway quyền Mạng cục bộ | Bật trong Privacy & Security › Local Network |
| Connection refused | Máy kia chưa mở Portway hoặc Connect đang tắt | Mở Portway ở máy kia |
| Không thấy qua mDNS | Khác mạng, chặn multicast, máy kia tắt | Nhập IP tay |

## Trang web (docs/)

Thư mục `docs/` chứa trang web `portway.nmtung.dev`, là một workspace pnpm tách khỏi ứng dụng:

| Thư mục | Nội dung | Địa chỉ |
|---|---|---|
| `docs/landing/` | Trang giới thiệu (Vite + React, dựng sẵn HTML cho SEO) | `/` (English), `/vi/` (tiếng Việt) |
| `docs/guide/` | Tài liệu hướng dẫn (Astro Starlight) | `/docs/` (English), `/docs/vi/` (tiếng Việt) |

English là ngôn ngữ mặc định, giao diện tối là mặc định (có nút đổi sang sáng).

```sh
cd docs
pnpm install
pnpm dev       # landing ở http://localhost:5180, /docs được chuyển tiếp tới guide
pnpm build     # gộp hai phần vào docs/site (thư mục để triển khai)
pnpm preview   # phục vụ docs/site tại http://localhost:4173
```

Ảnh trong tài liệu được cắt từ ảnh chụp toàn cửa sổ ứng dụng bằng `node docs/guide/scripts/make-doc-shots.mjs <thư mục ảnh>` (thư mục có `real/` và `real2/`, mỗi thư mục chứa `en/` và `vi/`). Ảnh của landing được cắt từ ảnh chụp toàn cửa sổ ứng dụng bằng `pnpm --filter portway-landing shots <thư mục ảnh>` (thư mục có hai thư mục con `en/` và `vi/`); ảnh gốc không nằm trong kho mã. Tên và toạ độ cắt nằm trong `docs/landing/scripts/make-shots.mjs`.

Tài liệu chia thành hai tab (Hướng dẫn, Kiến trúc và ý tưởng) bằng `starlight-sidebar-topics`; cấu hình ở `docs/guide/astro.config.mjs`. Bài hướng dẫn nằm trong `docs/guide/src/content/docs/` (bản tiếng Việt trong thư mục `vi/`). Ảnh chụp màn hình đặt trong `docs/guide/public/img/<ngôn ngữ>/` và được chèn bằng component `Figure`. Mỗi ảnh chụp ở chế độ tối, đúng ngôn ngữ của bài.

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
│   └── connect-probe/      # Probe LAN tạm cho Portway Connect (crate riêng)
├── docs/                   # Trang web: landing (React) và tài liệu (Starlight)
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
