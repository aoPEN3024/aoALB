//! 写真分類。元分類（aoPIC等）は `photos.orig_*` に固定し、変更は `photo_overrides` に保持する。
//! 項目単位・全項目で元分類へ戻せる。元に戻す／やり直すは、変更前の上書き状態を返して画面側で保持する。

use crate::error::{AppError, Result};
use crate::photos::FIELDS;
use crate::project::Project;
use crate::util::{self, now};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const MAX_FIELD_CHARS: usize = 200;

/// 1項目の変更内容
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "mode", content = "value")]
pub enum FieldChange {
    /// この値にする（空文字＝空欄にする）
    Set(String),
    /// 元分類へ戻す
    Original,
}

/// 写真1枚の上書き状態（NULL＝元分類）。元に戻す用のスナップショット。
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OverrideState {
    pub photo_uuid: String,
    pub koushu: Option<String>,
    pub shubetsu: Option<String>,
    pub saibetsu: Option<String>,
    pub sokuten: Option<String>,
    pub tekiyo: Option<String>,
}
impl OverrideState {
    fn field_mut(&mut self, f: &str) -> &mut Option<String> {
        match f { "koushu" => &mut self.koushu, "shubetsu" => &mut self.shubetsu, "saibetsu" => &mut self.saibetsu, "sokuten" => &mut self.sokuten, _ => &mut self.tekiyo }
    }
}

fn load_state(conn: &Connection, photo: &str) -> Result<OverrideState> {
    Ok(conn.query_row("select koushu, shubetsu, saibetsu, sokuten, tekiyo from photo_overrides where photo_uuid = ?1", [photo], |r| Ok(OverrideState {
        photo_uuid: photo.into(), koushu: r.get(0)?, shubetsu: r.get(1)?, saibetsu: r.get(2)?, sokuten: r.get(3)?, tekiyo: r.get(4)?,
    })).optional()?.unwrap_or(OverrideState { photo_uuid: photo.into(), ..Default::default() }))
}

fn save_state(conn: &Connection, s: &OverrideState) -> Result<()> {
    if s.koushu.is_none() && s.shubetsu.is_none() && s.saibetsu.is_none() && s.sokuten.is_none() && s.tekiyo.is_none() {
        conn.execute("delete from photo_overrides where photo_uuid = ?1", [&s.photo_uuid])?;
    } else {
        conn.execute("insert into photo_overrides(photo_uuid, koushu, shubetsu, saibetsu, sokuten, tekiyo, updated_at) values(?1,?2,?3,?4,?5,?6,?7)
            on conflict(photo_uuid) do update set koushu = excluded.koushu, shubetsu = excluded.shubetsu, saibetsu = excluded.saibetsu,
            sokuten = excluded.sokuten, tekiyo = excluded.tekiyo, updated_at = excluded.updated_at, revision = photo_overrides.revision + 1",
            params![s.photo_uuid, s.koushu, s.shubetsu, s.saibetsu, s.sokuten, s.tekiyo, now()])?;
    }
    conn.execute("update photos set updated_at = ?2, revision = revision + 1 where uuid = ?1", params![s.photo_uuid, now()])?;
    Ok(())
}

/// 選択写真へ同じ変更を適用する。指定しない項目は変更しない。戻り値は変更前の状態（元に戻す用）。
pub fn apply(project: &mut Project, photo_uuids: &[String], changes: &BTreeMap<String, FieldChange>) -> Result<Vec<OverrideState>> {
    if photo_uuids.is_empty() { return Err(AppError::invalid("写真を選んでください。")); }
    for (k, v) in changes {
        if !FIELDS.contains(&k.as_str()) { return Err(AppError::invalid("分類の項目が正しくありません。")); }
        if let FieldChange::Set(s) = v { if s.chars().count() > MAX_FIELD_CHARS { return Err(AppError::invalid(format!("分類は{MAX_FIELD_CHARS}文字以内で入力してください。"))); } }
    }
    let tx = project.conn.transaction()?;
    let mut before = Vec::with_capacity(photo_uuids.len());
    for id in photo_uuids {
        let exists: bool = tx.query_row("select 1 from photos where uuid = ?1", [id], |_| Ok(())).optional()?.is_some();
        if !exists { return Err(AppError::not_found("写真が見つかりません。")); }
        let old = load_state(&tx, id)?;
        let orig: [String; 5] = tx.query_row("select orig_koushu, orig_shubetsu, orig_saibetsu, orig_sokuten, orig_tekiyo from photos where uuid = ?1", [id],
            |r| Ok([r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?]))?;
        let mut new = old.clone();
        for (k, v) in changes {
            let i = FIELDS.iter().position(|f| f == k).unwrap_or(0);
            *new.field_mut(k) = match v {
                FieldChange::Original => None,
                // 元分類と同じ値なら上書きを持たない（元分類と区別できなくなるのを防ぐ）
                FieldChange::Set(s) => { let s = s.trim().to_string(); if s == orig[i] { None } else { Some(s) } }
            };
        }
        if new != old { save_state(&tx, &new)?; }
        before.push(old);
    }
    record_recent(&tx, changes)?;
    Project::touch(&tx, &project.device_id)?;
    tx.commit()?;
    Ok(before)
}

/// 元に戻す・やり直す：保存しておいた上書き状態をそのまま書き戻す。戻り値は書き戻す直前の状態。
pub fn restore_states(project: &mut Project, states: &[OverrideState]) -> Result<Vec<OverrideState>> {
    let tx = project.conn.transaction()?;
    let mut before = Vec::with_capacity(states.len());
    for s in states {
        before.push(load_state(&tx, &s.photo_uuid)?);
        save_state(&tx, s)?;
    }
    Project::touch(&tx, &project.device_id)?;
    tx.commit()?;
    Ok(before)
}

fn record_recent(conn: &Connection, changes: &BTreeMap<String, FieldChange>) -> Result<()> {
    let values: BTreeMap<&String, &String> = changes.iter().filter_map(|(k, v)| match v { FieldChange::Set(s) if !s.trim().is_empty() => Some((k, s)), _ => None }).collect();
    if values.is_empty() { return Ok(()); }
    conn.execute("insert into recent_classifications(values_json, used_at) values(?1, ?2) on conflict(values_json) do update set used_at = excluded.used_at",
        params![serde_json::to_string(&values)?, now()])?;
    conn.execute("delete from recent_classifications where values_json not in (select values_json from recent_classifications order by used_at desc limit 20)", [])?;
    Ok(())
}

pub fn recent(conn: &Connection) -> Result<Vec<Value>> {
    let mut stmt = conn.prepare("select values_json from recent_classifications order by used_at desc limit 20")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    Ok(rows.filter_map(|r| r.ok()).filter_map(|s| serde_json::from_str(&s).ok()).collect())
}

/// 入力候補：工事内で使われている値（使用数順）
pub fn suggestions(conn: &Connection, field: &str) -> Result<Vec<String>> {
    if !FIELDS.contains(&field) { return Err(AppError::invalid("分類の項目が正しくありません。")); }
    let sql = format!("select v, count(*) c from (select coalesce(o.{field}, p.orig_{field}) v from photos p left join photo_overrides o on o.photo_uuid = p.uuid where p.deleted_at is null) where v <> '' group by v order by c desc, v limit 200");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Template { pub uuid: String, pub name: String, pub values: BTreeMap<String, String> }

pub fn save_template(project: &mut Project, uuid: Option<String>, name: &str, values: &BTreeMap<String, String>) -> Result<Template> {
    let name = name.trim();
    if name.is_empty() { return Err(AppError::invalid("テンプレート名を入力してください。")); }
    let values: BTreeMap<String, String> = values.iter().filter(|(k, _)| FIELDS.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.trim().to_string())).collect();
    let uuid = uuid.filter(|u| util::is_uuid(u)).unwrap_or_else(util::new_uuid);
    project.conn.execute("insert into classification_templates(uuid, name, values_json, created_at, updated_at) values(?1, ?2, ?3, ?4, ?4)
        on conflict(uuid) do update set name = excluded.name, values_json = excluded.values_json, updated_at = excluded.updated_at, revision = revision + 1, deleted_at = null",
        params![uuid, name, serde_json::to_string(&values)?, now()])?;
    Project::touch(&project.conn, &project.device_id)?;
    Ok(Template { uuid, name: name.into(), values })
}

pub fn delete_template(project: &mut Project, uuid: &str) -> Result<()> {
    project.conn.execute("update classification_templates set deleted_at = ?2, updated_at = ?2 where uuid = ?1", params![uuid, now()])?;
    Project::touch(&project.conn, &project.device_id)?;
    Ok(())
}

pub fn templates(conn: &Connection) -> Result<Vec<Template>> {
    let mut stmt = conn.prepare("select uuid, name, values_json from classification_templates where deleted_at is null order by name")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?;
    let mut out = Vec::new();
    for r in rows { let (uuid, name, v) = r?; out.push(Template { uuid, name, values: serde_json::from_str(&v).unwrap_or_default() }); }
    Ok(out)
}
