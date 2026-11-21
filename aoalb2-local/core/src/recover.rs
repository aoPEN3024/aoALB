//! 一覧に登録されていない原寸写真（originals/ にあるがDBにない）の検出と復旧。
//!
//! 起きる場面：
//! - 古いバックアップへ復元した（復元した時点より後に取り込んだ写真の原寸は残っている）
//! - 取込み中の異常終了で、原寸の保存後・DB登録前に止まった
//!
//! 復旧の順序：
//! 1. バックアップ（新しい順）に同じ写真ID・同じSHA-256の記録があれば、その記録（aoPIC情報・元分類・分類の上書きを含む）を戻す
//! 2. どのバックアップにもなければ、原寸ファイル自体（JPEGヘッダー・EXIF）から一般写真として登録する
//!
//! 原寸ファイルは削除・移動・変更しない。読めないファイルは「復旧できなかった写真」として報告し、そのまま残す。

use crate::backup;
use crate::db;
use crate::error::Result;
use crate::photos;
use crate::project::Project;
use crate::util::{self, Cancel, now};
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OpenFlags, params, params_from_iter};
use serde::Serialize;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Unregistered {
    pub photo_uuid: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryReport {
    pub found: usize,
    pub recovered_from_backup: usize,
    pub recovered_from_file: usize,
    pub failed: Vec<String>,
    /// 原寸フォルダにある、このアプリが作ったものではないファイル（触らない）
    pub other_files: usize,
    pub batch_uuid: Option<String>,
}

/// 原寸フォルダとDBを突き合わせる（ファイル名と登録の有無だけを見るので速い）
pub fn find_unregistered(conn: &Connection, root: &Path) -> Result<(Vec<Unregistered>, usize)> {
    let mut stmt = conn.prepare("select uuid from photos")?;
    let known: HashSet<String> = stmt.query_map([], |r| r.get(0))?.collect::<std::result::Result<_, _>>()?;
    let mut out = Vec::new();
    let mut other = 0;
    let dir = root.join("originals");
    if !dir.exists() {
        return Ok((out, 0));
    }
    for e in fs::read_dir(&dir)? {
        let e = e?;
        if !e.file_type()?.is_file() {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') && name.ends_with(".partial") {
            continue;
        }
        match name.strip_suffix(".jpg").filter(|u| util::is_uuid(u)) {
            Some(u) if !known.contains(u) => out.push(Unregistered { photo_uuid: u.into(), bytes: e.metadata()?.len() }),
            Some(_) => {}
            None => other += 1,
        }
    }
    out.sort_by(|a, b| a.photo_uuid.cmp(&b.photo_uuid));
    Ok((out, other))
}

type Row = (Vec<String>, Vec<SqlValue>);

fn read_rows(conn: &Connection, table: &str, key: &str, ids: &[String]) -> Result<HashMap<String, Row>> {
    let mut out = HashMap::new();
    let sql = format!("select * from {table} where {key} in (select value from json_each(?1))");
    let mut stmt = conn.prepare(&sql)?;
    let cols: Vec<String> = stmt.column_names().map(|s| s.to_string()).collect();
    let key_idx = cols.iter().position(|c| c == key).unwrap_or(0);
    let mut rows = stmt.query([serde_json::to_string(ids)?])?;
    while let Some(r) = rows.next()? {
        let vals: Vec<SqlValue> = (0..cols.len()).map(|i| r.get::<_, SqlValue>(i)).collect::<std::result::Result<_, _>>()?;
        if let SqlValue::Text(k) = &vals[key_idx] {
            out.insert(k.clone(), (cols.clone(), vals));
        }
    }
    Ok(out)
}

fn insert_row(conn: &Connection, table: &str, row: &Row) -> Result<()> {
    let (cols, vals) = row;
    let sql = format!("insert or ignore into {table}({}) values({})", cols.join(","), (1..=cols.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(","));
    conn.execute(&sql, params_from_iter(vals.iter()))?;
    Ok(())
}

pub fn recover_unregistered(project: &mut Project, cancel: &Cancel) -> Result<RecoveryReport> {
    let (list, other) = find_unregistered(&project.conn, &project.root)?;
    let mut report = RecoveryReport { found: list.len(), other_files: other, ..Default::default() };
    if list.is_empty() {
        return Ok(report);
    }
    backup::create(project, backup::Reason::BeforeRecovery)?;
    // 1枚ずつSHA-256を確認（原寸の中身と記録の一致を確かめる）
    let mut sha: HashMap<String, String> = HashMap::new();
    for u in &list {
        cancel.check()?;
        match util::hash_file(&project.original_path(&u.photo_uuid), cancel) {
            Ok((h, _)) => {
                sha.insert(u.photo_uuid.clone(), h);
            }
            Err(_) => report.failed.push(u.photo_uuid.clone()),
        }
    }
    // バックアップを新しい順に1つずつ開き、残っている写真の記録を探す
    let mut from_backup: HashMap<String, (Row, Option<Row>, Option<Row>)> = HashMap::new();
    for b in backup::list(project)? {
        let remaining: Vec<String> = sha.keys().filter(|k| !from_backup.contains_key(*k)).cloned().collect();
        if remaining.is_empty() {
            break;
        }
        let path = project.root.join("backups").join(&b.name);
        let Ok(bk) = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX) else { continue };
        let ver: i64 = bk.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap_or(-1);
        if ver != db::SCHEMA_VERSION || db::get_meta(&bk, "project_uuid").ok().flatten().as_deref() != Some(project.uuid.as_str()) {
            continue;
        }
        let photos_rows = read_rows(&bk, "photos", "uuid", &remaining)?;
        let overrides = read_rows(&bk, "photo_overrides", "photo_uuid", &remaining)?;
        let batch_ids: Vec<String> = photos_rows
            .values()
            .filter_map(|(c, v)| {
                c.iter().position(|x| x == "import_batch_uuid").and_then(|i| match &v[i] {
                    SqlValue::Text(t) => Some(t.clone()),
                    _ => None,
                })
            })
            .collect();
        let batches = read_rows(&bk, "import_batches", "uuid", &batch_ids)?;
        for (id, row) in photos_rows {
            let sha_i = row.0.iter().position(|c| c == "sha256").unwrap_or(0);
            let ok = matches!(&row.1[sha_i], SqlValue::Text(h) if Some(h) == sha.get(&id));
            if !ok {
                continue;
            }
            let bi = row.0.iter().position(|c| c == "import_batch_uuid").unwrap_or(0);
            let batch = match &row.1[bi] {
                SqlValue::Text(t) => batches.get(t).cloned(),
                _ => None,
            };
            from_backup.insert(id.clone(), (row, overrides.get(&id).cloned(), batch));
        }
    }
    let batch = util::new_uuid();
    let originals = project.originals_dir();
    let device = project.device_id.clone();
    let tx = project.conn.transaction()?;
    tx.execute("insert into import_batches(uuid, source_kind, source_label, started_at, finished_at, total, state) values(?1, 'recovery', '復旧した写真', ?2, ?2, ?3, 'done')",
        params![batch, now(), list.len() as i64])?;
    let mut next_no = db::meta_i64(&tx, "next_photo_number")?.max(1);
    for u in &list {
        let Some(h) = sha.get(&u.photo_uuid) else { continue };
        if let Some((mut row, ov, b)) = from_backup.remove(&u.photo_uuid) {
            if let Some(b) = &b {
                insert_row(&tx, "import_batches", b)?;
            }
            // 復元後に同じaoPIC写真を取り込み直していた場合、photoUidの重複を避ける（元情報は aopic_json に残る）
            let ui = row.0.iter().position(|c| c == "photo_uid").unwrap_or(0);
            if let SqlValue::Text(pu) = &row.1[ui] {
                let taken: bool = tx.query_row("select exists(select 1 from photos where photo_uid = ?1)", [pu], |r| r.get(0))?;
                if taken {
                    row.1[ui] = SqlValue::Null;
                }
            }
            let ti = row.0.iter().position(|c| c == "thumb_state").unwrap_or(0);
            row.1[ti] = SqlValue::Text("pending".into());
            insert_row(&tx, "photos", &row)?;
            if let Some(o) = &ov {
                insert_row(&tx, "photo_overrides", o)?;
            }
            let no_i = row.0.iter().position(|c| c == "photo_number").unwrap_or(0);
            if let SqlValue::Integer(n) = row.1[no_i] {
                next_no = next_no.max(n + 1);
            }
            report.recovered_from_backup += 1;
            continue;
        }
        // 記録がない：原寸ファイルから一般写真として登録
        let path = originals.join(format!("{}.jpg", u.photo_uuid));
        let info = match photos::read_jpeg_info(&path) {
            Ok(i) => i,
            Err(_) => {
                report.failed.push(u.photo_uuid.clone());
                continue;
            }
        };
        let exif = photos::read_exif(&path);
        let (taken, src) = match (exif.taken_at.clone(), photos::file_time_label(&path)) {
            (Some(t), _) => (Some(t), "exif"),
            (None, Some(t)) => (Some(t), "file"),
            _ => (None, "unknown"),
        };
        let ts = now();
        tx.execute("insert into photos(uuid, source_kind, sha256, bytes, width, height, orientation, components, adobe_cmyk, taken_at, taken_at_source, original_name, folder_label,
            import_batch_uuid, photo_number, exif_json, created_at, updated_at) values(?1,'general',?2,?3,?4,?5,?6,?7,?8,?9,?10,'復旧した写真.jpg','復旧した写真',?11,?12,?13,?14,?14)",
            params![u.photo_uuid, h, u.bytes as i64, info.width, info.height, exif.orientation, info.components, info.adobe_cmyk, taken, src, batch, next_no,
                json!({"recovered": true, "exif": exif.json}).to_string(), ts])?;
        next_no += 1;
        report.recovered_from_file += 1;
    }
    db::set_meta(&tx, "next_photo_number", &next_no.to_string())?;
    tx.execute(
        "update import_batches set accepted = ?2, failed = ?3 where uuid = ?1",
        params![batch, (report.recovered_from_backup + report.recovered_from_file) as i64, report.failed.len() as i64],
    )?;
    Project::touch(&tx, &device)?;
    tx.commit()?;
    report.batch_uuid = Some(batch);
    Ok(report)
}
