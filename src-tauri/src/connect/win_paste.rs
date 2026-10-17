//! Pasting files in Explorer that are fetched at the moment of the paste. The
//! clipboard holds an `IDataObject` that describes the files (names and
//! sizes, in "FileGroupDescriptorW") and hands out each one's bytes only when
//! Explorer asks for it ("FileContents", index by index). Asking is what
//! triggers the fetch from the other machine; Explorer shows its own progress
//! while it waits.
//!
//! OLE keeps such a clipboard working only while the thread that set it is
//! alive, in a single-threaded apartment, and pumps messages. So the object
//! lives on a thread of its own that does nothing else.
//!
//! Folders are not offered here (each file inside would have to be listed up
//! front); they go through the "Save to Downloads" button.

use std::mem::ManuallyDrop;
use std::sync::Mutex;
use windows::core::{implement, Interface, BOOL, HRESULT, PCWSTR};
use windows::Win32::Foundation::{DV_E_FORMATETC, DV_E_TYMED, E_FAIL, E_NOTIMPL, HGLOBAL, OLE_E_ADVISENOTSUPPORTED, S_OK, WPARAM, LPARAM};
use windows::Win32::System::Com::{IAdviseSink, IDataObject, IDataObject_Impl, IEnumFORMATETC, IEnumSTATDATA, DATADIR_GET, FORMATETC, STGMEDIUM, STGMEDIUM_0, TYMED_HGLOBAL, TYMED_ISTREAM, DVASPECT_CONTENT};
use windows::Win32::System::DataExchange::{GetClipboardSequenceNumber, RegisterClipboardFormatW};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::{OleInitialize, OleSetClipboard, OleUninitialize};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Shell::{SHCreateStdEnumFmtEtc, SHCreateStreamOnFileEx, FILEDESCRIPTORW, FD_FILESIZE, FD_PROGRESSUI};
use windows::Win32::UI::WindowsAndMessaging::{DispatchMessageW, GetMessageW, PeekMessageW, PostThreadMessageW, TranslateMessage, MSG, PM_NOREMOVE, WM_QUIT};

use super::sys_clip::{FileSource, LazyItem};

#[link(name = "ole32")]
extern "system" {
    /// S_OK (0) when the object is what the clipboard holds; S_FALSE (1) when not. The
    /// wrapper in the `windows` crate turns both into `Ok`, so this one is declared here.
    fn OleIsCurrentClipboard(pdataobj: *mut core::ffi::c_void) -> i32;
}

const STGM_READ: u32 = 0;
const STGM_SHARE_DENY_WRITE: u32 = 0x20;
const FILE_ATTRIBUTE_NORMAL: u32 = 0x80;
const DROPEFFECT_COPY: u32 = 1;

fn format(name: &str) -> u16 {
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: NUL-terminated and alive for the call.
    unsafe { RegisterClipboardFormatW(PCWSTR(wide.as_ptr())) as u16 }
}

fn formatetc(cf: u16, tymed: i32, lindex: i32) -> FORMATETC {
    FORMATETC { cfFormat: cf, ptd: std::ptr::null_mut(), dwAspect: DVASPECT_CONTENT.0 as u32, lindex, tymed: tymed as u32 }
}

/// What is pasted: only the files, in the order they are listed.
#[implement(IDataObject)]
struct Files {
    items: Vec<LazyItem>,
    /// Position of each listed file among everything that was copied, for `source`.
    positions: Vec<usize>,
    source: FileSource,
    fmt_descriptor: u16,
    fmt_contents: u16,
    fmt_effect: u16,
}

impl Files {
    /// "FileGroupDescriptorW": how many files and what each is called and how big.
    fn descriptor(&self) -> windows::core::Result<STGMEDIUM> {
        let each = std::mem::size_of::<FILEDESCRIPTORW>();
        let total = 4 + each * self.items.len();
        // SAFETY: the block is sized for the count and the descriptors written into it, and unlocked before it is handed over.
        unsafe {
            let handle = GlobalAlloc(GMEM_MOVEABLE, total)?;
            let base = GlobalLock(handle) as *mut u8;
            if base.is_null() {
                return Err(E_FAIL.into());
            }
            std::ptr::write_unaligned(base as *mut u32, self.items.len() as u32);
            for (i, item) in self.items.iter().enumerate() {
                let mut d: FILEDESCRIPTORW = std::mem::zeroed();
                d.dwFlags = (FD_FILESIZE.0 | FD_PROGRESSUI.0) as u32;
                d.nFileSizeHigh = (item.size >> 32) as u32;
                d.nFileSizeLow = item.size as u32;
                // The struct is packed: build the name apart and copy it in.
                let mut name = [0u16; 260];
                for (slot, unit) in name.iter_mut().zip(item.name.encode_utf16().take(259)) {
                    *slot = unit;
                }
                d.cFileName = name;
                std::ptr::write_unaligned(base.add(4 + i * each) as *mut FILEDESCRIPTORW, d);
            }
            let _ = GlobalUnlock(handle);
            Ok(hglobal_medium(handle))
        }
    }

    /// "Preferred DropEffect": a copy, so Explorer leaves the source alone.
    fn effect(&self) -> windows::core::Result<STGMEDIUM> {
        // SAFETY: as above.
        unsafe {
            let handle = GlobalAlloc(GMEM_MOVEABLE, 4)?;
            let base = GlobalLock(handle) as *mut u32;
            if base.is_null() {
                return Err(E_FAIL.into());
            }
            std::ptr::write_unaligned(base, DROPEFFECT_COPY);
            let _ = GlobalUnlock(handle);
            Ok(hglobal_medium(handle))
        }
    }

    /// "FileContents" for one listed file: fetched now, then streamed from where it landed.
    fn contents(&self, lindex: i32) -> windows::core::Result<STGMEDIUM> {
        let listed = usize::try_from(lindex).ok().filter(|i| *i < self.positions.len()).ok_or(DV_E_FORMATETC)?;
        let path = (self.source)(self.positions[listed]).ok_or(E_FAIL)?;
        let wide: Vec<u16> = path.as_os_str().to_string_lossy().encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: NUL-terminated and alive for the call.
        let stream = unsafe { SHCreateStreamOnFileEx(PCWSTR(wide.as_ptr()), STGM_READ | STGM_SHARE_DENY_WRITE, FILE_ATTRIBUTE_NORMAL, false, None)? };
        Ok(STGMEDIUM { tymed: TYMED_ISTREAM.0 as u32, u: STGMEDIUM_0 { pstm: ManuallyDrop::new(Some(stream)) }, pUnkForRelease: ManuallyDrop::new(None) })
    }

    fn formats(&self) -> Vec<FORMATETC> {
        vec![formatetc(self.fmt_descriptor, TYMED_HGLOBAL.0, -1), formatetc(self.fmt_contents, TYMED_ISTREAM.0, -1), formatetc(self.fmt_effect, TYMED_HGLOBAL.0, -1)]
    }
}

fn hglobal_medium(handle: HGLOBAL) -> STGMEDIUM {
    STGMEDIUM { tymed: TYMED_HGLOBAL.0 as u32, u: STGMEDIUM_0 { hGlobal: handle }, pUnkForRelease: ManuallyDrop::new(None) }
}

impl IDataObject_Impl for Files_Impl {
    fn GetData(&self, pformatetcin: *const FORMATETC) -> windows::core::Result<STGMEDIUM> {
        // SAFETY: COM passes a valid FORMATETC.
        let wanted = unsafe { &*pformatetcin };
        let has = |tymed: i32| wanted.tymed & tymed as u32 != 0;
        if wanted.cfFormat == self.fmt_descriptor {
            return if has(TYMED_HGLOBAL.0) { self.descriptor() } else { Err(DV_E_TYMED.into()) };
        }
        if wanted.cfFormat == self.fmt_effect {
            return if has(TYMED_HGLOBAL.0) { self.effect() } else { Err(DV_E_TYMED.into()) };
        }
        if wanted.cfFormat == self.fmt_contents {
            return if has(TYMED_ISTREAM.0) { self.contents(wanted.lindex) } else { Err(DV_E_TYMED.into()) };
        }
        Err(DV_E_FORMATETC.into())
    }

    fn GetDataHere(&self, _pformatetc: *const FORMATETC, _pmedium: *mut STGMEDIUM) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn QueryGetData(&self, pformatetc: *const FORMATETC) -> HRESULT {
        // SAFETY: COM passes a valid FORMATETC.
        let wanted = unsafe { &*pformatetc };
        let ok = |cf: u16, tymed: i32| wanted.cfFormat == cf && wanted.tymed & tymed as u32 != 0;
        if ok(self.fmt_descriptor, TYMED_HGLOBAL.0) || ok(self.fmt_effect, TYMED_HGLOBAL.0) || ok(self.fmt_contents, TYMED_ISTREAM.0) {
            S_OK
        } else if wanted.cfFormat == self.fmt_descriptor || wanted.cfFormat == self.fmt_effect || wanted.cfFormat == self.fmt_contents {
            DV_E_TYMED
        } else {
            DV_E_FORMATETC
        }
    }

    fn GetCanonicalFormatEtc(&self, _pformatectin: *const FORMATETC, _pformatetcout: *mut FORMATETC) -> HRESULT {
        // DATA_S_SAMEFORMATETC
        HRESULT(0x00040130)
    }

    fn SetData(&self, _pformatetc: *const FORMATETC, _pmedium: *const STGMEDIUM, _frelease: BOOL) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn EnumFormatEtc(&self, dwdirection: u32) -> windows::core::Result<IEnumFORMATETC> {
        if dwdirection != DATADIR_GET.0 as u32 {
            return Err(E_NOTIMPL.into());
        }
        // SAFETY: the formats are copied by the enumerator.
        unsafe { SHCreateStdEnumFmtEtc(&self.formats()) }
    }

    fn DAdvise(&self, _pformatetc: *const FORMATETC, _advf: u32, _padvsink: windows::core::Ref<'_, IAdviseSink>) -> windows::core::Result<u32> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }

    fn DUnadvise(&self, _dwconnection: u32) -> windows::core::Result<()> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }

    fn EnumDAdvise(&self) -> windows::core::Result<IEnumSTATDATA> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }
}

/// The thread that holds the clipboard object, and how to end it.
struct Holder {
    thread_id: u32,
    join: std::thread::JoinHandle<()>,
}

static CURRENT: Mutex<Option<Holder>> = Mutex::new(None);

/// Put the files on the clipboard. Gives the clipboard's change count right
/// after (to tell this write from a copy by the user), or None when there is
/// nothing this can paste (only folders) or OLE refused.
pub fn set(items: &[LazyItem], source: FileSource) -> Option<u64> {
    clear();
    let (listed, positions): (Vec<LazyItem>, Vec<usize>) = items.iter().cloned().enumerate().filter(|(_, i)| !i.dir).map(|(pos, i)| (i, pos)).unzip();
    if listed.is_empty() {
        return None;
    }
    let (tx, rx) = std::sync::mpsc::channel::<Option<(u32, u64)>>();
    let join = std::thread::Builder::new()
        .name("portway-clip-paste".into())
        .spawn(move || {
            // SAFETY: a thread of its own: OLE is initialised here, the object lives and is used only here
            // (other processes reach it through OLE's marshalling), and the thread ends by uninitialising.
            unsafe {
                if OleInitialize(None).is_err() {
                    let _ = tx.send(None);
                    return;
                }
                let data: IDataObject = Files {
                    items: listed,
                    positions,
                    source,
                    fmt_descriptor: format("FileGroupDescriptorW"),
                    fmt_contents: format("FileContents"),
                    fmt_effect: format("Preferred DropEffect"),
                }
                .into();
                if OleSetClipboard(&data).is_err() {
                    let _ = tx.send(None);
                    OleUninitialize();
                    return;
                }
                // The message queue has to exist before anyone can post to this thread.
                let mut msg = MSG::default();
                let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
                let _ = tx.send(Some((GetCurrentThreadId(), GetClipboardSequenceNumber() as u64)));
                while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                // Ended: take it off the clipboard unless something else is there now.
                if OleIsCurrentClipboard(data.as_raw()) == 0 {
                    let _ = OleSetClipboard(None);
                }
                drop(data);
                OleUninitialize();
            }
        })
        .ok()?;
    match rx.recv().ok().flatten() {
        Some((thread_id, change)) => {
            *CURRENT.lock().unwrap() = Some(Holder { thread_id, join });
            Some(change)
        }
        None => {
            let _ = join.join();
            None
        }
    }
}

/// End the thread that holds the files; they leave the clipboard if still there.
pub fn clear() {
    let held = CURRENT.lock().unwrap().take();
    if let Some(h) = held {
        // SAFETY: posting a message to a thread of ours that is pumping.
        unsafe {
            let _ = PostThreadMessageW(h.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        let _ = h.join.join();
    }
}
