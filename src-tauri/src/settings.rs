//! App preferences, persisted as JSON in the app data directory and sent to
//! every window as a `settings` event when they change.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

use crate::error::{AppError, AppResult};
use crate::paths::expand_tilde;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Theme {
    #[default]
    Dark,
    Light,
    /// Follow macOS.
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Language {
    #[default]
    Vi,
    En,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// UI language, also for text the Rust side sends (errors, statuses).
    pub language: Language,
    /// Default folder for downloads; None is ~/Downloads.
    pub download_dir: Option<String>,
    /// Ask where to save each download (opening at the default folder).
    /// None for files from before this setting: they asked unless a folder was set.
    pub ask_download: Option<bool>,
    pub theme: Theme,
    /// App (a .app path) that opens text files edited on this Mac; None is
    /// the default text editor.
    pub editor: Option<String>,
    /// App per file extension ("docx" → Microsoft Word), for files edited on
    /// this Mac. Learnt the first time a type is opened (the system's app for
    /// it, or the one picked with "Mở bằng app khác…"); changed in Cài đặt.
    pub open_with: BTreeMap<String, String>,
}

/// A key of `open_with`: a lowercase extension without the dot.
pub fn valid_ext(ext: &str) -> bool {
    (1..=16).contains(&ext.len()) && ext.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "+-_".contains(c))
}

/// Remember `app` for files ending in `.ext`, and tell every window.
pub fn remember_app(handle: &AppHandle, ext: &str, app: &str) {
    if !valid_ext(ext) {
        return;
    }
    let store = handle.state::<SettingsStore>();
    let mut next = store.get();
    if next.open_with.get(ext).map(String::as_str) == Some(app) {
        return;
    }
    next.open_with.insert(ext.to_string(), app.to_string());
    if let Ok(saved) = store.save(next) {
        let _ = handle.emit("settings", saved);
    }
}

pub struct SettingsStore {
    path: PathBuf,
    current: Mutex<Settings>,
}

impl SettingsStore {
    /// A missing or unreadable file gives the defaults; preferences are never
    /// worth refusing to start over.
    pub fn load(path: PathBuf) -> Self {
        let current: Settings = fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        crate::i18n::set(current.language);
        Self { path, current: Mutex::new(current) }
    }

    pub fn get(&self) -> Settings {
        self.current.lock().unwrap().clone()
    }

    fn save(&self, next: Settings) -> AppResult<Settings> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(&next)?)?;
        fs::rename(&tmp, &self.path)?;
        crate::i18n::set(next.language);
        *self.current.lock().unwrap() = next.clone();
        Ok(next)
    }
}

#[tauri::command]
pub fn settings_get(store: tauri::State<'_, SettingsStore>) -> Settings {
    store.get()
}

#[tauri::command]
pub fn settings_set(app: AppHandle, store: tauri::State<'_, SettingsStore>, settings: Settings) -> AppResult<Settings> {
    let mut next = settings;
    next.download_dir = next.download_dir.map(|d| d.trim().to_string()).filter(|d| !d.is_empty());
    if let Some(dir) = &next.download_dir {
        if !expand_tilde(dir).is_dir() {
            return Err(AppError::detail("not_a_dir", dir));
        }
    }
    next.ask_download = Some(next.ask_download.unwrap_or(next.download_dir.is_none()));
    next.editor = next.editor.filter(|e| !e.trim().is_empty());
    if let Some(app) = &next.editor {
        if !crate::editing::is_app(std::path::Path::new(app)) {
            return Err(AppError::detail("not_an_app", app));
        }
    }
    next.open_with = next.open_with.into_iter().map(|(k, v)| (k.trim().trim_start_matches('.').to_ascii_lowercase(), v)).collect();
    for (ext, app) in &next.open_with {
        if !valid_ext(ext) {
            return Err(AppError::detail("invalid_ext", ext));
        }
        if !crate::editing::is_app(std::path::Path::new(app)) {
            return Err(AppError::detail("not_an_app", app));
        }
    }
    let saved = store.save(next)?;
    let _ = app.emit("settings", saved.clone());
    Ok(saved)
}

/// Where Portway keeps its files (server list, tunnels, audit log).
#[tauri::command]
pub fn app_data_path(app: AppHandle) -> AppResult<String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| AppError::detail("io", e))?;
    Ok(dir.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_round_trip() {
        let path = std::env::temp_dir().join(format!("portway-settings-{}.json", std::process::id()));
        let _ = fs::remove_file(&path);
        let store = SettingsStore::load(path.clone());
        assert_eq!(store.get(), Settings::default());
        assert_eq!(store.get().theme, Theme::Dark);
        let mut open_with = BTreeMap::new();
        open_with.insert("docx".to_string(), "/Applications/Microsoft Word.app".to_string());
        store
            .save(Settings { download_dir: Some(std::env::temp_dir().to_string_lossy().into_owned()), ask_download: Some(false), theme: Theme::System, open_with, ..Default::default() })
            .unwrap();
        let back = SettingsStore::load(path.clone()).get();
        assert_eq!((back.theme, back.open_with.get("docx").map(String::as_str)), (Theme::System, Some("/Applications/Microsoft Word.app")));
        assert_eq!(SettingsStore::load(path.clone()).get().theme, Theme::System);
        // Unknown or missing fields fall back to defaults.
        fs::write(&path, r#"{"theme":"light","extra":1}"#).unwrap();
        assert_eq!(SettingsStore::load(path.clone()).get(), Settings { theme: Theme::Light, ..Default::default() });
        fs::remove_file(path).ok();
    }

    #[test]
    fn extension_keys() {
        for ok in ["docx", "xlsx", "tar", "c++", "7z", "mp4"] {
            assert!(valid_ext(ok), "{ok}");
        }
        for bad in ["", "DOCX", ".docx", "a b", "x/y", "averyveryverylongext"] {
            assert!(!valid_ext(bad), "{bad}");
        }
    }
}
