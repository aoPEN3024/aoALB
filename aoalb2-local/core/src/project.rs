//! 工事フォルダの作成・オープン・ロック・異常終了後の確認。
//!
//! ```text
//! ○○工事/
//!   aoalb-project.json   工事の識別情報（フォルダ名ではなくprojectUuidで識別）
//!   project.sqlite       台帳・分類・写真情報（正本）
//!   originals/           原寸写真 {photoUuid}.jpg（作成後は変更しない）
//!   thumbnails/          サムネイル（消えても再生成）
//!   exports/             引継ぎファイルの既定出力先
//!   backups/             DBバックアップ（原寸写真は複製しない）
//!   tmp/                 作業中ファイル（開くたびに掃除）
//!   .aoalb.lock          同時オープン防止
//! ```

use crate::db;
use crate::error::{AppError, ErrorKind, Result};
use crate::util::{self, now};
use fs2::FileExt;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const MARKER_FILE: &str = "aoalb-project.json";
pub const DB_FILE: &str = "project.sqlite";
pub const LOCK_FILE: &str = ".aoalb.lock";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMarker {
    pub format: String,
    pub format_version: u32,
    pub project_uuid: String,
    pub name: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub uuid: String,
    pub name: String,
    pub kouji_code: String,
    pub contractor: String,
    pub created_at: String,
    pub updated_at: String,
    pub revision: i64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpenReport {
    /// 前回正常に閉じられなかった
    pub recovered_after_crash: bool,
    pub integrity_ok: bool,
    pub missing_originals: Vec<String>,
    pub missing_thumbnails: u64,
    pub cleaned_temp_files: u64,
    pub cancelled_imports: u64,
    /// 原寸はあるが一覧に登録されていない写真（復旧できる）
    pub unregistered_originals: usize,
}

pub struct Project {
    pub root: PathBuf,
    pub conn: Connection,
    pub uuid: String,
    pub device_id: String,
    _lock: File,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewProject {
    pub name: String,
    #[serde(default)]
    pub kouji_code: String,
    #[serde(default)]
    pub contractor: String,
}

/// 親フォルダの中に工事フォルダを新規作成する。同名フォルダがあれば「(2)」等を付ける。
pub fn create_project(parent: &Path, input: &NewProject, device_id: &str) -> Result<Project> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err(AppError::invalid("工事名を入力してください。"));
    }
    if name.chars().count() > 160 {
        return Err(AppError::invalid("工事名は160文字以内にしてください。"));
    }
    fs::create_dir_all(parent)?;
    let root = util::unique_child(parent, &util::safe_name(name, "工事"))?;
    let uuid = util::new_uuid();
    let ts = now();
    // 作業用フォルダで作ってから名前を確定する（途中失敗で中途半端な工事フォルダを残さない）
    let staging = parent.join(format!(".{}.creating", uuid));
    let result = (|| -> Result<()> {
        for d in ["originals", "thumbnails", "exports", "backups", "tmp"] {
            fs::create_dir_all(staging.join(d))?;
        }
        let mut conn = db::open(&staging.join(DB_FILE))?;
        db::migrate(&mut conn)?;
        conn.execute(
            "insert into project(uuid, name, kouji_code, contractor, created_at, updated_at) values(?1, ?2, ?3, ?4, ?5, ?5)",
            params![uuid, name, input.kouji_code.trim(), input.contractor.trim(), ts],
        )?;
        for (k, v) in [
            ("format_version", "1"),
            ("project_uuid", uuid.as_str()),
            ("generation", "1"),
            ("edit_seq", "0"),
            ("sync_generation", "0"),
            ("sync_edit_seq", "0"),
            ("last_device_id", device_id),
            ("created_app_version", APP_VERSION),
            ("next_photo_number", "1"),
        ] {
            db::set_meta(&conn, k, v)?;
        }
        conn.pragma_update(None, "wal_checkpoint", "TRUNCATE")?;
        drop(conn);
        let marker =
            ProjectMarker { format: "aoALB2-project".into(), format_version: 1, project_uuid: uuid.clone(), name: name.into(), created_at: ts.clone() };
        util::write_atomic(&staging.join(MARKER_FILE), &serde_json::to_vec_pretty(&marker)?)?;
        fs::rename(&staging, &root)?;
        Ok(())
    })();
    if let Err(e) = result {
        let _ = fs::remove_dir_all(&staging);
        return Err(e);
    }
    let (project, _) = open_project(&root, device_id)?;
    Ok(project)
}

pub fn read_marker(root: &Path) -> Result<ProjectMarker> {
    let bytes = fs::read(root.join(MARKER_FILE)).map_err(|_| AppError::not_found("このフォルダは工事フォルダではありません。"))?;
    let marker: ProjectMarker = serde_json::from_slice(&bytes).map_err(|_| AppError::corrupt("工事フォルダの情報を読み取れません。"))?;
    if marker.format != "aoALB2-project" || !util::is_uuid(&marker.project_uuid) {
        return Err(AppError::corrupt("工事フォルダの情報を読み取れません。"));
    }
    Ok(marker)
}

fn acquire_lock(root: &Path) -> Result<File> {
    let path = root.join(LOCK_FILE);
    let mut f = OpenOptions::new().create(true).truncate(false).read(true).write(true).open(&path)?;
    if f.try_lock_exclusive().is_err() {
        return Err(AppError::new(ErrorKind::Locked, "この工事はすでに別の画面で開かれています。先に開いている画面を閉じてください。"));
    }
    // OSのロックはプロセス異常終了時に自動で外れる。内容は診断用のみ
    f.set_len(0)?;
    let _ = writeln!(f, "pid={} opened_at={}", std::process::id(), now());
    Ok(f)
}

/// 工事を開く。フォルダを移動していても `aoalb-project.json` とDB内のUUIDが一致すれば開ける。
pub fn open_project(root: &Path, device_id: &str) -> Result<(Project, OpenReport)> {
    let marker = read_marker(root)?;
    let lock = acquire_lock(root)?;
    let mut conn = db::open(&root.join(DB_FILE))?;
    db::migrate(&mut conn)?;
    let uuid = db::get_meta(&conn, "project_uuid")?.unwrap_or_default();
    if uuid != marker.project_uuid {
        return Err(AppError::corrupt("工事フォルダの情報とデータが一致しません。"));
    }
    let mut report = OpenReport { integrity_ok: true, ..Default::default() };
    report.recovered_after_crash = db::get_meta(&conn, "open_state")?.as_deref() == Some("open");
    report.cleaned_temp_files = clean_temp(root)?;
    if report.recovered_after_crash {
        report.integrity_ok = db::integrity_ok(&conn)?;
        report.cancelled_imports = conn.execute("update import_batches set state = 'cancelled', finished_at = ?1 where state = 'running'", [now()])? as u64;
        let mut stmt = conn.prepare("select uuid from photos where deleted_at is null")?;
        let ids: Vec<String> = stmt.query_map([], |r| r.get(0))?.collect::<std::result::Result<_, _>>()?;
        drop(stmt);
        for id in ids {
            if !root.join("originals").join(format!("{id}.jpg")).exists() {
                report.missing_originals.push(id.clone());
            }
            if !root.join("thumbnails").join(format!("{id}.jpg")).exists() {
                report.missing_thumbnails += 1;
                conn.execute("update photos set thumb_state = 'pending' where uuid = ?1", [&id])?;
            }
        }
    }
    // 開くたびに確認する（ファイル名とDBの突き合わせだけなので数千枚でも数十ms）
    report.unregistered_originals = crate::recover::find_unregistered(&conn, root)?.0.len();
    db::set_meta(&conn, "open_state", "open")?;
    Ok((Project { root: root.to_path_buf(), conn, uuid, device_id: device_id.into(), _lock: lock }, report))
}

fn clean_temp(root: &Path) -> Result<u64> {
    let mut n = 0;
    let tmp = root.join("tmp");
    if tmp.exists() {
        for e in fs::read_dir(&tmp)? {
            let e = e?;
            let p = e.path();
            if p.is_dir() {
                fs::remove_dir_all(&p)?;
            } else {
                fs::remove_file(&p)?;
            }
            n += 1;
        }
    } else {
        fs::create_dir_all(&tmp)?;
    }
    for d in ["originals", "thumbnails", "exports", "backups"] {
        let dir = root.join(d);
        if !dir.exists() {
            fs::create_dir_all(&dir)?;
            continue;
        }
        for e in fs::read_dir(&dir)? {
            let p = e?.path();
            if p.file_name().map(|n| n.to_string_lossy().ends_with(".partial")).unwrap_or(false) {
                fs::remove_file(&p)?;
                n += 1;
            }
        }
    }
    Ok(n)
}

impl Project {
    pub fn info(&self) -> Result<ProjectInfo> {
        Ok(self.conn.query_row("select uuid, name, kouji_code, contractor, created_at, updated_at, revision from project", [], |r| {
            Ok(ProjectInfo {
                uuid: r.get(0)?,
                name: r.get(1)?,
                kouji_code: r.get(2)?,
                contractor: r.get(3)?,
                created_at: r.get(4)?,
                updated_at: r.get(5)?,
                revision: r.get(6)?,
            })
        })?)
    }

    pub fn update_info(&mut self, input: &NewProject) -> Result<ProjectInfo> {
        let name = input.name.trim();
        if name.is_empty() {
            return Err(AppError::invalid("工事名を入力してください。"));
        }
        let tx = self.conn.transaction()?;
        tx.execute(
            "update project set name = ?1, kouji_code = ?2, contractor = ?3, updated_at = ?4, revision = revision + 1",
            params![name, input.kouji_code.trim(), input.contractor.trim(), now()],
        )?;
        db::bump_edit_seq(&tx)?;
        tx.commit()?;
        let mut marker = read_marker(&self.root)?;
        marker.name = name.into();
        util::write_atomic(&self.root.join(MARKER_FILE), &serde_json::to_vec_pretty(&marker)?)?;
        self.info()
    }

    pub fn originals_dir(&self) -> PathBuf {
        self.root.join("originals")
    }
    pub fn thumbs_dir(&self) -> PathBuf {
        self.root.join("thumbnails")
    }
    pub fn tmp_dir(&self) -> PathBuf {
        self.root.join("tmp")
    }
    pub fn original_path(&self, photo: &str) -> PathBuf {
        self.originals_dir().join(format!("{photo}.jpg"))
    }
    pub fn thumb_path(&self, photo: &str) -> PathBuf {
        self.thumbs_dir().join(format!("{photo}.jpg"))
    }

    /// 書込みトランザクションの共通後処理（編集番号・最終編集端末）
    pub fn touch(conn: &Connection, device_id: &str) -> Result<()> {
        db::bump_edit_seq(conn)?;
        db::set_meta(conn, "last_device_id", device_id)?;
        Ok(())
    }

    /// 正常に閉じる。WALを本体へ反映し、異常終了フラグを消す。
    pub fn close(self) -> Result<()> {
        db::set_meta(&self.conn, "open_state", "closed")?;
        self.conn.pragma_update(None, "wal_checkpoint", "TRUNCATE")?;
        self.conn.close().map_err(|(_, e)| AppError::from(e))?;
        Ok(())
    }
}
