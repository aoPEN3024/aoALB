//! 別端末への引継ぎファイル（.aoalb）の書出し・取込み。
//!
//! 形式：ZIP（必要に応じてZIP64）。SQLiteファイルは入れず、バージョン付きJSON＋原寸JPEGで構成する。
//! ```text
//! manifest.json          形式名・formatVersion・工事UUID・世代番号・各ファイルのbytes/SHA-256
//! data/project.json      工事情報
//! data/photos.json       写真情報（元分類・上書き・aoPIC元情報・EXIF要約）
//! data/ledgers.json      台帳・ページ・枠・文言
//! data/templates.json    分類テンプレート
//! originals/{uuid}.jpg   原寸JPEG（無圧縮で格納、再圧縮しない）
//! ```
//! 取込みは一時フォルダで全件検証してから確定する。途中で失敗しても既存の工事は変更しない。

use crate::db;
use crate::error::{AppError, ErrorKind, Result};
use crate::project::{self, APP_VERSION, DB_FILE, MARKER_FILE, Project};
use crate::util::{self, Cancel, Progress, ProgressFn, now};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Seek, Write};
use std::path::{Path, PathBuf};
use zip::CompressionMethod;
use zip::write::SimpleFileOptions;

pub const FORMAT: &str = "aoALB2-exchange";
pub const FORMAT_VERSION: u32 = 1;
pub const EXTENSION: &str = "aoalb";
// ---- 取込み時の上限（根拠は docs/design.md「引継ぎファイルの上限」）
/// 1工事の写真の上限。現場の想定（数千枚）の10倍以上の余裕
pub const MAX_PHOTOS: usize = 50_000;
/// ZIP内の項目数の上限（写真＋manifest＋data 4つ）
pub const MAX_ENTRIES: usize = MAX_PHOTOS + 5;
/// manifest.json の上限（5万件×約200バイト＝約10MB に余裕を持たせる）
pub const MAX_MANIFEST: u64 = 64 * 1024 * 1024;
/// data/*.json 1つの上限（写真5万件の photos.json は約100〜150MB。取込み時に全体をメモリへ読むため上限を設ける）
pub const MAX_JSON: u64 = 256 * 1024 * 1024;
/// 展開後の総容量の上限（1TiB。5万枚×平均20MB）
pub const MAX_TOTAL_BYTES: u64 = 1 << 40;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format: String,
    pub format_version: u32,
    pub app_version: String,
    pub export_id: String,
    pub exported_at: String,
    pub project_uuid: String,
    pub project_name: String,
    pub generation: i64,
    pub edit_seq: i64,
    pub last_device_id: String,
    pub export_device_id: String,
    pub counts: Value,
    pub total_bytes: u64,
    pub files: Vec<FileEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPlan {
    pub photos: i64,
    pub ledgers: i64,
    pub total_bytes: u64,
    pub free_bytes: Option<u64>,
    pub suggested_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub path: String,
    pub bytes: u64,
    pub photos: usize,
    pub generation: i64,
    pub verified: bool,
}

// ------------------------------------------------------------------ 書出し

pub fn plan_export(project: &Project, dest_dir: &Path) -> Result<ExportPlan> {
    let (photos, bytes): (i64, i64) = project.conn.query_row("select count(*), coalesce(sum(bytes), 0) from photos", [], |r| Ok((r.get(0)?, r.get(1)?)))?;
    let ledgers: i64 = project.conn.query_row("select count(*) from ledgers where deleted_at is null", [], |r| r.get(0))?;
    let info = project.info()?;
    let name = util::safe_name(&info.name, "工事");
    Ok(ExportPlan {
        photos,
        ledgers,
        total_bytes: bytes as u64 + 1024 * 1024,
        free_bytes: util::available_space(dest_dir),
        suggested_name: format!("{}_{}.{EXTENSION}", name, chrono::Local::now().format("%Y%m%d")),
    })
}

/// 書き出す内容：工事・写真・台帳・分類テンプレート
type ExchangeData = (Value, Vec<Value>, Vec<Value>, Vec<Value>);

fn data_json(conn: &Connection) -> Result<ExchangeData> {
    let project = conn.query_row("select uuid, name, kouji_code, contractor, created_at, updated_at, revision from project", [], |r| {
        Ok(json!({
            "uuid": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "koujiCode": r.get::<_, String>(2)?, "contractor": r.get::<_, String>(3)?,
            "createdAt": r.get::<_, String>(4)?, "updatedAt": r.get::<_, String>(5)?, "revision": r.get::<_, i64>(6)?,
        }))
    })?;
    let mut stmt = conn.prepare("select p.uuid, p.photo_uid, p.source_kind, p.sha256, p.bytes, p.width, p.height, p.orientation, p.components, p.adobe_cmyk, p.taken_at, p.taken_at_source,
        p.original_name, p.folder_label, p.photo_number, p.orig_koushu, p.orig_shubetsu, p.orig_saibetsu, p.orig_sokuten, p.orig_tekiyo, p.aopic_json, p.exif_json,
        p.created_at, p.updated_at, p.revision, p.deleted_at, o.photo_uuid is not null, o.koushu, o.shubetsu, o.saibetsu, o.sokuten, o.tekiyo, o.updated_at, o.revision
        from photos p left join photo_overrides o on o.photo_uuid = p.uuid order by p.photo_number")?;
    let photos = stmt.query_map([], |r| {
        let parse = |s: Option<String>| s.and_then(|s| serde_json::from_str::<Value>(&s).ok()).unwrap_or(Value::Null);
        Ok(json!({
            "uuid": r.get::<_, String>(0)?, "photoUid": r.get::<_, Option<String>>(1)?, "sourceKind": r.get::<_, String>(2)?, "sha256": r.get::<_, String>(3)?,
            "bytes": r.get::<_, i64>(4)?, "width": r.get::<_, i64>(5)?, "height": r.get::<_, i64>(6)?, "orientation": r.get::<_, i64>(7)?,
            "components": r.get::<_, i64>(8)?, "adobeCmyk": r.get::<_, bool>(9)?, "takenAt": r.get::<_, Option<String>>(10)?, "takenAtSource": r.get::<_, String>(11)?,
            "originalName": r.get::<_, String>(12)?, "folderLabel": r.get::<_, String>(13)?, "photoNumber": r.get::<_, Option<i64>>(14)?,
            "original": {"koushu": r.get::<_, String>(15)?, "shubetsu": r.get::<_, String>(16)?, "saibetsu": r.get::<_, String>(17)?, "sokuten": r.get::<_, String>(18)?, "tekiyo": r.get::<_, String>(19)?},
            "aopic": parse(r.get(20)?), "exif": parse(r.get(21)?),
            "createdAt": r.get::<_, String>(22)?, "updatedAt": r.get::<_, String>(23)?, "revision": r.get::<_, i64>(24)?, "deletedAt": r.get::<_, Option<String>>(25)?,
            "override": if r.get::<_, bool>(26)? { json!({"koushu": r.get::<_, Option<String>>(27)?, "shubetsu": r.get::<_, Option<String>>(28)?, "saibetsu": r.get::<_, Option<String>>(29)?,
                "sokuten": r.get::<_, Option<String>>(30)?, "tekiyo": r.get::<_, Option<String>>(31)?, "updatedAt": r.get::<_, String>(32)?, "revision": r.get::<_, i64>(33)?}) } else { Value::Null },
            "file": format!("originals/{}.jpg", r.get::<_, String>(0)?),
        }))
    })?.collect::<std::result::Result<Vec<_>, _>>()?;
    let mut ledgers = Vec::new();
    let mut lstmt = conn.prepare(
        "select uuid, title, template, show_cover, cover_json, view_mode, created_at, updated_at, revision, deleted_at from ledgers order by created_at",
    )?;
    let ls: Vec<(String, Value)> = lstmt.query_map([], |r| Ok((r.get::<_, String>(0)?, json!({
        "uuid": r.get::<_, String>(0)?, "title": r.get::<_, String>(1)?, "template": r.get::<_, String>(2)?, "showCover": r.get::<_, bool>(3)?,
        "cover": serde_json::from_str::<Value>(&r.get::<_, String>(4)?).unwrap_or(json!({})), "viewMode": r.get::<_, String>(5)?,
        "createdAt": r.get::<_, String>(6)?, "updatedAt": r.get::<_, String>(7)?, "revision": r.get::<_, i64>(8)?, "deletedAt": r.get::<_, Option<String>>(9)?,
    }))))?.collect::<std::result::Result<_, _>>()?;
    for (uuid, mut l) in ls {
        let mut pstmt = conn
            .prepare("select uuid, position, kind, created_at, updated_at, revision, deleted_at from ledger_pages where ledger_uuid = ?1 order by position")?;
        let pages: Vec<Value> = pstmt.query_map([&uuid], |r| Ok(json!({"uuid": r.get::<_, String>(0)?, "position": r.get::<_, f64>(1)?, "kind": r.get::<_, String>(2)?,
            "createdAt": r.get::<_, String>(3)?, "updatedAt": r.get::<_, String>(4)?, "revision": r.get::<_, i64>(5)?, "deletedAt": r.get::<_, Option<String>>(6)?})))?
            .collect::<std::result::Result<_, _>>()?;
        let mut pages_out = Vec::new();
        for mut p in pages {
            let pu = p["uuid"].as_str().unwrap_or("").to_string();
            let mut sstmt =
                conn.prepare("select uuid, slot_index, kind, photo_uuid, updated_at, revision from ledger_slots where page_uuid = ?1 order by slot_index")?;
            let slots: Vec<Value> = sstmt
                .query_map([&pu], |r| {
                    Ok(json!({"uuid": r.get::<_, String>(0)?, "index": r.get::<_, i64>(1)?, "kind": r.get::<_, String>(2)?,
                "photoUuid": r.get::<_, Option<String>>(3)?, "updatedAt": r.get::<_, String>(4)?, "revision": r.get::<_, i64>(5)?}))
                })?
                .collect::<std::result::Result<_, _>>()?;
            p["slots"] = Value::Array(slots);
            pages_out.push(p);
        }
        let mut cstmt = conn.prepare("select photo_uuid, koushu, sokuten, body, updated_at, revision from ledger_captions where ledger_uuid = ?1")?;
        let caps: Vec<Value> = cstmt
            .query_map([&uuid], |r| {
                Ok(json!({"photoUuid": r.get::<_, String>(0)?, "koushu": r.get::<_, Option<String>>(1)?, "sokuten": r.get::<_, Option<String>>(2)?,
            "body": r.get::<_, Option<String>>(3)?, "updatedAt": r.get::<_, String>(4)?, "revision": r.get::<_, i64>(5)?}))
            })?
            .collect::<std::result::Result<_, _>>()?;
        l["pages"] = Value::Array(pages_out);
        l["captions"] = Value::Array(caps);
        ledgers.push(l);
    }
    let mut tstmt = conn.prepare("select uuid, name, values_json, created_at, updated_at, revision, deleted_at from classification_templates")?;
    let templates = tstmt.query_map([], |r| Ok(json!({"uuid": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?,
        "values": serde_json::from_str::<Value>(&r.get::<_, String>(2)?).unwrap_or(json!({})), "createdAt": r.get::<_, String>(3)?, "updatedAt": r.get::<_, String>(4)?,
        "revision": r.get::<_, i64>(5)?, "deletedAt": r.get::<_, Option<String>>(6)?})))?.collect::<std::result::Result<_, _>>()?;
    Ok((project, photos, ledgers, templates))
}

/// ハッシュを計算しながらZIPへ書くWriter
struct HashWriter<'a, W: Write> {
    inner: &'a mut W,
    hasher: sha2::Sha256,
    n: u64,
}
impl<W: Write> Write for HashWriter<'_, W> {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        use sha2::Digest;
        let n = self.inner.write(b)?;
        self.hasher.update(&b[..n]);
        self.n += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

pub fn export(project: &mut Project, dest: &Path, cancel: &Cancel, progress: ProgressFn) -> Result<ExportReport> {
    let parent = dest.parent().ok_or_else(|| AppError::invalid("保存先が正しくありません。"))?;
    fs::create_dir_all(parent)?;
    let plan = plan_export(project, parent)?;
    util::ensure_space(parent, plan.total_bytes)?;
    // 書出し時点を世代として確定（この端末はこの世代と同期済み）
    let generation = db::meta_i64(&project.conn, "generation")? + 1;
    let edit_seq = db::meta_i64(&project.conn, "edit_seq")?;
    let (proj, photos, ledgers, templates) = data_json(&project.conn)?;
    let tmp = util::tmp_sibling(dest);
    let result = (|| -> Result<ExportReport> {
        let mut zip = zip::ZipWriter::new(BufWriter::with_capacity(1 << 20, File::create(&tmp)?));
        let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored).large_file(true);
        let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated).large_file(true);
        let mut files = Vec::new();
        let put_json = |zip: &mut zip::ZipWriter<BufWriter<File>>, path: &str, v: &Value, files: &mut Vec<FileEntry>| -> Result<()> {
            let bytes = serde_json::to_vec_pretty(v)?;
            zip.start_file(path, deflated)?;
            zip.write_all(&bytes)?;
            use sha2::Digest;
            files.push(FileEntry { path: path.into(), bytes: bytes.len() as u64, sha256: hex::encode(sha2::Sha256::digest(&bytes)) });
            Ok(())
        };
        put_json(&mut zip, "data/project.json", &proj, &mut files)?;
        put_json(&mut zip, "data/photos.json", &Value::Array(photos.clone()), &mut files)?;
        put_json(&mut zip, "data/ledgers.json", &Value::Array(ledgers.clone()), &mut files)?;
        put_json(&mut zip, "data/templates.json", &Value::Array(templates), &mut files)?;
        let total = photos.len() as u64;
        for (i, p) in photos.iter().enumerate() {
            cancel.check()?;
            if i % 10 == 0 {
                progress(Progress { phase: "export", current: i as u64, total, message: format!("写真を書き出しています {}/{}", i + 1, total) });
            }
            let uuid = p["uuid"].as_str().unwrap_or_default();
            let path = format!("originals/{uuid}.jpg");
            zip.start_file(&path, stored)?;
            let mut hw = HashWriter { inner: &mut zip, hasher: <sha2::Sha256 as sha2::Digest>::new(), n: 0 };
            std::io::copy(
                &mut BufReader::new(
                    File::open(project.original_path(uuid)).map_err(|_| AppError::corrupt("原寸写真が見つかりません。工事フォルダを確認してください。"))?,
                ),
                &mut hw,
            )?;
            let sha = hex::encode(sha2::Digest::finalize(hw.hasher));
            if sha != p["sha256"].as_str().unwrap_or("") {
                return Err(AppError::corrupt("原寸写真の内容が取込み時と一致しません。工事フォルダを確認してください。"));
            }
            files.push(FileEntry { path, bytes: hw.n, sha256: sha });
        }
        let pages: usize = ledgers.iter().map(|l| l["pages"].as_array().map(|a| a.len()).unwrap_or(0)).sum();
        let manifest = Manifest {
            format: FORMAT.into(),
            format_version: FORMAT_VERSION,
            app_version: APP_VERSION.into(),
            export_id: util::new_uuid(),
            exported_at: now(),
            project_uuid: project.uuid.clone(),
            project_name: proj["name"].as_str().unwrap_or("").into(),
            generation,
            edit_seq,
            last_device_id: db::get_meta(&project.conn, "last_device_id")?.unwrap_or_default(),
            export_device_id: project.device_id.clone(),
            counts: json!({"photos": photos.len(), "ledgers": ledgers.len(), "pages": pages}),
            total_bytes: files.iter().try_fold(0u64, |a, f| a.checked_add(f.bytes)).ok_or_else(|| AppError::internal("total overflow"))?,
            files,
        };
        zip.start_file("manifest.json", deflated)?;
        zip.write_all(&serde_json::to_vec_pretty(&manifest)?)?;
        let w = zip.finish()?;
        let f = w.into_inner().map_err(|e| AppError::from(e.into_error()))?;
        f.sync_all()?;
        drop(f);
        progress(Progress { phase: "verify", current: 0, total, message: "書き出したファイルを確認しています".into() });
        let checked = inspect(&tmp, cancel, true)?;
        if checked.manifest.files.len() != manifest.files.len() {
            return Err(AppError::internal("verify mismatch"));
        }
        Ok(ExportReport { path: dest.to_string_lossy().into(), bytes: 0, photos: photos.len(), generation, verified: true })
    })();
    match result {
        Ok(mut r) => {
            fs::rename(&tmp, dest)?;
            r.bytes = fs::metadata(dest)?.len();
            db::set_meta(&project.conn, "generation", &generation.to_string())?;
            db::set_meta(&project.conn, "sync_generation", &generation.to_string())?;
            db::set_meta(&project.conn, "sync_edit_seq", &edit_seq.to_string())?;
            Ok(r)
        }
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

// ------------------------------------------------------------------ 検査

#[derive(Debug, Clone)]
pub struct Inspected {
    pub manifest: Manifest,
    /// 全ファイルの容量を足し直した値（申告値と一致済み）。空き容量の判定にはこちらを使う
    pub verified_total: u64,
    index: HashMap<String, usize>,
}

fn allowed_path(p: &str) -> bool {
    if matches!(p, "manifest.json" | "data/project.json" | "data/photos.json" | "data/ledgers.json" | "data/templates.json") {
        return true;
    }
    p.strip_prefix("originals/").and_then(|r| r.strip_suffix(".jpg")).map(util::is_uuid).unwrap_or(false)
}

/// manifest の容量を検証する。申告値（totalBytes）を信用せず全ファイルの容量を足し直し、
/// 桁あふれ・申告との不一致・ファイル数・JSON/JPEG 1つの容量・総容量の上限を確認する。戻り値は足し直した総容量。
pub fn verify_manifest_sizes(manifest: &Manifest) -> Result<u64> {
    let bad = || AppError::invalid("引継ぎファイルが壊れているか、対応していない形式です。");
    if manifest.files.len() > MAX_ENTRIES - 1 {
        return Err(bad().with_detail("too many files"));
    }
    let photo_files = manifest.files.iter().filter(|f| f.path.starts_with("originals/")).count();
    if photo_files > MAX_PHOTOS {
        return Err(AppError::invalid(format!("写真が多すぎます（{MAX_PHOTOS}枚まで）。")));
    }
    let mut total: u64 = 0;
    for f in &manifest.files {
        total = total.checked_add(f.bytes).ok_or_else(|| bad().with_detail("total overflow"))?;
    }
    if total != manifest.total_bytes {
        return Err(bad().with_detail(format!("total mismatch declared={} actual={total}", manifest.total_bytes)));
    }
    for f in &manifest.files {
        if f.path.ends_with(".json") && f.bytes > MAX_JSON {
            return Err(bad().with_detail(format!("json too large {}", f.path)));
        }
        if f.path.ends_with(".jpg") && f.bytes > crate::photos::MAX_JPEG_BYTES {
            return Err(bad().with_detail(format!("jpeg too large {}", f.path)));
        }
    }
    if total > MAX_TOTAL_BYTES {
        return Err(AppError::invalid("引継ぎファイルが大きすぎます（展開後1TBまで）。").with_detail("total too large"));
    }
    Ok(total)
}

/// 引継ぎファイルを検証する。`deep` ならすべての項目のSHA-256とJPEG署名まで確認する。
pub fn inspect(path: &Path, cancel: &Cancel, deep: bool) -> Result<Inspected> {
    let bad = || AppError::invalid("引継ぎファイルが壊れているか、対応していない形式です。");
    let mut archive = zip::ZipArchive::new(BufReader::new(File::open(path)?)).map_err(|_| bad())?;
    if archive.len() > MAX_ENTRIES {
        return Err(bad().with_detail("too many entries"));
    }
    let mut index = HashMap::new();
    let mut lower = HashSet::new();
    for i in 0..archive.len() {
        let e = archive.by_index_raw(i)?;
        let name = e.name()?.to_string();
        // パストラバーサル・実行ファイル・HTML等は名前の許可リストで全て拒否する
        if e.is_dir() || !allowed_path(&name) || e.encrypted() {
            return Err(bad().with_detail(format!("unexpected entry {name}")));
        }
        // 同じ名前・大文字小文字だけ違う名前（Windowsでは同じファイルになる）を拒否
        if !lower.insert(name.to_lowercase()) {
            return Err(bad().with_detail("duplicate or case-colliding entry"));
        }
        index.insert(name, i);
    }
    let mi = *index.get("manifest.json").ok_or_else(bad)?;
    let manifest: Manifest = {
        let e = archive.by_index(mi)?;
        if e.size() > MAX_MANIFEST {
            return Err(bad().with_detail("manifest too large"));
        }
        crate::photos::check_entry_ratio(e.size(), e.compressed_size())?;
        let mut s = Vec::new();
        e.take(MAX_MANIFEST + 1).read_to_end(&mut s)?;
        if s.len() as u64 > MAX_MANIFEST {
            return Err(bad().with_detail("manifest too large"));
        }
        let v: Value = serde_json::from_slice(&s).map_err(|_| bad())?;
        if v.get("format").and_then(|f| f.as_str()) != Some(FORMAT) {
            return Err(bad());
        }
        let fv = v.get("formatVersion").and_then(|f| f.as_u64()).unwrap_or(0);
        if fv > FORMAT_VERSION as u64 {
            return Err(AppError::invalid("新しい版のアプリで作成された引継ぎファイルです。アプリを更新してください。"));
        }
        if fv < 1 {
            return Err(bad());
        }
        serde_json::from_value(v).map_err(|_| bad())?
    };
    if !util::is_uuid(&manifest.project_uuid) {
        return Err(bad());
    }
    let total = verify_manifest_sizes(&manifest)?;
    let listed: HashSet<&str> = manifest.files.iter().map(|f| f.path.as_str()).collect();
    if listed.len() != manifest.files.len()
        || listed.len() + 1 != index.len()
        || manifest.files.iter().any(|f| !index.contains_key(&f.path) || f.path == "manifest.json")
    {
        return Err(bad().with_detail("file list mismatch"));
    }
    for f in &manifest.files {
        let i = index[&f.path];
        let e = archive.by_index_raw(i)?;
        // ZIPが申告する展開後容量と manifest の容量の一致、圧縮率の確認（展開前に判定）
        if e.size() != f.bytes {
            return Err(bad().with_detail(format!("size mismatch {}", f.path)));
        }
        crate::photos::check_entry_ratio(e.size(), e.compressed_size())?;
    }
    if deep {
        for f in &manifest.files {
            cancel.check()?;
            let e = archive.by_index(index[&f.path])?;
            let mut head = Vec::new();
            let (sha, n) = util::hash_copy(PeekReader { inner: e.take(f.bytes + 1), head: &mut head }, None::<&mut File>, cancel)?;
            if n != f.bytes || sha != f.sha256 {
                return Err(AppError::invalid("引継ぎファイルの内容が壊れています（確認値が一致しません）。").with_detail(f.path.clone()));
            }
            if f.path.ends_with(".jpg") && !util::looks_like_jpeg(&head) {
                return Err(bad().with_detail("not jpeg"));
            }
        }
    }
    Ok(Inspected { manifest, verified_total: total, index })
}

/// 先頭数バイトを覚えておくReader（JPEG署名の確認用）
struct PeekReader<'a, R: Read> {
    inner: R,
    head: &'a mut Vec<u8>,
}
impl<R: Read> Read for PeekReader<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        if self.head.len() < 4 {
            let take = (4 - self.head.len()).min(n);
            self.head.extend_from_slice(&buf[..take]);
        }
        Ok(n)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub project_uuid: String,
    pub project_name: String,
    pub exported_at: String,
    pub generation: i64,
    pub photos: u64,
    pub ledgers: u64,
    pub total_bytes: u64,
    pub free_bytes: Option<u64>,
    /// 同じ工事がこの端末にある場合
    pub existing: Option<ExistingState>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingState {
    pub root: String,
    pub generation: i64,
    /// この端末に取込ファイルより新しい編集がある
    pub local_newer: bool,
    pub message: Option<String>,
}

pub const NEWER_WARNING: &str = "この端末には、取込ファイルより新しい編集内容があります。取り込むと、この端末の変更が置き換わります。";

fn existing_state(root: &Path, m: &Manifest) -> Result<Option<ExistingState>> {
    let Ok(marker) = project::read_marker(root) else { return Ok(None) };
    if marker.project_uuid != m.project_uuid {
        return Ok(None);
    }
    let conn = Connection::open_with_flags(root.join(DB_FILE), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let g = db::meta_i64(&conn, "generation")?;
    let edit = db::meta_i64(&conn, "edit_seq")?;
    let sync_edit = db::meta_i64(&conn, "sync_edit_seq")?;
    let sync_gen = db::meta_i64(&conn, "sync_generation")?;
    // 新しいとみなす：最後に引継ぎした後に編集した／取込ファイルより後の世代を持つ
    let local_newer = edit > sync_edit || g > m.generation || (sync_gen == m.generation && edit > m.edit_seq);
    Ok(Some(ExistingState { root: root.to_string_lossy().into(), generation: g, local_newer, message: local_newer.then(|| NEWER_WARNING.to_string()) }))
}

pub fn preview(path: &Path, known_projects: &[PathBuf], dest_parent: &Path) -> Result<ImportPreview> {
    let ins = inspect(path, &Cancel::new(), false)?;
    let m = &ins.manifest;
    let mut existing = None;
    for root in known_projects {
        if let Some(s) = existing_state(root, m)? {
            existing = Some(s);
            break;
        }
    }
    Ok(ImportPreview {
        project_uuid: m.project_uuid.clone(),
        project_name: m.project_name.clone(),
        exported_at: m.exported_at.clone(),
        generation: m.generation,
        photos: m.counts["photos"].as_u64().unwrap_or(0),
        ledgers: m.counts["ledgers"].as_u64().unwrap_or(0),
        total_bytes: ins.verified_total,
        free_bytes: util::available_space(dest_parent),
        existing,
    })
}

// ------------------------------------------------------------------ 取込み

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "mode")]
pub enum ImportMode {
    /// この端末にない工事として取り込む
    New,
    /// 別の工事として取り込む（新しい工事UUIDを割り当てる）
    AsCopy,
    /// 既存工事をバックアップしてから置き換える
    Replace {
        root: PathBuf,
        #[serde(default)]
        confirm_newer: bool,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub root: String,
    pub project_uuid: String,
    pub photos: usize,
    pub ledgers: usize,
    pub previous_folder: Option<String>,
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}
fn os(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(|x| x.as_str()).map(String::from)
}
fn i(v: &Value, k: &str) -> i64 {
    v.get(k).and_then(|x| x.as_i64()).unwrap_or(0)
}

pub fn import(path: &Path, dest_parent: &Path, mode: ImportMode, device_id: &str, cancel: &Cancel, progress: ProgressFn) -> Result<ImportReport> {
    progress(Progress { phase: "verify", current: 0, total: 0, message: "引継ぎファイルを確認しています".into() });
    let ins = inspect(path, cancel, false)?;
    let m = ins.manifest.clone();
    if let ImportMode::Replace { root, confirm_newer } = &mode {
        let st = existing_state(root, &m)?.ok_or_else(|| AppError::invalid("置き換える工事が、取込ファイルと同じ工事ではありません。"))?;
        if st.local_newer && !confirm_newer {
            return Err(AppError::new(ErrorKind::NeedsConfirmation, NEWER_WARNING));
        }
    }
    fs::create_dir_all(dest_parent)?;
    util::ensure_space(dest_parent, ins.verified_total)?;
    let staging = dest_parent.join(format!(".{}.importing", uuid::Uuid::new_v4().simple()));
    let result = (|| -> Result<ImportReport> {
        for d in ["originals", "thumbnails", "exports", "backups", "tmp"] {
            fs::create_dir_all(staging.join(d))?;
        }
        let mut archive = zip::ZipArchive::new(BufReader::new(File::open(path)?))?;
        let read_json = |archive: &mut zip::ZipArchive<BufReader<File>>, p: &str| -> Result<Value> {
            let f = m.files.iter().find(|f| f.path == p).ok_or_else(|| AppError::invalid("引継ぎファイルに必要な情報がありません。"))?;
            let e = archive.by_index(ins.index[p])?;
            let mut buf = Vec::with_capacity(f.bytes as usize);
            e.take(f.bytes + 1).read_to_end(&mut buf)?;
            use sha2::Digest;
            if buf.len() as u64 != f.bytes || hex::encode(sha2::Sha256::digest(&buf)) != f.sha256 {
                return Err(AppError::invalid("引継ぎファイルの内容が壊れています。"));
            }
            Ok(serde_json::from_slice(&buf)?)
        };
        let proj = read_json(&mut archive, "data/project.json")?;
        let photos = read_json(&mut archive, "data/photos.json")?;
        let ledgers = read_json(&mut archive, "data/ledgers.json")?;
        let templates = read_json(&mut archive, "data/templates.json")?;
        let photos = photos.as_array().ok_or_else(|| AppError::invalid("写真情報を読み取れません。"))?;
        let ledgers = ledgers.as_array().ok_or_else(|| AppError::invalid("台帳情報を読み取れません。"))?;
        // 参照の検証
        let photo_ids: HashSet<String> = photos.iter().map(|p| s(p, "uuid")).collect();
        let by_path: HashMap<&str, &FileEntry> = m.files.iter().map(|f| (f.path.as_str(), f)).collect();
        if photo_ids.len() != photos.len() || photo_ids.iter().any(|u| !util::is_uuid(u)) {
            return Err(AppError::invalid("写真情報が正しくありません。"));
        }
        for p in photos {
            let u = s(p, "uuid");
            let f = by_path.get(format!("originals/{u}.jpg").as_str()).ok_or_else(|| AppError::invalid("写真ファイルが不足しています。"))?;
            if f.sha256 != s(p, "sha256") || f.bytes as i64 != i(p, "bytes") {
                return Err(AppError::invalid("写真情報と写真ファイルが一致しません。"));
            }
        }
        // 原寸を1枚ずつ一時フォルダへ展開（ハッシュ・JPEG署名を確認）
        let total = photos.len() as u64;
        for (k, p) in photos.iter().enumerate() {
            cancel.check()?;
            if k % 10 == 0 {
                progress(Progress { phase: "import", current: k as u64, total, message: format!("写真を取り込んでいます {}/{}", k + 1, total) });
            }
            let u = s(p, "uuid");
            let fpath = format!("originals/{u}.jpg");
            let f = by_path[fpath.as_str()];
            let dest = staging.join(&fpath);
            let e = archive.by_index(ins.index[&fpath])?;
            let mut out = File::create(&dest)?;
            let mut head = Vec::new();
            let (sha, n) = util::hash_copy(PeekReader { inner: e.take(f.bytes + 1), head: &mut head }, Some(&mut out), cancel)?;
            if sha != f.sha256 || n != f.bytes || !util::looks_like_jpeg(&head) {
                return Err(AppError::invalid("引継ぎファイルの写真が壊れています。"));
            }
            out.sync_all()?;
        }
        progress(Progress { phase: "import", current: total, total, message: "台帳情報を登録しています".into() });
        let as_copy = matches!(mode, ImportMode::AsCopy);
        let project_uuid = if as_copy { util::new_uuid() } else { m.project_uuid.clone() };
        let mut name = s(&proj, "name");
        if as_copy {
            name = format!("{name}（取込）");
        }
        let mut conn = db::open(&staging.join(DB_FILE))?;
        db::migrate(&mut conn)?;
        let tx = conn.transaction()?;
        tx.execute(
            "insert into project(uuid, name, kouji_code, contractor, created_at, updated_at, revision) values(?1,?2,?3,?4,?5,?6,?7)",
            params![
                project_uuid,
                name,
                s(&proj, "koujiCode"),
                s(&proj, "contractor"),
                s(&proj, "createdAt"),
                s(&proj, "updatedAt"),
                i(&proj, "revision").max(1)
            ],
        )?;
        let batch = util::new_uuid();
        tx.execute("insert into import_batches(uuid, source_kind, source_label, started_at, finished_at, total, accepted, state) values(?1, 'exchange', ?2, ?3, ?3, ?4, ?4, 'done')",
            params![batch, util::display_name(&path.to_string_lossy()), now(), photos.len() as i64])?;
        let mut max_no = 0;
        for p in photos {
            let o = &p["original"];
            let no = p.get("photoNumber").and_then(|v| v.as_i64());
            max_no = max_no.max(no.unwrap_or(0));
            let src = s(p, "sourceKind");
            if src != "aopic" && src != "general" {
                return Err(AppError::invalid("写真情報が正しくありません。"));
            }
            tx.execute("insert into photos(uuid, photo_uid, source_kind, sha256, bytes, width, height, orientation, components, adobe_cmyk, taken_at, taken_at_source, original_name, folder_label,
                import_batch_uuid, photo_number, orig_koushu, orig_shubetsu, orig_saibetsu, orig_sokuten, orig_tekiyo, aopic_json, exif_json, created_at, updated_at, revision, deleted_at)
                values(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27)",
                params![s(p, "uuid"), os(p, "photoUid"), src, s(p, "sha256"), i(p, "bytes"), i(p, "width"), i(p, "height"), i(p, "orientation").clamp(1, 8),
                    i(p, "components").clamp(1, 4), p["adobeCmyk"].as_bool().unwrap_or(false), os(p, "takenAt"), s(p, "takenAtSource"), s(p, "originalName"), s(p, "folderLabel"),
                    batch, no, s(o, "koushu"), s(o, "shubetsu"), s(o, "saibetsu"), s(o, "sokuten"), s(o, "tekiyo"),
                    (!p["aopic"].is_null()).then(|| p["aopic"].to_string()), (!p["exif"].is_null()).then(|| p["exif"].to_string()),
                    s(p, "createdAt"), s(p, "updatedAt"), i(p, "revision").max(1), os(p, "deletedAt")])?;
            let ov = &p["override"];
            if ov.is_object() {
                tx.execute("insert into photo_overrides(photo_uuid, koushu, shubetsu, saibetsu, sokuten, tekiyo, updated_at, revision) values(?1,?2,?3,?4,?5,?6,?7,?8)",
                    params![s(p, "uuid"), os(ov, "koushu"), os(ov, "shubetsu"), os(ov, "saibetsu"), os(ov, "sokuten"), os(ov, "tekiyo"), s(ov, "updatedAt"), i(ov, "revision").max(1)])?;
            }
        }
        for l in ledgers {
            let lu = s(l, "uuid");
            if !util::is_uuid(&lu) {
                return Err(AppError::invalid("台帳情報が正しくありません。"));
            }
            tx.execute("insert into ledgers(uuid, title, template, show_cover, cover_json, view_mode, created_at, updated_at, revision, deleted_at) values(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                params![lu, s(l, "title"), s(l, "template"), l["showCover"].as_bool().unwrap_or(true), l["cover"].to_string(),
                    if s(l, "viewMode") == "spread" { "spread" } else { "single" }, s(l, "createdAt"), s(l, "updatedAt"), i(l, "revision").max(1), os(l, "deletedAt")])?;
            for pg in l["pages"].as_array().into_iter().flatten() {
                tx.execute(
                    "insert into ledger_pages(uuid, ledger_uuid, position, kind, created_at, updated_at, revision, deleted_at) values(?1,?2,?3,?4,?5,?6,?7,?8)",
                    params![
                        s(pg, "uuid"),
                        lu,
                        pg["position"].as_f64().unwrap_or(0.0),
                        s(pg, "kind"),
                        s(pg, "createdAt"),
                        s(pg, "updatedAt"),
                        i(pg, "revision").max(1),
                        os(pg, "deletedAt")
                    ],
                )?;
                for sl in pg["slots"].as_array().into_iter().flatten() {
                    let ph = os(sl, "photoUuid");
                    if let Some(p) = &ph
                        && !photo_ids.contains(p)
                    {
                        return Err(AppError::invalid("台帳が存在しない写真を参照しています。"));
                    }
                    tx.execute("insert into ledger_slots(uuid, page_uuid, ledger_uuid, slot_index, kind, photo_uuid, updated_at, revision) values(?1,?2,?3,?4,?5,?6,?7,?8)",
                        params![s(sl, "uuid"), s(pg, "uuid"), lu, i(sl, "index"), s(sl, "kind"), ph, s(sl, "updatedAt"), i(sl, "revision").max(1)])?;
                }
            }
            for c in l["captions"].as_array().into_iter().flatten() {
                if !photo_ids.contains(&s(c, "photoUuid")) {
                    return Err(AppError::invalid("台帳が存在しない写真を参照しています。"));
                }
                tx.execute(
                    "insert into ledger_captions(ledger_uuid, photo_uuid, koushu, sokuten, body, updated_at, revision) values(?1,?2,?3,?4,?5,?6,?7)",
                    params![lu, s(c, "photoUuid"), os(c, "koushu"), os(c, "sokuten"), os(c, "body"), s(c, "updatedAt"), i(c, "revision").max(1)],
                )?;
            }
        }
        for t in templates.as_array().into_iter().flatten() {
            tx.execute(
                "insert into classification_templates(uuid, name, values_json, created_at, updated_at, revision, deleted_at) values(?1,?2,?3,?4,?5,?6,?7)",
                params![s(t, "uuid"), s(t, "name"), t["values"].to_string(), s(t, "createdAt"), s(t, "updatedAt"), i(t, "revision").max(1), os(t, "deletedAt")],
            )?;
        }
        let (generation, edit) = if as_copy { (1, 0) } else { (m.generation, m.edit_seq) };
        for (k, v) in [
            ("format_version", "1".to_string()),
            ("project_uuid", project_uuid.clone()),
            ("generation", generation.to_string()),
            ("edit_seq", edit.to_string()),
            ("sync_generation", generation.to_string()),
            ("sync_edit_seq", edit.to_string()),
            ("last_device_id", if as_copy { device_id.to_string() } else { m.last_device_id.clone() }),
            ("created_app_version", APP_VERSION.to_string()),
            ("next_photo_number", (max_no + 1).to_string()),
            ("open_state", "closed".to_string()),
        ] {
            db::set_meta(&tx, k, &v)?;
        }
        tx.commit()?;
        if !db::integrity_ok(&conn)? {
            return Err(AppError::corrupt("取込み後の確認で不整合が見つかりました。"));
        }
        conn.pragma_update(None, "wal_checkpoint", "TRUNCATE")?;
        drop(conn);
        let marker = project::ProjectMarker {
            format: "aoALB2-project".into(),
            format_version: 1,
            project_uuid: project_uuid.clone(),
            name: name.clone(),
            created_at: s(&proj, "createdAt"),
        };
        util::write_atomic(&staging.join(MARKER_FILE), &serde_json::to_vec_pretty(&marker)?)?;
        Ok(ImportReport { root: String::new(), project_uuid, photos: photos.len(), ledgers: ledgers.len(), previous_folder: None })
    })();
    let mut report = match result {
        Ok(r) => r,
        Err(e) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(e);
        }
    };
    // ここまで既存工事には一切触れていない。全検証が通った後だけ確定する
    match mode {
        ImportMode::Replace { root, .. } => {
            // 開かれていないことをロックで確認し、DBバックアップを取ってから、フォルダごと退避して置き換える
            let (existing, _) = project::open_project(&root, device_id).inspect_err(|_e| {
                let _ = fs::remove_dir_all(&staging);
            })?;
            crate::backup::create(&existing, crate::backup::Reason::BeforeImportReplace).inspect_err(|_e| {
                let _ = fs::remove_dir_all(&staging);
            })?;
            existing.close()?;
            let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
            let base = root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "工事".into());
            let previous = root.with_file_name(format!("{base}_置換前_{stamp}"));
            fs::rename(&root, &previous).map_err(|e| {
                let _ = fs::remove_dir_all(&staging);
                AppError::from(e)
            })?;
            if let Err(e) = fs::rename(&staging, &root) {
                let _ = fs::rename(&previous, &root);
                let _ = fs::remove_dir_all(&staging);
                return Err(e.into());
            }
            report.root = root.to_string_lossy().into();
            report.previous_folder = Some(previous.to_string_lossy().into());
        }
        _ => {
            let name = project::read_marker(&staging)?.name;
            let root = util::unique_child(dest_parent, &util::safe_name(&name, "工事")).inspect_err(|_e| {
                let _ = fs::remove_dir_all(&staging);
            })?;
            fs::rename(&staging, &root).map_err(|e| {
                let _ = fs::remove_dir_all(&staging);
                AppError::from(e)
            })?;
            report.root = root.to_string_lossy().into();
        }
    }
    Ok(report)
}

/// 取込み元のZIPを読む汎用ヘルパー（テスト用）
pub fn entry_names<R: Read + Seek>(archive: &mut zip::ZipArchive<R>) -> Vec<String> {
    (0..archive.len()).filter_map(|i| archive.by_index_raw(i).ok().and_then(|e| e.name().ok().map(|n| n.to_string()))).collect()
}
