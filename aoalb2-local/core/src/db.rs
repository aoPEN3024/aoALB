//! SQLiteの接続設定とスキーマmigration。
//! `PRAGMA user_version` でスキーマ版を管理し、古い版は順に上げる（下げない）。

use crate::error::{AppError, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

pub const SCHEMA_VERSION: i64 = 1;

const MIGRATION_1: &str = r#"
create table meta (
  key text primary key,
  value text not null
);

create table project (
  uuid text primary key,
  name text not null,
  kouji_code text not null default '',
  contractor text not null default '',
  created_at text not null,
  updated_at text not null,
  revision integer not null default 1,
  deleted_at text
);

create table import_batches (
  uuid text primary key,
  source_kind text not null,           -- files / folder / zip / aopic_zip / exchange
  source_label text not null default '',
  started_at text not null,
  finished_at text,
  total integer not null default 0,
  accepted integer not null default 0,
  duplicates integer not null default 0,
  failed integer not null default 0,
  state text not null default 'running' -- running / done / cancelled
);

create table import_failures (
  id integer primary key,
  batch_uuid text not null references import_batches(uuid),
  source_name text not null,           -- 表示用ファイル名
  source_path text,                    -- 再試行用（端末内パス）
  reason text not null,                -- 利用者向け日本語
  kind text not null,                  -- invalid / duplicate / io
  resolved integer not null default 0,
  created_at text not null
);
create index import_failures_batch_idx on import_failures(batch_uuid, resolved);

create table photos (
  uuid text primary key,
  photo_uid text,                      -- aoPICのphotoUid（一般写真はnull）
  source_kind text not null check (source_kind in ('aopic', 'general')),
  sha256 text not null,
  bytes integer not null,
  width integer not null,
  height integer not null,
  orientation integer not null default 1,  -- EXIF Orientation（原寸は変更せず表示・PDFで補正）
  components integer not null default 3,   -- JPEGの色成分数（PDF埋込み用）
  adobe_cmyk integer not null default 0,
  taken_at text,
  taken_at_source text not null,           -- exif / aopic / file / unknown
  original_name text not null default '',
  folder_label text not null default '',
  import_batch_uuid text references import_batches(uuid),
  photo_number integer,                    -- 工事内の通し番号（取込み順）
  orig_koushu text not null default '',
  orig_shubetsu text not null default '',
  orig_saibetsu text not null default '',
  orig_sokuten text not null default '',
  orig_tekiyo text not null default '',
  aopic_json text,                         -- aoPICの元情報（boardSnapshot等）。作成後に変更しない
  exif_json text,                          -- 主要EXIF（撮影日時・機種等）
  thumb_state text not null default 'pending' check (thumb_state in ('pending', 'ready', 'failed')),
  created_at text not null,
  updated_at text not null,
  revision integer not null default 1,
  deleted_at text
);
create index photos_taken_idx on photos(taken_at, uuid) where deleted_at is null;
create index photos_sha_idx on photos(sha256);
create unique index photos_photo_uid_idx on photos(photo_uid) where photo_uid is not null;
create index photos_thumb_idx on photos(thumb_state) where thumb_state = 'pending';

-- 元分類を壊さない上書き。NULL = 元分類を使う、'' = 空欄にする
create table photo_overrides (
  photo_uuid text primary key references photos(uuid),
  koushu text, shubetsu text, saibetsu text, sokuten text, tekiyo text,
  updated_at text not null,
  revision integer not null default 1
);

-- 元aoPIC分類は上書きできないことをDBでも保証する
create trigger photos_immutable before update of uuid, sha256, bytes, photo_uid, source_kind,
  orig_koushu, orig_shubetsu, orig_saibetsu, orig_sokuten, orig_tekiyo, aopic_json on photos
begin
  select raise(abort, 'photo original fields are immutable');
end;

create table classification_templates (
  uuid text primary key,
  name text not null,
  values_json text not null,
  created_at text not null,
  updated_at text not null,
  revision integer not null default 1,
  deleted_at text
);

create table recent_classifications (
  values_json text primary key,
  used_at text not null
);

create table ledgers (
  uuid text primary key,
  title text not null,
  template text not null default 'construction-3',
  show_cover integer not null default 1,
  cover_json text not null default '{}',
  view_mode text not null default 'single' check (view_mode in ('single', 'spread')),
  created_at text not null,
  updated_at text not null,
  revision integer not null default 1,
  deleted_at text
);

create table ledger_pages (
  uuid text primary key,
  ledger_uuid text not null references ledgers(uuid),
  position real not null,                  -- 並べ替えは中間値。後続ページを書き換えない
  kind text not null default 'photo' check (kind in ('photo', 'blank')),
  created_at text not null,
  updated_at text not null,
  revision integer not null default 1,
  deleted_at text
);
create index ledger_pages_ledger_idx on ledger_pages(ledger_uuid, position) where deleted_at is null;

create table ledger_slots (
  uuid text primary key,
  page_uuid text not null references ledger_pages(uuid),
  ledger_uuid text not null references ledgers(uuid),
  slot_index integer not null check (slot_index between 0 and 2),
  kind text not null default 'empty' check (kind in ('empty', 'photo', 'blank')),
  photo_uuid text references photos(uuid),
  updated_at text not null,
  revision integer not null default 1,
  check ((kind = 'photo') = (photo_uuid is not null))
);
create unique index ledger_slots_page_idx on ledger_slots(page_uuid, slot_index);
-- 同じ台帳に同じ写真は1回だけ（現行のO(枠数^2)検査を索引1回へ）
create unique index ledger_slots_photo_once_idx on ledger_slots(ledger_uuid, photo_uuid) where photo_uuid is not null;
create index ledger_slots_photo_idx on ledger_slots(photo_uuid) where photo_uuid is not null;

-- 写真ごとの台帳文言。NULL = 自動（分類・aoPIC台帳文から）
create table ledger_captions (
  ledger_uuid text not null references ledgers(uuid),
  photo_uuid text not null references photos(uuid),
  koushu text, sokuten text, body text,
  updated_at text not null,
  revision integer not null default 1,
  primary key (ledger_uuid, photo_uuid)
);
"#;

pub fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    configure(&conn)?;
    Ok(conn)
}

pub fn configure(conn: &Connection) -> Result<()> {
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    // WALでは NORMAL でも電源断で破損しない（直近コミットが失われる可能性のみ）。終了時はcheckpointする
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(())
}

pub fn migrate(conn: &mut Connection) -> Result<()> {
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version > SCHEMA_VERSION {
        return Err(AppError::invalid("この工事は新しい版のアプリで作成されています。アプリを更新してください。")
            .with_detail(format!("schema {version} > {SCHEMA_VERSION}")));
    }
    if version < 1 {
        let tx = conn.transaction()?;
        tx.execute_batch(MIGRATION_1)?;
        tx.pragma_update(None, "user_version", 1)?;
        tx.commit()?;
    }
    Ok(())
}

pub fn get_meta(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn.query_row("select value from meta where key = ?1", [key], |r| r.get(0)).optional()?)
}

pub fn set_meta(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute("insert into meta(key, value) values(?1, ?2) on conflict(key) do update set value = excluded.value", params![key, value])?;
    Ok(())
}

pub fn meta_i64(conn: &Connection, key: &str) -> Result<i64> {
    Ok(get_meta(conn, key)?.and_then(|v| v.parse().ok()).unwrap_or(0))
}

/// 書込みのたびに増える編集番号。「この端末に取込ファイルより新しい編集があるか」の判定に使う。
pub fn bump_edit_seq(conn: &Connection) -> Result<i64> {
    let next = meta_i64(conn, "edit_seq")? + 1;
    set_meta(conn, "edit_seq", &next.to_string())?;
    Ok(next)
}

pub fn integrity_ok(conn: &Connection) -> Result<bool> {
    let r: String = conn.query_row("pragma quick_check", [], |r| r.get(0))?;
    let fk: Option<String> = conn.query_row("pragma foreign_key_check", [], |r| r.get(0)).optional()?;
    Ok(r == "ok" && fk.is_none())
}
