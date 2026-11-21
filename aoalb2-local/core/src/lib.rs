//! aoALB 2 ローカル版の中核。画面（Web UI）からは Tauri コマンド経由で呼ばれる。
//! 画面側は Repository インターフェースだけに依存し、この実装を将来クラウド版へ差し替えられる。

pub mod backup;
pub mod classify;
pub mod db;
pub mod error;
pub mod exchange;
pub mod ledger;
pub mod pdf;
pub mod photos;
pub mod project;
pub mod synth;
pub mod util;

pub use error::{AppError, ErrorKind, Result};
