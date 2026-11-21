//! 利用者向けの日本語メッセージと、ログ・検証用の分類コードを分けて持つエラー型。
//! 画面には `message` だけを出し、技術的な詳細（`detail`）は診断ログ専用にする。

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// 工事がほかのアプリで開かれている
    Locked,
    /// 保存先の空き容量が足りない
    DiskFull,
    /// 入力（ファイル・取込ファイル・操作）が不正
    Invalid,
    /// 見つからない
    NotFound,
    /// 利用者の判断が必要（古い世代の取込み等）
    NeedsConfirmation,
    /// 利用者がキャンセルした
    Cancelled,
    /// 工事データの破損・不整合
    Corrupt,
    /// ファイル操作・DB等の内部エラー
    Internal,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppError {
    pub kind: ErrorKind,
    /// 画面に出す日本語
    pub message: String,
    /// 診断用（画面には出さない。写真内容・個人情報を含めない）
    #[serde(skip_serializing)]
    pub detail: String,
}

impl AppError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into(), detail: String::new() }
    }
    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = detail.into();
        self
    }
    pub fn invalid(message: impl Into<String>) -> Self { Self::new(ErrorKind::Invalid, message) }
    pub fn not_found(message: impl Into<String>) -> Self { Self::new(ErrorKind::NotFound, message) }
    pub fn corrupt(message: impl Into<String>) -> Self { Self::new(ErrorKind::Corrupt, message) }
    pub fn cancelled() -> Self { Self::new(ErrorKind::Cancelled, "処理を中止しました。") }
    pub fn internal(detail: impl Into<String>) -> Self {
        Self::new(ErrorKind::Internal, "処理できませんでした。もう一度お試しください。").with_detail(detail)
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.detail.is_empty() { write!(f, "{}", self.message) } else { write!(f, "{} ({})", self.message, self.detail) }
    }
}
impl std::error::Error for AppError {}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        if let rusqlite::Error::SqliteFailure(code, _) = &e {
            if code.code == rusqlite::ErrorCode::DiskFull {
                return AppError::new(ErrorKind::DiskFull, "保存先の空き容量が足りません。").with_detail(e.to_string());
            }
            if code.code == rusqlite::ErrorCode::DatabaseCorrupt || code.code == rusqlite::ErrorCode::NotADatabase {
                return AppError::corrupt("工事データが壊れている可能性があります。バックアップから復元してください。").with_detail(e.to_string());
            }
        }
        AppError::internal(format!("db: {e}"))
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        // ENOSPC(28) / Windows ERROR_DISK_FULL(112) / ERROR_HANDLE_DISK_FULL(39)
        if matches!(e.raw_os_error(), Some(28) | Some(112) | Some(39)) || e.kind() == std::io::ErrorKind::StorageFull {
            return AppError::new(ErrorKind::DiskFull, "保存先の空き容量が足りません。").with_detail(e.to_string());
        }
        AppError::internal(format!("io: {e}"))
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self { AppError::invalid("データの形式が正しくありません。").with_detail(format!("json: {e}")) }
}

impl From<zip::result::ZipError> for AppError {
    fn from(e: zip::result::ZipError) -> Self {
        AppError::invalid("ファイルを開けません。壊れているか、対応していない形式です。").with_detail(format!("zip: {e}"))
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
