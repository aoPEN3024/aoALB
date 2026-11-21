//! DBバックアップ（世代管理・検証・復元）。
//! 原寸写真は作成後に変更・削除しない（写真のごみ箱も論理削除）ため、バックアップはDBだけを複製する。
//! これにより原寸写真を無制限に重複させずに、どの世代へ戻しても写真が揃う。

use crate::db;
use crate::error::{AppError, Result};
use crate::project::Project;
use crate::util::{self, now};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

pub const KEEP_AUTOMATIC: usize = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Reason {
    Periodic,
    Manual,
    BeforeImportReplace,
    BeforeLedgerDelete,
    BeforeRestore,
    BeforeImportPhotos,
    OnClose,
    BeforeRecovery,
}
impl Reason {
    fn slug(self) -> &'static str {
        match self {
            Reason::Periodic => "periodic",
            Reason::Manual => "manual",
            Reason::BeforeImportReplace => "before-import-replace",
            Reason::BeforeLedgerDelete => "before-ledger-delete",
            Reason::BeforeRestore => "before-restore",
            Reason::BeforeImportPhotos => "before-import-photos",
            Reason::OnClose => "on-close",
            Reason::BeforeRecovery => "before-recovery",
        }
    }
    pub fn label(slug: &str) -> &'static str {
        match slug {
            "periodic" => "定期",
            "manual" => "手動",
            "before-import-replace" => "引継ぎファイルで置き換える前",
            "before-ledger-delete" => "台帳削除の前",
            "before-restore" => "復元の前",
            "before-import-photos" => "写真取込みの前",
            "on-close" => "工事を閉じる時",
            "before-recovery" => "写真の復旧の前",
            _ => "その他",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub name: String,
    pub created_at: String,
    pub reason: String,
    pub reason_label: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupStatus {
    pub folder: String,
    pub count: usize,
    pub total_bytes: u64,
    pub last_backup_at: Option<String>,
    pub free_bytes: Option<u64>,
}

fn dir(project: &Project) -> PathBuf {
    project.root.join("backups")
}

pub fn create(project: &Project, reason: Reason) -> Result<BackupInfo> {
    let d = dir(project);
    fs::create_dir_all(&d)?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S%3f");
    let name = format!("{stamp}-{}.sqlite", reason.slug());
    let dest = d.join(&name);
    let tmp = util::tmp_sibling(&dest);
    let size: u64 = fs::metadata(project.root.join(crate::project::DB_FILE)).map(|m| m.len()).unwrap_or(0);
    util::ensure_space(&d, size)?;
    let res = (|| -> Result<()> {
        project.conn.backup(rusqlite::MAIN_DB, &tmp, None::<fn(rusqlite::backup::Progress)>)?;
        // バックアップは単体ファイルで完結させる（-wal/-shm を残さない）
        {
            let c = Connection::open(&tmp)?;
            c.pragma_update(None, "journal_mode", "DELETE")?;
        }
        verify_file(&tmp, &project.uuid)?;
        fs::rename(&tmp, &dest)?;
        Ok(())
    })();
    if let Err(e) = res {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    db::set_meta(&project.conn, "last_backup_at", &now())?;
    db::set_meta(&project.conn, "last_backup_edit_seq", &db::meta_i64(&project.conn, "edit_seq")?.to_string())?;
    prune(project)?;
    info_for(&dest)
}

/// 前回から編集があり、間隔を過ぎていればバックアップする（画面を開いている間、定期的に呼ぶ）
pub fn periodic_if_due(project: &Project, interval_minutes: i64) -> Result<Option<BackupInfo>> {
    let edited = db::meta_i64(&project.conn, "edit_seq")? != db::meta_i64(&project.conn, "last_backup_edit_seq")?;
    if !edited {
        return Ok(None);
    }
    let last = db::get_meta(&project.conn, "last_backup_at")?.and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok());
    let due = last.map(|t| chrono::Utc::now().signed_duration_since(t).num_minutes() >= interval_minutes).unwrap_or(true);
    if !due {
        return Ok(None);
    }
    create(project, Reason::Periodic).map(Some)
}

fn info_for(path: &Path) -> Result<BackupInfo> {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let meta = fs::metadata(path)?;
    // 20261121-093000123-periodic.sqlite
    let stem = name.trim_end_matches(".sqlite");
    let (stamp, reason) = stem.split_at(stem.find('-').and_then(|i| stem[i + 1..].find('-').map(|j| i + 1 + j)).unwrap_or(stem.len()));
    let reason = reason.trim_start_matches('-').to_string();
    let created_at = chrono::NaiveDateTime::parse_from_str(&stamp[..stamp.len().min(15)], "%Y%m%d-%H%M%S")
        .map(|t| t.format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_default();
    Ok(BackupInfo { name, created_at, reason_label: Reason::label(&reason).into(), reason, bytes: meta.len() })
}

pub fn list(project: &Project) -> Result<Vec<BackupInfo>> {
    let d = dir(project);
    let mut out = Vec::new();
    if d.exists() {
        for e in fs::read_dir(&d)? {
            let p = e?.path();
            let n = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            if n.ends_with(".sqlite") && !n.starts_with('.') {
                out.push(info_for(&p)?);
            }
        }
    }
    out.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(out)
}

pub fn status(project: &Project) -> Result<BackupStatus> {
    let l = list(project)?;
    Ok(BackupStatus {
        folder: dir(project).to_string_lossy().into(),
        count: l.len(),
        total_bytes: l.iter().map(|b| b.bytes).sum(),
        last_backup_at: db::get_meta(&project.conn, "last_backup_at")?,
        free_bytes: util::available_space(&project.root),
    })
}

/// 自動バックアップは新しい順に30世代残す。手動・置換前・復元前は自動削除しない。
fn prune(project: &Project) -> Result<()> {
    let auto: Vec<BackupInfo> =
        list(project)?.into_iter().filter(|b| b.reason == "periodic" || b.reason == "on-close" || b.reason == "before-import-photos").collect();
    for b in auto.iter().skip(KEEP_AUTOMATIC) {
        let _ = fs::remove_file(dir(project).join(&b.name));
    }
    Ok(())
}

fn safe_name(name: &str) -> Result<()> {
    if name.contains(['/', '\\']) || name.starts_with('.') || !name.ends_with(".sqlite") || name.contains("..") {
        return Err(AppError::invalid("バックアップの指定が正しくありません。"));
    }
    Ok(())
}

/// バックアップを開いて整合性と工事の一致を確認する
pub fn verify_file(path: &Path, project_uuid: &str) -> Result<()> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    if !db::integrity_ok(&conn)? {
        return Err(AppError::corrupt("バックアップが壊れています。"));
    }
    if db::get_meta(&conn, "project_uuid")?.as_deref() != Some(project_uuid) {
        return Err(AppError::invalid("別の工事のバックアップです。"));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyReport {
    pub ok: bool,
    pub photos: i64,
    pub ledgers: i64,
    pub missing_originals: i64,
    pub message: String,
}

pub fn verify(project: &Project, name: &str) -> Result<VerifyReport> {
    safe_name(name)?;
    let path = dir(project).join(name);
    if let Err(e) = verify_file(&path, &project.uuid) {
        return Ok(VerifyReport { ok: false, photos: 0, ledgers: 0, missing_originals: 0, message: e.message });
    }
    let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let photos: i64 = conn.query_row("select count(*) from photos", [], |r| r.get(0))?;
    let ledgers: i64 = conn.query_row("select count(*) from ledgers where deleted_at is null", [], |r| r.get(0))?;
    let mut stmt = conn.prepare("select uuid from photos")?;
    let ids: Vec<String> = stmt.query_map([], |r| r.get(0))?.collect::<std::result::Result<_, _>>()?;
    let missing = ids.iter().filter(|id| !project.original_path(id).exists()).count() as i64;
    let ok = missing == 0;
    Ok(VerifyReport {
        ok,
        photos,
        ledgers,
        missing_originals: missing,
        message: if ok { "このバックアップは正常です。".into() } else { format!("原寸写真が{missing}枚見つかりません。") },
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    /// 復元前の状態を保存したバックアップ
    pub before: BackupInfo,
    /// 復元した時点より後に取り込まれていた写真を一覧へ戻した結果（黙って消さない）
    pub recovery: crate::recover::RecoveryReport,
}

/// バックアップから復元する。復元前の状態も自動でバックアップし、
/// 復元後に一覧から外れた原寸写真（復元時点より後に取り込んだもの）は自動で一覧へ戻す。
pub fn restore(project: &mut Project, name: &str) -> Result<RestoreReport> {
    safe_name(name)?;
    let path = dir(project).join(name);
    verify_file(&path, &project.uuid)?;
    let before = create(project, Reason::BeforeRestore)?;
    project.conn.restore(rusqlite::MAIN_DB, &path, None::<fn(rusqlite::backup::Progress)>)?;
    db::migrate(&mut project.conn)?;
    db::set_meta(&project.conn, "open_state", "open")?;
    Project::touch(&project.conn, &project.device_id)?;
    // 復元した世代に合わせてサムネイルの有無を確認し直す
    crate::photos::reset_thumbnails(&project.conn, &project.root)?;
    let recovery = crate::recover::recover_unregistered(project, &crate::util::Cancel::new())?;
    Ok(RestoreReport { before, recovery })
}
