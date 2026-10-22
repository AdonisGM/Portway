export type Lang = 'vi' | 'en';

export const GITHUB = 'https://github.com/AdonisGM/Portway';
export const RELEASES = `${GITHUB}/releases/latest`;

export const docsUrl = (lang: Lang) => (lang === 'vi' ? '/docs/vi/' : '/docs/');
export const homeUrl = (lang: Lang) => (lang === 'vi' ? '/vi/' : '/');

export type TileId = 'tunnel' | 'files' | 'nginx' | 'docker' | 'firewall' | 'services' | 'http' | 'connect';

type Copy = {
  meta: { title: string; description: string };
  nav: { features: string; details: string; security: string; download: string; docs: string; theme: string; language: string };
  hero: { badge: string; title: [string, string]; sub: string; primary: string; secondary: string; github: string; note: string; alt: string };
  stats: { value: string; label: string }[];
  showcase: { eyebrow: string; title: string; sub: string; shot: string; tiles: Record<TileId, { title: string; text: string }> };
  details: { eyebrow: string; title: string; items: { icon: string; title: string; text: string }[] };
  trust: { eyebrow: string; title: string; text: string; points: { icon: string; title: string; text: string }[] };
  download: {
    eyebrow: string;
    title: string;
    sub: string;
    mac: { name: string; req: string };
    win: { name: string; req: string };
    button: string;
    server: string;
    source: string;
  };
  footer: { tagline: string; guide: string; source: string; issues: string; version: string };
};

const en: Copy = {
  meta: {
    title: 'Portway: manage Linux servers over SSH in one window',
    description:
      'Portway is a desktop application for macOS and Windows. It connects to Linux servers over SSH and manages files, tunnels, Docker, Nginx and firewalls without installing an agent on the server.',
  },
  nav: { features: 'Features', details: 'Details', security: 'Security', download: 'Download', docs: 'Docs', theme: 'Toggle light or dark theme', language: 'Tiếng Việt' },
  hero: {
    badge: 'New: Connect links two computers of the same person on one network',
    title: ['Every Linux server,', 'managed in one window.'],
    sub: 'Portway connects over SSH, browses files, opens tunnels and manages services on many servers. No agent is installed on the server, and every change that Portway makes is written to an audit log.',
    primary: 'Download Portway',
    secondary: 'Read the documentation',
    github: 'GitHub',
    note: 'macOS 11+ and Windows 10+ · Source code on GitHub',
    alt: 'The Overview screen of Portway for a connected server, with resource usage, top processes, health, ports and disks.',
  },
  stats: [
    { value: '0', label: 'agents installed on servers' },
    { value: '2', label: 'platforms: macOS and Windows' },
    { value: '2', label: 'languages: English and Vietnamese' },
    { value: 'Local', label: 'configuration stays on the computer' },
  ],
  showcase: {
    eyebrow: 'Features',
    title: 'The real application, screen by screen.',
    sub: 'Every image below is a screenshot of Portway connected to test servers.',
    shot: 'screenshot',
    tiles: {
      tunnel: {
        title: 'Tunnels with a live monitor',
        text: 'Throughput, latency and the local application behind every connection are shown in real time. Tunnels reconnect by themselves when the network drops.',
      },
      files: {
        title: 'Files, with clear permissions',
        text: 'The access of the signed-in user is explained for each item. Every file offers rename, chmod, chown, download and editing in a local application.',
      },
      nginx: {
        title: 'Nginx as a map',
        text: 'Each site is drawn from domain to target, with certificate expiry and upstream health. A change that breaks `nginx -t` is rolled back.',
      },
      docker: {
        title: 'Docker, grouped by Compose project',
        text: 'Ports that are reachable from outside are marked as public, and containers in a restart loop are easy to find.',
      },
      firewall: {
        title: 'Firewall rules in context',
        text: 'Rules of `ufw` or `firewalld` are compared with the ports that are really listening, so exposed and blocked services stand out.',
      },
      services: {
        title: 'systemd services',
        text: 'Status, start at boot, memory use and the journal of each watched unit, with restart and stop actions that show the exact command.',
      },
      http: {
        title: 'HTTP requests from the server',
        text: 'Requests run with `curl` on the server itself, so internal addresses can be reached. DNS, TCP, TLS and server time are measured separately.',
      },
      connect: {
        title: 'Connect, for your own two computers',
        text: 'Made for one person who works on two computers on the same network, such as a Mac and a Windows PC. It sends files, shares the clipboard and wakes the other computer. It is not for sharing between different people, and it is off by default.',
      },
    },
  },
  details: {
    eyebrow: 'Details',
    title: 'Smaller features that complete the workflow.',
    items: [
      { icon: 'route', title: 'Jump host', text: 'Servers that do not expose SSH are reached through a bastion, as with `ssh -J`.' },
      { icon: 'shield', title: 'Host key verification', text: 'An unknown or changed host key always requires confirmation, based on `~/.ssh/known_hosts`.' },
      { icon: 'import', title: 'Import from ~/.ssh/config', text: 'Existing hosts and `ProxyJump` settings are imported.' },
      { icon: 'arrows', title: 'Server to server copy', text: 'A two-pane view copies files from one server to another through this computer.' },
      { icon: 'terminal', title: 'Terminal', text: 'Terminal opens with the matching `ssh` command for the selected server.' },
      { icon: 'tail', title: 'Log following', text: 'Log files are followed in real time, in the same way as `tail -f`.' },
      { icon: 'users', title: 'Multiple accounts', text: 'Each server can hold several accounts that use a password or an SSH key.' },
      { icon: 'moon', title: 'Light and dark themes', text: 'The interface follows the system theme or a manual choice.' },
    ],
  },
  trust: {
    eyebrow: 'Transparency and safety',
    title: 'Every change that Portway makes is recorded.',
    text: 'Portway uses tools that already exist on the server, such as `sftp`, `systemctl`, `docker` and `nginx`. Changes made by Portway are written to an audit log together with their result. Commands typed in a terminal are not part of that log.',
    points: [
      { icon: 'key', title: 'Secrets stay in the system store', text: 'Passwords and passphrases are kept in the Keychain on macOS and in Credential Manager on Windows, never in configuration files.' },
      { icon: 'lock', title: 'sudo through standard input', text: 'The sudo password is passed through standard input and does not appear in a command line or in the log.' },
      { icon: 'eye', title: 'Data stays on the computer', text: 'No account and no relay server are involved. Configuration is stored on the local computer only.' },
    ],
  },
  download: {
    eyebrow: 'Download',
    title: 'Available for macOS and Windows.',
    sub: 'Get the latest build from GitHub Releases.',
    mac: { name: 'macOS', req: 'macOS 11 or later · Apple Silicon and Intel' },
    win: { name: 'Windows', req: 'Windows 10 (1809+) or Windows 11 · 64-bit' },
    button: 'Download the latest release',
    server: 'Target servers: Linux with OpenSSH. Nothing else needs to be installed.',
    source: 'Build from source',
  },
  footer: { tagline: 'Manage Linux servers over SSH.', guide: 'Documentation', source: 'Source code', issues: 'Report an issue', version: 'Version' },
};

const vi: Copy = {
  meta: {
    title: 'Portway: quản trị server Linux qua SSH trong một cửa sổ',
    description:
      'Portway là ứng dụng desktop cho macOS và Windows. Ứng dụng kết nối tới server Linux qua SSH và quản lý tệp, tunnel, Docker, Nginx, firewall mà không cần cài agent lên server.',
  },
  nav: { features: 'Tính năng', details: 'Chi tiết', security: 'Bảo mật', download: 'Tải về', docs: 'Tài liệu', theme: 'Đổi giao diện sáng hoặc tối', language: 'English' },
  hero: {
    badge: 'Mới: Connect liên kết hai máy tính của cùng một người trong một mạng',
    title: ['Mọi server Linux,', 'được quản trị trong một cửa sổ.'],
    sub: 'Portway kết nối qua SSH, duyệt tệp, mở tunnel và quản lý dịch vụ trên nhiều server. Không có agent nào được cài lên server, và mọi thay đổi do Portway thực hiện đều được ghi vào nhật ký thao tác.',
    primary: 'Tải Portway',
    secondary: 'Xem tài liệu',
    github: 'GitHub',
    note: 'macOS 11+ và Windows 10+ · Mã nguồn trên GitHub',
    alt: 'Màn hình Tổng quan của Portway cho một server đã kết nối, gồm mức dùng tài nguyên, tiến trình dùng nhiều nhất, tình trạng, cổng mạng và ổ đĩa.',
  },
  stats: [
    { value: '0', label: 'agent được cài lên server' },
    { value: '2', label: 'nền tảng: macOS và Windows' },
    { value: '2', label: 'ngôn ngữ: tiếng Anh và tiếng Việt' },
    { value: 'Cục bộ', label: 'cấu hình chỉ nằm trên máy tính' },
  ],
  showcase: {
    eyebrow: 'Tính năng',
    title: 'Ứng dụng thật, từng màn hình một.',
    sub: 'Mọi hình bên dưới đều là ảnh chụp Portway đang kết nối tới các server thử nghiệm.',
    shot: 'ảnh chụp màn hình',
    tiles: {
      tunnel: {
        title: 'Tunnel có màn hình theo dõi',
        text: 'Tốc độ, độ trễ và ứng dụng cục bộ tạo ra từng kết nối được hiển thị theo thời gian thực. Tunnel tự kết nối lại khi mạng bị gián đoạn.',
      },
      files: {
        title: 'Tệp với quyền truy cập rõ ràng',
        text: 'Quyền của tài khoản đang đăng nhập được giải thích cho từng mục. Mỗi tệp có sẵn các thao tác đổi tên, chmod, chown, tải xuống và sửa bằng ứng dụng trên máy.',
      },
      nginx: {
        title: 'Nginx dưới dạng sơ đồ',
        text: 'Mỗi site được vẽ từ tên miền tới đích, kèm hạn chứng chỉ và tình trạng upstream. Thay đổi làm `nginx -t` báo lỗi sẽ được hoàn tác.',
      },
      docker: {
        title: 'Docker, gom theo dự án Compose',
        text: 'Các cổng truy cập được từ bên ngoài được đánh dấu là công khai, và container rơi vào vòng lặp khởi động lại dễ dàng được nhận ra.',
      },
      firewall: {
        title: 'Rule firewall đặt trong ngữ cảnh',
        text: 'Rule của `ufw` hoặc `firewalld` được đối chiếu với các cổng đang thực sự lắng nghe, nhờ đó dịch vụ bị phơi ra ngoài hoặc bị chặn được nhận ra ngay.',
      },
      services: {
        title: 'Dịch vụ systemd',
        text: 'Trạng thái, tuỳ chọn khởi động cùng hệ thống, mức dùng bộ nhớ và journal của từng unit đang theo dõi, cùng các hành động khởi động lại và dừng hiển thị lệnh chính xác.',
      },
      http: {
        title: 'Request HTTP chạy từ server',
        text: 'Request được chạy bằng `curl` ngay trên server, nên có thể truy cập các địa chỉ nội bộ. Thời gian DNS, TCP, TLS và xử lý của server được đo riêng.',
      },
      connect: {
        title: 'Connect, cho hai máy tính của cùng một người',
        text: 'Dành cho một người làm việc trên hai máy tính trong cùng một mạng, ví dụ một máy Mac và một máy Windows. Connect chuyển tệp, chia sẻ clipboard và đánh thức máy kia. Connect không dành cho việc chia sẻ giữa những người khác nhau, và tắt theo mặc định.',
      },
    },
  },
  details: {
    eyebrow: 'Chi tiết',
    title: 'Những tính năng nhỏ hoàn thiện quy trình làm việc.',
    items: [
      { icon: 'route', title: 'Jump host', text: 'Server không mở SSH ra ngoài được truy cập qua bastion, tương tự `ssh -J`.' },
      { icon: 'shield', title: 'Xác minh khoá máy chủ', text: 'Khoá máy chủ lạ hoặc đã thay đổi luôn cần được xác nhận, dựa trên `~/.ssh/known_hosts`.' },
      { icon: 'import', title: 'Nhập từ ~/.ssh/config', text: 'Các host sẵn có và thiết lập `ProxyJump` được nhập vào Portway.' },
      { icon: 'arrows', title: 'Sao chép giữa hai server', text: 'Giao diện hai khung sao chép tệp từ server này sang server khác thông qua máy tính đang dùng.' },
      { icon: 'terminal', title: 'Terminal', text: 'Terminal được mở với đúng lệnh `ssh` tương ứng của server đang chọn.' },
      { icon: 'tail', title: 'Theo dõi nhật ký', text: 'Tệp nhật ký được theo dõi theo thời gian thực, tương tự `tail -f`.' },
      { icon: 'users', title: 'Nhiều tài khoản', text: 'Mỗi server có thể có nhiều tài khoản, đăng nhập bằng mật khẩu hoặc khoá SSH.' },
      { icon: 'moon', title: 'Giao diện sáng và tối', text: 'Giao diện theo chủ đề của hệ thống hoặc theo lựa chọn thủ công.' },
    ],
  },
  trust: {
    eyebrow: 'Minh bạch và an toàn',
    title: 'Mọi thay đổi do Portway thực hiện đều được ghi lại.',
    text: 'Portway chỉ dùng các công cụ đã có sẵn trên server, như `sftp`, `systemctl`, `docker` và `nginx`. Các thay đổi do Portway thực hiện được ghi vào nhật ký thao tác cùng với kết quả. Lệnh gõ trực tiếp trong terminal không nằm trong nhật ký này.',
    points: [
      { icon: 'key', title: 'Bí mật nằm trong kho của hệ điều hành', text: 'Mật khẩu và passphrase được lưu trong Keychain trên macOS và trong Credential Manager trên Windows, không nằm trong tệp cấu hình.' },
      { icon: 'lock', title: 'sudo qua đầu vào chuẩn', text: 'Mật khẩu sudo được chuyển qua đầu vào chuẩn và không xuất hiện trong dòng lệnh hay trong nhật ký.' },
      { icon: 'eye', title: 'Dữ liệu nằm trên máy tính', text: 'Không cần tài khoản và không có máy chủ trung gian. Cấu hình chỉ được lưu trên máy tính đang dùng.' },
    ],
  },
  download: {
    eyebrow: 'Tải về',
    title: 'Có sẵn cho macOS và Windows.',
    sub: 'Tải bản mới nhất tại GitHub Releases.',
    mac: { name: 'macOS', req: 'macOS 11 trở lên · Apple Silicon và Intel' },
    win: { name: 'Windows', req: 'Windows 10 (1809+) hoặc Windows 11 · 64-bit' },
    button: 'Tải bản mới nhất',
    server: 'Server đích: Linux có OpenSSH. Không cần cài thêm thành phần nào.',
    source: 'Biên dịch từ mã nguồn',
  },
  footer: { tagline: 'Quản trị server Linux qua SSH.', guide: 'Tài liệu', source: 'Mã nguồn', issues: 'Báo lỗi', version: 'Phiên bản' },
};

export const copy: Record<Lang, Copy> = { vi, en };
