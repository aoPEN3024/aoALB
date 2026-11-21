//! 自動検証（架空データのみ）。`cargo test` で実行する。

use aoalb_core::classify::{self, FieldChange};
use aoalb_core::exchange::{self, ImportMode};
use aoalb_core::ledger::{self, Op};
use aoalb_core::photos::{self, ImportOptions, ImportSource, PhotoFilter};
use aoalb_core::project::{self, NewProject, Project};
use aoalb_core::util::{self, Cancel, Progress};
use aoalb_core::{backup, db, pdf, synth, ErrorKind};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const DEV: &str = "test-device-a";
fn np(name: &str) -> NewProject { NewProject { name: name.into(), kouji_code: "K-1".into(), contractor: "架空建設".into() } }
fn noop() -> impl FnMut(Progress) { |_| {} }

fn write_photos(dir: &Path, n: usize) -> Vec<PathBuf> {
    fs::create_dir_all(dir).unwrap();
    let base = synth::jpeg(800, 600, 3, 80);
    (0..n).map(|i| {
        let p = dir.join(format!("IMG_{i:04}.JPG"));
        let b = synth::with_exif(&synth::with_comment(&base, &format!("g{i}")), Some(&format!("2026:10:{:02} 10:{:02}:00", 1 + i % 28, i % 60)), Some(if i % 5 == 0 { 6 } else { 1 }));
        fs::write(&p, b).unwrap();
        p
    }).collect()
}

fn new_project(tmp: &Path, name: &str) -> Project { project::create_project(&tmp.join("data"), &np(name), DEV).unwrap() }

fn import_files(p: &mut Project, files: Vec<PathBuf>) -> photos::ImportResult {
    photos::import(p, &ImportSource::Files { paths: files }, ImportOptions::default(), &Cancel::new(), &mut noop()).unwrap()
}

fn originals_hashes(p: &Project) -> BTreeMap<String, String> {
    let mut m = BTreeMap::new();
    for e in fs::read_dir(p.originals_dir()).unwrap() { let e = e.unwrap().path(); m.insert(e.file_name().unwrap().to_string_lossy().to_string(), synth::sha256(&fs::read(&e).unwrap())); }
    m
}

#[test]
fn migration_and_integrity() {
    let t = tempfile::tempdir().unwrap();
    let p = new_project(t.path(), "架空工事");
    let v: i64 = p.conn.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
    assert_eq!(v, db::SCHEMA_VERSION);
    assert!(db::integrity_ok(&p.conn).unwrap());
    for d in ["originals", "thumbnails", "exports", "backups", "tmp"] { assert!(p.root.join(d).is_dir()); }
}

#[test]
fn same_name_projects_are_distinct_and_lock_prevents_double_open() {
    let t = tempfile::tempdir().unwrap();
    let a = new_project(t.path(), "同名工事");
    let b = new_project(t.path(), "同名工事");
    assert_ne!(a.uuid, b.uuid);
    assert_ne!(a.root, b.root);
    let e = project::open_project(&a.root, DEV).err().unwrap();
    assert_eq!(e.kind, ErrorKind::Locked);
    let root = a.root.clone();
    a.close().unwrap();
    let (again, _) = project::open_project(&root, DEV).unwrap();
    again.close().unwrap();
}

#[test]
fn folder_can_be_moved_and_reopened() {
    let t = tempfile::tempdir().unwrap();
    let mut p = new_project(t.path(), "移動工事");
    import_files(&mut p, write_photos(&t.path().join("src"), 3));
    let uuid = p.uuid.clone();
    let root = p.root.clone();
    p.close().unwrap();
    let moved = t.path().join("外付けSSD").join("名前を変えたフォルダ");
    fs::create_dir_all(moved.parent().unwrap()).unwrap();
    fs::rename(&root, &moved).unwrap();
    let (p, _) = project::open_project(&moved, DEV).unwrap();
    assert_eq!(p.uuid, uuid);
    assert_eq!(photos::list_photos(&p.conn, &PhotoFilter::default()).unwrap().len(), 3);
}

#[test]
fn import_general_jpeg_keeps_original_bytes_and_detects_duplicates() {
    let t = tempfile::tempdir().unwrap();
    let mut p = new_project(t.path(), "取込工事");
    let files = write_photos(&t.path().join("src"), 6);
    let src_hashes: Vec<String> = files.iter().map(|f| synth::sha256(&fs::read(f).unwrap())).collect();
    // 壊れたJPEG・非対応形式を混ぜる
    let broken = t.path().join("src").join("broken.jpg");
    fs::write(&broken, b"\xFF\xD8\xFFnot really a jpeg").unwrap();
    let heic = t.path().join("src").join("a.heic");
    fs::write(&heic, b"....").unwrap();
    let mut all = files.clone();
    all.push(broken);
    all.push(heic);
    let r = import_files(&mut p, all);
    assert_eq!(r.accepted, 6);
    assert_eq!(r.failed, 2);
    // 原寸はバイト単位で同一
    let stored: Vec<String> = originals_hashes(&p).into_values().collect();
    for h in &src_hashes { assert!(stored.contains(h)); }
    let list = photos::list_photos(&p.conn, &PhotoFilter::default()).unwrap();
    assert!(list.iter().all(|x| x.source_kind == "general" && x.classification.is_empty() && x.taken_at_source == "exif"));
    assert!(list.iter().any(|x| x.orientation == 6));
    // 重複は既定で取り込まない
    let r2 = import_files(&mut p, files[..2].to_vec());
    assert_eq!((r2.accepted, r2.duplicates), (0, 2));
    // 失敗分だけ再試行（重複も取り込む指定）
    let ids: Vec<i64> = r2.failures.iter().map(|f| f.id).collect();
    let r3 = photos::retry_failures(&mut p, &ids, ImportOptions { allow_duplicates: true }, &Cancel::new(), &mut noop()).unwrap();
    assert_eq!(r3.accepted, 2);
    // 一時ファイルが残っていない
    assert_eq!(fs::read_dir(p.tmp_dir()).unwrap().count(), 0);
}

#[test]
fn same_photo_can_be_imported_into_another_project() {
    let t = tempfile::tempdir().unwrap();
    let files = write_photos(&t.path().join("src"), 2);
    let mut a = new_project(t.path(), "工事A");
    let mut b = new_project(t.path(), "工事B");
    assert_eq!(import_files(&mut a, files.clone()).accepted, 2);
    assert_eq!(import_files(&mut b, files).accepted, 2);
}

#[test]
fn folder_and_zip_import_with_cancel() {
    let t = tempfile::tempdir().unwrap();
    let mut p = new_project(t.path(), "フォルダ工事");
    write_photos(&t.path().join("SD").join("DCIM").join("100CANON"), 4);
    let r = photos::import(&mut p, &ImportSource::Folder { path: t.path().join("SD") }, ImportOptions::default(), &Cancel::new(), &mut noop()).unwrap();
    assert_eq!(r.accepted, 4);
    let folders = photos::folder_labels(&p.conn).unwrap();
    assert!(folders[0].folder_label.ends_with("100CANON"));
    // 通常ZIP
    let zip_path = t.path().join("normal.zip");
    {
        let mut z = zip::ZipWriter::new(fs::File::create(&zip_path).unwrap());
        let o = zip::write::SimpleFileOptions::default();
        for i in 0..3 { z.start_file(format!("現場/日付{i}/p{i}.jpg"), o).unwrap(); z.write_all(&synth::with_comment(&synth::jpeg(320, 240, i, 70), &format!("z{i}"))).unwrap(); }
        z.start_file("../evil.jpg", o).unwrap(); z.write_all(&synth::jpeg(10, 10, 1, 50)).unwrap();
        z.start_file("readme.exe", o).unwrap(); z.write_all(b"MZ").unwrap();
        z.finish().unwrap();
    }
    let r = photos::import(&mut p, &ImportSource::Zip { path: zip_path }, ImportOptions::default(), &Cancel::new(), &mut noop()).unwrap();
    assert_eq!(r.accepted, 4); // "../evil.jpg" も名前は使わず中身だけ取り込む（パスへ書き出さない）
    assert!(!t.path().join("evil.jpg").exists());
    // キャンセル：取り込み済みは残り、途中の一時ファイルは残らない
    let cancel = Cancel::new();
    cancel.cancel();
    let files = write_photos(&t.path().join("later"), 3);
    let r = photos::import(&mut p, &ImportSource::Files { paths: files }, ImportOptions::default(), &cancel, &mut noop()).unwrap();
    assert!(r.cancelled);
    assert_eq!(r.accepted, 0);
    assert_eq!(fs::read_dir(p.tmp_dir()).unwrap().count(), 0);
}

#[test]
fn aopic_zip_keeps_metadata_and_classification_override_is_reversible() {
    let t = tempfile::tempdir().unwrap();
    let mut p = new_project(t.path(), "aoPIC工事");
    let zip_path = t.path().join("aopic.zip");
    let files = synth::aopic_zip(&zip_path, 5);
    let r = photos::import(&mut p, &ImportSource::Zip { path: zip_path.clone() }, ImportOptions::default(), &Cancel::new(), &mut noop()).unwrap();
    assert_eq!(r.accepted, 5);
    assert_eq!(r.aopic_project.as_ref().unwrap()["name"], "架空橋梁塗装工事");
    let before = originals_hashes(&p);
    for (uid, bytes) in &files {
        let row = photos::list_photos(&p.conn, &PhotoFilter::default()).unwrap().into_iter().find(|x| x.photo_uid.as_deref() == Some(uid)).unwrap();
        assert_eq!(row.source_kind, "aopic");
        let d = photos::photo_detail(&p, &row.uuid).unwrap();
        assert_eq!(d.sha256, synth::sha256(bytes));
        let a = d.aopic.unwrap();
        assert_eq!(a["boardSnapshot"]["koujimei"], "架空橋梁塗装工事");
        assert!(a["ledger"]["title"].as_str().unwrap().starts_with("架空台帳タイトル"));
        assert_eq!(row.classification.koushu, "塗装工");
        assert!(row.ledger_text.starts_with("架空台帳タイトル"));
    }
    // 一括で種別を変更、測点を空欄に
    let ids: Vec<String> = photos::list_photos(&p.conn, &PhotoFilter::default()).unwrap().into_iter().map(|x| x.uuid).collect();
    let mut ch = BTreeMap::new();
    ch.insert("shubetsu".to_string(), FieldChange::Set("鋼橋塗替".into()));
    ch.insert("sokuten".to_string(), FieldChange::Set(String::new()));
    let undo = classify::apply(&mut p, &ids, &ch).unwrap();
    let rows = photos::list_photos(&p.conn, &PhotoFilter::default()).unwrap();
    assert!(rows.iter().all(|x| x.classification.shubetsu == "鋼橋塗替" && x.classification.sokuten.is_empty() && x.original.shubetsu == "橋梁塗装"));
    assert!(rows.iter().all(|x| x.overridden == vec!["shubetsu", "sokuten"]));
    // 元のaoPIC情報・JPEGは変わらない
    assert_eq!(before, originals_hashes(&p));
    let a: String = p.conn.query_row("select aopic_json from photos where uuid = ?1", [&ids[0]], |r| r.get(0)).unwrap();
    assert!(a.contains("橋梁塗装"));
    // DBでも元分類は書き換え不可
    assert!(p.conn.execute("update photos set orig_shubetsu = 'x' where uuid = ?1", [&ids[0]]).is_err());
    // 項目単位で元分類へ戻す
    let mut back = BTreeMap::new();
    back.insert("sokuten".to_string(), FieldChange::Original);
    classify::apply(&mut p, &ids[..1].to_vec(), &back).unwrap();
    let r0 = photos::list_photos(&p.conn, &PhotoFilter { uuids: Some(vec![ids[0].clone()]), ..Default::default() }).unwrap().remove(0);
    assert!(r0.classification.sokuten.starts_with('P'));
    assert_eq!(r0.overridden, vec!["shubetsu"]);
    // 元に戻す（一括変更前へ）
    classify::restore_states(&mut p, &undo).unwrap();
    let rows = photos::list_photos(&p.conn, &PhotoFilter::default()).unwrap();
    assert!(rows.iter().all(|x| x.overridden.is_empty() && x.classification == x.original));
    // 未分類の絞込み
    assert_eq!(photos::list_photos(&p.conn, &PhotoFilter { unclassified_only: true, ..Default::default() }).unwrap().len(), 0);
    // 同じZIPを再度取り込むと重複として案内
    let r = photos::import(&mut p, &ImportSource::Zip { path: zip_path }, ImportOptions::default(), &Cancel::new(), &mut noop()).unwrap();
    assert_eq!((r.accepted, r.duplicates), (0, 5));
}

fn ledger_with_photos(t: &Path, n: usize) -> (Project, String, Vec<String>) {
    let mut p = new_project(t, "台帳工事");
    import_files(&mut p, write_photos(&t.join("src"), n));
    let ids: Vec<String> = photos::list_photos(&p.conn, &PhotoFilter::default()).unwrap().into_iter().map(|x| x.uuid).collect();
    let l = ledger::create(&mut p, "第1回 台帳", 1).unwrap();
    (p, l.uuid, ids)
}

fn slot_ids(d: &ledger::LedgerDetail) -> Vec<String> { d.pages.iter().flat_map(|p| p.slots.iter().map(|s| s.uuid.clone())).collect() }
fn contents(d: &ledger::LedgerDetail) -> Vec<Option<String>> { d.pages.iter().flat_map(|p| p.slots.iter().map(|s| if s.kind == "blank" { Some("BLANK".into()) } else { s.photo_uuid.clone() })).collect() }

#[test]
fn ledger_place_swap_move_blank_pages_and_incremental_writes() {
    let t = tempfile::tempdir().unwrap();
    let (mut p, l, ids) = ledger_with_photos(t.path(), 7);
    let d = ledger::detail(&p.conn, &l).unwrap();
    let s = slot_ids(&d);
    // 1枚配置：更新は1枠だけ
    let r = ledger::apply_ops(&mut p, &l, &[Op::Place { slot: s[0].clone(), photo: ids[0].clone() }]).unwrap();
    assert_eq!(r.changed_slots, 1);
    let slot_rev: i64 = p.conn.query_row("select revision from ledger_slots where uuid = ?1", [&s[1]], |r| r.get(0)).unwrap();
    assert_eq!(slot_rev, 1, "触っていない枠は書き換えない");
    // 連続配置：足りない分はページ追加
    let r = ledger::apply_ops(&mut p, &l, &[Op::PlaceMany { from: s[1].clone(), photos: ids[1..6].to_vec() }]).unwrap();
    assert_eq!(r.detail.pages.len(), 2);
    let c = contents(&r.detail);
    assert_eq!(c[..6].iter().map(|x| x.clone().unwrap()).collect::<Vec<_>>(), ids[..6].to_vec());
    let s = slot_ids(&r.detail);
    // 入替え
    let r = ledger::apply_ops(&mut p, &l, &[Op::Swap { a: s[0].clone(), b: s[4].clone() }]).unwrap();
    let c = contents(&r.detail);
    assert_eq!((c[0].clone().unwrap(), c[4].clone().unwrap()), (ids[4].clone(), ids[0].clone()));
    // 同じ写真を別枠へPlace＝移動（重複配置しない）
    let r = ledger::apply_ops(&mut p, &l, &[Op::Place { slot: s[5].clone(), photo: ids[1].clone() }]).unwrap();
    let c = contents(&r.detail);
    assert_eq!(c.iter().filter(|x| x.as_deref() == Some(ids[1].as_str())).count(), 1);
    // 空白挿入→後ろへ送る、空白削除→詰める
    let before = contents(&ledger::detail(&p.conn, &l).unwrap());
    let r = ledger::apply_ops(&mut p, &l, &[Op::InsertBlank { slot: s[1].clone() }]).unwrap();
    let c = contents(&r.detail);
    assert_eq!(c[1].as_deref(), Some("BLANK"));
    assert_eq!(c[2], before[1]);
    let r = ledger::apply_ops(&mut p, &l, &[Op::RemoveSlot { slot: s[1].clone() }]).unwrap();
    assert_eq!(contents(&r.detail)[..6], before[..6]);
    // 未配置へ戻す
    let r = ledger::apply_ops(&mut p, &l, &[Op::Clear { slot: s[0].clone() }]).unwrap();
    assert!(contents(&r.detail)[0].is_none());
    let unplaced = photos::list_photos(&p.conn, &PhotoFilter { ledger_uuid: Some(l.clone()), unplaced_only: true, ..Default::default() }).unwrap();
    assert!(unplaced.iter().any(|x| x.uuid == before[0].clone().unwrap()));
    // ページ追加（空白ページ）・並べ替え・削除・復元
    let d = ledger::detail(&p.conn, &l).unwrap();
    let blank = util::new_uuid();
    let r = ledger::apply_ops(&mut p, &l, &[Op::AddPage { page: Some(blank.clone()), after: Some(d.pages[0].uuid.clone()), blank: true }]).unwrap();
    assert_eq!(r.detail.pages[1].uuid, blank);
    assert_eq!(r.detail.pages[1].kind, "blank");
    let r = ledger::apply_ops(&mut p, &l, &[Op::MovePage { page: blank.clone(), after: None }]).unwrap();
    assert_eq!(r.detail.pages[0].uuid, blank);
    let r = ledger::apply_ops(&mut p, &l, &[Op::DeletePage { page: blank.clone() }]).unwrap();
    assert!(r.detail.pages.iter().all(|x| x.uuid != blank));
    let r = ledger::apply_ops(&mut p, &l, &[Op::RestorePage { page: blank.clone() }]).unwrap();
    assert!(r.detail.pages.iter().any(|x| x.uuid == blank));
    // 失敗した操作はまとめて取り消される
    let bad = ledger::apply_ops(&mut p, &l, &[Op::Clear { slot: s[2].clone() }, Op::Place { slot: s[2].clone(), photo: util::new_uuid() }]);
    assert!(bad.is_err());
    assert!(contents(&ledger::detail(&p.conn, &l).unwrap()).contains(&before[2]));
    // 台帳名・文言・表紙
    let mut f = serde_json::Map::new();
    f.insert("body".into(), serde_json::json!("手入力の台帳文"));
    let r = ledger::apply_ops(&mut p, &l, &[Op::SetTitle { title: "第1回 出来形".into() }, Op::SetCaption { photo: ids[2].clone(), fields: f },
        Op::SetCover { cover: serde_json::json!({"title": "工事写真帳", "project": "架空工事", "contractor": "架空建設", "koushu": "塗装工"}) }]).unwrap();
    assert_eq!(r.detail.title, "第1回 出来形");
    assert_eq!(r.detail.captions[&ids[2]]["body"], "手入力の台帳文");
    // 長すぎる文言は拒否
    let mut f = serde_json::Map::new();
    f.insert("body".into(), serde_json::json!("あ".repeat(1001)));
    assert!(ledger::apply_ops(&mut p, &l, &[Op::SetCaption { photo: ids[2].clone(), fields: f }]).is_err());
}

#[test]
fn ledger_trash_restore_purge_never_touch_photos() {
    let t = tempfile::tempdir().unwrap();
    let (mut p, l, ids) = ledger_with_photos(t.path(), 4);
    let s = slot_ids(&ledger::detail(&p.conn, &l).unwrap());
    ledger::apply_ops(&mut p, &l, &[Op::PlaceMany { from: s[0].clone(), photos: ids.clone() }]).unwrap();
    let copy = ledger::duplicate(&mut p, &l, "複製した台帳").unwrap();
    assert_eq!(contents(&copy).iter().flatten().count(), 4);
    let hashes = originals_hashes(&p);
    backup::create(&p, backup::Reason::BeforeLedgerDelete).unwrap();
    ledger::trash(&mut p, &l).unwrap();
    assert_eq!(ledger::list(&p.conn, false).unwrap().len(), 1);
    assert_eq!(ledger::list(&p.conn, true).unwrap().len(), 1);
    assert!(ledger::apply_ops(&mut p, &l, &[Op::Clear { slot: s[0].clone() }]).is_err(), "ごみ箱の台帳は編集不可");
    assert_eq!(photos::list_photos(&p.conn, &PhotoFilter::default()).unwrap().len(), 4);
    ledger::restore(&mut p, &l).unwrap();
    assert_eq!(contents(&ledger::detail(&p.conn, &l).unwrap()).iter().flatten().count(), 4, "復元後も配置が残る");
    ledger::trash(&mut p, &l).unwrap();
    ledger::purge(&mut p, &l).unwrap();
    assert_eq!(photos::list_photos(&p.conn, &PhotoFilter::default()).unwrap().len(), 4);
    assert_eq!(hashes, originals_hashes(&p));
    // 配置中の写真はごみ箱へ入れられない（複製台帳に配置中）
    assert!(photos::trash_photos(&mut p, &ids[..1].to_vec()).is_err());
}

#[test]
fn crash_recovery_detects_and_cleans() {
    let t = tempfile::tempdir().unwrap();
    let mut p = new_project(t.path(), "異常終了工事");
    import_files(&mut p, write_photos(&t.path().join("src"), 3));
    let root = p.root.clone();
    let rows = photos::list_photos(&p.conn, &PhotoFilter::default()).unwrap();
    photos::process_pending_thumbnails(&p.conn, &root, 100, &Cancel::new()).unwrap();
    // 異常終了を再現：closeせずに破棄し、作業途中のファイルと消えたサムネイルを作る
    fs::write(root.join("tmp").join("abc.partial"), b"half").unwrap();
    fs::write(root.join("originals").join(".x.jpg.123.partial"), b"half").unwrap();
    fs::remove_file(root.join("thumbnails").join(format!("{}.jpg", rows[0].uuid))).unwrap();
    std::mem::forget(p); // 終了処理なし（ロックはプロセス内なので解放のため別手段を取る）
    // forgetしたロックは同一プロセスでは保持され続けるため、ロックファイルを複製先で開き直す
    let copy = t.path().join("copy");
    copy_dir(&root, &copy);
    let (p, report) = project::open_project(&copy, DEV).unwrap();
    assert!(report.recovered_after_crash);
    assert!(report.integrity_ok);
    assert_eq!(report.cleaned_temp_files, 2);
    assert_eq!(report.missing_thumbnails, 1);
    assert!(report.missing_originals.is_empty());
    assert_eq!(photos::process_pending_thumbnails(&p.conn, &copy, 100, &Cancel::new()).unwrap(), 1);
}

fn copy_dir(src: &Path, dst: &Path) {
    fs::create_dir_all(dst).unwrap();
    for e in fs::read_dir(src).unwrap() {
        let e = e.unwrap();
        if e.file_name() == ".aoalb.lock" { continue; } // Windowsではロック中のファイルを読めない
        let to = dst.join(e.file_name());
        if e.file_type().unwrap().is_dir() { copy_dir(&e.path(), &to); } else { fs::copy(e.path(), to).unwrap(); }
    }
}

#[test]
fn thumbnails_are_separate_and_regenerable_with_orientation() {
    let t = tempfile::tempdir().unwrap();
    let mut p = new_project(t.path(), "サムネイル工事");
    import_files(&mut p, write_photos(&t.path().join("src"), 5));
    let before = originals_hashes(&p);
    assert_eq!(photos::process_pending_thumbnails(&p.conn, &p.root, 100, &Cancel::new()).unwrap(), 5);
    let rows = photos::list_photos(&p.conn, &PhotoFilter::default()).unwrap();
    for r in &rows {
        let img = image::open(p.thumb_path(&r.uuid)).unwrap();
        // 800x600 の写真。Orientation=6 は縦向きに補正される
        if r.orientation == 6 { assert_eq!((img.width(), img.height()), (360, 480)); } else { assert_eq!((img.width(), img.height()), (480, 360)); }
    }
    fs::remove_dir_all(p.thumbs_dir()).unwrap();
    fs::create_dir_all(p.thumbs_dir()).unwrap();
    assert_eq!(photos::reset_thumbnails(&p.conn, &p.root).unwrap(), 5);
    assert_eq!(photos::process_pending_thumbnails(&p.conn, &p.root, 100, &Cancel::new()).unwrap(), 5);
    assert_eq!(before, originals_hashes(&p), "サムネイル生成で原寸は変わらない");
}

#[test]
fn pdf_embeds_jpeg_without_recompression() {
    let t = tempfile::tempdir().unwrap();
    let (mut p, l, ids) = ledger_with_photos(t.path(), 5);
    let s = slot_ids(&ledger::detail(&p.conn, &l).unwrap());
    ledger::apply_ops(&mut p, &l, &[Op::PlaceMany { from: s[0].clone(), photos: ids.clone() }, Op::InsertBlank { slot: s[1].clone() }]).unwrap();
    let mut f = serde_json::Map::new();
    f.insert("body".into(), serde_json::json!("長い文言".repeat(200)));
    ledger::apply_ops(&mut p, &l, &[Op::SetCaption { photo: ids[0].clone(), fields: f }]).unwrap();
    let out = p.root.join("exports").join("台帳.pdf");
    let r = pdf::export_ledger_pdf(&p, &l, &out, &Cancel::new(), &mut noop()).unwrap();
    assert_eq!(r.images, 5);
    assert_eq!(r.pages, 3); // 表紙 + 2ページ
    assert!(r.warnings.iter().any(|w| w.message.contains("文言が長く")));
    let bytes = fs::read(&out).unwrap();
    assert!(bytes.starts_with(b"%PDF-1.6"));
    // 原寸JPEGのバイト列がそのまま含まれている（再圧縮していない）
    let orig = fs::read(p.original_path(&ids[3])).unwrap();
    assert!(bytes.windows(orig.len()).any(|w| w == orig.as_slice()));
    // キャンセル時は完成ファイルを作らない
    let c = Cancel::new(); c.cancel();
    let out2 = p.root.join("exports").join("中止.pdf");
    assert!(pdf::export_ledger_pdf(&p, &l, &out2, &c, &mut noop()).is_err());
    assert!(!out2.exists());
    assert_eq!(fs::read_dir(p.root.join("exports")).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().ends_with(".partial")).count(), 0);
}

#[test]
fn exchange_round_trip_and_generation_warning() {
    let t = tempfile::tempdir().unwrap();
    let (mut a, l, ids) = ledger_with_photos(t.path(), 6);
    let zip_path = t.path().join("aopic.zip");
    synth::aopic_zip(&zip_path, 2);
    photos::import(&mut a, &ImportSource::Zip { path: zip_path }, ImportOptions::default(), &Cancel::new(), &mut noop()).unwrap();
    let s = slot_ids(&ledger::detail(&a.conn, &l).unwrap());
    ledger::apply_ops(&mut a, &l, &[Op::PlaceMany { from: s[0].clone(), photos: ids.clone() }]).unwrap();
    let mut ch = BTreeMap::new();
    ch.insert("koushu".to_string(), FieldChange::Set("足場工".into()));
    classify::apply(&mut a, &ids[..2].to_vec(), &ch).unwrap();
    let file = t.path().join("受渡し").join("工事_20261121.aoalb");
    let rep = exchange::export(&mut a, &file, &Cancel::new(), &mut noop()).unwrap();
    assert!(rep.verified);
    // 端末Bで新規取込み
    let b_parent = t.path().join("端末B");
    let imp = exchange::import(&file, &b_parent, ImportMode::New, "device-b", &Cancel::new(), &mut noop()).unwrap();
    let (mut b, _) = project::open_project(Path::new(&imp.root), "device-b").unwrap();
    assert_eq!(b.uuid, a.uuid);
    assert_eq!(originals_hashes(&a), originals_hashes(&b));
    let la = ledger::detail(&a.conn, &l).unwrap();
    let lb = ledger::detail(&b.conn, &l).unwrap();
    assert_eq!(contents(&la), contents(&lb));
    let pa = photos::list_photos(&a.conn, &PhotoFilter::default()).unwrap();
    let pb = photos::list_photos(&b.conn, &PhotoFilter::default()).unwrap();
    assert_eq!(pa.iter().map(|x| (&x.uuid, &x.classification, &x.original, &x.photo_uid)).collect::<Vec<_>>(), pb.iter().map(|x| (&x.uuid, &x.classification, &x.original, &x.photo_uid)).collect::<Vec<_>>());
    // 端末Bで編集して書き出し→端末Aへ置換で戻す（Aは未編集なので警告なし）
    ledger::apply_ops(&mut b, &l, &[Op::SetTitle { title: "端末Bで編集".into() }]).unwrap();
    let file_b = t.path().join("受渡し").join("工事_B.aoalb");
    exchange::export(&mut b, &file_b, &Cancel::new(), &mut noop()).unwrap();
    // Aが同時に編集していた場合：警告
    ledger::apply_ops(&mut a, &l, &[Op::SetTitle { title: "端末Aでも編集".into() }]).unwrap();
    let a_root = a.root.clone();
    a.close().unwrap();
    let prev = exchange::preview(&file_b, &[a_root.clone()], t.path()).unwrap();
    assert!(prev.existing.as_ref().unwrap().local_newer);
    let e = exchange::import(&file_b, t.path(), ImportMode::Replace { root: a_root.clone(), confirm_newer: false }, DEV, &Cancel::new(), &mut noop()).err().unwrap();
    assert_eq!(e.kind, ErrorKind::NeedsConfirmation);
    assert!(e.message.contains("この端末には、取込ファイルより新しい編集内容があります"));
    // 確認の上で置換：前の工事フォルダは退避され、DBバックアップも取られる
    let r = exchange::import(&file_b, a_root.parent().unwrap(), ImportMode::Replace { root: a_root.clone(), confirm_newer: true }, DEV, &Cancel::new(), &mut noop()).unwrap();
    let prev_folder = PathBuf::from(r.previous_folder.unwrap());
    assert!(prev_folder.join("project.sqlite").exists());
    assert!(fs::read_dir(prev_folder.join("backups")).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().contains("before-import-replace")));
    let (a2, _) = project::open_project(&a_root, DEV).unwrap();
    assert_eq!(ledger::detail(&a2.conn, &l).unwrap().title, "端末Bで編集");
    // 別の工事として取り込む：別UUID
    let c = exchange::import(&file_b, &t.path().join("端末C"), ImportMode::AsCopy, "device-c", &Cancel::new(), &mut noop()).unwrap();
    assert_ne!(c.project_uuid, a2.uuid);
}

#[test]
fn exchange_rejects_broken_and_malicious_archives_without_touching_existing() {
    let t = tempfile::tempdir().unwrap();
    let (mut a, _, _) = ledger_with_photos(t.path(), 3);
    let file = t.path().join("ok.aoalb");
    exchange::export(&mut a, &file, &Cancel::new(), &mut noop()).unwrap();
    let dest = t.path().join("dest");
    fs::create_dir_all(&dest).unwrap();
    let count = || fs::read_dir(&dest).unwrap().count();
    // 壊れたファイル（途中で切れている）
    let bytes = fs::read(&file).unwrap();
    let cut = t.path().join("cut.aoalb");
    fs::write(&cut, &bytes[..bytes.len() / 2]).unwrap();
    assert!(exchange::import(&cut, &dest, ImportMode::New, DEV, &Cancel::new(), &mut noop()).is_err());
    // 写真の中身を書き換え（SHA-256不一致）
    let tampered = t.path().join("tampered.aoalb");
    rewrite_zip(&file, &tampered, |name, data| if name.starts_with("originals/") { let mut d = data.to_vec(); let n = d.len(); d[n - 10] ^= 0xFF; Some((name.to_string(), d)) } else { Some((name.to_string(), data.to_vec())) });
    let e = exchange::import(&tampered, &dest, ImportMode::New, DEV, &Cancel::new(), &mut noop()).err().unwrap();
    assert!(e.message.contains("壊れて"));
    // 不正なパス・HTML・実行ファイルを含む
    for (bad, label) in [("../escape.jpg", "trav"), ("originals/../../x.jpg", "trav2"), ("index.html", "html"), ("tool.exe", "exe"), ("C:/Windows/x.jpg", "abs")] {
        let f = t.path().join(format!("{label}.aoalb"));
        rewrite_zip(&file, &f, |name, data| Some((name.to_string(), data.to_vec())));
        append_entry(&f, bad);
        assert!(exchange::import(&f, &dest, ImportMode::New, DEV, &Cancel::new(), &mut noop()).is_err(), "{bad}");
    }
    // 新しい形式版は拒否
    let future = t.path().join("future.aoalb");
    rewrite_zip(&file, &future, |name, data| if name == "manifest.json" { let s = String::from_utf8(data.to_vec()).unwrap().replace("\"formatVersion\": 1", "\"formatVersion\": 99"); Some((name.into(), s.into_bytes())) } else { Some((name.into(), data.to_vec())) });
    assert!(exchange::import(&future, &dest, ImportMode::New, DEV, &Cancel::new(), &mut noop()).err().unwrap().message.contains("新しい版"));
    // 途中キャンセル
    let c = Cancel::new(); c.cancel();
    assert!(exchange::import(&file, &dest, ImportMode::New, DEV, &c, &mut noop()).is_err());
    // どの失敗でも取込み先に工事フォルダ・作業フォルダを残さない
    assert_eq!(count(), 0);
    // 書出しのキャンセルでも完成ファイルを残さない
    let out = t.path().join("cancel.aoalb");
    let c = Cancel::new(); c.cancel();
    assert!(exchange::export(&mut a, &out, &c, &mut noop()).is_err());
    assert!(!out.exists());
}

fn rewrite_zip(src: &Path, dst: &Path, f: impl Fn(&str, &[u8]) -> Option<(String, Vec<u8>)>) {
    let mut a = zip::ZipArchive::new(fs::File::open(src).unwrap()).unwrap();
    let mut w = zip::ZipWriter::new(fs::File::create(dst).unwrap());
    for i in 0..a.len() {
        let mut e = a.by_index(i).unwrap();
        let name = e.name().unwrap().to_string();
        let mut data = Vec::new();
        std::io::Read::read_to_end(&mut e, &mut data).unwrap();
        if let Some((n, d)) = f(&name, &data) { w.start_file(n, zip::write::SimpleFileOptions::default()).unwrap(); w.write_all(&d).unwrap(); }
    }
    w.finish().unwrap();
}

fn append_entry(path: &Path, name: &str) {
    let tmp = path.with_extension("tmp");
    rewrite_zip(path, &tmp, |n, d| Some((n.into(), d.to_vec())));
    let mut a = zip::ZipWriter::new_append(fs::OpenOptions::new().read(true).write(true).open(&tmp).unwrap()).unwrap();
    a.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
    a.write_all(b"<html>").unwrap();
    a.finish().unwrap();
    fs::rename(tmp, path).unwrap();
}

#[test]
fn zip_bomb_is_rejected() {
    let t = tempfile::tempdir().unwrap();
    let mut p = new_project(t.path(), "爆弾工事");
    let zip_path = t.path().join("bomb.zip");
    {
        let mut z = zip::ZipWriter::new(fs::File::create(&zip_path).unwrap());
        let o = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        z.start_file("big.jpg", o).unwrap();
        let mut data = vec![0u8; 50 * 1024 * 1024];
        data[..3].copy_from_slice(&[0xFF, 0xD8, 0xFF]);
        z.write_all(&data).unwrap();
        z.finish().unwrap();
    }
    let r = photos::import(&mut p, &ImportSource::Zip { path: zip_path }, ImportOptions::default(), &Cancel::new(), &mut noop()).unwrap();
    assert_eq!(r.accepted, 0);
    assert!(r.failures[0].reason.contains("圧縮率"));
}

#[test]
fn disk_space_check_reports_in_japanese() {
    let t = tempfile::tempdir().unwrap();
    let e = util::ensure_space(t.path(), u64::MAX / 4).err().unwrap();
    assert_eq!(e.kind, ErrorKind::DiskFull);
    assert!(e.message.contains("空き容量が足りません"));
}

#[test]
fn backup_verify_restore() {
    let t = tempfile::tempdir().unwrap();
    let (mut p, l, ids) = ledger_with_photos(t.path(), 3);
    let s = slot_ids(&ledger::detail(&p.conn, &l).unwrap());
    ledger::apply_ops(&mut p, &l, &[Op::Place { slot: s[0].clone(), photo: ids[0].clone() }]).unwrap();
    let b = backup::create(&p, backup::Reason::Manual).unwrap();
    assert!(backup::verify(&p, &b.name).unwrap().ok);
    ledger::apply_ops(&mut p, &l, &[Op::Clear { slot: s[0].clone() }, Op::SetTitle { title: "後から変更".into() }]).unwrap();
    backup::restore(&mut p, &b.name).unwrap();
    let d = ledger::detail(&p.conn, &l).unwrap();
    assert_eq!(d.title, "第1回 台帳");
    assert_eq!(d.pages[0].slots[0].photo_uuid.as_deref(), Some(ids[0].as_str()));
    let list = backup::list(&p).unwrap();
    assert!(list.iter().any(|x| x.reason == "before-restore"));
    // バックアップは原寸写真を複製しない
    assert!(backup::status(&p).unwrap().count >= 2);
    assert!(fs::read_dir(p.root.join("backups")).unwrap().all(|e| e.unwrap().file_name().to_string_lossy().ends_with(".sqlite")));
    // 不正な名前は拒否
    assert!(backup::restore(&mut p, "../project.sqlite").is_err());
    // 壊れたバックアップは検証で検出
    let broken = p.root.join("backups").join("20260101-000000000-manual.sqlite");
    fs::write(&broken, b"not sqlite").unwrap();
    assert!(!backup::verify(&p, "20260101-000000000-manual.sqlite").unwrap().ok);
}

#[test]
fn no_network_code_and_no_secrets_in_sources() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let cargo = fs::read_to_string(root.join("core").join("Cargo.toml")).unwrap();
    for net in ["reqwest", "hyper", "ureq", "supabase", "tokio-tungstenite"] { assert!(!cargo.contains(net), "network crate {net}"); }
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in fs::read_dir(&d).unwrap() {
            let p = e.unwrap().path();
            let n = p.file_name().unwrap().to_string_lossy().to_string();
            if p.is_dir() { if !["target", "node_modules", "gen", ".git"].contains(&n.as_str()) { stack.push(p); } continue; }
            if !["rs", "js", "html", "css", "json", "toml", "md"].iter().any(|x| n.ends_with(x)) { continue; }
            let s = fs::read_to_string(&p).unwrap_or_default();
            for bad in [["service", "_role"].concat(), ["sb_", "secret_"].concat(), ["supabase", ".co"].concat(), ["BEGIN PRIVATE", " KEY"].concat(), ["eyJhbGci", "Oi"].concat()] {
                let bad = bad.as_str(); assert!(!s.contains(bad), "{} contains {bad}", p.display());
            }
        }
    }
}


/// 画面（app/ui）が送るJSONの形と中核の型が一致していることを固定する
#[test]
fn ui_json_contract() {
    let ops: Vec<Op> = serde_json::from_str(r#"[
        {"op":"Place","slot":"s","photo":"p"},{"op":"Swap","a":"x","b":"y"},{"op":"Move","from":"x","to":"y"},{"op":"Clear","slot":"s"},
        {"op":"SetBlank","slot":"s","blank":true},{"op":"InsertBlank","slot":"s"},{"op":"RemoveSlot","slot":"s"},{"op":"PlaceMany","from":"s","photos":["a","b"]},
        {"op":"AddPage","page":"p","after":null,"blank":true},{"op":"AddPage","page":"p","after":"q"},{"op":"DeletePage","page":"p"},{"op":"RestorePage","page":"p"},
        {"op":"MovePage","page":"p","after":null},{"op":"SetSlots","slots":[{"uuid":"s","index":0,"kind":"photo","photoUuid":"p"}]},
        {"op":"SetCaption","photo":"p","fields":{"body":"x","koushu":null}},{"op":"SetTitle","title":"t"},{"op":"SetCover","cover":{"title":"a"}},
        {"op":"SetShowCover","show":false},{"op":"SetViewMode","mode":"spread"}]"#).unwrap();
    assert_eq!(ops.len(), 19);
    let m: ImportMode = serde_json::from_str(r#"{"mode":"replace","root":"/x","confirmNewer":true}"#).unwrap();
    assert!(matches!(m, ImportMode::Replace { confirm_newer: true, .. }));
    assert!(matches!(serde_json::from_str::<ImportMode>(r#"{"mode":"asCopy"}"#).unwrap(), ImportMode::AsCopy));
    let src: ImportSource = serde_json::from_str(r#"{"kind":"files","paths":["a.jpg"]}"#).unwrap();
    assert!(matches!(src, ImportSource::Files { .. }));
    let _: ImportOptions = serde_json::from_str(r#"{"allowDuplicates":true}"#).unwrap();
    let f: PhotoFilter = serde_json::from_str(r#"{"ledgerUuid":"l","unplacedOnly":true,"unclassifiedOnly":false,"text":"a","takenFrom":"2026-01-01","uuids":["x"]}"#).unwrap();
    assert!(f.unplaced_only);
    let ch: BTreeMap<String, FieldChange> = serde_json::from_str(r#"{"koushu":{"mode":"set","value":"塗装工"},"sokuten":{"mode":"original"}}"#).unwrap();
    assert_eq!(ch["sokuten"], FieldChange::Original);
    let st: Vec<classify::OverrideState> = serde_json::from_str(r#"[{"photoUuid":"p","koushu":null,"shubetsu":"x","saibetsu":null,"sokuten":null,"tekiyo":null}]"#).unwrap();
    assert_eq!(st[0].shubetsu.as_deref(), Some("x"));
    let np: NewProject = serde_json::from_str(r#"{"name":"工事","contractor":"x"}"#).unwrap();
    assert_eq!(np.name, "工事");
}

/// 4GBを超える引継ぎファイル（ZIP64）。時間と容量が必要なため通常は実行しない：
/// AOALB2_HUGE_DIR=<作業フォルダ> cargo test --release -- --ignored huge_exchange_over_4gb
#[test]
#[ignore]
fn huge_exchange_over_4gb() {
    let base = PathBuf::from(std::env::var("AOALB2_HUGE_DIR").unwrap_or_else(|_| std::env::temp_dir().join("aoalb2-huge").to_string_lossy().into()));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(base.join("src")).unwrap();
    let mut p = new_project(&base, "巨大工事");
    let jpeg = synth::jpeg(640, 480, 1, 80);
    // EOI後に詰め物をした約95MBの架空JPEG×46枚（合計約4.3GB）
    let pad = vec![0x5Au8; 95 * 1024 * 1024];
    for i in 0..46 {
        let f = base.join("src").join(format!("big{i}.jpg"));
        let mut w = fs::File::create(&f).unwrap();
        w.write_all(&synth::with_comment(&jpeg, &format!("huge{i}"))).unwrap();
        w.write_all(&pad).unwrap();
        drop(w);
        let r = photos::import(&mut p, &ImportSource::Files { paths: vec![f.clone()] }, ImportOptions::default(), &Cancel::new(), &mut noop()).unwrap();
        assert_eq!(r.accepted, 1);
        fs::remove_file(&f).unwrap();
    }
    let file = base.join("巨大.aoalb");
    let r = exchange::export(&mut p, &file, &Cancel::new(), &mut noop()).unwrap();
    assert!(r.bytes > 4 * 1024 * 1024 * 1024, "4GBを超える");
    p.close().unwrap();
    let imp = exchange::import(&file, &base.join("B"), ImportMode::New, "device-b", &Cancel::new(), &mut noop()).unwrap();
    assert_eq!(imp.photos, 46);
    let _ = fs::remove_dir_all(&base);
}
