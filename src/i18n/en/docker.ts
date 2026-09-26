import { plural, type Dict } from '..'

const en: Dict = {
  // Screen
  'Container#title': 'Containers',
  'Đang đọc…': 'Loading…',
  '{running}/{total} container đang chạy · Docker {version}': (v) =>
    `${v.running}/${v.total} ${Number(v.total) === 1 ? 'container' : 'containers'} running · Docker ${v.version}`,
  '{n} project compose': (v) => plural(v.n, 'compose project'),
  'Tìm container, image': 'Search containers, images',
  'Dọn image thừa': 'Prune images',
  'Không đọc được Docker': "Couldn't read Docker",
  'Docker chưa được cài trên {server}': 'Docker is not installed on {server}',
  'Không tìm thấy lệnh docker. Có thể cài bằng script chính thức của Docker:':
    "The docker command wasn't found. You can install it with Docker's official script:",
  'Cần quyền root hoặc thuộc group docker': 'Needs root or the docker group',
  'User {user} không thuộc group docker nên không đọc được /var/run/docker.sock.':
    "User {user} isn't in the docker group, so it can't read /var/run/docker.sock.",
  'Mở bằng kết nối root': 'Open with the root connection',
  'Docker daemon không chạy': "Docker daemon isn't running",
  'Docker đã được cài nhưng daemon không trả lời, nên không đọc được container, image, volume.':
    "Docker is installed but the daemon doesn't answer, so containers, images and volumes can't be read.",
  'Khởi động Docker?': 'Start Docker?',
  'Chạy lại docker.service. Container có restart policy "always" hoặc "unless-stopped" sẽ tự chạy theo.':
    'Starts docker.service again. Containers with restart policy "always" or "unless-stopped" start with it.',
  'Khởi động': 'Start',
  'Khởi động Docker': 'Start Docker',
  'Xem log trong Terminal': 'View log in Terminal',
  'Đã chạy lệnh': 'Command ran',
  'Không chạy được lệnh': "Couldn't run the command",
  'Đã mở Terminal': 'Opened Terminal',
  'Không mở được Terminal': "Couldn't open Terminal",

  // Status
  'Đang chạy': 'Running',
  'Đang chạy · unhealthy': 'Running · unhealthy',
  'Đang chạy · healthy': 'Running · healthy',
  'Đang chạy · đang kiểm tra': 'Running · checking',
  'Khởi động lại liên tục · {n} lần': (v) => `Restart loop · ${plural(v.n, 'time')}`,
  'Tạm dừng#state': 'Paused',
  'Đã tạo, chưa chạy': 'Created, not started',
  'Hỏng (dead)': 'Dead',
  'Đã chạy xong': 'Completed',
  'Đã dừng · exit {code}': 'Stopped · exit {code}',
  'Đã dừng': 'Stopped',
  'Lỗi · exit {code}': 'Failed · exit {code}',
  'job · chạy một lần': 'job · runs once',
  '{n} giây': (v) => plural(v.n, 'second'),
  '{n} phút': (v) => plural(v.n, 'minute'),
  '{n} giờ': (v) => plural(v.n, 'hour'),
  '{n} ngày': (v) => plural(v.n, 'day'),
  'chạy {span}': 'up {span}',
  'dừng {span} trước': 'stopped {span} ago',
  'Mở trên mọi địa chỉ của server nên truy cập được từ ngoài. Docker tự thêm rule iptables nên UFW không chặn được cổng này.':
    "Open on every address of the server, so it's reachable from outside. Docker adds its own iptables rules, so UFW can't block this port.",
  'Database/cache không nên mở ra ngoài, nên bind 127.0.0.1.': "A database or cache shouldn't be exposed; bind it to 127.0.0.1.",
  '{running}/{total} đang chạy': '{running}/{total} running',
  '{running}/{total} đang chạy · {jobs} job xong': (v) => `${v.running}/${v.total} running · ${plural(v.jobs, 'job')} done`,

  // Containers
  'Trạng thái': 'Status',
  'Cổng (host → container)': 'Ports (host → container)',
  'của {n} nhân': (v) => `of ${plural(v.n, 'core')}`,
  'Container lẻ': 'Standalone containers',
  'Container không chạy': "Container isn't running",
  'Xem chi tiết': 'Show details',
  'Mở tunnel tới cổng {port}': 'Open tunnel to port {port}',
  'Khởi động lại': 'Restart',
  Dừng: 'Stop',
  'Chạy lại': 'Run again',
  Chạy: 'Start',
  'Không có container nào khớp "{q}"': 'No containers match "{q}"',
  'Chưa có container nào trên server này.': 'No containers on this server yet.',
  'nội bộ': 'internal',
  'Container không chạy nên cổng này đang đóng': "The container isn't running, so this port is closed",
  'công khai': 'public',
  'Container cùng project {project}: {others}.': 'Other containers in project {project}: {others}.',
  'Khởi động lại {name}?': 'Restart {name}?',
  '{name} là {role}. Các container phụ thuộc có thể lỗi trong lúc nó khởi động lại.':
    '{name} is a {role}. Containers that depend on it may fail while it restarts.',
  'Container sẽ ngừng phục vụ vài giây.': 'The container will be unavailable for a few seconds.',
  'Dừng {name}?': 'Stop {name}?',
  '{name} là {role}. Các container phụ thuộc có thể lỗi cho tới khi nó chạy lại.':
    '{name} is a {role}. Containers that depend on it may fail until it runs again.',
  'Container sẽ dừng cho tới khi bạn chạy lại.': 'The container stays stopped until you start it again.',
  'Dừng container': 'Stop container',
  'Chạy lại {name}?': 'Run {name} again?',
  'Container này sẽ thực thi lại tác vụ của nó (ví dụ migration database).':
    'This container will run its task again (a database migration, for example).',
  'Tác vụ chạy với cùng image và biến môi trường như lần trước. Nếu nó không lặp lại được an toàn, kết quả có thể lỗi.':
    "The task runs with the same image and environment variables as last time. If it isn't safe to repeat, the result may be broken.",
  'Đã chạy {name}': 'Started {name}',
  'Tạo lại container nếu cấu hình thay đổi, chạy các container đang dừng.':
    'Recreates containers whose configuration changed and starts the stopped ones.',
  'Tải image mới nhất theo tag trong compose rồi tạo lại container nếu image thay đổi.':
    'Pulls the latest images for the tags in the compose file, then recreates containers whose image changed.',
  'Khởi động lại toàn bộ {n} container của project. Dịch vụ sẽ gián đoạn trong lúc khởi động lại.': (v) =>
    `Restarts all ${plural(v.n, 'container')} of the project. Services are interrupted while they restart.`,
  'Job {jobs} cũng được chạy lại (docker compose restart gồm cả container đã chạy xong).':
    '{jobs} will also run again (docker compose restart includes finished containers).',
  'Dừng và xoá {n} container: {names}.': (v) => `Stops and removes ${plural(v.n, 'container')}: ${v.names}.`,
  'Network {networks} cũng bị xoá.': 'Also removes network {networks}.',
  'Volume được giữ lại ({volumes}), image không bị xoá. Chạy Up để tạo lại container.':
    'Volumes are kept ({volumes}) and images are not removed. Run Up to recreate the containers.',
  'Volume được giữ lại, image không bị xoá. Chạy Up để tạo lại container.':
    'Volumes are kept and images are not removed. Run Up to recreate the containers.',
  'Không tìm thấy trên server: {files}. Project có thể đã được chạy từ máy khác hoặc file đã bị chuyển đi.':
    'Not found on the server: {files}. The project may have been started from another machine, or the files were moved.',
  'File compose không có trên server': 'Compose file not on the server',
  'Chưa chọn container': 'No container selected',
  'Bấm vào một dòng để xem trạng thái, health check, cổng, volume và biến môi trường.':
    'Click a row to see its status, health check, ports, volumes and environment variables.',
  'unhealthy · {n} lần kiểm tra lỗi liên tiếp': (v) => `unhealthy · ${plural(v.n, 'failed check')} in a row`,
  'Không có': 'None',
  'Số lần restart': 'Restarts',
  '{n} lần': (v) => plural(v.n, 'time'),
  Lệnh: 'Command',
  'Ngày tạo': 'Created',
  'Container lẻ (docker run)': 'Standalone (docker run)',
  'Xem log': 'View log',
  'Mở Terminal trong container': 'Open Terminal in container',
  Đóng: 'Close',
  'Cổng#ports': 'Ports',
  'Không publish cổng nào (nội bộ)': 'No published ports (internal)',
  'chỉ đọc': 'read-only',
  'Không gắn volume': 'No volumes mounted',
  'Biến môi trường': 'Environment variables',
  'bấm để hiện giá trị': 'click to show values',
  '(trống)': '(empty)',

  // Compose
  'Không có project compose nào. Container chạy bằng docker compose mới hiện ở đây.':
    'No compose projects. Containers started with docker compose show up here.',
  'Không rõ file compose (container không có nhãn config_files)': 'Compose file unknown (the containers have no config_files label)',

  // Logs
  'Tất cả': 'All',
  'Cảnh báo + lỗi': 'Warnings + errors',
  'Lỗi#level': 'Errors',
  'Lọc theo chữ': 'Filter text',
  '{n} dòng': (v) => plural(v.n, 'line'),
  'đang theo dõi': 'following',
  'container không chạy': "container isn't running",
  'Container không chạy, chỉ có log cũ': "The container isn't running; only old logs are available",
  'Tạm dừng': 'Pause',
  'Theo dõi trực tiếp': 'Follow live',
  'Mở trong Terminal': 'Open in Terminal',
  'Không có dòng nào khớp bộ lọc': 'No lines match the filter',
  'Chưa có log': 'No logs yet',

  // Images
  '{n} image': (v) => plural(v.n, 'image'),
  'Dung lượng': 'Size',
  'Đang dùng': 'In use',
  'đang dùng bởi {containers}': 'used by {containers}',
  'lơ lửng': 'dangling',
  'không dùng': 'unused',
  'Chưa có image nào.': 'No images yet.',
  'tổng {size}': 'total {size}',
  'Lơ lửng {dangling} · không dùng {unused}': 'Dangling {dangling} · unused {unused}',
  'Đã thu hồi {size}': 'Reclaimed {size}',
  'Chỉ image lơ lửng (an toàn)': 'Dangling images only (safe)',
  'Image không có tag, thường là bản build cũ bị ghi đè. Không container nào dùng.':
    'Untagged images, usually old builds that were overwritten. No container uses them.',
  'Tất cả image không dùng': 'All unused images',
  'Kể cả image còn tag mà không container nào dùng, có thể là bản cần để rollback (ví dụ {ref}).':
    'Includes tagged images no container uses, which may be the ones you need to roll back (for example {ref}).',
  'Kể cả image còn tag mà không container nào dùng, có thể là bản cần để rollback.':
    'Includes tagged images no container uses, which may be the ones you need to roll back.',
  'docker image prune trên {server}': 'docker image prune on {server}',
  Huỷ: 'Cancel',
  'Đang xoá…': 'Deleting…',
  'Xoá {n} image': (v) => `Remove ${plural(v.n, 'image')}`,
  'Đang đọc danh sách image…': 'Loading images…',
  'Không có image nào để xoá.': 'No images to remove.',
  'Xoá {n} image · thu hồi khoảng {size}': (v) => `Remove ${plural(v.n, 'image')} · frees about ${v.size}`,
  'Không xoá volume.': "Volumes aren't removed.",

  // Volumes
  '{n} volume': (v) => plural(v.n, 'volume'),
  'Đang gắn vào': 'Mounted in',
  'đang tính…': 'calculating…',
  'Không gắn container nào': 'Not mounted',
  'Thêm thao tác': 'More actions',
  'Đã sao chép': 'Copied',
  'Sao chép đường dẫn': 'Copy path',
  'Đang gắn vào {containers}. Dừng và xoá container trước.': 'Mounted in {containers}. Stop and remove the containers first.',
  'Xoá volume…': 'Remove volume…',
  'Đang gắn vào container': 'Mounted in a container',
  'Chưa có volume nào.': 'No volumes yet.',
  'chỉ xem, xoá qua menu ⋯': 'view only, remove from the ⋯ menu',
  'không tính được dung lượng: {error}': "couldn't calculate sizes: {error}",
  'Đã xoá volume {name}': 'Removed volume {name}',
  'Xoá volume {name}?': 'Remove volume {name}?',
  'Xoá volume': 'Remove volume',
  'Toàn bộ dữ liệu trong volume ({size}) bị xoá vĩnh viễn, không hoàn tác được.':
    'All data in the volume ({size}) is deleted permanently. This cannot be undone.',
  'Toàn bộ dữ liệu trong volume bị xoá vĩnh viễn, không hoàn tác được.':
    'All data in the volume is deleted permanently. This cannot be undone.',
  'Gõ lại tên volume để xác nhận': 'Type the volume name to confirm',
}

export default en
