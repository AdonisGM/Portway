import { t } from '../../i18n'
import { isAppError } from '../../lib/api'
import { isWindows } from '../../lib/platform'

export type Hint = { title: string; steps: string[]; command?: { text: string; where: string } }

const PRIVATE_CMD = 'Set-NetConnectionProfile -InterfaceAlias "Ethernet" -NetworkCategory Private'

/** What to tell the user when a connection or pairing fails: what it means
 *  and what to try, in the order that is easiest first. Portway only advises;
 *  it never changes a firewall or a network profile itself. `code` comes from
 *  the Rust side; `peerOs` is the other machine's system when it is known
 *  (a machine that is not paired yet has not told us). */
export function hintFor(code: string, peerOs: string | null): Hint {
  const peerWindows = peerOs === 'windows'
  switch (code) {
    case 'connect_timeout':
      return {
        title: t('Thấy máy kia nhưng không kết nối được'),
        steps: [
          t('Mở Portway ở máy kia và kiểm tra Connect đang bật.'),
          peerWindows || peerOs === null
            ? t('Tường lửa của máy kia có thể đang chặn (hay gặp trên Windows). Ở hộp thoại tường lửa lần đầu, tích cả Private và Public, hoặc đổi mạng đó sang Private.')
            : t('Tường lửa của máy kia có thể đang chặn. Kiểm tra nó cho phép Portway nhận kết nối vào.'),
          t('Thử đường khác (cáp hoặc Wi-Fi), hoặc nhập địa chỉ IP của máy kia.'),
        ],
        command: peerWindows || peerOs === null ? { text: PRIVATE_CMD, where: t('Chạy ở máy Windows kia, trong PowerShell mở bằng quyền quản trị') } : undefined,
      }
    case 'connect_no_route':
      return isWindows
        ? {
            title: t('Không có đường tới máy kia'),
            steps: [t('Kiểm tra hai máy cùng một mạng và dây cáp hoặc Wi-Fi còn kết nối.'), t('Thử nhập địa chỉ IP của máy kia.')],
          }
        : {
            title: t('Máy này chưa cho Portway quyền mạng nội bộ'),
            steps: [
              t('Mở Cài đặt hệ thống › Quyền riêng tư & Bảo mật › Mạng cục bộ (Local Network) và bật Portway.'),
              t('Nếu Portway chưa có trong danh sách, thoát hẳn Portway rồi mở lại.'),
              t('Nếu vẫn lỗi, kiểm tra hai máy cùng một mạng.'),
            ],
          }
    case 'no_reply':
      return {
        title: t('Máy kia nhận kết nối nhưng không trả lời'),
        steps: [
          t('Thường là máy kia chạy một bản Portway khác phiên bản. Cập nhật Portway ở cả hai máy.'),
          t('Hoặc một chương trình khác đang dùng cổng này trên máy kia.'),
        ],
      }
    case 'connect_refused':
      return {
        title: t('Máy kia không nhận kết nối'),
        steps: [t('Mở Portway ở máy kia.'), t('Bật Connect trong màn hình Connect của máy kia.')],
      }
    case 'handshake_failed':
    case 'connection_lost':
      return {
        title: t('Kết nối bị ngắt giữa chừng'),
        steps: [t('Thử lại.'), t('Nếu lặp lại, kiểm tra hai máy dùng cùng phiên bản Portway.')],
      }
    case 'version':
    case 'refused_version':
      return { title: t('Hai máy dùng phiên bản Portway khác nhau'), steps: [t('Cập nhật Portway ở cả hai máy.')] }
    case 'refused_not_paired':
      return {
        title: t('Máy kia không còn ghép đôi với máy này'),
        steps: [t('Bỏ ghép đôi ở cả hai máy, rồi ghép đôi lại.')],
      }
    case 'refused_busy':
    case 'busy':
      return {
        title: t('Máy kia đang bận'),
        steps: [t('Máy kia đang có một kết nối hoặc một yêu cầu ghép đôi khác. Thử lại sau vài giây.')],
      }
    case 'key_changed':
      return {
        title: t('Khoá của máy kia đã đổi'),
        steps: [
          t('Có thể máy kia đã cài lại Portway, hoặc có một máy khác đang giả danh.'),
          t('Bỏ ghép đôi rồi ghép đôi lại, và so sánh kỹ mã hiện ra.'),
        ],
      }
    case 'peer_mismatch':
      return {
        title: t('Địa chỉ này không phải máy bạn chọn'),
        steps: [t('Máy trả lời có ID khác với máy bạn bấm ghép đôi. Thử lại, hoặc nhập đúng địa chỉ IP.')],
      }
    case 'declined':
      return { title: t('Ghép đôi đã bị từ chối'), steps: [t('Một trong hai bên bấm “Không khớp”. Có thể thử lại.')] }
    case 'timeout':
      return { title: t('Hết thời gian chờ so mã'), steps: [t('Hai bên cần bấm Khớp trong vòng 2 phút. Có thể thử lại.')] }
    case 'wake_timeout':
      return {
        title: t('Máy chưa lên sau 2 phút'),
        steps: [
          t('Wake-on-LAN phải được bật ở máy kia: trong BIOS/UEFI, và trong cài đặt card mạng (Windows: Wake on Magic Packet).'),
          t('Windows: tắt Fast Startup, vì nó thường làm Wake-on-LAN không hoạt động khi máy tắt.'),
          t('Mac chỉ thức dậy được từ trạng thái ngủ, qua cáp mạng, khi bật “Wake for network access”. Tắt hẳn hoặc qua Wi-Fi thường không được.'),
          t('Máy kia cần nối cáp mạng vào cùng mạng với máy này.'),
        ],
      }
    case 'aborted':
      return { title: t('Đã huỷ'), steps: [] }
    case 'listen_failed':
      return {
        title: t('Không mở được cổng nhận kết nối'),
        steps: [t('Cổng đang bị chương trình khác dùng hoặc bị chặn. Thử tắt rồi bật lại Connect.')],
      }
    case 'mdns_failed':
      return { title: t('Không bật được việc tìm máy trong mạng'), steps: [t('Kiểm tra máy đang nối mạng, rồi tắt và bật lại Connect.')] }
    case 'keychain':
      return {
        title: t('Không lưu được khoá của máy này'),
        steps: [t('Cho phép Portway dùng Keychain khi hệ thống hỏi, rồi thử lại.')],
      }
    default:
      return { title: t('Không kết nối được'), steps: [t('Kiểm tra hai máy cùng một mạng, rồi thử lại.')] }
  }
}

/** Text for an error that came straight back from a command. */
export function commandError(e: unknown): string {
  if (!isAppError(e)) return String(e)
  switch (e.code) {
    case 'connect_off':
      return t('Connect đang tắt')
    case 'pairing_busy':
      return t('Đang có một yêu cầu ghép đôi khác')
    case 'link_busy':
      return t('Đang kết nối với một máy khác')
    case 'invalid_address':
      return t('Địa chỉ IP không hợp lệ')
    case 'peer_not_found':
      return t('Không thấy máy này trong mạng')
    case 'not_linked':
      return t('Chỉ gửi clipboard được khi đang kết nối với máy đó')
    case 'clip_empty':
      return t('Clipboard không có văn bản hoặc ảnh để gửi')
    case 'clip_image_too_large':
      return t('Ảnh trong clipboard quá lớn (tối đa 25 MB)')
    case 'clip_image_invalid':
      return t('Không đọc được ảnh trong clipboard')
    case 'clipimage_unsupported':
      return t('Portway ở máy kia chưa hỗ trợ nhận ảnh. Cập nhật Portway ở máy đó.')
    case 'clip_too_large':
      return t('Văn bản trong clipboard quá dài (tối đa khoảng 40.000 ký tự)')
    case 'no_files':
      return t('Chưa chọn tệp nào')
    case 'too_many_files':
      return t('Quá nhiều tệp một lần (tối đa 20.000)')
    case 'empty_folder':
      return t('{path} không có tệp nào để gửi', { path: e.detail ?? '' })
    case 'not_a_file':
      return t('{path} không phải tệp hay thư mục thường', { path: e.detail ?? '' })
    case 'no_offer':
      return t('Yêu cầu nhận tệp này đã hết hạn')
    case 'peer_login_screen':
      return t('Máy đó đang ở màn hình đăng nhập. Đăng nhập Windows ở máy đó rồi thử lại.')
    case 'clip_no_files':
      return t('Clipboard không có tệp nào. Hãy copy tệp trong Finder hoặc Explorer trước.')
    case 'clipfiles_unsupported':
      return t('Portway ở máy kia chưa hỗ trợ dán tệp. Cập nhật Portway ở máy đó.')
    case 'no_clip_files':
      return t('Máy kia không còn tệp nào đang được copy')
    case 'speed_unsupported':
      return t('Portway ở máy kia chưa hỗ trợ đo tốc độ')
    case 'speed_busy':
      return t('Đang đo tốc độ với một máy khác')
    case 'no_mac':
      return t('Chưa có địa chỉ MAC của máy này. Kết nối với nó một lần để Portway ghi lại.')
    case 'wake_failed':
      return t('Không gửi được gói đánh thức: kiểm tra máy này đang nối mạng')
    default:
      return hintFor(e.code, null).title + (e.detail ? ` (${e.detail})` : '')
  }
}

/** Why a file transfer ended badly, for the row in the list. */
export function transferError(code: string): string {
  switch (code) {
    case 'hash_mismatch':
      return t('Tệp nhận về bị sai, đã bỏ')
    case 'file_changed':
      return t('Tệp bị đổi trong lúc gửi')
    case 'io':
      return t('Không đọc hoặc ghi được tệp (ổ đĩa đầy hoặc không có quyền)')
    case 'protocol':
      return t('Máy kia gửi dữ liệu không đúng')
    case 'refused_busy':
      return t('Máy kia đang có quá nhiều yêu cầu nhận tệp')
    case 'refused_gone':
      return t('Máy kia đã copy thứ khác nên tệp không còn nữa')
    case 'refused_bad_offer':
      return t('Máy kia không nhận danh sách tệp này')
    default:
      return hintFor(code, null).title
  }
}

/** Why a speed test ended badly. */
export function speedError(code: string): string {
  switch (code) {
    case 'refused_busy':
      return t('Máy kia đang đo tốc độ với máy khác')
    case 'connection_lost':
      return t('mất kết nối giữa chừng')
    default:
      return hintFor(code, null).title
  }
}
