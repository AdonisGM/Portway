use serde::Serialize;

/// Error returned to the frontend. `code` is stable and mapped to a message in
/// the UI; `field` points at the form input it belongs to, when there is one.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl AppError {
    pub fn new(code: &'static str) -> Self {
        Self { code, field: None, detail: None }
    }

    pub fn field(code: &'static str, field: &'static str) -> Self {
        Self { code, field: Some(field), detail: None }
    }

    pub fn detail(code: &'static str, detail: impl ToString) -> Self {
        Self { code, field: None, detail: Some(detail.to_string()) }
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        Self::detail("io", e)
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        Self::detail("corrupt_store", e)
    }
}

pub type AppResult<T> = Result<T, AppError>;
