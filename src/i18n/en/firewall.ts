import { plural, type Dict } from '..'

const en: Dict = {
  // Shared words
  'Huỷ': 'Cancel',
  'Sao chép': 'Copy',
  'Sao chép lệnh': 'Copy command',
  'Sửa': 'Edit',
  'Xoá': 'Delete',
  'Đang chạy…': 'Running…',
  'Đang tắt': 'Off',
  'Cần quyền root': 'Needs root',

  // Rule fields and actions
  'Mọi cổng': 'Any port',
  'Mọi nơi': 'Anywhere',
  'Cho phép': 'Allow',
  'Giới hạn': 'Limit',
  'Chặn': 'Deny',
  'Từ chối': 'Reject',
  'Khác': 'Other',
  'cho phép': 'allow',
  'từ chối': 'reject',
  'chặn': 'deny',
  'cho phép#done': 'allowed',
  'từ chối#done': 'rejected',
  'chặn#done': 'blocked',
  'Cổng không hợp lệ (1–65535, dải dạng 6000:6010, nhiều cổng cách nhau bằng dấu phẩy)':
    'Invalid port (1–65535, a range like 6000:6010, several ports separated by commas)',
  'Dải cổng hoặc nhiều cổng cần chọn TCP hoặc UDP': 'A port range or several ports needs TCP or UDP',
  'Địa chỉ IP không hợp lệ': 'Invalid IP address',
  'Độ dài mạng (sau dấu /) không hợp lệ': 'Invalid prefix length (after the /)',

  // Dialogs
  'Firewall trên server vừa thay đổi (công cụ, zone hoặc trạng thái bật/tắt). Đóng và mở lại để xem bản mới.':
    'The firewall on the server just changed (tool, zone or on/off state). Close and reopen to see the latest.',
  'Rule này không còn trên server. Đóng lại để tải danh sách mới.': 'This rule is no longer on the server. Close to reload the list.',
  'firewalld không có kiểu Giới hạn như UFW.': 'firewalld has no Limit action like UFW.',
  'Lệnh chính xác sẽ chạy': 'Exact command to run',
  'Chạy bằng': 'Run as',
  'Sửa rule {rule}': 'Edit rule {rule}',
  'Mở cổng': 'Open port',
  '{firewall} trên {server}': '{firewall} on {server}',
  'Đã sửa rule': 'Rule updated',
  'Đã thêm rule': 'Rule added',
  'Lưu rule': 'Save rule',
  'Cổng hoặc dải cổng': 'Port or port range',
  'Ví dụ 8080, 80,443 hoặc 6000:6010': 'For example 8080, 80,443 or 6000:6010',
  'Giao thức': 'Protocol',
  'Cả hai': 'Both',
  'Nguồn': 'Source',
  'Một IP': 'Single IP',
  'Dải CIDR': 'CIDR range',
  'Hành động': 'Action',
  'Chặn IP mở quá 6 kết nối trong 30 giây (chống dò mật khẩu SSH)': 'Blocks an IP that opens more than 6 connections in 30 seconds (stops SSH password guessing)',
  'Ghi chú#rule': 'Comment',
  'firewalld không lưu ghi chú cho rule': "firewalld doesn't store rule comments",
  'Cổng {port} đang do Docker publish ({container}). Rule này không có tác dụng vì Docker mở cổng trước khi firewall kiểm tra.':
    'Port {port} is published by Docker ({container}). This rule has no effect because Docker opens the port before the firewall checks it.',
  'Cách khắc phục': 'How to fix',
  'firewalld không sửa rule tại chỗ: rule cũ bị gỡ và rule mới được thêm.': "firewalld can't edit a rule in place: the old rule is removed and the new one added.",
  'UFW không sửa rule tại chỗ: rule cũ bị xoá và rule mới được thêm vào cuối danh sách.':
    "UFW can't edit a rule in place: the old rule is deleted and the new one added at the end of the list.",
  'Điền cổng hợp lệ để xem lệnh': 'Enter a valid port to see the commands',
  '{port}/tcp · Cho phép · Mọi nơi': '{port}/tcp · Allow · Anywhere',
  'Portway tự thêm': 'Added by Portway',
  'Bật firewall?': 'Turn on the firewall?',
  'Bật firewall': 'Turn on firewall',
  'Firewall đã bật': 'Firewall is on',
  'Portway thêm rule cho phép cổng SSH {ports} trước khi bật. ': (v) =>
    `Portway adds a rule allowing SSH ${String(v.ports).includes(',') ? 'ports' : 'port'} ${v.ports} before turning it on. `,
  'Đã có rule cho phép cổng SSH. ': 'A rule already allows the SSH port. ',
  'Sau khi bật, Portway mở thử một kết nối SSH mới; không được thì tự tắt lại. Kết nối vào không khớp rule nào sẽ bị {policy}.':
    'Once it is on, Portway tries a new SSH connection and turns the firewall back off if that fails. Incoming connections that match no rule will be {policy}.',
  'Chưa có rule nào.': 'No rules yet.',
  'UFW khớp rule từ trên xuống.': 'UFW matches rules from top to bottom.',
  'Xoá rule SSH {rule}?': 'Delete SSH rule {rule}?',
  'Đã xoá rule': 'Rule deleted',
  'Xoá rule': 'Delete rule',
  'Portway đang kết nối qua SSH. Rule khác vẫn cho phép SSH: {rules}. Sau khi xoá, Portway mở thử một kết nối SSH mới; không được thì tự hoàn tác.':
    'Portway is connected over SSH. Other rules still allow SSH: {rules}. After deleting, Portway tries a new SSH connection and undoes the change if that fails.',
  '{rule} từ {source}': '{rule} from {source}',
  'Gõ lại tên server để xác nhận': 'Type the server name to confirm',
  '# nếu cần cho một dải IP vào: thêm -s <dải IP> -j RETURN trước dòng DROP': '# to let an IP range in: add -s <IP range> -j RETURN before the DROP line',
  'giữ rule sau khi khởi động lại (gói iptables-persistent)': 'keep the rule after a reboot (iptables-persistent package)',
  'Khắc phục: {container} ({port}) mở ra internet': 'Fix: {container} ({port}) is open to the internet',
  'Docker publish cổng này trực tiếp qua iptables, trước firewall': 'Docker publishes this port directly through iptables, ahead of the firewall',
  'Cách 1 · Bind vào 127.0.0.1 (khuyên dùng)': 'Option 1 · Bind to 127.0.0.1 (recommended)',
  'Sửa file compose rồi chạy Up cho project (mục Docker · Compose) để tạo lại container.':
    'Edit the compose file, then run Up on the project (Docker · Compose) to recreate the container.',
  'Chạy lại container với': 'Run the container again with',
  'thay cho': 'instead of',
  'Sau đó truy cập từ máy bạn qua SSH tunnel.': 'Then reach it from your Mac through an SSH tunnel.',
  'Cách 2 · Chặn trong chain DOCKER-USER': 'Option 2 · Block in the DOCKER-USER chain',
  'Giữ nguyên container, thêm rule iptables mà Docker tôn trọng. Chỉ áp dụng cho IPv4.':
    'Keep the container as is and add an iptables rule that Docker respects. IPv4 only.',

  // Screen
  'Xoá rule {rule}?': 'Delete rule {rule}?',
  'Kết nối từ {source} sẽ không còn bị chặn riêng nữa mà theo các rule còn lại.':
    'Connections from {source} will no longer be blocked by this rule and will follow the remaining rules.',
  'Kết nối từ {source} tới {rule} sẽ theo mặc định ({policy}).': 'Connections from {source} to {rule} will get the default ({policy}).',
  'Kết nối từ {source} tới {rule} sẽ theo mặc định ({policy}) khi firewall được bật.':
    'Connections from {source} to {rule} will get the default ({policy}) once the firewall is on.',
  'Tắt firewall?': 'Turn off the firewall?',
  'Mọi cổng đang lắng nghe trên địa chỉ công khai sẽ truy cập được từ internet. Các rule vẫn được giữ để bật lại sau.':
    'Every port listening on a public address will be reachable from the internet. Rules are kept for when you turn it back on.',
  'Tắt firewall': 'Turn off firewall',
  'Firewall đã tắt': 'Firewall is off',
  'Chưa có firewall do UFW hay firewalld quản lý': 'No firewall managed by UFW or firewalld',
  '{backend} · cần quyền root để đọc': '{backend} · needs root to read',
  '{backend} · không đọc được': "{backend} · couldn't be read",
  'Đang bật · mặc định {incoming} kết nối vào, {outgoing} kết nối ra': 'On · default {incoming} incoming, {outgoing} outgoing',
  'firewalld đang dừng': 'firewalld is stopped',
  'Firewall của nhà cung cấp cloud (security group / security list) không kiểm tra được từ bên trong server.':
    "Your cloud provider's firewall (security group / security list) can't be checked from inside the server.",
  'Có hai công cụ firewall cùng bật: {backend} và {others}.': 'Two firewall tools are on at once: {backend} and {others}.',
  'Chúng ghi đè rule của nhau nên kết quả khó đoán. Portway đang quản lý {backend} (hợp với hệ điều hành này); nên tắt công cụ còn lại.':
    "They overwrite each other's rules, so the result is hard to predict. Portway manages {backend} (the right fit for this OS); turn the other one off.",
  'Server dùng iptables trực tiếp': 'The server uses iptables directly',
  'Chưa có firewall': 'No firewall',
  'Có {n} rule iptables nhưng không do UFW hay firewalld quản lý. Portway chưa đọc được rule iptables thuần; bên dưới là các cổng đang lắng nghe.': (v) =>
    `${plural(v.n, 'iptables rule')} found, not managed by UFW or firewalld. Portway can't read plain iptables rules yet; the listening ports are below.`,
  'Không thấy UFW hay firewalld. {hint}; cài xong Portway quản lý được ngay tại đây.':
    'Neither UFW nor firewalld found. {hint}; once installed, Portway can manage it right here.',
  'Họ RHEL (Oracle Linux, Rocky, Alma) thường dùng firewalld': 'RHEL-family systems (Oracle Linux, Rocky, Alma) usually use firewalld',
  'Debian/Ubuntu thường dùng UFW': 'Debian/Ubuntu usually use UFW',
  'Firewall đang tắt': 'Firewall is off',
  'Mọi cổng lắng nghe trên địa chỉ công khai đều truy cập được từ internet. Rule bên dưới chưa có hiệu lực (đây là cấu hình vĩnh viễn, dùng khi firewalld chạy).':
    'Every port listening on a public address is reachable from the internet. The rules below are not in effect yet (this is the permanent configuration, used when firewalld runs).',
  'Mọi cổng lắng nghe trên địa chỉ công khai đều truy cập được từ internet. Rule bên dưới chưa có hiệu lực.':
    'Every port listening on a public address is reachable from the internet. The rules below are not in effect yet.',
  '⚠ Mở ra internet, không đi qua firewall': '⚠ Open to the internet, bypassing the firewall',
  'Docker tự mở các cổng này trước firewall của server, rule firewall không có tác dụng.':
    "Docker opens these ports ahead of the server's firewall, so firewall rules have no effect.",
  'Rule firewall': 'Firewall rules',
  'Rule firewall (chưa có hiệu lực)': 'Firewall rules (not in effect)',
  'Rule khớp đầu tiên được áp dụng, thứ tự từ trên xuống. Lấy từ ufw show added.': 'The first matching rule applies, top to bottom. Read from ufw show added.',
  'Service, port và rich rule của các zone {zones}; firewalld không xét thứ tự. Lấy từ firewall-cmd --list-all.':
    'Services, ports and rich rules of zones {zones}; firewalld has no rule order. Read from firewall-cmd --list-all.',
  'Service, port và rich rule của zone {zone}; firewalld không xét thứ tự. Lấy từ firewall-cmd --list-all.':
    'Services, ports and rich rules of zone {zone}; firewalld has no rule order. Read from firewall-cmd --list-all.',
  'Cổng / Service': 'Port / Service',
  'Cổng / App': 'Port / App',
  'Từ': 'From',
  ' · route (chuyển tiếp)': ' · route (forwarded)',
  ' · chiều ra': ' · outgoing',
  'Portway đang dùng (SSH)': 'Used by Portway (SSH)',
  ' · nên dùng Giới hạn để chống dò mật khẩu': ' · consider Limit to stop password guessing',
  'Không có hiệu lực: Docker đã mở cổng này cho mọi nơi': 'No effect: Docker already opened this port to everyone',
  'Không có tác dụng: rule #{n} ({rule}, {action}) khớp trước': 'No effect: rule #{n} ({rule}, {action}) matches first',
  'Rule theo {kind}: xoá rồi mở cổng mới': (v) => `Rule uses ${v.kind === 'service' ? 'a service' : 'an app profile'}: delete it and open a new port`,
  'Rule phức tạp (interface, log, route…): sửa trong Terminal': 'Complex rule (interface, log, route…): edit it in Terminal',
  'Đổi sang Giới hạn (limit)': 'Switch to Limit',
  'Đổi rule {rule} sang Giới hạn?': 'Switch rule {rule} to Limit?',
  'UFW sẽ chặn một IP nếu nó mở quá 6 kết nối trong 30 giây, đủ để chặn dò mật khẩu mà không ảnh hưởng người dùng bình thường. Kết nối SSH đang mở không bị ngắt.':
    'UFW will block an IP that opens more than 6 connections in 30 seconds: enough to stop password guessing without affecting normal users. Open SSH connections stay up.',
  'Rule mới được thêm vào cuối danh sách, sau {rule} ({action} từ {source}). Rule đó khớp trước nên limit sẽ không có tác dụng cho tới khi bạn xoá nó.':
    'The new rule is added at the end of the list, after {rule} ({action} from {source}). That rule matches first, so limit has no effect until you delete it.',
  'Đổi sang Giới hạn': 'Switch to Limit',
  'SSH đã dùng limit': 'SSH now uses limit',
  'Rule SSH duy nhất: xoá sẽ làm mất kết nối tới server': 'Only SSH rule: deleting it would cut the connection to the server',
  'Chưa có rule nào. Kết nối vào đều theo mặc định.': 'No rules yet. Incoming connections follow the default.',
  'Mở ra internet vì firewall đang tắt': 'Open to the internet because the firewall is off',
  'Tiến trình lắng nghe trên địa chỉ công khai, không có gì chặn.': 'Processes listening on a public address, with nothing blocking them.',
  'Lắng nghe công khai nhưng bị firewall chặn': 'Listening publicly but blocked by the firewall',
  'An toàn: tiến trình bind địa chỉ công khai nhưng không có rule cho phép.': 'Safe: the process binds a public address but no rule allows it.',
  'Đang bị chặn': 'Blocked',
  'Lắng nghe trên địa chỉ công khai': 'Listening on a public address',
  'Không đọc được rule firewall nên Portway không biết cổng nào bị chặn (có thể có iptables/nftables hoặc firewall của cloud).':
    "Firewall rules couldn't be read, so Portway can't tell which ports are blocked (there may be iptables/nftables or a cloud firewall).",
  ' Tên tiến trình của user khác cần quyền root.': " Other users' process names need root.",
  'Chỉ truy cập trong server (127.0.0.1)': 'Reachable only inside the server (127.0.0.1)',
  'Không mở ra ngoài. Dùng SSH tunnel để truy cập từ máy bạn.': 'Not exposed. Use an SSH tunnel to reach it from your Mac.',
  'Cổng {port}': 'Port {port}',
  'Mở tunnel': 'Open tunnel',
  'Đã sao chép lệnh tunnel': 'Tunnel command copied',
  'Lệnh ssh': 'ssh command',
  'Rule thừa': 'Unused rules',
  'Rule cho phép cổng nhưng không có tiến trình nào lắng nghe.': 'Rules that allow a port no process listens on.',
  'từ {source}': 'from {source}',
  'Không có tiến trình': 'No process',
  '— (không thuộc tiến trình nào trong server)': '— (not owned by any process on the server)',
  '— (cần root để biết tiến trình)': '— (needs root to see the process)',
}

export default en
