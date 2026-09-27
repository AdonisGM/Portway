import { plural, type Dict } from '..'

const en: Dict = {
  // Conflict dialog
  'Thư mục · {time}': 'Folder · {time}',
  'Giữ cả hai': 'Keep both',
  'Chép thành tên mới, ví dụ {name}.': 'Copy under a new name, e.g. {name}.',
  'Thay bản ở đích, không hoàn tác được. Thư mục trùng tên được gộp: tệp trùng bên trong bị thay, tệp khác giữ nguyên.':
    "Replace the copy at the destination; this can't be undone. Folders with the same name are merged: matching files inside are replaced, others are kept.",
  ' {names} khác loại (tệp và thư mục) nên vẫn giữ cả hai.': (v) =>
    ` ${v.names} ${Number(v.n) === 1 ? 'is a different kind' : 'are different kinds'} (file vs. folder), so both are kept.`,
  'Chỉ chép {n} mục không trùng.': (v) => `Copy only the ${plural(v.n, 'item')} with no clash.`,
  'Mọi mục đều trùng, sẽ không chép gì.': 'Every item clashes, so nothing will be copied.',
  'Đã có {name} ở đích': '{name} already exists at the destination',
  '{n} mục đã có ở đích': (v) => `${plural(v.n, 'item')} already exist at the destination`,
  'Chép, giữ cả hai': 'Copy, keep both',
  'Chép {n} mục': (v) => `Copy ${plural(v.n, 'item')}`,
  'Bản đang chép': 'Being copied',
  'Bản ở đích': 'At destination',
  'từ Finder': 'from Finder',
  ' · mới hơn': ' · newer',

  // Sources
  'Máy này': 'This Mac',
  'Máy này · {path}': 'This Mac · {path}',

  // Pane
  'Server không còn trong danh sách': 'This server is no longer in the list',
  'Chưa kết nối {name}': 'Not connected to {name}',
  'Kết nối': 'Connect',
  'Đang kết nối tới {name}…': 'Connecting to {name}…',
  'Về thư mục nhà': 'Go to home folder',
  'macOS chưa cho Portway đọc thư mục này': "macOS hasn't allowed Portway to read this folder",
  'Mở Cài đặt hệ thống › Quyền riêng tư & Bảo mật › Tệp và thư mục, bật quyền cho Portway rồi bấm làm mới.':
    'Open System Settings › Privacy & Security › Files and Folders, allow Portway, then refresh.',
  '{path} thuộc {owner}:{group}, quyền {mode}.': '{path} is owned by {owner}:{group} with mode {mode}.',
  'Chỉ có tệp ẩn trong thư mục này. Bấm nút con mắt để xem.': 'This folder only has hidden files. Click the eye button to see them.',
  'Sửa lúc {time}': 'Modified {time}',
  'Không có quyền đọc': 'No read permission',
  'Thư mục bên kia đã có mục cùng tên': 'The folder on the other side already has an item with this name',
  'trùng tên': 'same name',
  'Làm mới': 'Refresh',
  'Ẩn tệp ẩn ({n})': 'Hide hidden files ({n})',
  'Hiện tệp ẩn ({n})': 'Show hidden files ({n})',
  'Mở trong Terminal ({name})': 'Open in Terminal ({name})',
  'Chỉ đọc: {user} không có quyền ghi vào thư mục này': "Read-only: {user} can't write to this folder",
  'Cỡ': 'Size',
  'Sửa lúc': 'Modified',
  'Lên thư mục cha (⌫)': 'Up to parent folder (⌫)',

  // Transfer screen
  'Chọn tệp ở {name} trước': 'Select files on {name} first',
  'Hai bên đều là máy này. Chọn một server ở một bên.': 'Both sides are this Mac. Pick a server on one side.',
  '{name} chưa sẵn sàng': "{name} isn't ready yet",
  'Hai bên đang mở cùng một thư mục': 'Both sides show the same folder',
  '{user} không có quyền ghi vào {path}': "{user} can't write to {path}",
  'Không đọc được {name} và {n} mục khác': (v) => `Can't read ${v.name} and ${plural(v.n, 'other item')}`,
  'Không đọc được {name}': "Can't read {name}",
  'Không chép thư mục vào chính nó': "Can't copy a folder into itself",
  'Không chép được': "Couldn't copy",
  'Chưa chép được': "Can't copy yet",
  'Đã ở trên máy này': 'Already on this Mac',
  'Thả vào pane của một server để tải lên.': "Drop onto a server's pane to upload.",
  'Chưa tải lên được': "Can't upload yet",
  'Tải về máy này · {path}': 'Download to this Mac · {path}',
  'Chép sang {dest}': 'Copy to {dest}',
  '{n} mục từ {name}': (v) => `${plural(v.n, 'item')} from ${v.name}`,
  'Đây là máy này': 'This is this Mac',
  'Thả vào pane của một server để tải lên': "Drop onto a server's pane to upload",
  '{n} mục từ Finder': (v) => `${plural(v.n, 'item')} from Finder`,
  'Hai phiên SSH khác nhau ({a} và {b}): Portway đọc bằng phiên này và ghi bằng phiên kia, dữ liệu vẫn đi qua máy bạn.':
    'Two different SSH sessions ({a} and {b}): Portway reads with one and writes with the other, and the data still passes through your Mac.',
  '{a} và {b} không kết nối trực tiếp với nhau: Portway đọc tệp từ server này và ghi sang server kia qua máy bạn, không lưu tạm trên máy. Tốc độ phụ thuộc mạng của máy bạn tới cả hai server.':
    "{a} and {b} don't connect to each other directly: Portway reads files from one server and writes them to the other through your Mac, without storing them locally. Speed depends on your Mac's connection to both servers.",
  'Chuyển tệp': 'Transfer',
  'Chép tệp giữa máy bạn và server, hoặc giữa hai server qua SFTP. Chọn rồi bấm mũi tên, hoặc kéo sang pane bên kia.':
    'Copy files between your Mac and a server, or between two servers over SFTP. Select files and click an arrow, or drag them to the other pane.',
  'Đổi chỗ hai pane': 'Swap the two panes',
  'Đổi hai bên': 'Swap sides',
  'Hai bên đều là máy này. Chọn một server ở ô nguồn của một pane để bắt đầu chép.':
    "Both sides are this Mac. Pick a server in one pane's source menu to start copying.",
  'Chép {n} mục sang {dest} (⌘→)': (v) => `Copy ${plural(v.n, 'item')} to ${v.dest} (⌘→)`,
  'Chép {n} mục sang {dest} (⌘←)': (v) => `Copy ${plural(v.n, 'item')} to ${v.dest} (⌘←)`,
  'Phím tắt: ⇥ đổi pane · ↑↓ di chuyển (⇧ chọn dải) · Space chọn · ↵ mở thư mục · ⌫ lên thư mục cha · ⌘A chọn hết · ⌘→ ⌘← chép sang bên kia':
    'Shortcuts: ⇥ switch pane · ↑↓ move (⇧ selects a range) · Space select · ↵ open folder · ⌫ parent folder · ⌘A select all · ⌘→ ⌘← copy to the other side',
  'Không tạo được thư mục': "Couldn't create the folder",
  'ten-thu-muc': 'folder-name',
  'Phiên này đang thao tác tệp bằng quyền root qua sudo (bật ở màn Tệp)': 'This session works on files as root through sudo (turned on in Files)',
}

export default en
