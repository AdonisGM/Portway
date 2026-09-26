import { plural, type Dict } from '..'

const en: Dict = {
  'Container#menu': 'Containers',
  // meta (titles and module names)
  'Tổng quan': 'Overview',
  'Tệp (SFTP)': 'Files (SFTP)',
  'Dịch vụ': 'Services',
  'Tất cả server': 'All servers',
  'Khoá SSH': 'SSH keys',
  'Chuyển tệp': 'Transfer',
  'Cài đặt': 'Settings',

  // rail
  'Quản lý kết nối': 'Connections',
  'Server đang kết nối': 'Connected servers',
  'Nhật ký gỡ lỗi · {n} việc đang chạy': (v) => `Debug log · ${plural(v.n, 'task')} running`,
  'Nhật ký gỡ lỗi (mở cửa sổ riêng)': 'Debug log (opens in its own window)',

  // menu
  'Danh sách server': 'Server list',
  '{n} đang chạy': '{n} running',
  'Ngôn ngữ': 'Language',
  'Tải xuống#section': 'Downloads',
  'Sửa tệp#section': 'File editing',
  'Giao diện': 'Appearance',
  'Dữ liệu': 'Data',
  'Giới thiệu': 'About',
  'Tác vụ định kỳ': 'Scheduled jobs',
  'Đang kết nối': 'Connected',
  'Ngắt kết nối {user}': 'Disconnect {user}',

  // edits dock
  'Đã tải lên lúc {time} · {n} lần': (v) => `Uploaded at ${v.time} · ${Number(v.n) === 1 ? 'once' : `${v.n} times`}`,
  'Chưa sửa · lưu trong editor là tự tải lên': 'No changes yet · saving in the editor uploads automatically',
  'Đang tải lên…': 'Uploading…',
  'Chờ tải lên': 'Waiting to upload',
  'Tệp trên server đã đổi từ lúc mở': 'The file on the server changed since it was opened',
  'Lỗi khi tải lên': 'Upload failed',
  'Mở lại bằng {app}': 'Reopen in {app}',
  'Mở lại trong editor': 'Reopen in the editor',
  'Hiện bản trên máy trong Finder': 'Show the local copy in Finder',
  'Thôi sửa: ngừng tải lên và xoá bản trên máy': 'Stop editing: stop uploading and delete the local copy',
  'Ghi đè lên server': 'Overwrite on server',
  'Lấy bản trên server': 'Use server version',
  'Đang sửa trên máy': 'Editing on this Mac',
  '{n} cần xem': (v) => `${v.n} ${Number(v.n) === 1 ? 'needs' : 'need'} attention`,
  '{n} tệp': (v) => plural(v.n, 'file'),
  'Thôi sửa {name}?': 'Stop editing {name}?',
  'Lấy bản trên server của {name}?': 'Use the server version of {name}?',
  'Thôi sửa': 'Stop editing',
  'Thay đổi chưa tải lên server sẽ mất: bản trên máy bị xoá và Portway không theo dõi tệp này nữa.':
    'Changes not yet uploaded will be lost: the local copy is deleted and Portway stops watching this file.',
  'Bản trên máy được thay bằng nội dung hiện tại trên server; những gì bạn sửa mà chưa tải lên sẽ mất. Editor sẽ hiện nội dung mới.':
    'The local copy is replaced with what is on the server now; edits not yet uploaded will be lost. The editor will show the new content.',
}

export default en
