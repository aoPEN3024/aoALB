//! 検証用の架空写真・架空aoPIC ZIPを生成する（実写真は使わない）。

use serde_json::json;
use std::io::Write;
use std::path::Path;

/// 模様入りの架空JPEG（seedで模様が変わる）
pub fn jpeg(w: u32, h: u32, seed: u32, quality: u8) -> Vec<u8> {
    let mut img = image::RgbImage::new(w, h);
    let (a, b, c) = ((seed * 37) % 255, (seed * 91) % 255, (seed * 53) % 255);
    for (x, y, p) in img.enumerate_pixels_mut() {
        let band = ((x / 40 + y / 40 + seed) % 2) * 60;
        *p = image::Rgb([((x * 255 / w.max(1) + a) % 256) as u8, ((y * 255 / h.max(1) + b) % 256) as u8, ((band + c) % 256) as u8]);
    }
    // 向き確認用の目印（左上に白い四角）
    for y in 0..(h / 8) {
        for x in 0..(w / 8) {
            img.put_pixel(x, y, image::Rgb([255, 255, 255]));
        }
    }
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality).encode_image(&img).unwrap();
    out
}

/// 細かい模様で圧縮が効かない、実際のデジカメ写真並みの容量（4000×3000で約5MB）の架空JPEG
pub fn noisy_jpeg(w: u32, h: u32, seed: u32) -> Vec<u8> {
    let mut img = image::RgbImage::new(w, h);
    let mut x: u32 = seed.wrapping_mul(2654435761).max(1);
    for (px, py, p) in img.enumerate_pixels_mut() {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        let base = ((px / 8 + py / 8 + seed) % 200) as u8;
        *p = image::Rgb([base.wrapping_add((x & 0x0F) as u8), base.wrapping_add(((x >> 8) & 0x0F) as u8), base.wrapping_add(((x >> 16) & 0x0F) as u8)]);
    }
    for y in 0..(h / 8) {
        for x in 0..(w / 8) {
            img.put_pixel(x, y, image::Rgb([255, 255, 255]));
        }
    }
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 88).encode_image(&img).unwrap();
    out
}

/// SOI直後にCOMセグメントを入れて、画像は同じでもSHA-256が異なるJPEGにする
pub fn with_comment(jpeg: &[u8], text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(jpeg.len() + text.len() + 4);
    out.extend_from_slice(&jpeg[..2]);
    let len = (text.len() + 2) as u16;
    out.extend_from_slice(&[0xFF, 0xFE]);
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(text.as_bytes());
    out.extend_from_slice(&jpeg[2..]);
    out
}

/// 最小限のEXIF（Orientation・DateTimeOriginal）を付ける
pub fn with_exif(jpeg: &[u8], datetime: Option<&str>, orientation: Option<u16>) -> Vec<u8> {
    let mut tiff: Vec<u8> = b"II*\0".to_vec();
    tiff.extend_from_slice(&8u32.to_le_bytes());
    let entry = |t: &mut Vec<u8>, tag: u16, typ: u16, count: u32, val: u32| {
        t.extend_from_slice(&tag.to_le_bytes());
        t.extend_from_slice(&typ.to_le_bytes());
        t.extend_from_slice(&count.to_le_bytes());
        t.extend_from_slice(&val.to_le_bytes());
    };
    tiff.extend_from_slice(&2u16.to_le_bytes());
    entry(&mut tiff, 0x0112, 3, 1, orientation.unwrap_or(1) as u32);
    entry(&mut tiff, 0x8769, 4, 1, 38);
    tiff.extend_from_slice(&0u32.to_le_bytes());
    tiff.extend_from_slice(&1u16.to_le_bytes());
    entry(&mut tiff, 0x9003, 2, 20, 56);
    tiff.extend_from_slice(&0u32.to_le_bytes());
    let dt = datetime.unwrap_or("2026:01:01 00:00:00");
    tiff.extend_from_slice(dt.as_bytes());
    tiff.push(0);
    let mut seg = b"Exif\0\0".to_vec();
    seg.extend_from_slice(&tiff);
    let mut out = jpeg[..2].to_vec();
    out.extend_from_slice(&[0xFF, 0xE1]);
    out.extend_from_slice(&((seg.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(&seg);
    out.extend_from_slice(&jpeg[2..]);
    out
}

pub fn sha256(b: &[u8]) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(b))
}

/// aoPICの「aoALB連携ZIP」（manifestVersion 1）と同じ形式の架空ZIP
pub fn aopic_zip(path: &Path, n: usize) -> Vec<(String, Vec<u8>)> {
    let project_uid = uuid::Uuid::new_v4().to_string();
    let base = jpeg(1280, 960, 7, 85);
    let mut photos = Vec::new();
    let mut files = Vec::new();
    for i in 0..n {
        let uid = uuid::Uuid::new_v4().to_string();
        let bytes = with_comment(&base, &format!("aopic-{i}"));
        photos.push(json!({
            "photoUid": uid, "legacyId": i + 1, "projectUid": project_uid, "capturedAt": format!("2026-11-{:02}T09:{:02}:00+09:00", 1 + i % 28, i % 60),
            "filePath": format!("photos/{uid}.jpg"), "sha256": sha256(&bytes), "mimeType": "image/jpeg", "width": 1280, "height": 960, "bytes": bytes.len(), "schemaVersion": 2,
            "classification": {"koushu": "塗装工", "shubetsu": "橋梁塗装", "saibetsu": format!("第{}層", 1 + i % 3), "sokuten": format!("P{}", i + 1), "tekiyo": "架空データ"},
            "boardSnapshot": {"koujimei": "架空橋梁塗装工事", "contractor": "架空建設", "koushu": "塗装工", "shubetsu": "橋梁塗装", "saibetsu": format!("第{}層", 1 + i % 3), "sokuten": format!("P{}", i + 1), "tekiyo": "架空データ"},
            "ledger": {"title": format!("架空台帳タイトル{}", i + 1), "description": "", "manual": false}
        }));
        files.push((uid, bytes));
    }
    let manifest = json!({"app": "aoPIC", "type": "aoALB-export", "manifestVersion": 1, "exportId": uuid::Uuid::new_v4().to_string(), "exportedAt": "2026-11-21T00:00:00Z",
        "project": {"projectUid": project_uid, "koujiId": "K-0001", "name": "架空橋梁塗装工事", "contractor": "架空建設"}, "photos": photos});
    let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
    let opt = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("aoalb-export/manifest.json", opt).unwrap();
    zip.write_all(manifest.to_string().as_bytes()).unwrap();
    for (uid, b) in &files {
        zip.start_file(format!("aoalb-export/photos/{uid}.jpg"), opt).unwrap();
        zip.write_all(b).unwrap();
    }
    zip.finish().unwrap();
    files
}
