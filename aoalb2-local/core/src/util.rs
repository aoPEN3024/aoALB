//! 共通処理：時刻、UUID、ハッシュ、安全なファイル書込み、キャンセル・進捗。

use crate::error::{AppError, Result};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn new_uuid() -> String {
    uuid::Uuid::now_v7().to_string()
}

pub fn is_uuid(s: &str) -> bool {
    uuid::Uuid::parse_str(s).map(|u| u.hyphenated().to_string() == s).unwrap_or(false)
}

/// 読み込みながらSHA-256とバイト数を計算し、必要なら書き出し先へコピーする（全体をメモリへ載せない）。
pub fn hash_copy<R: Read, W: Write>(mut reader: R, mut writer: Option<&mut W>, cancel: &Cancel) -> Result<(String, u64)> {
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut total = 0u64;
    loop {
        cancel.check()?;
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        if let Some(w) = writer.as_mut() {
            w.write_all(&buf[..n])?;
        }
        total += n as u64;
    }
    Ok((hex::encode(hasher.finalize()), total))
}

pub fn hash_file(path: &Path, cancel: &Cancel) -> Result<(String, u64)> {
    let f = File::open(path)?;
    hash_copy::<_, File>(std::io::BufReader::new(f), None, cancel)
}

/// 一時ファイルへ書いてfsync後に置換する。途中で失敗しても完成ファイルは現れない。
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = tmp_sibling(path);
    {
        let mut f = File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        AppError::from(e)
    })?;
    Ok(())
}

pub fn tmp_sibling(path: &Path) -> PathBuf {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    path.with_file_name(format!(".{name}.{}.partial", uuid::Uuid::new_v4().simple()))
}

/// JPEGの先頭(SOI)を確認する。拡張子やMIMEは信用しない。
pub fn looks_like_jpeg(head: &[u8]) -> bool {
    head.len() >= 3 && head[0] == 0xFF && head[1] == 0xD8 && head[2] == 0xFF
}

#[derive(Clone, Default)]
pub struct Cancel(Arc<AtomicBool>);
impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst)
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
    pub fn check(&self) -> Result<()> {
        if self.is_cancelled() { Err(AppError::cancelled()) } else { Ok(()) }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Progress {
    pub phase: &'static str,
    pub current: u64,
    pub total: u64,
    /// 画面に出す短い日本語
    pub message: String,
}

pub type ProgressFn<'a> = &'a mut dyn FnMut(Progress);

pub fn no_progress() -> impl FnMut(Progress) {
    |_p: Progress| {}
}

/// 画面へ出すファイル名（パスを除いた最後の部分だけ）
pub fn display_name(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).to_string()
}

pub fn available_space(path: &Path) -> Option<u64> {
    let mut p = path.to_path_buf();
    while !p.exists() {
        if !p.pop() {
            return None;
        }
    }
    fs2::available_space(&p).ok()
}

pub fn ensure_space(dir: &Path, needed: u64) -> Result<()> {
    if let Some(free) = available_space(dir) {
        // 余裕として必要量の5%と64MBを上乗せ
        let margin = needed / 20 + 64 * 1024 * 1024;
        if free < needed.saturating_add(margin) {
            return Err(AppError::new(
                crate::error::ErrorKind::DiskFull,
                format!("保存先の空き容量が足りません。必要：約{}、空き：約{}", human_bytes(needed + margin), human_bytes(free)),
            ));
        }
    }
    Ok(())
}

pub fn human_bytes(n: u64) -> String {
    const U: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < U.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 { format!("{n}B") } else { format!("{v:.1}{}", U[i]) }
}

/// Windowsで予約されている名前か（大文字小文字を区別しない。「CON.txt」「LPT9.工事」のように拡張子付きでも予約名）
pub fn is_reserved_windows_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").trim_end_matches(' ').to_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$") {
        return true;
    }
    for prefix in ["COM", "LPT"] {
        if let Some(rest) = stem.strip_prefix(prefix)
            && matches!(rest, "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³")
        {
            return true;
        }
    }
    false
}

/// 工事フォルダ・書出しファイル名に使える名前へ整える（工事の新規作成・引継ぎ取込み・ファイル名の既定値で共通）
/// - Windowsで使えない文字 `<>:"/\|?*` と制御文字は「_」
/// - 前後の空白、末尾のピリオド・空白を除く（Windowsは末尾のピリオド・空白を黙って削るため）
/// - 80文字まで（パス長の余裕のため）
/// - 予約名（CON・PRN・AUX・NUL・COM0〜9・LPT0〜9 等。拡張子付き・大文字小文字違いを含む）は名前の後ろに「_」を付ける
/// - 空になったら `fallback`
pub fn safe_name(name: &str, fallback: &str) -> String {
    let cleaned: String = name.chars().map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { '_' } else { c }).collect();
    let trim = |s: &str| s.trim().trim_end_matches(['.', ' ']).trim().to_string();
    let mut s = trim(&cleaned);
    if s.chars().count() > 80 {
        s = trim(&s.chars().take(80).collect::<String>());
    }
    if s.is_empty() {
        s = fallback.to_string();
    }
    if is_reserved_windows_name(&s) {
        s = match s.find('.') {
            Some(i) => format!("{}_{}", &s[..i], &s[i..]),
            None => format!("{s}_"),
        };
    }
    s
}

/// 親フォルダの中で、既存の名前と重ならない名前を選ぶ（大文字小文字違いも重なりとみなす）。
/// 重なる場合は「名前 (2)」「名前 (3)」…とする。
pub fn unique_child(parent: &Path, base: &str) -> Result<PathBuf> {
    let existing: std::collections::HashSet<String> = match fs::read_dir(parent) {
        Ok(rd) => rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_lowercase()).collect(),
        Err(_) => Default::default(),
    };
    for n in 1..10_000u32 {
        let name = if n == 1 { base.to_string() } else { format!("{base} ({n})") };
        let p = parent.join(&name);
        if !existing.contains(&name.to_lowercase()) && !p.exists() {
            return Ok(p);
        }
    }
    Err(AppError::invalid("同じ名前のフォルダが多すぎます。別の名前にしてください。"))
}
