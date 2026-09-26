//! App preferences, persisted as JSON in the app data directory and sent to
//! every window as a `settings` event when they change.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Default folder for downloads; None is ~/Downloads.
    pub download_dir: Option<String>,
    /// Ask where to save each download (opening at the default folder).
    /// None for files from before this setting: they asked unless a folder was set.
    pub ask_download: Option<bool>,
    pub theme: Theme,
}

pub struct SettingsStore {
    path: PathBuf,
    current: Mutex<Settings>,
}

impl SettingsStore {
    /// A missing or unreadable file gives the defaults; preferences are never
    /// worth refusing to start over.
    pub fn load(path: PathBuf) -> Self {
        let current = fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
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
        assert_eq!(store.get(), Settings { download_dir: None, ask_download: None, theme: Theme::Dark });
        store.save(Settings { download_dir: Some("/tmp".into()), ask_download: Some(false), theme: Theme::System }).unwrap();
        assert_eq!(SettingsStore::load(path.clone()).get().theme, Theme::System);
        // Unknown or missing fields fall back to defaults.
        fs::write(&path, r#"{"theme":"light","extra":1}"#).unwrap();
        assert_eq!(SettingsStore::load(path.clone()).get(), Settings { download_dir: None, ask_download: None, theme: Theme::Light });
        fs::remove_file(path).ok();
    }
}
