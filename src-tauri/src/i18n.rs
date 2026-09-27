//! Language of the text the Rust side sends to the UI (errors, statuses,
//! trace labels). Set from Cài đặt; Vietnamese until then.

use std::sync::atomic::{AtomicBool, Ordering};

use crate::settings::Language;

static EN: AtomicBool = AtomicBool::new(false);

pub fn set(lang: Language) {
    EN.store(lang == Language::En, Ordering::Relaxed);
}

pub fn en() -> bool {
    EN.load(Ordering::Relaxed)
}

/// The Vietnamese or English text, whichever the UI is in. English text is
/// written for macOS ("this Mac"); on Windows it says "this PC".
pub fn tr(vi: impl Into<String>, en: impl Into<String>) -> String {
    if self::en() {
        let en = en.into();
        if cfg!(windows) {
            en.replace("this Mac", "this PC").replace("your Mac", "your PC")
        } else {
            en
        }
    } else {
        vi.into()
    }
}
