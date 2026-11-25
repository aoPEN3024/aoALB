//! 台帳。操作（op）単位で、変更したページ・枠だけを更新する。台帳全体の削除→再作成はしない。
//! 台帳の削除はごみ箱（`deleted_at`）で、写真には影響しない。

use crate::error::{AppError, Result};
use crate::project::Project;
use crate::util::{self, now};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashSet};

pub const SLOTS_PER_PAGE: i64 = 3;
pub const MAX_TITLE: usize = 200;
pub const MAX_FOLDER_NAME: usize = 100;
pub const MAX_FOLDERS: usize = 1000;
pub const FOLDERS_META_KEY: &str = "ledger_folders_v1";
pub const CAPTION_LIMITS: [(&str, usize); 3] = [("koushu", 200), ("sokuten", 200), ("body", 1000)];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Slot {
    pub uuid: String,
    pub index: i64,
    pub kind: String,
    pub photo_uuid: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub uuid: String,
    pub kind: String,
    pub position: f64,
    pub slots: Vec<Slot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Caption {
    pub koushu: Option<String>,
    pub sokuten: Option<String>,
    pub body: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerDetail {
    pub uuid: String,
    pub title: String,
    pub template: String,
    pub show_cover: bool,
    pub cover: Value,
    pub view_mode: String,
    pub created_at: String,
    pub updated_at: String,
    pub revision: i64,
    pub deleted_at: Option<String>,
    pub pages: Vec<Page>,
    pub captions: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerSummary {
    pub uuid: String,
    pub title: String,
    pub project_name: String,
    pub created_at: String,
    pub updated_at: String,
    pub page_count: i64,
    pub photo_count: i64,
    pub deleted_at: Option<String>,
    pub last_backup_at: Option<String>,
    pub folder_uuid: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LedgerFolder {
    pub uuid: String,
    pub name: String,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct LedgerFolderState {
    #[serde(default)]
    pub folders: Vec<LedgerFolder>,
    #[serde(default)]
    pub assignments: BTreeMap<String, String>,
}

fn check_folder_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() { return Err(AppError::invalid("フォルダ名を入力してください。")); }
    if name.chars().count() > MAX_FOLDER_NAME {
        return Err(AppError::invalid(format!("フォルダ名は{MAX_FOLDER_NAME}文字以内にしてください。")));
    }
    Ok(name.into())
}

/// 保存値または引継ぎファイルのフォルダ情報を検証する。
pub fn validate_folder_state(mut state: LedgerFolderState, allowed_ledgers: Option<&HashSet<String>>) -> Result<LedgerFolderState> {
    if state.folders.len() > MAX_FOLDERS || state.assignments.len() > 50_000 {
        return Err(AppError::invalid("台帳フォルダ情報が多すぎます。"));
    }
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    for (i, folder) in state.folders.iter_mut().enumerate() {
        if !util::is_uuid(&folder.uuid) || !ids.insert(folder.uuid.clone()) {
            return Err(AppError::invalid("台帳フォルダ情報が正しくありません。"));
        }
        folder.name = check_folder_name(&folder.name)?;
        if !names.insert(folder.name.to_lowercase()) {
            return Err(AppError::invalid("同じ名前の台帳フォルダがあります。"));
        }
        folder.position = i as i64;
    }
    state.assignments.retain(|ledger, folder| ids.contains(folder) && allowed_ledgers.map(|set| set.contains(ledger)).unwrap_or(true));
    Ok(state)
}

pub fn folder_state(conn: &Connection) -> Result<LedgerFolderState> {
    let Some(raw) = crate::db::get_meta(conn, FOLDERS_META_KEY)? else { return Ok(LedgerFolderState::default()); };
    let state: LedgerFolderState = serde_json::from_str(&raw).map_err(|_| AppError::corrupt("台帳フォルダ情報を読み取れません。"))?;
    validate_folder_state(state, None)
}

fn save_folder_state(conn: &Connection, state: &LedgerFolderState) -> Result<()> {
    crate::db::set_meta(conn, FOLDERS_META_KEY, &serde_json::to_string(state)?)
}

pub fn folders(conn: &Connection) -> Result<Vec<LedgerFolder>> { Ok(folder_state(conn)?.folders) }

pub fn create_folder(project: &mut Project, name: &str) -> Result<LedgerFolder> {
    let name = check_folder_name(name)?;
    let tx = project.conn.transaction()?;
    let mut state = folder_state(&tx)?;
    if state.folders.len() >= MAX_FOLDERS { return Err(AppError::invalid("台帳フォルダはこれ以上作れません。")); }
    if state.folders.iter().any(|f| f.name.eq_ignore_ascii_case(&name)) { return Err(AppError::invalid("同じ名前のフォルダがあります。")); }
    let folder = LedgerFolder { uuid: util::new_uuid(), name, position: state.folders.len() as i64 };
    state.folders.push(folder.clone());
    save_folder_state(&tx, &state)?;
    Project::touch(&tx, &project.device_id)?;
    tx.commit()?;
    Ok(folder)
}

pub fn rename_folder(project: &mut Project, uuid: &str, name: &str) -> Result<LedgerFolder> {
    let name = check_folder_name(name)?;
    let tx = project.conn.transaction()?;
    let mut state = folder_state(&tx)?;
    if state.folders.iter().any(|f| f.uuid != uuid && f.name.eq_ignore_ascii_case(&name)) { return Err(AppError::invalid("同じ名前のフォルダがあります。")); }
    let folder = state.folders.iter_mut().find(|f| f.uuid == uuid).ok_or_else(|| AppError::not_found("フォルダが見つかりません。"))?;
    folder.name = name;
    let result = folder.clone();
    save_folder_state(&tx, &state)?;
    Project::touch(&tx, &project.device_id)?;
    tx.commit()?;
    Ok(result)
}

/// フォルダだけを削除し、中の台帳は未分類へ戻す。
pub fn delete_folder(project: &mut Project, uuid: &str) -> Result<()> {
    let tx = project.conn.transaction()?;
    let mut state = folder_state(&tx)?;
    let before = state.folders.len();
    state.folders.retain(|f| f.uuid != uuid);
    if state.folders.len() == before { return Err(AppError::not_found("フォルダが見つかりません。")); }
    state.assignments.retain(|_, folder| folder != uuid);
    for (i, folder) in state.folders.iter_mut().enumerate() { folder.position = i as i64; }
    save_folder_state(&tx, &state)?;
    Project::touch(&tx, &project.device_id)?;
    tx.commit()?;
    Ok(())
}

pub fn move_to_folder(project: &mut Project, ledger_uuid: &str, folder_uuid: Option<&str>) -> Result<()> {
    let tx = project.conn.transaction()?;
    let exists: bool = tx.query_row("select exists(select 1 from ledgers where uuid = ?1 and deleted_at is null)", [ledger_uuid], |r| r.get(0))?;
    if !exists { return Err(AppError::not_found("台帳が見つかりません。")); }
    let mut state = folder_state(&tx)?;
    match folder_uuid.filter(|s| !s.is_empty()) {
        Some(folder) if state.folders.iter().any(|f| f.uuid == folder) => { state.assignments.insert(ledger_uuid.into(), folder.into()); }
        Some(_) => return Err(AppError::not_found("移動先のフォルダが見つかりません。")),
        None => { state.assignments.remove(ledger_uuid); }
    }
    save_folder_state(&tx, &state)?;
    Project::touch(&tx, &project.device_id)?;
    tx.commit()?;
    Ok(())
}

/// 画面から送られる操作。JSONでは `{"op": "Place", "slot": "...", "photo": "..."}` の形（画面側 ledger-model.js と同じ名前）。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op")]
pub enum Op {
    /// 写真を枠へ置く（同じ台帳の別枠にあれば移動、置き先に写真があれば入れ替え）
    Place {
        slot: String,
        photo: String,
    },
    /// 2枠の中身を入れ替える
    Swap {
        a: String,
        b: String,
    },
    /// 枠の中身を別の枠へ移す（移動先に写真があれば入れ替え）
    Move {
        from: String,
        to: String,
    },
    /// 枠を空にする（写真は未配置へ戻る）
    Clear {
        slot: String,
    },
    /// 空白枠にする／空白を解除する
    SetBlank {
        slot: String,
        blank: bool,
    },
    /// この枠の位置に空白枠を挿入し、後ろを1枠ずつ送る（次の空き枠で止まる）
    InsertBlank {
        slot: String,
    },
    /// この枠を詰める（後ろを1枠ずつ前へ）
    RemoveSlot {
        slot: String,
    },
    /// この枠から順に空き枠へ写真を置く（足りなければページを追加）
    PlaceMany {
        from: String,
        photos: Vec<String>,
    },
    /// ページ追加（uuidは画面側で採番してよい）
    AddPage {
        page: Option<String>,
        after: Option<String>,
        #[serde(default)]
        blank: bool,
    },
    DeletePage {
        page: String,
    },
    RestorePage {
        page: String,
    },
    /// ページを `after` の後ろへ（nullなら先頭）
    MovePage {
        page: String,
        after: Option<String>,
    },
    /// 元に戻す用：枠の中身をそのまま設定
    SetSlots {
        slots: Vec<Slot>,
    },
    /// 写真ごとの台帳文言。フィールドを省略＝変更なし、null＝自動
    SetCaption {
        photo: String,
        fields: Map<String, Value>,
    },
    SetTitle {
        title: String,
    },
    SetCover {
        cover: Value,
    },
    SetShowCover {
        show: bool,
    },
    SetViewMode {
        mode: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub detail: LedgerDetail,
    /// 実際に更新した枠・ページの数（性能確認用）
    pub changed_slots: usize,
    pub changed_pages: usize,
    /// 置けなかった写真（PlaceManyで既に配置済み等）
    pub skipped_photos: Vec<String>,
}

// ------------------------------------------------------------------ 読取り

pub fn list(conn: &Connection, trashed: bool) -> Result<Vec<LedgerSummary>> {
    let project_name: String = conn.query_row("select name from project", [], |r| r.get(0))?;
    let last_backup = crate::db::get_meta(conn, "last_backup_at")?;
    let folders = folder_state(conn)?;
    let mut stmt = conn.prepare(&format!("select l.uuid, l.title, l.created_at, l.updated_at, l.deleted_at,
        (select count(*) from ledger_pages p where p.ledger_uuid = l.uuid and p.deleted_at is null),
        (select count(*) from ledger_slots s join ledger_pages p on p.uuid = s.page_uuid where s.ledger_uuid = l.uuid and p.deleted_at is null and s.kind = 'photo')
        from ledgers l where l.deleted_at is {} null order by l.updated_at desc", if trashed { "not" } else { "" }))?;
    let rows = stmt.query_map([], |r| {
        let uuid: String = r.get(0)?;
        Ok(LedgerSummary {
            folder_uuid: folders.assignments.get(&uuid).cloned(),
            uuid,
            title: r.get(1)?,
            project_name: project_name.clone(),
            created_at: r.get(2)?,
            updated_at: r.get(3)?,
            deleted_at: r.get(4)?,
            page_count: r.get(5)?,
            photo_count: r.get(6)?,
            last_backup_at: last_backup.clone(),
        })
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

pub fn detail(conn: &Connection, uuid: &str) -> Result<LedgerDetail> {
    let (title, template, show_cover, cover, view_mode, created_at, updated_at, revision, deleted_at): (
        String,
        String,
        bool,
        String,
        String,
        String,
        String,
        i64,
        Option<String>,
    ) = conn
        .query_row(
            "select title, template, show_cover, cover_json, view_mode, created_at, updated_at, revision, deleted_at from ledgers where uuid = ?1",
            [uuid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("台帳が見つかりません。"))?;
    let mut pstmt = conn.prepare("select uuid, kind, position from ledger_pages where ledger_uuid = ?1 and deleted_at is null order by position")?;
    let mut pages: Vec<Page> = pstmt
        .query_map([uuid], |r| Ok(Page { uuid: r.get(0)?, kind: r.get(1)?, position: r.get(2)?, slots: vec![] }))?
        .collect::<std::result::Result<_, _>>()?;
    let mut sstmt = conn.prepare(
        "select s.page_uuid, s.uuid, s.slot_index, s.kind, s.photo_uuid from ledger_slots s join ledger_pages p on p.uuid = s.page_uuid
        where s.ledger_uuid = ?1 and p.deleted_at is null order by p.position, s.slot_index",
    )?;
    let mut idx: std::collections::HashMap<String, usize> = pages.iter().enumerate().map(|(i, p)| (p.uuid.clone(), i)).collect();
    for r in sstmt.query_map([uuid], |r| Ok((r.get::<_, String>(0)?, Slot { uuid: r.get(1)?, index: r.get(2)?, kind: r.get(3)?, photo_uuid: r.get(4)? })))? {
        let (page, slot) = r?;
        if let Some(i) = idx.get_mut(&page) {
            pages[*i].slots.push(slot);
        }
    }
    let mut cstmt = conn.prepare("select photo_uuid, koushu, sokuten, body from ledger_captions where ledger_uuid = ?1")?;
    let mut captions = Map::new();
    for r in cstmt.query_map([uuid], |r| Ok((r.get::<_, String>(0)?, Caption { koushu: r.get(1)?, sokuten: r.get(2)?, body: r.get(3)? })))? {
        let (p, c) = r?;
        captions.insert(p, serde_json::to_value(c)?);
    }
    Ok(LedgerDetail {
        uuid: uuid.into(),
        title,
        template,
        show_cover,
        cover: serde_json::from_str(&cover).unwrap_or(json!({})),
        view_mode,
        created_at,
        updated_at,
        revision,
        deleted_at,
        pages,
        captions,
    })
}

// ------------------------------------------------------------------ 作成・ごみ箱

pub fn create(project: &mut Project, title: &str, initial_pages: usize) -> Result<LedgerDetail> {
    let title = check_title(title)?;
    let info = project.info()?;
    let uuid = util::new_uuid();
    let ts = now();
    let cover = json!({"title": "工事写真帳", "koushu": "", "project": info.name, "contractor": info.contractor});
    let tx = project.conn.transaction()?;
    tx.execute("insert into ledgers(uuid, title, cover_json, created_at, updated_at) values(?1, ?2, ?3, ?4, ?4)", params![uuid, title, cover.to_string(), ts])?;
    for i in 0..initial_pages.max(1) {
        insert_page(&tx, &uuid, &util::new_uuid(), (i + 1) as f64, false)?;
    }
    Project::touch(&tx, &project.device_id)?;
    tx.commit()?;
    detail(&project.conn, &uuid)
}

fn check_title(title: &str) -> Result<String> {
    let t = title.trim();
    if t.is_empty() {
        return Err(AppError::invalid("台帳名を入力してください。"));
    }
    if t.chars().count() > MAX_TITLE {
        return Err(AppError::invalid(format!("台帳名は{MAX_TITLE}文字以内にしてください。")));
    }
    Ok(t.into())
}

fn insert_page(tx: &Transaction, ledger: &str, page: &str, position: f64, blank: bool) -> Result<()> {
    if !util::is_uuid(page) {
        return Err(AppError::invalid("ページの指定が正しくありません。"));
    }
    let ts = now();
    tx.execute(
        "insert into ledger_pages(uuid, ledger_uuid, position, kind, created_at, updated_at) values(?1, ?2, ?3, ?4, ?5, ?5)",
        params![page, ledger, position, if blank { "blank" } else { "photo" }, ts],
    )?;
    if !blank {
        for i in 0..SLOTS_PER_PAGE {
            tx.execute(
                "insert into ledger_slots(uuid, page_uuid, ledger_uuid, slot_index, kind, updated_at) values(?1, ?2, ?3, ?4, 'empty', ?5)",
                params![util::new_uuid(), page, ledger, i, ts],
            )?;
        }
    }
    Ok(())
}

pub fn trash(project: &mut Project, uuid: &str) -> Result<()> {
    let tx = project.conn.transaction()?;
    let n = tx
        .execute("update ledgers set deleted_at = ?2, updated_at = ?2, revision = revision + 1 where uuid = ?1 and deleted_at is null", params![uuid, now()])?;
    if n == 0 {
        return Err(AppError::not_found("台帳が見つかりません。"));
    }
    Project::touch(&tx, &project.device_id)?;
    tx.commit()?;
    Ok(())
}

pub fn restore(project: &mut Project, uuid: &str) -> Result<()> {
    let tx = project.conn.transaction()?;
    let n = tx.execute(
        "update ledgers set deleted_at = null, updated_at = ?2, revision = revision + 1 where uuid = ?1 and deleted_at is not null",
        params![uuid, now()],
    )?;
    if n == 0 {
        return Err(AppError::not_found("ごみ箱に台帳が見つかりません。"));
    }
    Project::touch(&tx, &project.device_id)?;
    tx.commit()?;
    Ok(())
}

/// ごみ箱の台帳を完全に削除する。写真・原寸ファイルは削除しない。
pub fn purge(project: &mut Project, uuid: &str) -> Result<()> {
    let tx = project.conn.transaction()?;
    let trashed: bool = tx.query_row("select deleted_at is not null from ledgers where uuid = ?1", [uuid], |r| r.get(0)).optional()?.unwrap_or(false);
    if !trashed {
        return Err(AppError::invalid("ごみ箱にある台帳だけ完全に削除できます。"));
    }
    let photos_before: i64 = tx.query_row("select count(*) from photos", [], |r| r.get(0))?;
    tx.execute("delete from ledger_captions where ledger_uuid = ?1", [uuid])?;
    tx.execute("delete from ledger_slots where ledger_uuid = ?1", [uuid])?;
    tx.execute("delete from ledger_pages where ledger_uuid = ?1", [uuid])?;
    tx.execute("delete from ledgers where uuid = ?1", [uuid])?;
    let mut folders = folder_state(&tx)?;
    folders.assignments.remove(uuid);
    save_folder_state(&tx, &folders)?;
    let photos_after: i64 = tx.query_row("select count(*) from photos", [], |r| r.get(0))?;
    if photos_before != photos_after {
        return Err(AppError::internal("purge changed photos"));
    }
    Project::touch(&tx, &project.device_id)?;
    tx.commit()?;
    Ok(())
}

pub fn duplicate(project: &mut Project, uuid: &str, title: &str) -> Result<LedgerDetail> {
    let src = detail(&project.conn, uuid)?;
    let title = check_title(title)?;
    let new = util::new_uuid();
    let ts = now();
    let tx = project.conn.transaction()?;
    tx.execute(
        "insert into ledgers(uuid, title, template, show_cover, cover_json, view_mode, created_at, updated_at) values(?1,?2,?3,?4,?5,?6,?7,?7)",
        params![new, title, src.template, src.show_cover, src.cover.to_string(), src.view_mode, ts],
    )?;
    for p in &src.pages {
        let pu = util::new_uuid();
        tx.execute(
            "insert into ledger_pages(uuid, ledger_uuid, position, kind, created_at, updated_at) values(?1, ?2, ?3, ?4, ?5, ?5)",
            params![pu, new, p.position, p.kind, ts],
        )?;
        for s in &p.slots {
            tx.execute(
                "insert into ledger_slots(uuid, page_uuid, ledger_uuid, slot_index, kind, photo_uuid, updated_at) values(?1,?2,?3,?4,?5,?6,?7)",
                params![util::new_uuid(), pu, new, s.index, s.kind, s.photo_uuid, ts],
            )?;
        }
    }
    tx.execute("insert into ledger_captions(ledger_uuid, photo_uuid, koushu, sokuten, body, updated_at) select ?1, photo_uuid, koushu, sokuten, body, ?3 from ledger_captions where ledger_uuid = ?2",
        params![new, uuid, ts])?;
    let mut folders = folder_state(&tx)?;
    if let Some(folder) = folders.assignments.get(uuid).cloned() {
        folders.assignments.insert(new.clone(), folder);
        save_folder_state(&tx, &folders)?;
    }
    Project::touch(&tx, &project.device_id)?;
    tx.commit()?;
    detail(&project.conn, &new)
}

// ------------------------------------------------------------------ 操作

struct SlotRow {
    uuid: String,
    kind: String,
    photo: Option<String>,
}

fn get_slot(tx: &Transaction, ledger: &str, slot: &str) -> Result<SlotRow> {
    tx.query_row(
        "select s.uuid, s.page_uuid, s.kind, s.photo_uuid from ledger_slots s join ledger_pages p on p.uuid = s.page_uuid
        where s.uuid = ?1 and s.ledger_uuid = ?2 and p.deleted_at is null",
        params![slot, ledger],
        |r| Ok(SlotRow { uuid: r.get(0)?, kind: r.get(2)?, photo: r.get(3)? }),
    )
    .optional()?
    .ok_or_else(|| AppError::not_found("枠が見つかりません。画面を最新にしてください。"))
}

struct Ctx<'a> {
    tx: &'a Transaction<'a>,
    ledger: &'a str,
    slots: usize,
    pages: usize,
    skipped: Vec<String>,
}

impl Ctx<'_> {
    fn write(&mut self, slot: &str, kind: &str, photo: Option<&str>) -> Result<()> {
        self.tx.execute("update ledger_slots set kind = ?2, photo_uuid = ?3, updated_at = ?4, revision = revision + 1 where uuid = ?1 and (kind <> ?2 or photo_uuid is not ?3)",
            params![slot, kind, photo, now()])?;
        self.slots += 1;
        Ok(())
    }
    /// 複数枠をまとめて書く（同じ写真の一時的な重複で一意制約に当たらないよう、先に全て空にする）
    fn write_many(&mut self, contents: &[(String, String, Option<String>)]) -> Result<()> {
        for (s, _, _) in contents {
            self.tx.execute("update ledger_slots set kind = 'empty', photo_uuid = null where uuid = ?1", [s])?;
        }
        for (s, k, p) in contents {
            self.write(s, k, p.as_deref())?;
        }
        Ok(())
    }
    fn check_photo(&self, photo: &str) -> Result<()> {
        let ok: Option<bool> = self.tx.query_row("select deleted_at is null from photos where uuid = ?1", [photo], |r| r.get(0)).optional()?;
        match ok {
            Some(true) => Ok(()),
            Some(false) => Err(AppError::invalid("ごみ箱にある写真は配置できません。")),
            None => Err(AppError::not_found("写真が見つかりません。")),
        }
    }
    fn slot_of_photo(&self, photo: &str) -> Result<Option<String>> {
        Ok(self
            .tx
            .query_row("select uuid from ledger_slots where ledger_uuid = ?1 and photo_uuid = ?2", params![self.ledger, photo], |r| r.get(0))
            .optional()?)
    }
    /// 有効なページの枠を順番に並べたもの
    fn ordered(&self) -> Result<Vec<(String, String, Option<String>)>> {
        let mut stmt = self.tx.prepare(
            "select s.uuid, s.kind, s.photo_uuid from ledger_slots s join ledger_pages p on p.uuid = s.page_uuid
            where s.ledger_uuid = ?1 and p.deleted_at is null and p.kind = 'photo' order by p.position, s.slot_index",
        )?;
        let rows = stmt.query_map([self.ledger], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    fn append_page(&mut self) -> Result<Vec<String>> {
        let max: f64 = self.tx.query_row("select coalesce(max(position), 0) from ledger_pages where ledger_uuid = ?1", [self.ledger], |r| r.get(0))?;
        let page = util::new_uuid();
        insert_page(self.tx, self.ledger, &page, max.floor() + 1.0, false)?;
        self.pages += 1;
        let mut stmt = self.tx.prepare("select uuid from ledger_slots where page_uuid = ?1 order by slot_index")?;
        let ids = stmt.query_map([&page], |r| r.get(0))?.collect::<std::result::Result<_, _>>()?;
        Ok(ids)
    }
    fn position_after(&self, after: Option<&str>, exclude: Option<&str>) -> Result<f64> {
        let mut stmt =
            self.tx.prepare("select uuid, position from ledger_pages where ledger_uuid = ?1 and deleted_at is null and uuid is not ?2 order by position")?;
        let list: Vec<(String, f64)> = stmt.query_map(params![self.ledger, exclude], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<std::result::Result<_, _>>()?;
        Ok(match after {
            None => list.first().map(|(_, p)| p - 1.0).unwrap_or(1.0),
            Some(a) => {
                let i = list.iter().position(|(u, _)| u == a).ok_or_else(|| AppError::not_found("ページが見つかりません。"))?;
                match list.get(i + 1) {
                    Some((_, next)) => (list[i].1 + next) / 2.0,
                    None => list[i].1 + 1.0,
                }
            }
        })
    }

    fn apply(&mut self, op: &Op) -> Result<()> {
        match op {
            Op::Place { slot, photo } => {
                self.check_photo(photo)?;
                let target = get_slot(self.tx, self.ledger, slot)?;
                match self.slot_of_photo(photo)? {
                    Some(cur) if cur == target.uuid => {}
                    Some(cur) => {
                        self.apply(&Op::Swap { a: cur, b: target.uuid })?;
                    }
                    None => {
                        if let Some(old) = &target.photo {
                            let _ = old;
                        }
                        self.write(&target.uuid, "photo", Some(photo))?;
                    }
                }
            }
            Op::Swap { a, b } | Op::Move { from: a, to: b } => {
                if a == b {
                    return Ok(());
                }
                let sa = get_slot(self.tx, self.ledger, a)?;
                let sb = get_slot(self.tx, self.ledger, b)?;
                self.write_many(&[(sa.uuid.clone(), sb.kind.clone(), sb.photo.clone()), (sb.uuid.clone(), sa.kind.clone(), sa.photo.clone())])?;
            }
            Op::Clear { slot } => {
                let s = get_slot(self.tx, self.ledger, slot)?;
                self.write(&s.uuid, "empty", None)?;
            }
            Op::SetBlank { slot, blank } => {
                let s = get_slot(self.tx, self.ledger, slot)?;
                if s.kind == "photo" {
                    return Err(AppError::invalid("写真がある枠は空白にできません。先に写真を外してください。"));
                }
                self.write(&s.uuid, if *blank { "blank" } else { "empty" }, None)?;
            }
            Op::InsertBlank { slot } => {
                let list = self.ordered()?;
                let i = list.iter().position(|(u, _, _)| u == slot).ok_or_else(|| AppError::not_found("枠が見つかりません。"))?;
                let mut ids: Vec<String> = list.iter().map(|x| x.0.clone()).collect();
                let mut contents: Vec<(String, Option<String>)> = list.iter().map(|x| (x.1.clone(), x.2.clone())).collect();
                // 後ろの最初の空き枠で送りを止める。なければページを追加
                let stop = match (i..contents.len()).find(|&k| contents[k].0 == "empty") {
                    Some(k) => k,
                    None => {
                        let new = self.append_page()?;
                        let k = ids.len();
                        for id in new {
                            ids.push(id);
                            contents.push(("empty".into(), None));
                        }
                        k
                    }
                };
                let mut out = Vec::new();
                for k in (i + 1..=stop).rev() {
                    out.push((ids[k].clone(), contents[k - 1].0.clone(), contents[k - 1].1.clone()));
                }
                out.push((ids[i].clone(), "blank".into(), None));
                self.write_many(&out)?;
            }
            Op::RemoveSlot { slot } => {
                let list = self.ordered()?;
                let i = list.iter().position(|(u, _, _)| u == slot).ok_or_else(|| AppError::not_found("枠が見つかりません。"))?;
                let stop = (i + 1..list.len()).find(|&k| list[k].1 == "empty").unwrap_or(list.len());
                let mut out = Vec::new();
                for k in i..stop {
                    let (kind, photo) = if k + 1 < stop { (list[k + 1].1.clone(), list[k + 1].2.clone()) } else { ("empty".into(), None) };
                    out.push((list[k].0.clone(), kind, photo));
                }
                self.write_many(&out)?;
            }
            Op::PlaceMany { from, photos } => {
                let list = self.ordered()?;
                let mut i = list.iter().position(|(u, _, _)| u == from).ok_or_else(|| AppError::not_found("枠が見つかりません。"))?;
                let mut free: Vec<String> = list[i..].iter().filter(|x| x.1 == "empty").map(|x| x.0.clone()).collect();
                i = 0;
                for p in photos {
                    self.check_photo(p)?;
                    if self.slot_of_photo(p)?.is_some() {
                        self.skipped.push(p.clone());
                        continue;
                    }
                    if i >= free.len() {
                        free.extend(self.append_page()?);
                    }
                    self.write(&free[i].clone(), "photo", Some(p))?;
                    i += 1;
                }
            }
            Op::AddPage { page, after, blank } => {
                let page = page.clone().unwrap_or_else(util::new_uuid);
                let pos = match after {
                    Some(_) => self.position_after(after.as_deref(), None)?,
                    None => {
                        let max: f64 = self.tx.query_row(
                            "select coalesce(max(position), 0) from ledger_pages where ledger_uuid = ?1 and deleted_at is null",
                            [self.ledger],
                            |r| r.get(0),
                        )?;
                        max + 1.0
                    }
                };
                insert_page(self.tx, self.ledger, &page, pos, *blank)?;
                self.pages += 1;
            }
            Op::DeletePage { page } => {
                let n = self.tx.execute("update ledger_pages set deleted_at = ?3, updated_at = ?3, revision = revision + 1 where uuid = ?1 and ledger_uuid = ?2 and deleted_at is null", params![page, self.ledger, now()])?;
                if n == 0 {
                    return Err(AppError::not_found("ページが見つかりません。"));
                }
                let alive: i64 =
                    self.tx.query_row("select count(*) from ledger_pages where ledger_uuid = ?1 and deleted_at is null", [self.ledger], |r| r.get(0))?;
                if alive == 0 {
                    return Err(AppError::invalid("最後の1ページは削除できません。"));
                }
                // 削除したページの写真は未配置へ戻す（元に戻す時は画面が SetSlots で戻す）
                self.slots += self.tx.execute("update ledger_slots set kind = 'empty', photo_uuid = null, updated_at = ?2, revision = revision + 1 where page_uuid = ?1 and kind <> 'empty'", params![page, now()])?;
                self.pages += 1;
            }
            Op::RestorePage { page } => {
                let n = self.tx.execute("update ledger_pages set deleted_at = null, updated_at = ?3, revision = revision + 1 where uuid = ?1 and ledger_uuid = ?2 and deleted_at is not null", params![page, self.ledger, now()])?;
                if n == 0 {
                    return Err(AppError::not_found("ページが見つかりません。"));
                }
                self.pages += 1;
            }
            Op::MovePage { page, after } => {
                if after.as_deref() == Some(page.as_str()) {
                    return Ok(());
                }
                let pos = self.position_after(after.as_deref(), Some(page))?;
                let n = self.tx.execute("update ledger_pages set position = ?3, updated_at = ?4, revision = revision + 1 where uuid = ?1 and ledger_uuid = ?2 and deleted_at is null", params![page, self.ledger, pos, now()])?;
                if n == 0 {
                    return Err(AppError::not_found("ページが見つかりません。"));
                }
                self.pages += 1;
            }
            Op::SetSlots { slots } => {
                let mut out = Vec::new();
                for s in slots {
                    let cur = get_slot(self.tx, self.ledger, &s.uuid)?;
                    if !["empty", "photo", "blank"].contains(&s.kind.as_str()) || (s.kind == "photo") != s.photo_uuid.is_some() {
                        return Err(AppError::invalid("枠の内容が正しくありません。"));
                    }
                    if let Some(p) = &s.photo_uuid {
                        self.check_photo(p)?;
                    }
                    if cur.kind != s.kind || cur.photo != s.photo_uuid {
                        out.push((cur.uuid, s.kind.clone(), s.photo_uuid.clone()));
                    }
                }
                self.write_many(&out)?;
            }
            Op::SetCaption { photo, fields } => {
                let mut c: Caption = self
                    .tx
                    .query_row(
                        "select koushu, sokuten, body from ledger_captions where ledger_uuid = ?1 and photo_uuid = ?2",
                        params![self.ledger, photo],
                        |r| Ok(Caption { koushu: r.get(0)?, sokuten: r.get(1)?, body: r.get(2)? }),
                    )
                    .optional()?
                    .unwrap_or_default();
                for (k, v) in fields {
                    let limit =
                        CAPTION_LIMITS.iter().find(|(n, _)| n == k).map(|(_, l)| *l).ok_or_else(|| AppError::invalid("文言の項目が正しくありません。"))?;
                    let val = match v {
                        Value::Null => None,
                        Value::String(s) => {
                            if s.chars().count() > limit {
                                return Err(AppError::invalid(format!("文言は{limit}文字以内にしてください。")));
                            }
                            Some(s.clone())
                        }
                        _ => return Err(AppError::invalid("文言が正しくありません。")),
                    };
                    match k.as_str() {
                        "koushu" => c.koushu = val,
                        "sokuten" => c.sokuten = val,
                        _ => c.body = val,
                    }
                }
                self.check_photo(photo).or_else(|e| if e.kind == crate::error::ErrorKind::Invalid { Ok(()) } else { Err(e) })?;
                if c.koushu.is_none() && c.sokuten.is_none() && c.body.is_none() {
                    self.tx.execute("delete from ledger_captions where ledger_uuid = ?1 and photo_uuid = ?2", params![self.ledger, photo])?;
                } else {
                    self.tx.execute("insert into ledger_captions(ledger_uuid, photo_uuid, koushu, sokuten, body, updated_at) values(?1,?2,?3,?4,?5,?6)
                        on conflict(ledger_uuid, photo_uuid) do update set koushu = excluded.koushu, sokuten = excluded.sokuten, body = excluded.body, updated_at = excluded.updated_at, revision = ledger_captions.revision + 1",
                        params![self.ledger, photo, c.koushu, c.sokuten, c.body, now()])?;
                }
            }
            Op::SetTitle { title } => {
                let t = check_title(title)?;
                self.tx.execute("update ledgers set title = ?2 where uuid = ?1", params![self.ledger, t])?;
            }
            Op::SetCover { cover } => {
                let mut out = Map::new();
                for k in ["title", "koushu", "project", "contractor"] {
                    let v = cover.get(k).and_then(|v| v.as_str()).unwrap_or("");
                    if v.chars().count() > 300 {
                        return Err(AppError::invalid("表紙の文字が長すぎます。"));
                    }
                    out.insert(k.into(), json!(v));
                }
                self.tx.execute("update ledgers set cover_json = ?2 where uuid = ?1", params![self.ledger, Value::Object(out).to_string()])?;
            }
            Op::SetShowCover { show } => {
                self.tx.execute("update ledgers set show_cover = ?2 where uuid = ?1", params![self.ledger, show])?;
            }
            Op::SetViewMode { mode } => {
                if mode != "single" && mode != "spread" {
                    return Err(AppError::invalid("表示方法が正しくありません。"));
                }
                self.tx.execute("update ledgers set view_mode = ?2 where uuid = ?1", params![self.ledger, mode])?;
            }
        }
        Ok(())
    }
}

/// 操作をまとめて1トランザクションで適用する。途中で失敗したら全て取り消す。
pub fn apply_ops(project: &mut Project, ledger: &str, ops: &[Op]) -> Result<ApplyResult> {
    let tx = project.conn.transaction()?;
    let trashed: Option<bool> = tx.query_row("select deleted_at is not null from ledgers where uuid = ?1", [ledger], |r| r.get(0)).optional()?;
    match trashed {
        None => return Err(AppError::not_found("台帳が見つかりません。")),
        Some(true) => return Err(AppError::invalid("ごみ箱の台帳は編集できません。先に復元してください。")),
        _ => {}
    }
    let (slots, pages, skipped) = {
        let mut ctx = Ctx { tx: &tx, ledger, slots: 0, pages: 0, skipped: vec![] };
        for op in ops {
            ctx.apply(op)?;
        }
        (ctx.slots, ctx.pages, ctx.skipped)
    };
    tx.execute("update ledgers set updated_at = ?2, revision = revision + 1 where uuid = ?1", params![ledger, now()])?;
    Project::touch(&tx, &project.device_id)?;
    tx.commit()?;
    Ok(ApplyResult { detail: detail(&project.conn, ledger)?, changed_slots: slots, changed_pages: pages, skipped_photos: skipped })
}
