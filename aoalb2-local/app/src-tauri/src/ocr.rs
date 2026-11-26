//! Windows標準OCRを使った、利用者が指定した黒板範囲の読み取り。
//! 原寸写真は読み取り専用で、向き補正・切抜き・縮小はメモリ上と一時JPEGだけで行う。

use aoalb_core::{AppError, Result};
use image::{imageops::FilterType, DynamicImage, GenericImageView, ImageEncoder};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Crop {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Crop {
    fn checked(self) -> Result<Self> {
        let finite = [self.x, self.y, self.width, self.height].into_iter().all(f64::is_finite);
        if !finite
            || self.x < 0.0
            || self.y < 0.0
            || self.width <= 0.01
            || self.height <= 0.01
            || self.x + self.width > 1.000_001
            || self.y + self.height > 1.000_001
        {
            return Err(AppError::invalid("黒板の範囲をもう一度選んでください。"));
        }
        Ok(self)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrOutput {
    pub text: String,
    pub lines: Vec<String>,
    pub language: String,
    pub crop_width: u32,
    pub crop_height: u32,
}

fn oriented(mut image: DynamicImage, orientation: i64) -> DynamicImage {
    image = match orientation {
        2 => image.fliph(),
        3 => image.rotate180(),
        4 => image.flipv(),
        5 => image.rotate90().fliph(),
        6 => image.rotate90(),
        7 => image.rotate270().fliph(),
        8 => image.rotate270(),
        _ => image,
    };
    image
}

fn prepare_crop(path: &Path, orientation: i64, crop: Crop, dest: &Path) -> Result<(u32, u32)> {
    let crop = crop.checked()?;
    let image = image::open(path).map_err(|e| AppError::invalid("写真を読み取れませんでした。").with_detail(format!("ocr image: {e}")))?;
    let image = oriented(image, orientation);
    let (width, height) = image.dimensions();
    let x = (crop.x * width as f64).floor().clamp(0.0, width.saturating_sub(1) as f64) as u32;
    let y = (crop.y * height as f64).floor().clamp(0.0, height.saturating_sub(1) as f64) as u32;
    let w = (crop.width * width as f64).ceil().clamp(1.0, (width - x) as f64) as u32;
    let h = (crop.height * height as f64).ceil().clamp(1.0, (height - y) as f64) as u32;
    let mut selected = image.crop_imm(x, y, w, h);
    // Windows OCRの上限より十分小さくしつつ、黒板の文字が潰れない大きさを保つ。
    const LONG_EDGE: u32 = 2200;
    if w.max(h) > LONG_EDGE {
        let ratio = LONG_EDGE as f64 / w.max(h) as f64;
        selected = selected.resize((w as f64 * ratio).round() as u32, (h as f64 * ratio).round() as u32, FilterType::Lanczos3);
    }
    let (out_w, out_h) = selected.dimensions();
    let file = std::fs::File::create(dest)?;
    let mut writer = std::io::BufWriter::new(file);
    let rgb = selected.to_rgb8();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, 92)
        .write_image(&rgb, out_w, out_h, image::ExtendedColorType::Rgb8)
        .map_err(|e| AppError::internal(format!("ocr temp jpeg: {e}")))?;
    Ok((out_w, out_h))
}

struct TempFile(PathBuf);
impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[cfg(windows)]
fn recognize_windows(path: &Path) -> Result<(String, Vec<String>, String)> {
    use windows::core::HSTRING;
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::BitmapDecoder;
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::{FileAccessMode, StorageFile};

    let language = Language::CreateLanguage(&HSTRING::from("ja-JP"))
        .map_err(|e| AppError::internal(format!("ocr language: {e}")))?;
    if !OcrEngine::IsLanguageSupported(&language).unwrap_or(false) {
        return Err(AppError::invalid("Windowsの日本語OCRが利用できません。Windowsの言語設定で日本語を追加してください。"));
    }
    let engine = OcrEngine::TryCreateFromLanguage(&language)
        .map_err(|e| AppError::internal(format!("ocr engine: {e}")))?;
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path.to_string_lossy().as_ref()))
        .and_then(|op| op.join())
        .map_err(|e| AppError::internal(format!("ocr file: {e}")))?;
    let stream = file
        .OpenAsync(FileAccessMode::Read)
        .and_then(|op| op.join())
        .map_err(|e| AppError::internal(format!("ocr stream: {e}")))?;
    let decoder = BitmapDecoder::CreateAsync(&stream)
        .and_then(|op| op.join())
        .map_err(|e| AppError::internal(format!("ocr decoder: {e}")))?;
    let bitmap = decoder
        .GetSoftwareBitmapAsync()
        .and_then(|op| op.join())
        .map_err(|e| AppError::internal(format!("ocr bitmap: {e}")))?;
    let result = engine
        .RecognizeAsync(&bitmap)
        .and_then(|op| op.join())
        .map_err(|e| AppError::internal(format!("ocr recognize: {e}")))?;
    let text = result.Text().map(|s| s.to_string()).unwrap_or_default();
    let mut lines = Vec::new();
    if let Ok(items) = result.Lines() {
        for line in items {
            if let Ok(value) = line.Text() {
                let value = value.to_string().trim().to_string();
                if !value.is_empty() {
                    lines.push(value);
                }
            }
        }
    }
    let language = engine
        .RecognizerLanguage()
        .and_then(|l| l.LanguageTag())
        .map(|s| s.to_string())
        .unwrap_or_else(|_| "ja-JP".into());
    Ok((text, lines, language))
}

#[cfg(not(windows))]
fn recognize_windows(_path: &Path) -> Result<(String, Vec<String>, String)> {
    Err(AppError::invalid("黒板の読み取りはWindows版で利用できます。"))
}

pub fn recognize(path: &Path, orientation: i64, crop: Crop) -> Result<OcrOutput> {
    let temp = std::env::temp_dir().join(format!("aoalb2-ocr-{}.jpg", uuid::Uuid::new_v4().simple()));
    let guard = TempFile(temp.clone());
    let (crop_width, crop_height) = prepare_crop(path, orientation, crop, &temp)?;
    let (text, lines, language) = recognize_windows(&temp)?;
    drop(guard);
    Ok(OcrOutput { text, lines, language, crop_width, crop_height })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crop_rejects_invalid_values() {
        assert!(Crop { x: 0.0, y: 0.0, width: 1.0, height: 1.0 }.checked().is_ok());
        assert!(Crop { x: 0.9, y: 0.0, width: 0.2, height: 1.0 }.checked().is_err());
        assert!(Crop { x: f64::NAN, y: 0.0, width: 1.0, height: 1.0 }.checked().is_err());
    }
}
