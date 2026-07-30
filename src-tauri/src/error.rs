use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("{0}")]
    Io(#[from] std::io::Error),

    /// A field the user typed is unusable. The message is written to be shown
    /// verbatim in the form, so it stays in plain language.
    #[error("{0}")]
    Invalid(String),

    #[error("no host with id {0}")]
    NotFound(i64),

    /// Anything that went wrong talking to a host. The message is written to be
    /// shown in the terminal pane, so it says what to do about it.
    #[error("{0}")]
    Ssh(String),
}

/// Tauri needs the error type to serialise before it can cross to the webview.
/// Sending the message alone is enough — the frontend only ever displays it.
impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
