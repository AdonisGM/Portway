import { plural, type Dict } from '..'

const en: Dict = {
  // app/edits
  'Không có quyền đọc {path}. Bật sudo cho phiên này để sửa tệp của root.': 'No permission to read {path}. Turn on sudo for this session to edit files owned by root.',
  'Không có quyền đọc tệp này. Bật sudo cho phiên này để sửa tệp của root.': 'No permission to read this file. Turn on sudo for this session to edit files owned by root.',
  'Tệp lớn hơn 20 MB, không mở để sửa.': 'The file is larger than 20 MB, so it can’t be opened for editing.',
  'Chỉ sửa được tệp, không phải thư mục.': 'Only files can be edited, not folders.',
  'Phiên SSH chưa kết nối.': 'The SSH session isn’t connected.',
  'Không mở được để sửa': 'Couldn’t open for editing',
  'Không làm được': 'Couldn’t do that',
  'Không mở lại được': 'Couldn’t reopen',

  // components
  'Chưa rõ hệ điều hành, sẽ tự nhận khi kết nối': 'OS unknown; detected on the first connection',
  'Phiên bản {version}': 'Version {version}',
  'Bản dựng {id}': 'Build {id}',
  Chọn: 'Select',
  Đóng: 'Close',
  Huỷ: 'Cancel',
  'Đang xử lý': 'Working…',
  'Hiển thị {from} tới {to} trong {total} {unit}': 'Showing {from}–{to} of {total} {unit}',
  'Số dòng mỗi trang': 'Rows per page',
  '{n} dòng#row': (v) => plural(v.n, 'row'),
  'Trước#pager': 'Previous',
  'Sau#pager': 'Next',
  'Thêm thao tác': 'More actions',
  Tìm: 'Search',
  'Xoá ô tìm': 'Clear search',

  // lib
  'Chọn nơi lưu tệp tải xuống': 'Choose where to save the download',
  'Chọn nơi lưu {n} mục tải xuống': (v) => `Choose where to save ${plural(v.n, 'download')}`,
  'Ứng dụng': 'Applications',
}

export default en
