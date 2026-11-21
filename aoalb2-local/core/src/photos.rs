//! 写真の取込み・一覧・サムネイル。
//!
//! 取込みは1枚ずつストリーム処理する：読み込みながらSHA-256を計算して `tmp/` へコピー →
//! JPEGヘッダーとEXIFだけを読む → 重複確認 → fsync → `originals/{photoUuid}.jpg` へ改名 → DB登録。
//! 原寸写真は一度作成したら変更しない（再エンコード・EXIF書換えをしない）。

use crate::db;
use crate::error::{AppError, ErrorKind, Result};
use crate::project::Project;
use crate::util::{self, Cancel, Progress, ProgressFn, now};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs::{self, File};
use std::io::{BufReader, Read, Seek};
use std::path::{Path, PathBuf};

pub const MAX_JPEG_BYTES: u64 = 100 * 1024 * 1024;
pub const MAX_PIXELS: u64 = 120_000_000;
pub const THUMB_SIZE: u32 = 480;
pub const FIELDS: [&str; 5] = ["koushu", "shubetsu", "saibetsu", "sokuten", "tekiyo"];

// ---------------------------------------------------------------- 取込み

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ImportSource {
    Files { paths: Vec<PathBuf> },
    Folder { path: PathBuf },
    Zip { path: PathBuf },
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOptions {
    /// 同じ写真がすでにあっても取り込む
    #[serde(default)]
    pub allow_duplicates: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFailure {
    pub id: i64,
    pub source_name: String,
    pub reason: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub batch_uuid: String,
    pub total: u64,
    pub accepted: u64,
    pub duplicates: u64,
    pub failed: u64,
    pub cancelled: bool,
    pub photo_uuids: Vec<String>,
    pub failures: Vec<ImportFailure>,
    /// aoPIC連携ZIPの工事情報（工事名の初期値などに使う）
    pub aopic_project: Option<Value>,
}

/// 取込み対象1件。ファイルまたはZIP内の項目。
#[derive(Debug, Clone)]
enum Item {
    File { path: PathBuf, folder_label: String },
    ZipEntry { zip: PathBuf, index: usize, name: String, folder_label: String, aopic: Option<Value>, expect_sha: Option<String>, expect_bytes: Option<u64> },
}

impl Item {
    fn display(&self) -> String {
        match self {
            Item::File { path, .. } => util::display_name(&path.to_string_lossy()),
            Item::ZipEntry { name, .. } => util::display_name(name),
        }
    }
    fn retry_key(&self) -> String {
        match self {
            Item::File { path, .. } => path.to_string_lossy().into(),
            Item::ZipEntry { zip, name, .. } => format!("{}::{}", zip.to_string_lossy(), name),
        }
    }
}

fn is_jpeg_name(name: &str) -> bool {
    let l = name.to_ascii_lowercase();
    l.ends_with(".jpg") || l.ends_with(".jpeg") || l.ends_with(".jpe")
}
fn is_known_unsupported(name: &str) -> bool {
    let l = name.to_ascii_lowercase();
    [".heic", ".heif", ".png", ".gif", ".bmp", ".tif", ".tiff", ".webp", ".raw", ".cr2", ".nef", ".arw", ".dng"].iter().any(|e| l.ends_with(e))
}

fn collect_folder(root: &Path, dir: &Path, out: &mut Vec<Item>, unsupported: &mut Vec<String>, depth: u32) -> Result<()> {
    if depth > 32 {
        return Ok(());
    }
    let mut entries: Vec<_> = fs::read_dir(dir)?.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let p = e.path();
        let ft = match e.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            collect_folder(root, &p, out, unsupported, depth + 1)?;
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if is_jpeg_name(&name) {
            let rel = p
                .parent()
                .and_then(|pp| pp.strip_prefix(root.parent().unwrap_or(root)).ok())
                .map(|r| r.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            out.push(Item::File { path: p, folder_label: rel });
        } else if is_known_unsupported(&name) {
            unsupported.push(name);
        }
    }
    Ok(())
}

struct Prepared {
    tmp: PathBuf,
    sha256: String,
    bytes: u64,
}

pub(crate) struct JpegInfo {
    pub width: u32,
    pub height: u32,
    pub components: u8,
    pub adobe_cmyk: bool,
}

pub(crate) fn read_jpeg_info(path: &Path) -> Result<JpegInfo> {
    let mut d = jpeg_decoder::Decoder::new(BufReader::new(File::open(path)?));
    d.read_info().map_err(|e| AppError::invalid("写真として読み取れません（JPEGが壊れている可能性があります）。").with_detail(e.to_string()))?;
    let info = d.info().ok_or_else(|| AppError::invalid("写真として読み取れません。"))?;
    let components = match info.pixel_format {
        jpeg_decoder::PixelFormat::L8 | jpeg_decoder::PixelFormat::L16 => 1,
        jpeg_decoder::PixelFormat::RGB24 => 3,
        jpeg_decoder::PixelFormat::CMYK32 => 4,
    };
    if info.coding_process == jpeg_decoder::CodingProcess::Lossless {
        return Err(AppError::invalid("この形式のJPEGには対応していません。"));
    }
    let _ = &mut d;
    Ok(JpegInfo { width: info.width as u32, height: info.height as u32, components, adobe_cmyk: components == 4 })
}

#[derive(Default)]
pub(crate) struct ExifData {
    pub orientation: u32,
    pub taken_at: Option<String>,
    pub json: Value,
}

pub(crate) fn read_exif(path: &Path) -> ExifData {
    let mut out = ExifData { orientation: 1, ..Default::default() };
    let Ok(f) = File::open(path) else { return out };
    let Ok(exif) = exif::Reader::new().read_from_container(&mut BufReader::new(f)) else { return out };
    let get = |tag: exif::Tag| exif.get_field(tag, exif::In::PRIMARY);
    if let Some(f) = get(exif::Tag::Orientation)
        && let Some(v) = f.value.get_uint(0)
        && (1..=8).contains(&v)
    {
        out.orientation = v;
    }
    let ascii = |tag: exif::Tag| {
        get(tag).and_then(|f| match &f.value {
            exif::Value::Ascii(v) if !v.is_empty() => Some(String::from_utf8_lossy(&v[0]).trim().to_string()),
            _ => None,
        })
    };
    if let Some(dt) = ascii(exif::Tag::DateTimeOriginal).or_else(|| ascii(exif::Tag::DateTime)) {
        // "2026:11:21 09:30:00" → "2026-11-21T09:30:00(+09:00)"
        if dt.len() >= 19 && dt.as_bytes()[4] == b':' {
            let mut s = format!("{}-{}-{}T{}", &dt[0..4], &dt[5..7], &dt[8..10], &dt[11..19]);
            if let Some(off) = ascii(exif::Tag::OffsetTimeOriginal)
                && off.len() == 6
            {
                s.push_str(&off);
            }
            if !s.starts_with("0000") {
                out.taken_at = Some(s);
            }
        }
    }
    out.json = json!({
        "make": ascii(exif::Tag::Make), "model": ascii(exif::Tag::Model),
        "dateTimeOriginal": ascii(exif::Tag::DateTimeOriginal), "offsetTimeOriginal": ascii(exif::Tag::OffsetTimeOriginal),
        "orientation": out.orientation,
    });
    out
}

pub(crate) fn file_time_label(path: &Path) -> Option<String> {
    let m = fs::metadata(path).ok()?.modified().ok()?;
    let dt: chrono::DateTime<chrono::Local> = m.into();
    Some(dt.format("%Y-%m-%dT%H:%M:%S%:z").to_string())
}

fn copy_to_tmp<R: Read>(reader: R, tmp_dir: &Path, limit: u64, cancel: &Cancel) -> Result<Prepared> {
    let tmp = tmp_dir.join(format!("{}.partial", uuid::Uuid::new_v4().simple()));
    let res = (|| {
        let mut f = File::create(&tmp)?;
        let mut limited = reader.take(limit + 1);
        let mut head = [0u8; 3];
        let mut got = 0;
        while got < 3 {
            let n = limited.read(&mut head[got..])?;
            if n == 0 {
                break;
            }
            got += n;
        }
        if !util::looks_like_jpeg(&head[..got]) {
            return Err(AppError::invalid("JPEG写真ではありません。"));
        }
        // 確認に使った先頭バイトを戻して、全体を1回の読込みでハッシュ計算とコピーを行う
        let reader = std::io::Cursor::new(head[..got].to_vec()).chain(limited);
        let (rest_sha, rest_bytes) = util::hash_copy(reader, Some(&mut f), cancel)?;
        if rest_bytes > limit {
            return Err(AppError::invalid("写真のファイルが大きすぎます（100MBまで）。"));
        }
        f.sync_all()?;
        Ok(Prepared { tmp: tmp.clone(), sha256: rest_sha, bytes: rest_bytes })
    })();
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    res
}

struct Importer<'a> {
    project: &'a mut Project,
    batch: String,
    opts: ImportOptions,
    result: ImportResult,
}

impl<'a> Importer<'a> {
    fn fail(&mut self, item: &Item, reason: &str, kind: &str) -> Result<()> {
        self.project.conn.execute(
            "insert into import_failures(batch_uuid, source_name, source_path, reason, kind, created_at) values(?1, ?2, ?3, ?4, ?5, ?6)",
            params![self.batch, item.display(), item.retry_key(), reason, kind, now()],
        )?;
        let id = self.project.conn.last_insert_rowid();
        if kind == "duplicate" {
            self.result.duplicates += 1;
        } else {
            self.result.failed += 1;
        }
        self.result.failures.push(ImportFailure { id, source_name: item.display(), reason: reason.into(), kind: kind.into() });
        Ok(())
    }

    fn import_item(&mut self, item: &Item, cancel: &Cancel) -> Result<()> {
        let tmp_dir = self.project.tmp_dir();
        let (prepared, folder_label, aopic, source_time) = match item {
            Item::File { path, folder_label } => {
                let meta = fs::metadata(path)?;
                if meta.len() > MAX_JPEG_BYTES {
                    return Err(AppError::invalid("写真のファイルが大きすぎます（100MBまで）。"));
                }
                let p = copy_to_tmp(BufReader::new(File::open(path)?), &tmp_dir, MAX_JPEG_BYTES, cancel)?;
                (p, folder_label.clone(), None, file_time_label(path))
            }
            Item::ZipEntry { zip, index, folder_label, aopic, expect_sha, expect_bytes, .. } => {
                let mut archive = zip::ZipArchive::new(BufReader::new(File::open(zip)?))?;
                let entry = archive.by_index(*index)?;
                if entry.encrypted() {
                    return Err(AppError::invalid("パスワード付きのファイルには対応していません。"));
                }
                check_entry_ratio(entry.size(), entry.compressed_size())?;
                let p = copy_to_tmp(entry, &tmp_dir, MAX_JPEG_BYTES, cancel)?;
                if let Some(sha) = expect_sha
                    && &p.sha256 != sha
                {
                    let _ = fs::remove_file(&p.tmp);
                    return Err(AppError::invalid("写真の内容が書き出し時と一致しません（ファイルが壊れている可能性があります）。"));
                }
                if let Some(b) = expect_bytes
                    && p.bytes != *b
                {
                    let _ = fs::remove_file(&p.tmp);
                    return Err(AppError::invalid("写真の容量が書き出し時と一致しません。"));
                }
                (p, folder_label.clone(), aopic.clone(), None)
            }
        };
        let res = self.register(&prepared, item, folder_label, aopic, source_time);
        if prepared.tmp.exists() {
            let _ = fs::remove_file(&prepared.tmp);
        }
        res
    }

    fn register(&mut self, p: &Prepared, item: &Item, folder_label: String, aopic: Option<Value>, source_time: Option<String>) -> Result<()> {
        let info = read_jpeg_info(&p.tmp)?;
        if (info.width as u64) * (info.height as u64) > MAX_PIXELS {
            return Err(AppError::invalid("写真の画素数が大きすぎます。"));
        }
        let exif = read_exif(&p.tmp);
        let photo_uid = aopic.as_ref().and_then(|a| a.get("photoUid")).and_then(|v| v.as_str()).filter(|s| util::is_uuid(s)).map(String::from);
        let conn = &self.project.conn;
        let dup: Option<String> = conn
            .query_row(
                "select coalesce(original_name, '') from photos where deleted_at is null and (sha256 = ?1 or (?2 is not null and photo_uid = ?2)) limit 1",
                params![p.sha256, photo_uid],
                |r| r.get(0),
            )
            .optional()?;
        let uid_taken: bool = match &photo_uid {
            Some(u) => conn.query_row("select 1 from photos where photo_uid = ?1", [u], |_| Ok(())).optional()?.is_some(),
            None => false,
        };
        if dup.is_some() && !self.opts.allow_duplicates {
            return Err(AppError::new(ErrorKind::NeedsConfirmation, "同じ写真がこの工事にすでにあります。"));
        }
        // 意図的に重複を取り込む場合、photoUidの一意性は保てないため2枚目はphotoUidなしで登録し元情報に残す
        let photo_uid = if uid_taken { None } else { photo_uid };
        let uuid = util::new_uuid();
        let dest = self.project.original_path(&uuid);
        fs::rename(&p.tmp, &dest)?;
        let (taken_at, taken_src) = if let Some(c) = aopic.as_ref().and_then(|a| a.get("capturedAt")).and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            (Some(c.to_string()), "aopic")
        } else if let Some(t) = exif.taken_at.clone() {
            (Some(t), "exif")
        } else if let Some(t) = source_time {
            (Some(t), "file")
        } else {
            (None, "unknown")
        };
        let cls = aopic.as_ref().and_then(|a| a.get("classification")).cloned().unwrap_or(Value::Null);
        let f = |k: &str| cls.get(k).and_then(|v| v.as_str()).unwrap_or("").chars().take(500).collect::<String>();
        let ts = now();
        let insert = (|| -> Result<()> {
            let tx = self.project.conn.unchecked_transaction()?;
            let number = db::meta_i64(&tx, "next_photo_number")?.max(1);
            db::set_meta(&tx, "next_photo_number", &(number + 1).to_string())?;
            tx.execute("insert into photos(uuid, photo_uid, source_kind, sha256, bytes, width, height, orientation, components, adobe_cmyk, taken_at, taken_at_source,
                original_name, folder_label, import_batch_uuid, photo_number, orig_koushu, orig_shubetsu, orig_saibetsu, orig_sokuten, orig_tekiyo, aopic_json, exif_json,
                created_at, updated_at) values(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?24)",
                params![uuid, photo_uid, if aopic.is_some() { "aopic" } else { "general" }, p.sha256, p.bytes as i64, info.width, info.height, exif.orientation,
                    info.components, info.adobe_cmyk, taken_at, taken_src, item.display(), folder_label, self.batch, number,
                    f("koushu"), f("shubetsu"), f("saibetsu"), f("sokuten"), f("tekiyo"), aopic.as_ref().map(|a| a.to_string()), exif.json.to_string(), ts])?;
            Project::touch(&tx, &self.project.device_id)?;
            tx.commit()?;
            Ok(())
        })();
        if let Err(e) = insert {
            let _ = fs::remove_file(&dest);
            return Err(e);
        }
        self.result.accepted += 1;
        self.result.photo_uuids.push(uuid);
        Ok(())
    }
}

pub(crate) fn check_entry_ratio(size: u64, compressed: u64) -> Result<()> {
    // 圧縮爆弾対策：極端な圧縮率の項目は拒否（JPEGはほぼ圧縮できない）
    if size > 1024 * 1024 && size / compressed.max(1) > 100 {
        return Err(AppError::invalid("ファイルの内容が不自然です（圧縮率が異常）。"));
    }
    Ok(())
}

pub const ZIP_MAX_ENTRIES: usize = 50_000;
pub const ZIP_MAX_TOTAL: u64 = 64 * 1024 * 1024 * 1024;

fn collect_zip(path: &Path, out: &mut Vec<Item>, unsupported: &mut Vec<String>) -> Result<Option<Value>> {
    let mut archive = zip::ZipArchive::new(BufReader::new(File::open(path)?))?;
    if archive.len() > ZIP_MAX_ENTRIES {
        return Err(AppError::invalid("ファイル内の項目が多すぎます。"));
    }
    let mut total = 0u64;
    let mut names = Vec::with_capacity(archive.len());
    for i in 0..archive.len() {
        let e = archive.by_index_raw(i)?;
        total = total.saturating_add(e.size());
        names.push((i, e.name()?.to_string(), e.is_dir()));
    }
    if total > ZIP_MAX_TOTAL {
        return Err(AppError::invalid("ファイルの展開後の容量が大きすぎます。"));
    }
    let find = |n: &str| names.iter().find(|(_, name, _)| name == n).map(|(i, _, _)| *i);
    // aoPIC連携ZIP（現行aoALB連携ZIPも同形式）
    if let Some(mi) = find("aoalb-export/manifest.json") {
        let manifest = read_small_json(&mut archive, mi)?;
        if manifest.get("app").and_then(|v| v.as_str()) != Some("aoPIC")
            || manifest.get("type").and_then(|v| v.as_str()) != Some("aoALB-export")
            || manifest.get("manifestVersion").and_then(|v| v.as_i64()) != Some(1)
        {
            return Err(AppError::invalid("aoPIC連携ファイルの形式に対応していません。"));
        }
        let project = manifest.get("project").cloned().unwrap_or(Value::Null);
        let photos = manifest.get("photos").and_then(|v| v.as_array()).ok_or_else(|| AppError::invalid("aoPIC連携ファイルの写真一覧を読み取れません。"))?;
        for (k, rec) in photos.iter().enumerate() {
            let uid = rec.get("photoUid").and_then(|v| v.as_str()).unwrap_or("");
            let fp = rec.get("filePath").and_then(|v| v.as_str()).unwrap_or("");
            let label = format!("写真{}", k + 1);
            if !util::is_uuid(uid) || fp != format!("photos/{uid}.jpg") {
                unsupported.push(format!("{label}（写真情報が不正）"));
                continue;
            }
            let Some(idx) = find(&format!("aoalb-export/{fp}")) else {
                unsupported.push(format!("{label}（写真ファイルがありません）"));
                continue;
            };
            let mut a = rec.clone();
            if let Some(o) = a.as_object_mut() {
                o.remove("filePath");
                o.insert("project".into(), project.clone());
                o.insert("origin".into(), json!("aopic-aoalb-export"));
            }
            out.push(Item::ZipEntry {
                zip: path.into(),
                index: idx,
                name: format!("{}.jpg", uid),
                folder_label: String::new(),
                aopic: Some(a),
                expect_sha: rec.get("sha256").and_then(|v| v.as_str()).map(String::from),
                expect_bytes: rec.get("bytes").and_then(|v| v.as_u64()),
            });
        }
        return Ok(Some(project));
    }
    // aoPIC通常ZIP（photos.json付き）
    let photos_json = match find("photos.json") {
        Some(i) => Some(read_small_json(&mut archive, i)?),
        None => None,
    };
    let aopic_records: Option<Vec<Value>> =
        photos_json.filter(|j| j.get("app").and_then(|v| v.as_str()) == Some("aoPIC")).and_then(|j| j.get("photos").and_then(|v| v.as_array()).cloned());
    for (i, name, is_dir) in &names {
        if *is_dir {
            continue;
        }
        let base = util::display_name(name);
        if base.starts_with('.') || name.starts_with("__MACOSX/") {
            continue;
        }
        if !is_jpeg_name(name) {
            if is_known_unsupported(name) {
                unsupported.push(base);
            }
            continue;
        }
        let folder = name.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default();
        let aopic = aopic_records.as_ref().and_then(|rs| rs.iter().find(|r| r.get("filePath").and_then(|v| v.as_str()) == Some(name.as_str()))).map(|r| {
            let mut a = r.clone();
            if let Some(o) = a.as_object_mut() {
                let cls: serde_json::Map<String, Value> = FIELDS.iter().map(|f| (f.to_string(), o.get(*f).cloned().unwrap_or(json!("")))).collect();
                o.insert("classification".into(), Value::Object(cls));
                o.insert("origin".into(), json!("aopic-zip"));
            }
            a
        });
        out.push(Item::ZipEntry { zip: path.into(), index: *i, name: name.clone(), folder_label: folder, aopic, expect_sha: None, expect_bytes: None });
    }
    Ok(None)
}

fn read_small_json<R: Read + Seek>(archive: &mut zip::ZipArchive<R>, index: usize) -> Result<Value> {
    let e = archive.by_index(index)?;
    if e.size() > 50 * 1024 * 1024 {
        return Err(AppError::invalid("ファイル内の情報が大きすぎます。"));
    }
    let mut s = String::new();
    e.take(50 * 1024 * 1024).read_to_string(&mut s).map_err(|_| AppError::invalid("ファイル内の情報を読み取れません。"))?;
    Ok(serde_json::from_str(s.trim_start_matches('\u{feff}'))?)
}

fn source_label(src: &ImportSource) -> (&'static str, String) {
    match src {
        ImportSource::Files { paths } => ("files", format!("{}ファイル", paths.len())),
        ImportSource::Folder { path } => ("folder", util::display_name(&path.to_string_lossy())),
        ImportSource::Zip { path } => ("zip", util::display_name(&path.to_string_lossy())),
    }
}

pub fn import(project: &mut Project, src: &ImportSource, opts: ImportOptions, cancel: &Cancel, progress: ProgressFn) -> Result<ImportResult> {
    let mut items = Vec::new();
    let mut unsupported = Vec::new();
    let mut aopic_project = None;
    progress(Progress { phase: "scan", current: 0, total: 0, message: "取り込む写真を確認しています".into() });
    match src {
        ImportSource::Files { paths } => {
            for p in paths {
                let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                if name.to_ascii_lowercase().ends_with(".zip") {
                    aopic_project = collect_zip(p, &mut items, &mut unsupported)?.or(aopic_project);
                } else if is_known_unsupported(&name) {
                    unsupported.push(name);
                } else {
                    let label = p.parent().and_then(|d| d.file_name()).map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                    items.push(Item::File { path: p.clone(), folder_label: label });
                }
            }
        }
        ImportSource::Folder { path } => collect_folder(path, path, &mut items, &mut unsupported, 0)?,
        ImportSource::Zip { path } => aopic_project = collect_zip(path, &mut items, &mut unsupported)?,
    }
    let needed: u64 = items
        .iter()
        .map(|i| match i {
            Item::File { path, .. } => fs::metadata(path).map(|m| m.len()).unwrap_or(0),
            Item::ZipEntry { expect_bytes, .. } => expect_bytes.unwrap_or(0),
        })
        .sum();
    util::ensure_space(&project.root, needed)?;
    let batch = util::new_uuid();
    let (kind, label) = source_label(src);
    let kind = if aopic_project.is_some() { "aopic_zip" } else { kind };
    project.conn.execute(
        "insert into import_batches(uuid, source_kind, source_label, started_at, total) values(?1, ?2, ?3, ?4, ?5)",
        params![batch, kind, label, now(), (items.len() + unsupported.len()) as i64],
    )?;
    let mut imp = Importer { project, batch: batch.clone(), opts, result: ImportResult { batch_uuid: batch.clone(), aopic_project, ..Default::default() } };
    imp.result.total = (items.len() + unsupported.len()) as u64;
    for name in &unsupported {
        let item = Item::File { path: PathBuf::from(name), folder_label: String::new() };
        imp.fail(&item, "対応していない形式です（JPEGのみ取り込めます）。", "unsupported")?;
    }
    let total = items.len() as u64;
    for (i, item) in items.iter().enumerate() {
        if cancel.is_cancelled() {
            imp.result.cancelled = true;
            break;
        }
        progress(Progress { phase: "import", current: i as u64, total, message: format!("写真を取り込んでいます {}/{}", i + 1, total) });
        match imp.import_item(item, cancel) {
            Ok(()) => {}
            Err(e) if e.kind == ErrorKind::Cancelled => {
                imp.result.cancelled = true;
                break;
            }
            Err(e) if e.kind == ErrorKind::DiskFull => {
                imp.fail(item, &e.message, "io")?;
                imp.result.cancelled = true;
                break;
            }
            Err(e) => {
                let kind = match e.kind {
                    ErrorKind::NeedsConfirmation => "duplicate",
                    ErrorKind::Invalid => "invalid",
                    _ => "io",
                };
                imp.fail(item, &e.message, kind)?;
            }
        }
    }
    progress(Progress { phase: "import", current: total, total, message: "取込みが終わりました".into() });
    let r = &imp.result;
    imp.project.conn.execute(
        "update import_batches set finished_at = ?2, accepted = ?3, duplicates = ?4, failed = ?5, state = ?6 where uuid = ?1",
        params![batch, now(), r.accepted as i64, r.duplicates as i64, r.failed as i64, if r.cancelled { "cancelled" } else { "done" }],
    )?;
    Ok(imp.result)
}

/// 失敗した写真だけを再試行する。`allow_duplicates` で重複も取り込む。
pub fn retry_failures(project: &mut Project, failure_ids: &[i64], opts: ImportOptions, cancel: &Cancel, progress: ProgressFn) -> Result<ImportResult> {
    let mut paths = Vec::new();
    let mut zips: Vec<(PathBuf, Vec<String>)> = Vec::new();
    for id in failure_ids {
        let row: Option<(Option<String>, String)> = project
            .conn
            .query_row("select source_path, kind from import_failures where id = ?1 and resolved = 0", [id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        let Some((Some(sp), kind)) = row else { continue };
        if kind == "unsupported" {
            continue;
        }
        if let Some((zip, name)) = sp.split_once("::") {
            match zips.iter_mut().find(|(z, _)| z == Path::new(zip)) {
                Some((_, v)) => v.push(name.into()),
                None => zips.push((zip.into(), vec![name.into()])),
            }
        } else {
            paths.push(PathBuf::from(sp));
        }
        project.conn.execute("update import_failures set resolved = 1 where id = ?1", [id])?;
    }
    let mut result = import(project, &ImportSource::Files { paths }, opts.clone(), cancel, progress)?;
    for (zip, names) in zips {
        let mut items = Vec::new();
        let mut unsupported = Vec::new();
        collect_zip(&zip, &mut items, &mut unsupported)?;
        items.retain(|i| matches!(i, Item::ZipEntry { name, .. } if names.contains(name) || names.iter().any(|n| n.ends_with(&format!("/{name}")))));
        let mut imp = Importer { project, batch: result.batch_uuid.clone(), opts: opts.clone(), result: ImportResult::default() };
        for item in &items {
            if let Err(e) = imp.import_item(item, cancel) {
                if e.kind == ErrorKind::Cancelled {
                    break;
                }
                let kind = if e.kind == ErrorKind::NeedsConfirmation { "duplicate" } else { "invalid" };
                imp.fail(item, &e.message, kind)?;
            }
        }
        result.accepted += imp.result.accepted;
        result.duplicates += imp.result.duplicates;
        result.failed += imp.result.failed;
        result.photo_uuids.extend(imp.result.photo_uuids);
        result.failures.extend(imp.result.failures);
    }
    Ok(result)
}

pub fn list_failures(conn: &Connection, batch: Option<&str>) -> Result<Vec<ImportFailure>> {
    let mut stmt =
        conn.prepare("select id, source_name, reason, kind from import_failures where resolved = 0 and (?1 is null or batch_uuid = ?1) order by id")?;
    let rows = stmt.query_map([batch], |r| Ok(ImportFailure { id: r.get(0)?, source_name: r.get(1)?, reason: r.get(2)?, kind: r.get(3)? }))?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

// ---------------------------------------------------------------- サムネイル

/// 原寸を縮小デコード（DCTスケーリング）して長辺480pxのサムネイルを作る。原寸は読むだけ。
pub fn make_thumbnail(original: &Path, orientation: u32, dest: &Path) -> Result<(u32, u32)> {
    let mut d = jpeg_decoder::Decoder::new(BufReader::new(File::open(original)?));
    d.read_info().map_err(|e| AppError::invalid("写真を読み取れません。").with_detail(e.to_string()))?;
    let info = d.info().ok_or_else(|| AppError::invalid("写真を読み取れません。"))?;
    let (w, h) = (info.width as u32, info.height as u32);
    let scale = (THUMB_SIZE as f64 / w.max(h) as f64).min(1.0);
    let (rw, rh) = (((w as f64 * scale).round() as u16).max(1), ((h as f64 * scale).round() as u16).max(1));
    let (sw, sh) = d.scale(rw, rh).map_err(|e| AppError::invalid("写真を読み取れません。").with_detail(e.to_string()))?;
    let pixels = d.decode().map_err(|e| AppError::invalid("写真を読み取れません（壊れている可能性があります）。").with_detail(e.to_string()))?;
    let fmt = d.info().map(|i| i.pixel_format).unwrap_or(jpeg_decoder::PixelFormat::RGB24);
    let (sw, sh) = (sw as u32, sh as u32);
    let rgb: Vec<u8> = match fmt {
        jpeg_decoder::PixelFormat::RGB24 => pixels,
        jpeg_decoder::PixelFormat::L8 => pixels.iter().flat_map(|&v| [v, v, v]).collect(),
        jpeg_decoder::PixelFormat::L16 => pixels
            .chunks(2)
            .flat_map(|c| {
                let v = c[0];
                [v, v, v]
            })
            .collect(),
        jpeg_decoder::PixelFormat::CMYK32 => pixels
            .chunks(4)
            .flat_map(|c| {
                let k = c[3] as u32;
                [(c[0] as u32 * k / 255) as u8, (c[1] as u32 * k / 255) as u8, (c[2] as u32 * k / 255) as u8]
            })
            .collect(),
    };
    let img = image::RgbImage::from_raw(sw, sh, rgb).ok_or_else(|| AppError::internal("thumb buffer"))?;
    let (tw, th) = if sw.max(sh) > THUMB_SIZE {
        let s = THUMB_SIZE as f64 / sw.max(sh) as f64;
        (((sw as f64 * s).round() as u32).max(1), ((sh as f64 * s).round() as u32).max(1))
    } else {
        (sw, sh)
    };
    let img = if (tw, th) != (sw, sh) { image::imageops::thumbnail(&img, tw, th) } else { img };
    use image::imageops::{flip_horizontal, flip_vertical, rotate90, rotate180, rotate270};
    let img = match orientation {
        2 => flip_horizontal(&img),
        3 => rotate180(&img),
        4 => flip_vertical(&img),
        5 => flip_horizontal(&rotate90(&img)),
        6 => rotate90(&img),
        7 => flip_horizontal(&rotate270(&img)),
        8 => rotate270(&img),
        _ => img,
    };
    let mut buf = Vec::with_capacity(64 * 1024);
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 80).encode_image(&img).map_err(|e| AppError::internal(e.to_string()))?;
    util::write_atomic(dest, &buf)?;
    Ok((img.width(), img.height()))
}

/// 未作成のサムネイルを最大 `limit` 枚作る（バックグラウンドスレッドから別接続で呼ぶ想定）。
pub fn process_pending_thumbnails(conn: &Connection, root: &Path, limit: usize, cancel: &Cancel) -> Result<usize> {
    let mut stmt = conn.prepare("select uuid, orientation from photos where thumb_state = 'pending' and deleted_at is null order by photo_number limit ?1")?;
    let todo: Vec<(String, u32)> = stmt.query_map([limit as i64], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<std::result::Result<_, _>>()?;
    drop(stmt);
    let mut done = 0;
    for (uuid, orientation) in todo {
        if cancel.is_cancelled() {
            break;
        }
        let orig = root.join("originals").join(format!("{uuid}.jpg"));
        let dest = root.join("thumbnails").join(format!("{uuid}.jpg"));
        let state = match make_thumbnail(&orig, orientation, &dest) {
            Ok(_) => "ready",
            Err(_) => "failed",
        };
        conn.execute("update photos set thumb_state = ?2 where uuid = ?1", params![uuid, state])?;
        done += 1;
    }
    Ok(done)
}

/// サムネイルを消してしまった場合などに全て作り直す
pub fn reset_thumbnails(conn: &Connection, root: &Path) -> Result<usize> {
    let mut n = 0;
    let mut stmt = conn.prepare("select uuid from photos where deleted_at is null")?;
    let ids: Vec<String> = stmt.query_map([], |r| r.get(0))?.collect::<std::result::Result<_, _>>()?;
    for id in ids {
        if !root.join("thumbnails").join(format!("{id}.jpg")).exists() {
            conn.execute("update photos set thumb_state = 'pending' where uuid = ?1", [&id])?;
            n += 1;
        }
    }
    Ok(n)
}

// ---------------------------------------------------------------- 一覧

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Classification {
    pub koushu: String,
    pub shubetsu: String,
    pub saibetsu: String,
    pub sokuten: String,
    pub tekiyo: String,
}
impl Classification {
    pub fn get(&self, f: &str) -> &str {
        match f {
            "koushu" => &self.koushu,
            "shubetsu" => &self.shubetsu,
            "saibetsu" => &self.saibetsu,
            "sokuten" => &self.sokuten,
            _ => &self.tekiyo,
        }
    }
    pub fn is_empty(&self) -> bool {
        FIELDS.iter().all(|f| self.get(f).is_empty())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoRow {
    pub uuid: String,
    pub photo_uid: Option<String>,
    pub source_kind: String,
    pub photo_number: Option<i64>,
    pub taken_at: Option<String>,
    pub taken_at_source: String,
    pub width: u32,
    pub height: u32,
    pub orientation: u32,
    pub bytes: i64,
    pub original_name: String,
    pub folder_label: String,
    pub classification: Classification,
    pub original: Classification,
    /// 元分類から変更している項目
    pub overridden: Vec<String>,
    pub thumb_state: String,
    pub created_at: String,
    pub deleted_at: Option<String>,
    /// 指定した台帳に配置済みか（一覧の絞込み用）
    pub placed: bool,
    pub ledger_text: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoFilter {
    #[serde(default)]
    pub trashed: bool,
    #[serde(default)]
    pub unclassified_only: bool,
    pub text: Option<String>,
    pub folder_label: Option<String>,
    pub taken_from: Option<String>,
    pub taken_to: Option<String>,
    pub koushu: Option<String>,
    pub shubetsu: Option<String>,
    pub saibetsu: Option<String>,
    /// この台帳への配置状況を付ける
    pub ledger_uuid: Option<String>,
    /// true: 未配置だけ
    #[serde(default)]
    pub unplaced_only: bool,
    pub uuids: Option<Vec<String>>,
}

pub const PHOTO_SELECT: &str = "select p.uuid, p.photo_uid, p.source_kind, p.photo_number, p.taken_at, p.taken_at_source, p.width, p.height, p.orientation, p.bytes,
  p.original_name, p.folder_label,
  coalesce(o.koushu, p.orig_koushu), coalesce(o.shubetsu, p.orig_shubetsu), coalesce(o.saibetsu, p.orig_saibetsu), coalesce(o.sokuten, p.orig_sokuten), coalesce(o.tekiyo, p.orig_tekiyo),
  p.orig_koushu, p.orig_shubetsu, p.orig_saibetsu, p.orig_sokuten, p.orig_tekiyo,
  o.koushu is not null, o.shubetsu is not null, o.saibetsu is not null, o.sokuten is not null, o.tekiyo is not null,
  p.thumb_state, p.created_at, p.deleted_at, s.uuid is not null, p.aopic_json
from photos p left join photo_overrides o on o.photo_uuid = p.uuid
left join ledger_slots s on s.photo_uuid = p.uuid and s.ledger_uuid = ?1";

pub fn map_row(r: &rusqlite::Row) -> rusqlite::Result<PhotoRow> {
    let c = |i| -> rusqlite::Result<Classification> {
        Ok(Classification { koushu: r.get(i)?, shubetsu: r.get(i + 1)?, saibetsu: r.get(i + 2)?, sokuten: r.get(i + 3)?, tekiyo: r.get(i + 4)? })
    };
    let mut overridden = Vec::new();
    for (k, f) in FIELDS.iter().enumerate() {
        if r.get::<_, bool>(22 + k)? {
            overridden.push(f.to_string());
        }
    }
    let aopic: Option<String> = r.get(31)?;
    let classification = c(12)?;
    Ok(PhotoRow {
        uuid: r.get(0)?,
        photo_uid: r.get(1)?,
        source_kind: r.get(2)?,
        photo_number: r.get(3)?,
        taken_at: r.get(4)?,
        taken_at_source: r.get(5)?,
        width: r.get(6)?,
        height: r.get(7)?,
        orientation: r.get(8)?,
        bytes: r.get(9)?,
        original_name: r.get(10)?,
        folder_label: r.get(11)?,
        ledger_text: auto_ledger_text(aopic.as_deref(), &classification),
        classification,
        original: c(17)?,
        overridden,
        thumb_state: r.get(27)?,
        created_at: r.get(28)?,
        deleted_at: r.get(29)?,
        placed: r.get(30)?,
    })
}

/// 台帳文の自動値：aoPICの台帳タイトル→台帳説明→摘要
pub fn auto_ledger_text(aopic_json: Option<&str>, c: &Classification) -> String {
    if let Some(v) = aopic_json.and_then(|s| serde_json::from_str::<Value>(s).ok()) {
        for k in ["title", "description"] {
            if let Some(t) = v.get("ledger").and_then(|l| l.get(k)).and_then(|t| t.as_str()).map(str::trim).filter(|t| !t.is_empty()) {
                return t.to_string();
            }
        }
    }
    c.tekiyo.clone()
}

pub fn list_photos(conn: &Connection, f: &PhotoFilter) -> Result<Vec<PhotoRow>> {
    let mut sql = format!("{PHOTO_SELECT} where 1=1");
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(f.ledger_uuid.clone())];
    fn add(args: &mut Vec<Box<dyn rusqlite::ToSql>>, sql: &mut String, cond: &str, v: Box<dyn rusqlite::ToSql>) {
        args.push(v);
        sql.push_str(&cond.replace('?', &format!("?{}", args.len())));
    }
    sql.push_str(if f.trashed { " and p.deleted_at is not null" } else { " and p.deleted_at is null" });
    if f.unclassified_only {
        sql.push_str(" and coalesce(o.koushu, p.orig_koushu) = '' and coalesce(o.shubetsu, p.orig_shubetsu) = '' and coalesce(o.saibetsu, p.orig_saibetsu) = '' and coalesce(o.sokuten, p.orig_sokuten) = '' and coalesce(o.tekiyo, p.orig_tekiyo) = ''");
    }
    if f.unplaced_only && f.ledger_uuid.is_some() {
        sql.push_str(" and s.uuid is null");
    }
    if let Some(t) = f.text.as_ref().map(|t| t.trim()).filter(|t| !t.is_empty()) {
        let like = format!("%{}%", t.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
        let cols = [
            "p.original_name",
            "p.folder_label",
            "coalesce(o.koushu, p.orig_koushu)",
            "coalesce(o.shubetsu, p.orig_shubetsu)",
            "coalesce(o.saibetsu, p.orig_saibetsu)",
            "coalesce(o.sokuten, p.orig_sokuten)",
            "coalesce(o.tekiyo, p.orig_tekiyo)",
        ];
        let cond = format!(" and ({})", cols.iter().map(|c| format!("{c} like ? escape '\\'")).collect::<Vec<_>>().join(" or "));
        add(&mut args, &mut sql, &cond, Box::new(like));
    }
    if let Some(v) = &f.folder_label {
        add(&mut args, &mut sql, " and p.folder_label = ?", Box::new(v.clone()));
    }
    if let Some(v) = &f.taken_from {
        add(&mut args, &mut sql, " and p.taken_at >= ?", Box::new(v.clone()));
    }
    if let Some(v) = &f.taken_to {
        add(&mut args, &mut sql, " and p.taken_at < ?", Box::new(v.clone()));
    }
    if let Some(v) = &f.koushu {
        add(&mut args, &mut sql, " and coalesce(o.koushu, p.orig_koushu) = ?", Box::new(v.clone()));
    }
    if let Some(v) = &f.shubetsu {
        add(&mut args, &mut sql, " and coalesce(o.shubetsu, p.orig_shubetsu) = ?", Box::new(v.clone()));
    }
    if let Some(v) = &f.saibetsu {
        add(&mut args, &mut sql, " and coalesce(o.saibetsu, p.orig_saibetsu) = ?", Box::new(v.clone()));
    }
    if let Some(ids) = &f.uuids {
        add(&mut args, &mut sql, " and p.uuid in (select value from json_each(?))", Box::new(serde_json::to_string(ids)?));
    }
    sql.push_str(" order by coalesce(p.taken_at, p.created_at), p.photo_number");
    let mut stmt = conn.prepare(&sql)?;
    let params: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
    let rows = stmt.query_map(params.as_slice(), map_row)?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoDetail {
    pub photo: PhotoRow,
    pub sha256: String,
    pub aopic: Option<Value>,
    pub exif: Option<Value>,
    pub original_path: String,
    pub thumbnail_path: String,
    pub ledgers: Vec<Value>,
}

pub fn photo_detail(project: &Project, uuid: &str) -> Result<PhotoDetail> {
    let conn = &project.conn;
    let photo = conn
        .query_row(&format!("{PHOTO_SELECT} where p.uuid = ?2"), params![Option::<String>::None, uuid], map_row)
        .optional()?
        .ok_or_else(|| AppError::not_found("写真が見つかりません。"))?;
    let (sha256, aopic, exif): (String, Option<String>, Option<String>) =
        conn.query_row("select sha256, aopic_json, exif_json from photos where uuid = ?1", [uuid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
    let mut stmt = conn.prepare(
        "select distinct l.uuid, l.title, l.deleted_at is not null from ledger_slots s join ledgers l on l.uuid = s.ledger_uuid where s.photo_uuid = ?1",
    )?;
    let ledgers = stmt
        .query_map([uuid], |r| Ok(json!({"uuid": r.get::<_, String>(0)?, "title": r.get::<_, String>(1)?, "trashed": r.get::<_, bool>(2)?})))?
        .collect::<std::result::Result<_, _>>()?;
    Ok(PhotoDetail {
        photo,
        sha256,
        aopic: aopic.and_then(|s| serde_json::from_str(&s).ok()),
        exif: exif.and_then(|s| serde_json::from_str(&s).ok()),
        original_path: project.original_path(uuid).to_string_lossy().into(),
        thumbnail_path: project.thumb_path(uuid).to_string_lossy().into(),
        ledgers,
    })
}

/// 写真をごみ箱へ（原寸は消さない）。台帳に配置中の写真は先に外してもらう。
pub fn trash_photos(project: &mut Project, uuids: &[String]) -> Result<usize> {
    let tx = project.conn.transaction()?;
    let ids = serde_json::to_string(uuids)?;
    let placed: i64 = tx.query_row("select count(*) from ledger_slots s join ledgers l on l.uuid = s.ledger_uuid where l.deleted_at is null and s.photo_uuid in (select value from json_each(?1))", [&ids], |r| r.get(0))?;
    if placed > 0 {
        return Err(AppError::invalid(format!("台帳に配置されている写真が{placed}枚あります。先に台帳から外してください。")));
    }
    let n = tx.execute(
        "update photos set deleted_at = ?2, updated_at = ?2, revision = revision + 1 where deleted_at is null and uuid in (select value from json_each(?1))",
        params![ids, now()],
    )?;
    Project::touch(&tx, &project.device_id)?;
    tx.commit()?;
    Ok(n)
}

pub fn restore_photos(project: &mut Project, uuids: &[String]) -> Result<usize> {
    let tx = project.conn.transaction()?;
    let n = tx.execute("update photos set deleted_at = null, updated_at = ?2, revision = revision + 1 where deleted_at is not null and uuid in (select value from json_each(?1))", params![serde_json::to_string(uuids)?, now()])?;
    Project::touch(&tx, &project.device_id)?;
    tx.commit()?;
    Ok(n)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderCount {
    pub folder_label: String,
    pub count: i64,
}

pub fn folder_labels(conn: &Connection) -> Result<Vec<FolderCount>> {
    let mut stmt = conn.prepare("select folder_label, count(*) from photos where deleted_at is null group by folder_label order by folder_label")?;
    let rows = stmt.query_map([], |r| Ok(FolderCount { folder_label: r.get(0)?, count: r.get(1)? }))?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}
