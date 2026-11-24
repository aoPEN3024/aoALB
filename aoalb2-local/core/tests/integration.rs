//! 自動検証（架空データのみ）。`cargo test` で実行する。

use aoalb_core::classify::{self, FieldChange};
use aoalb_core::exchange::{self, ImportMode};
use aoalb_core::ledger::{self, Op};
use aoalb_core::photos::{self, ImportOptions, ImportSource, PhotoFilter};
use aoalb_core::project::{self, NewProject, Project};
use aoalb_core::util::{self, Cancel, Progress};
use aoalb_core::{ErrorKind, backup, db, pdf, synth};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const DEV: &str = "test-device-a";
fn np(name: &str) -> NewProject {
    NewProject { name: name.into(), kouji_code: "K-1".into(), contractor: "架空建設".into() }
}
fn noop() -> impl FnMut(Progress) {
    |_| {}
}

fn write_photos(dir: &Path, n: usize) -> Vec<PathBuf> {
    fs::create_dir_all(dir).unwrap();
    let base = synth::jpeg(800, 600, 3, 80);
    (0..n)
        .map(|i| {
            let p = dir.join(format!("IMG_{i:04}.JPG"));
            let b = synth::with_exif(
                &synth::with_comment(&base, &format!("g{i}")),
                Some(&format!("2026:10:{:02} 10:{:02}:00", 1 + i % 28, i % 60)),
                Some(if i % 5 == 0 { 6 } else { 1 }),
            );
            fs::write(&p, b).unwrap();
            p
        })
        .collect()
}

fn new_project(tmp: &Path, name: &str) -> Project {
    project::create_project(&tmp.join("data"), &np(name), DEV).unwrap()
}

fn import_files(p: &mut Project, files: Vec<PathBuf>) -> photos::ImportResult {
    photos::import(p, &ImportSource::Files { paths: files }, ImportOptions::default(), &Cancel::new(), &mut noop()).unwrap()
}

fn originals_hashes(p: &Project) -> BTreeMap<String, String> {
    let mut m = BTreeMap::new();
    for e in fs::read_dir(p.originals_dir()).unwrap() {
        let e = e.unwrap().path();
        m.insert(e.file_name().unwrap().to_string_lossy().to_string(), synth::sha256(&fs::read(&e).unwrap()));
    }
    m
}

#[test]
fn migration_and_integrity() {
    let t = tempfile::tempdir().unwrap();
    let p = new_project(t.path(), "架空工事");
    let v: i64 = p.conn.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap();
    assert_eq!(v, db::SCHEMA_VERSION);
    assert!(db::integrity_ok(&p.conn).unwrap());
    for d in ["originals", "thumbnails", "exports", "backups", "tmp"] {
        assert!(p.root.join(d).is_dir());
    }
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
    for h in &src_hashes {
        assert!(stored.contains(h));
    }
    let list = photos::list_photos(&p.conn, &PhotoFilter::default()).unwrap();
    assert!(list.iter().all(|x| x.source_kind == "general" && x.classification.is_empty() && x.taken_at_source == "exif"));
    assert!(list.iter().any(|x| x.orientation == 6));
    // 重複は既定で取り込まない
    let r2 = import_files(&mut p, files[..2].to_vec());
    assert_eq!((r2.accepted, r2.duplicates), (0, 2));
    // 失敗分だけ再試行（重複も取り込む指定）
    let ids: Vec<i64> = r2.failures.iter().map(|f| f.id).collect();
    let r3 = photos::retry_failures(&mut p, &ids, ImportOptions { allow_duplicates: true, ..Default::default() }, &Cancel::new(), &mut noop()).unwrap();
    assert_eq!(r3.accepted, 2);
    // 一時ファイルが残っていない
    assert_eq!(fs::read_dir(p.tmp_dir()).unwrap().count(), 0);
}

#[test]
fn photo_list_sorting_is_stable_and_whitelisted() {
    let t = tempfile::tempdir().unwrap();
    let mut p = new_project(t.path(), "並び替え工事");
    let src = t.path().join("src-sort");
    fs::create_dir_all(&src).unwrap();
    let base = synth::jpeg(800, 600, 3, 80);
    let files = [
        ("B_002.jpg", "2026:10:03 10:00:00"),
        ("C_003.jpg", "2026:10:01 10:00:00"),
        ("A_001.jpg", "2026:10:02 10:00:00"),
    ]
    .into_iter()
    .map(|(name, date)| {
        let path = src.join(name);
        fs::write(&path, synth::with_exif(&base, Some(date), Some(1))).unwrap();
        path
    })
    .collect();
    import_files(&mut p, files);
    let rows = photos::list_photos(&p.conn, &PhotoFilter::default()).unwrap();
    let ids: BTreeMap<_, _> = rows.into_iter().map(|r| (r.original_name, r.uuid)).collect();
    let a = ids["A_001.jpg"].clone();
    let b = ids["B_002.jpg"].clone();
    let c = ids["C_003.jpg"].clone();
    for (id, koushu) in [(&b, "塗装工"), (&a, "仮設工")] {
        classify::apply(
            &mut p,
            std::slice::from_ref(id),
            &BTreeMap::from([("koushu".into(), FieldChange::Set(koushu.into()))]),
        )
        .unwrap();
    }
    let order = |filter: PhotoFilter| photos::list_photos(&p.conn, &filter).unwrap().into_iter().map(|r| r.uuid).collect::<Vec<_>>();
    assert_eq!(order(PhotoFilter { sort_by: Some("date".into()), ..Default::default() }), vec![c.clone(), a.clone(), b.clone()]);
    assert_eq!(
        order(PhotoFilter { sort_by: Some("date".into()), sort_desc: true, ..Default::default() }),
        vec![b.clone(), a.clone(), c.clone()]
    );
    assert_eq!(order(PhotoFilter { sort_by: Some("name".into()), ..Default::default() }), vec![a.clone(), b.clone(), c.clone()]);
    assert_eq!(order(PhotoFilter { sort_by: Some("koushu".into()), ..Default::default() }), vec![a.clone(), b.clone(), c.clone()]);
    assert_eq!(
        order(PhotoFilter { sort_by: Some("koushu".into()), sort_desc: true, ..Default::default() }),
        vec![b.clone(), a.clone(), c.clone()]
    );
    // 未知の値でもSQL断片には使わず、既定の撮影日順へ戻す。
    assert_eq!(
        order(PhotoFilter { sort_by: Some("name desc; drop table photos".into()), ..Default::default() }),
        vec![c, a, b]
    );
    assert_eq!(photos::list_photos(&p.conn, &PhotoFilter::default()).unwrap().len(), 3);
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
        for i in 0..3 {
            z.start_file(format!("現場/日付{i}/p{i}.jpg"), o).unwrap();
            z.write_all(&synth::with_comment(&synth::jpeg(320, 240, i, 70), &format!("z{i}"))).unwrap();
        }
        z.start_file("../evil.jpg", o).unwrap();
        z.write_all(&synth::jpeg(10, 10, 1, 50)).unwrap();
        z.start_file("readme.exe", o).unwrap();
        z.write_all(b"MZ").unwrap();
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
fn aopic_folder_classification_import_and_recovery_preserve_existing_values() {
    let t = tempfile::tempdir().unwrap();
    let zip_path = t.path().join("folder-classification.zip");
    {
        let mut z = zip::ZipWriter::new(fs::File::create(&zip_path).unwrap());
        let o = zip::write::SimpleFileOptions::default();
        for (name, seed) in [("仮設工/足場架設/枠組足場設置/20261001_001.jpg", 31), ("準備工/20261001_002.jpg", 32)] {
            z.start_file(name, o).unwrap();
            z.write_all(&synth::with_comment(&synth::jpeg(640, 480, seed, 75), name)).unwrap();
        }
        z.finish().unwrap();
    }

    // 新規取込みでは、明示指定した時だけフォルダ分類を元分類として保存する。
    let mut imported = new_project(t.path(), "フォルダ分類取込み");
    let r = photos::import(
        &mut imported,
        &ImportSource::Zip { path: zip_path.clone() },
        ImportOptions { folder_classification: true, ..Default::default() },
        &Cancel::new(),
        &mut noop(),
    )
    .unwrap();
    assert_eq!((r.accepted, r.folder_classified), (2, 2));
    let rows = photos::list_photos(&imported.conn, &PhotoFilter::default()).unwrap();
    assert_eq!(rows[0].original.koushu, "仮設工");
    assert_eq!(rows[0].original.shubetsu, "足場架設");
    assert_eq!(rows[0].original.saibetsu, "枠組足場設置");
    assert_eq!(rows[1].original.koushu, "準備工");
    assert!(rows[1].original.shubetsu.is_empty());
    assert!(rows.iter().all(|p| p.overridden.is_empty() && p.source_kind == "general"));

    // 既存の未分類写真は上書き分類として救済し、手動値は維持する。
    let mut recovered = new_project(t.path(), "既存写真の分類復元");
    let r = photos::import(&mut recovered, &ImportSource::Zip { path: zip_path }, ImportOptions::default(), &Cancel::new(), &mut noop()).unwrap();
    assert_eq!(r.folder_classified, 0);
    let before = photos::list_photos(&recovered.conn, &PhotoFilter::default()).unwrap();
    let first = before.iter().find(|p| p.folder_label.starts_with("仮設工/")).unwrap();
    let mut manual = BTreeMap::new();
    manual.insert("koushu".to_string(), FieldChange::Set("手動の工種".into()));
    classify::apply(&mut recovered, std::slice::from_ref(&first.uuid), &manual).unwrap();

    let preview = classify::folder_classification_preview(&recovered.conn).unwrap();
    assert_eq!(preview.photo_count, 2);
    assert_eq!((preview.koushu_count, preview.shubetsu_count, preview.saibetsu_count), (1, 1, 1));
    let result = classify::apply_folder_classification(&mut recovered).unwrap();
    assert_eq!((result.changed_photos, result.changed_koushu, result.changed_shubetsu, result.changed_saibetsu), (2, 1, 1, 1));
    let after = photos::list_photos(&recovered.conn, &PhotoFilter::default()).unwrap();
    let first = after.iter().find(|p| p.folder_label.starts_with("仮設工/")).unwrap();
    assert_eq!(first.classification.koushu, "手動の工種");
    assert_eq!(first.classification.shubetsu, "足場架設");
    assert_eq!(first.classification.saibetsu, "枠組足場設置");
    assert_eq!(classify::folder_classification_preview(&recovered.conn).unwrap().photo_count, 0);
}

#[test]
fn aopic_json_classification_has_priority_over_folder_names() {
    let t = tempfile::tempdir().unwrap();
    let zip_path = t.path().join("aopic-normal.zip");
    let file_path = "フォルダ工種/フォルダ種別/フォルダ細別/20261001_001.jpg";
    {
        let mut z = zip::ZipWriter::new(fs::File::create(&zip_path).unwrap());
        let o = zip::write::SimpleFileOptions::default();
        z.start_file(file_path, o).unwrap();
        z.write_all(&synth::jpeg(640, 480, 41, 75)).unwrap();
        z.start_file("photos.json", o).unwrap();
        let meta = serde_json::json!({"app":"aoPIC","photos":[{
            "filePath":file_path,"koushu":"正式工種","shubetsu":"正式種別","saibetsu":"正式細別","sokuten":"P1","tekiyo":"施工前"
        }]});
        z.write_all(meta.to_string().as_bytes()).unwrap();
        z.finish().unwrap();
    }
    let mut p = new_project(t.path(), "正式分類優先");
    let r = photos::import(
        &mut p,
        &ImportSource::Zip { path: zip_path },
        ImportOptions { folder_classification: true, ..Default::default() },
        &Cancel::new(),
        &mut noop(),
    )
    .unwrap();
    assert_eq!(r.folder_classified, 0);
    let row = photos::list_photos(&p.conn, &PhotoFilter::default()).unwrap().remove(0);
    assert_eq!(row.source_kind, "aopic");
    assert_eq!(row.classification.koushu, "正式工種");
    assert_eq!(row.classification.shubetsu, "正式種別");
    assert_eq!(row.classification.saibetsu, "正式細別");
    assert_eq!(row.classification.sokuten, "P1");
    assert_eq!(row.classification.tekiyo, "施工前");
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
    classify::apply(&mut p, &ids[..1], &back).unwrap();
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

fn slot_ids(d: &ledger::LedgerDetail) -> Vec<String> {
    d.pages.iter().flat_map(|p| p.slots.iter().map(|s| s.uuid.clone())).collect()
}
fn contents(d: &ledger::LedgerDetail) -> Vec<Option<String>> {
    d.pages.iter().flat_map(|p| p.slots.iter().map(|s| if s.kind == "blank" { Some("BLANK".into()) } else { s.photo_uuid.clone() })).collect()
}

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
    let r = ledger::apply_ops(
        &mut p,
        &l,
        &[
            Op::SetTitle { title: "第1回 出来形".into() },
            Op::SetCaption { photo: ids[2].clone(), fields: f },
            Op::SetCover {
                cover: serde_json::json!({"title": "工事写真帳", "project": "架空工事", "contractor": "架空建設", "koushu": "塗装工"})
            },
        ],
    )
    .unwrap();
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
    assert!(photos::trash_photos(&mut p, &ids[..1]).is_err());
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
        if e.file_name() == ".aoalb.lock" {
            continue;
        } // Windowsではロック中のファイルを読めない
        let to = dst.join(e.file_name());
        if e.file_type().unwrap().is_dir() {
            copy_dir(&e.path(), &to);
        } else {
            fs::copy(e.path(), to).unwrap();
        }
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
        if r.orientation == 6 {
            assert_eq!((img.width(), img.height()), (360, 480));
        } else {
            assert_eq!((img.width(), img.height()), (480, 360));
        }
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
    let mut f2 = serde_json::Map::new();
    f2.insert("body".into(), serde_json::json!("髙﨑①㈱ 𠮷野家 😀"));
    ledger::apply_ops(&mut p, &l, &[Op::SetCaption { photo: ids[1].clone(), fields: f2 }]).unwrap();
    let out = p.root.join("exports").join("台帳.pdf");
    let r = pdf::export_ledger_pdf(&p, &l, &out, &Cancel::new(), &mut noop()).unwrap();
    assert_eq!(r.images, 5);
    assert_eq!(r.pages, 3); // 表紙 + 2ページ
    assert!(r.warnings.iter().any(|w| w.message.contains("文言が長く")));
    let bytes = fs::read(&out).unwrap();
    assert!(bytes.starts_with(b"%PDF-1.6"));
    // 同梱フォントを必ず埋め込む（端末・閲覧ソフトのフォントに依存しない）
    assert!(r.font.contains("BIZ UD"));
    assert!(bytes.windows(10).any(|w| w == b"/FontFile2"));
    assert!(!bytes.windows(14).any(|w| w == b"HeiseiKakuGo-W"));
    // 収録外の文字は警告（髙・﨑・①・㈱は収録済み）
    let miss = r.warnings.iter().find(|w| w.message.contains("印刷できない文字")).expect("missing-char warning");
    assert!(miss.message.contains("𠮷") && miss.message.contains("😀") && !miss.message.contains("髙"));
    // 原寸JPEGのバイト列がそのまま含まれている（再圧縮していない）
    let orig = fs::read(p.original_path(&ids[3])).unwrap();
    assert!(bytes.windows(orig.len()).any(|w| w == orig.as_slice()));
    // キャンセル時は完成ファイルを作らない
    let c = Cancel::new();
    c.cancel();
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
    classify::apply(&mut a, &ids[..2], &ch).unwrap();
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
    assert_eq!(
        pa.iter().map(|x| (&x.uuid, &x.classification, &x.original, &x.photo_uid)).collect::<Vec<_>>(),
        pb.iter().map(|x| (&x.uuid, &x.classification, &x.original, &x.photo_uid)).collect::<Vec<_>>()
    );
    // 端末Bで編集して書き出し→端末Aへ置換で戻す（Aは未編集なので警告なし）
    ledger::apply_ops(&mut b, &l, &[Op::SetTitle { title: "端末Bで編集".into() }]).unwrap();
    let file_b = t.path().join("受渡し").join("工事_B.aoalb");
    exchange::export(&mut b, &file_b, &Cancel::new(), &mut noop()).unwrap();
    // Aが同時に編集していた場合：警告
    ledger::apply_ops(&mut a, &l, &[Op::SetTitle { title: "端末Aでも編集".into() }]).unwrap();
    let a_root = a.root.clone();
    a.close().unwrap();
    let prev = exchange::preview(&file_b, std::slice::from_ref(&a_root), t.path()).unwrap();
    assert!(prev.existing.as_ref().unwrap().local_newer);
    let e = exchange::import(&file_b, t.path(), ImportMode::Replace { root: a_root.clone(), confirm_newer: false }, DEV, &Cancel::new(), &mut noop())
        .err()
        .unwrap();
    assert_eq!(e.kind, ErrorKind::NeedsConfirmation);
    assert!(e.message.contains("この端末には、取込ファイルより新しい編集内容があります"));
    // 確認の上で置換：前の工事フォルダは退避され、DBバックアップも取られる
    let r = exchange::import(
        &file_b,
        a_root.parent().unwrap(),
        ImportMode::Replace { root: a_root.clone(), confirm_newer: true },
        DEV,
        &Cancel::new(),
        &mut noop(),
    )
    .unwrap();
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
    rewrite_zip(&file, &tampered, |name, data| {
        if name.starts_with("originals/") {
            let mut d = data.to_vec();
            let n = d.len();
            d[n - 10] ^= 0xFF;
            Some((name.to_string(), d))
        } else {
            Some((name.to_string(), data.to_vec()))
        }
    });
    let e = exchange::import(&tampered, &dest, ImportMode::New, DEV, &Cancel::new(), &mut noop()).err().unwrap();
    assert!(e.message.contains("壊れて"));
    // 不正なパス・HTML・実行ファイルを含む
    for (bad, label) in
        [("../escape.jpg", "trav"), ("originals/../../x.jpg", "trav2"), ("index.html", "html"), ("tool.exe", "exe"), ("C:/Windows/x.jpg", "abs")]
    {
        let f = t.path().join(format!("{label}.aoalb"));
        rewrite_zip(&file, &f, |name, data| Some((name.to_string(), data.to_vec())));
        append_entry(&f, bad);
        assert!(exchange::import(&f, &dest, ImportMode::New, DEV, &Cancel::new(), &mut noop()).is_err(), "{bad}");
    }
    // 新しい形式版は拒否
    let future = t.path().join("future.aoalb");
    rewrite_zip(&file, &future, |name, data| {
        if name == "manifest.json" {
            let s = String::from_utf8(data.to_vec()).unwrap().replace("\"formatVersion\": 1", "\"formatVersion\": 99");
            Some((name.into(), s.into_bytes()))
        } else {
            Some((name.into(), data.to_vec()))
        }
    });
    assert!(exchange::import(&future, &dest, ImportMode::New, DEV, &Cancel::new(), &mut noop()).err().unwrap().message.contains("新しい版"));
    // 途中キャンセル
    let c = Cancel::new();
    c.cancel();
    assert!(exchange::import(&file, &dest, ImportMode::New, DEV, &c, &mut noop()).is_err());
    // どの失敗でも取込み先に工事フォルダ・作業フォルダを残さない
    assert_eq!(count(), 0);
    // 書出しのキャンセルでも完成ファイルを残さない
    let out = t.path().join("cancel.aoalb");
    let c = Cancel::new();
    c.cancel();
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
        if let Some((n, d)) = f(&name, &data) {
            w.start_file(n, zip::write::SimpleFileOptions::default()).unwrap();
            w.write_all(&d).unwrap();
        }
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
    for net in ["reqwest", "hyper", "ureq", "supabase", "tokio-tungstenite"] {
        assert!(!cargo.contains(net), "network crate {net}");
    }
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in fs::read_dir(&d).unwrap() {
            let p = e.unwrap().path();
            let n = p.file_name().unwrap().to_string_lossy().to_string();
            if p.is_dir() {
                if !["target", "node_modules", "gen", ".git"].contains(&n.as_str()) {
                    stack.push(p);
                }
                continue;
            }
            if !["rs", "js", "html", "css", "json", "toml", "md"].iter().any(|x| n.ends_with(x)) {
                continue;
            }
            let s = fs::read_to_string(&p).unwrap_or_default();
            for bad in [
                ["service", "_role"].concat(),
                ["sb_", "secret_"].concat(),
                ["supabase", ".co"].concat(),
                ["BEGIN PRIVATE", " KEY"].concat(),
                ["eyJhbGci", "Oi"].concat(),
            ] {
                let bad = bad.as_str();
                assert!(!s.contains(bad), "{} contains {bad}", p.display());
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
    let f: PhotoFilter =
        serde_json::from_str(r#"{"ledgerUuid":"l","unplacedOnly":true,"unclassifiedOnly":false,"text":"a","takenFrom":"2026-01-01","uuids":["x"]}"#).unwrap();
    assert!(f.unplaced_only);
    let ch: BTreeMap<String, FieldChange> = serde_json::from_str(r#"{"koushu":{"mode":"set","value":"塗装工"},"sokuten":{"mode":"original"}}"#).unwrap();
    assert_eq!(ch["sokuten"], FieldChange::Original);
    let st: Vec<classify::OverrideState> =
        serde_json::from_str(r#"[{"photoUuid":"p","koushu":null,"shubetsu":"x","saibetsu":null,"sokuten":null,"tekiyo":null}]"#).unwrap();
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

/// 古いバックアップへ復元しても、その後に取り込んだ写真を黙って消さない（aoPIC情報・分類の上書きも戻す）
#[test]
fn restore_old_backup_keeps_later_photos() {
    let t = tempfile::tempdir().unwrap();
    let mut p = new_project(t.path(), "復元工事");
    import_files(&mut p, write_photos(&t.path().join("src1"), 2));
    let l = ledger::create(&mut p, "台帳", 1).unwrap();
    let b = backup::create(&p, backup::Reason::Manual).unwrap();
    // バックアップ後に取り込んだ写真（aoPIC 3枚＋一般 2枚）と分類の変更
    let zip = t.path().join("later.zip");
    synth::aopic_zip(&zip, 3);
    photos::import(&mut p, &ImportSource::Zip { path: zip }, ImportOptions::default(), &Cancel::new(), &mut noop()).unwrap();
    let later_general = write_photos(&t.path().join("src2"), 2)
        .into_iter()
        .inspect(|f| {
            let b = synth::with_comment(&fs::read(f).unwrap(), "later");
            fs::write(f, b).unwrap();
        })
        .collect();
    import_files(&mut p, later_general);
    let all_before: Vec<_> = photos::list_photos(&p.conn, &PhotoFilter::default()).unwrap();
    assert_eq!(all_before.len(), 7);
    let later_ids: Vec<String> = all_before.iter().filter(|x| x.source_kind == "aopic").map(|x| x.uuid.clone()).collect();
    let mut ch = BTreeMap::new();
    ch.insert("shubetsu".to_string(), FieldChange::Set("変更後の種別".into()));
    classify::apply(&mut p, &later_ids[..1], &ch).unwrap();
    let s0 = ledger::detail(&p.conn, &l.uuid).unwrap().pages[0].slots[0].uuid.clone();
    ledger::apply_ops(&mut p, &l.uuid, &[Op::Place { slot: s0, photo: later_ids[0].clone() }]).unwrap();
    // 古いバックアップへ復元
    let r = backup::restore(&mut p, &b.name).unwrap();
    assert_eq!(r.recovery.found, 5);
    assert_eq!(r.recovery.recovered_from_backup, 5, "復元前の自動バックアップから記録を戻す");
    assert_eq!(r.recovery.recovered_from_file, 0);
    let after = photos::list_photos(&p.conn, &PhotoFilter::default()).unwrap();
    assert_eq!(after.len(), 7, "一覧から消えない");
    let a = after.iter().find(|x| x.uuid == later_ids[0]).unwrap();
    assert_eq!(a.source_kind, "aopic");
    assert!(a.photo_uid.is_some());
    assert_eq!(a.classification.shubetsu, "変更後の種別");
    assert_eq!(a.original.shubetsu, "橋梁塗装");
    // 台帳は復元した時点の状態（配置は戻らない）
    assert!(ledger::detail(&p.conn, &l.uuid).unwrap().pages[0].slots[0].photo_uuid.is_none());
    assert!(db::integrity_ok(&p.conn).unwrap());
    // 再度開いても未登録は0
    let root = p.root.clone();
    p.close().unwrap();
    let (_p, rep) = project::open_project(&root, DEV).unwrap();
    assert_eq!(rep.unregistered_originals, 0);
}

/// DBに登録されていない原寸（異常終了など）を検出し、ファイルから復旧する。読めないファイル・他のファイルは触らない
#[test]
fn unregistered_originals_detect_and_recover_from_file() {
    let t = tempfile::tempdir().unwrap();
    let mut p = new_project(t.path(), "未登録工事");
    import_files(&mut p, write_photos(&t.path().join("src"), 1));
    let orphan = util::new_uuid();
    let broken = util::new_uuid();
    let jpeg = synth::with_exif(&synth::jpeg(400, 300, 9, 80), Some("2026:09:15 08:30:00"), Some(6));
    fs::write(p.original_path(&orphan), &jpeg).unwrap();
    fs::write(p.original_path(&broken), b"not a jpeg").unwrap();
    fs::write(p.originals_dir().join("memo.txt"), b"user file").unwrap();
    let root = p.root.clone();
    p.close().unwrap();
    let (mut p, rep) = project::open_project(&root, DEV).unwrap();
    assert_eq!(rep.unregistered_originals, 2);
    let r = aoalb_core::recover::recover_unregistered(&mut p, &Cancel::new()).unwrap();
    assert_eq!((r.found, r.recovered_from_file, r.failed.len(), r.other_files), (2, 1, 1, 1));
    let row = photos::list_photos(&p.conn, &PhotoFilter { uuids: Some(vec![orphan.clone()]), ..Default::default() }).unwrap().remove(0);
    assert_eq!(row.taken_at.as_deref(), Some("2026-09-15T08:30:00"));
    assert_eq!(row.orientation, 6);
    assert_eq!(row.folder_label, "復旧した写真");
    let d = photos::photo_detail(&p, &orphan).unwrap();
    assert_eq!(d.sha256, synth::sha256(&jpeg), "原寸はそのまま");
    assert!(p.original_path(&broken).exists() && p.originals_dir().join("memo.txt").exists(), "読めないファイルも削除しない");
    assert!(backup::list(&p).unwrap().iter().any(|b| b.reason == "before-recovery"));
}

/// Windowsの予約名・使えない文字・末尾のピリオドや空白・空文字・既存フォルダとの衝突
#[test]
fn windows_reserved_and_unsafe_folder_names() {
    use aoalb_core::util::{is_reserved_windows_name, safe_name, unique_child};
    for r in ["CON", "con", "Prn", "AUX", "nul", "COM1", "com9", "LPT1", "lpt9", "COM0", "CON.txt", "LPT9.工事", "nul.tar.gz", "CON .txt", "COM¹", "CONIN$"]
    {
        assert!(is_reserved_windows_name(r), "{r}");
        let s = safe_name(r, "工事");
        assert!(!is_reserved_windows_name(&s), "{r} -> {s}");
    }
    for ok in ["CONSOLE", "COM10", "LPT", "工事CON", "A.CON", "com1工事"] {
        assert!(!is_reserved_windows_name(ok), "{ok}");
    }
    assert_eq!(safe_name("CON.txt", "x"), "CON_.txt");
    assert_eq!(safe_name("lpt9", "x"), "lpt9_");
    assert_eq!(safe_name("  工事名. . ", "x"), "工事名");
    assert_eq!(safe_name("a<b>c:d\"e/f\\g|h?i*j\u{1}", "x"), "a_b_c_d_e_f_g_h_i_j_");
    assert_eq!(safe_name("", "工事"), "工事");
    assert_eq!(safe_name(" . . ", "工事"), "工事");
    assert_eq!(safe_name("CON.", "工事"), "CON_");
    assert_eq!(safe_name(&"長".repeat(200), "x").chars().count(), 80);
    // 衝突（大文字小文字違いを含む）
    let t = tempfile::tempdir().unwrap();
    fs::create_dir(t.path().join("Abc")).unwrap();
    fs::create_dir(t.path().join("abc (2)")).unwrap();
    assert_eq!(unique_child(t.path(), "ABC").unwrap().file_name().unwrap(), "ABC (3)");
    // 工事の新規作成と引継ぎ取込みが同じ規則で作られる
    let p = project::create_project(&t.path().join("data"), &np("CON"), DEV).unwrap();
    assert_eq!(p.root.file_name().unwrap(), "CON_");
    let p2 = project::create_project(&t.path().join("data"), &np("con"), DEV).unwrap();
    assert_eq!(p2.root.file_name().unwrap(), "con_ (2)");
    let mut p3 = project::create_project(&t.path().join("data"), &np("LPT9.工事 . "), DEV).unwrap();
    assert_eq!(p3.root.file_name().unwrap(), "LPT9_.工事");
    let file = t.path().join("x.aoalb");
    exchange::export(&mut p3, &file, &Cancel::new(), &mut noop()).unwrap();
    fs::create_dir_all(t.path().join("B").join("lpt9_.工事")).unwrap();
    let r = exchange::import(&file, &t.path().join("B"), ImportMode::New, "device-b", &Cancel::new(), &mut noop()).unwrap();
    assert!(r.root.ends_with("LPT9_.工事 (2)"), "{}", r.root);
}

/// manifest の容量の申告を偽装した引継ぎファイルを拒否し、取込み先に何も作らない
#[test]
fn exchange_rejects_forged_sizes() {
    let t = tempfile::tempdir().unwrap();
    let (mut a, _, _) = ledger_with_photos(t.path(), 3);
    let file = t.path().join("ok.aoalb");
    exchange::export(&mut a, &file, &Cancel::new(), &mut noop()).unwrap();
    let dest = t.path().join("dest");
    fs::create_dir_all(&dest).unwrap();
    let forge = |label: &str, f: &dyn Fn(&mut serde_json::Value)| -> aoalb_core::AppError {
        let out = t.path().join(format!("{label}.aoalb"));
        rewrite_zip(&file, &out, |name, data| {
            if name != "manifest.json" {
                return Some((name.into(), data.to_vec()));
            }
            let mut v: serde_json::Value = serde_json::from_slice(data).unwrap();
            f(&mut v);
            Some((name.into(), serde_json::to_vec(&v).unwrap()))
        });
        let e = exchange::import(&out, &dest, ImportMode::New, DEV, &Cancel::new(), &mut noop()).err().unwrap_or_else(|| panic!("{label} accepted"));
        assert!(exchange::preview(&out, &[], &dest).is_err(), "{label}: preview");
        e
    };
    let real_total = {
        let ins = exchange::inspect(&file, &Cancel::new(), true).unwrap();
        assert_eq!(ins.verified_total, ins.manifest.total_bytes);
        ins.verified_total
    };
    assert!(forge("zero", &|v| v["totalBytes"] = 0.into()).detail.contains("total mismatch"));
    assert!(forge("small", &|v| v["totalBytes"] = (real_total - 1).into()).detail.contains("total mismatch"));
    assert!(forge("big", &|v| v["totalBytes"] = (real_total * 1000).into()).detail.contains("total mismatch"));
    assert!(forge("u64max", &|v| v["totalBytes"] = u64::MAX.into()).detail.contains("total mismatch"));
    // 個々の容量を巨大にして合計を桁あふれさせる
    let e = forge("overflow", &|v| {
        let f = v["files"].as_array_mut().unwrap();
        f[0]["bytes"] = u64::MAX.into();
        f[1]["bytes"] = u64::MAX.into();
    });
    assert!(e.detail.contains("overflow"), "{}", e.detail);
    // 合計は合っているが、個々の容量がZIPの中身と違う
    let e = forge("shifted", &|v| {
        let f = v["files"].as_array_mut().unwrap();
        let a = f[0]["bytes"].as_u64().unwrap();
        let b = f[1]["bytes"].as_u64().unwrap();
        f[0]["bytes"] = (a + 1).into();
        f[1]["bytes"] = (b - 1).into();
    });
    assert!(e.detail.contains("size mismatch"), "{}", e.detail);
    // 総容量の上限超え（申告と合計を一致させても拒否）
    let e = forge("toolarge", &|v| {
        let f = v["files"].as_array_mut().unwrap();
        let jpg = f.iter_mut().find(|x| x["path"].as_str().unwrap().ends_with(".jpg")).unwrap();
        jpg["bytes"] = (100u64 * 1024 * 1024).into();
        let sum: u64 = v["files"].as_array().unwrap().iter().map(|x| x["bytes"].as_u64().unwrap()).sum();
        v["totalBytes"] = sum.into();
    });
    assert!(e.detail.contains("size mismatch") || e.detail.contains("too large"), "{}", e.detail);
    // JPEG 1枚の上限超え
    let e = forge("bigjpeg", &|v| {
        let f = v["files"].as_array_mut().unwrap();
        let jpg = f.iter_mut().find(|x| x["path"].as_str().unwrap().ends_with(".jpg")).unwrap();
        jpg["bytes"] = (101u64 * 1024 * 1024).into();
        let sum: u64 = v["files"].as_array().unwrap().iter().map(|x| x["bytes"].as_u64().unwrap()).sum();
        v["totalBytes"] = sum.into();
    });
    assert!(e.detail.contains("jpeg too large"), "{}", e.detail);
    // ファイル一覧の重複
    let e = forge("dup", &|v| {
        let f = v["files"].as_array_mut().unwrap();
        let d = f[0].clone();
        f.push(d);
        let sum: u64 = v["files"].as_array().unwrap().iter().map(|x| x["bytes"].as_u64().unwrap()).sum();
        v["totalBytes"] = sum.into();
    });
    assert!(e.detail.contains("file list mismatch"), "{}", e.detail);
    // 大文字小文字だけ違う項目（ZIP側）
    let case = t.path().join("case.aoalb");
    rewrite_zip(&file, &case, |n, d| Some((n.into(), d.to_vec())));
    append_entry(&case, "Manifest.json");
    assert!(exchange::import(&case, &dest, ImportMode::New, DEV, &Cancel::new(), &mut noop()).is_err());
    // どの失敗でも取込み先に何も残さない
    assert_eq!(fs::read_dir(&dest).unwrap().count(), 0);
    // 書出し側の合計も一致
    let ins = exchange::inspect(&file, &Cancel::new(), false).unwrap();
    assert_eq!(ins.manifest.files.iter().map(|f| f.bytes).sum::<u64>(), ins.manifest.total_bytes);
}

#[test]
fn manifest_size_limits() {
    let base = |files: Vec<exchange::FileEntry>, total: u64| exchange::Manifest {
        format: exchange::FORMAT.into(),
        format_version: 1,
        app_version: "t".into(),
        export_id: util::new_uuid(),
        exported_at: "t".into(),
        project_uuid: util::new_uuid(),
        project_name: "x".into(),
        generation: 1,
        edit_seq: 0,
        last_device_id: "d".into(),
        export_device_id: "d".into(),
        counts: serde_json::json!({}),
        total_bytes: total,
        files,
    };
    let jpg = |n: usize, b: u64| exchange::FileEntry { path: format!("originals/{}.jpg", uuid_n(n)), bytes: b, sha256: "0".repeat(64) };
    // 1TiBを超える総容量（100MB×10,486枚）は、申告と一致していても拒否
    let files: Vec<_> = (0..10_486).map(|i| jpg(i, 100 * 1024 * 1024)).collect();
    let sum: u64 = files.iter().map(|f| f.bytes).sum();
    assert!(sum > exchange::MAX_TOTAL_BYTES);
    let e = exchange::verify_manifest_sizes(&base(files, sum)).err().unwrap();
    assert!(e.detail.contains("total too large"), "{}", e.detail);
    // 写真の枚数の上限
    let files: Vec<_> = (0..exchange::MAX_PHOTOS + 1).map(|i| jpg(i, 1)).collect();
    let n = files.len() as u64;
    assert!(exchange::verify_manifest_sizes(&base(files, n)).is_err());
    // JSONの上限
    let big = exchange::FileEntry { path: "data/photos.json".into(), bytes: exchange::MAX_JSON + 1, sha256: "0".repeat(64) };
    let e = exchange::verify_manifest_sizes(&base(vec![big], exchange::MAX_JSON + 1)).err().unwrap();
    assert!(e.detail.contains("json too large"));
    // 桁あふれ
    let e = exchange::verify_manifest_sizes(&base(vec![jpg(1, u64::MAX), jpg(2, 1)], 0)).err().unwrap();
    assert!(e.detail.contains("overflow"));
    // 上限ちょうどは受け付ける
    let ok = vec![jpg(1, 5), exchange::FileEntry { path: "data/project.json".into(), bytes: exchange::MAX_JSON, sha256: "0".repeat(64) }];
    assert_eq!(exchange::verify_manifest_sizes(&base(ok, exchange::MAX_JSON + 5)).unwrap(), exchange::MAX_JSON + 5);
}

fn uuid_n(n: usize) -> String {
    format!("00000000-0000-4000-8000-{n:012x}")
}

/// PDFの上限：見積りが上限以内なら作成、超えるなら作成しない、作成中に超えたら中止。いずれも途中ファイルを残さない
#[test]
fn pdf_size_limit_before_and_during() {
    let t = tempfile::tempdir().unwrap();
    let (mut p, l, ids) = ledger_with_photos(t.path(), 12);
    let s = slot_ids(&ledger::detail(&p.conn, &l).unwrap());
    ledger::apply_ops(&mut p, &l, &[Op::PlaceMany { from: s[0].clone(), photos: ids.clone() }]).unwrap();
    let hashes = originals_hashes(&p);
    let exports = p.root.join("exports");
    let leftovers = || fs::read_dir(&exports).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().contains("partial")).count();
    let est = pdf::estimate(&p, &l, pdf::PDF_MAX_BYTES).unwrap();
    assert!(est.within_limit);
    assert_eq!(est.images, 12);
    // 上限ちょうど（見積りと同じ）：作成でき、実際の容量は見積り以下
    let ok = exports.join("ok.pdf");
    let r = pdf::export_ledger_pdf_with(&p, &l, &ok, &Cancel::new(), &mut noop(), pdf::PdfLimits { max_bytes: est.bytes, precheck: true }).unwrap();
    assert!(r.bytes <= est.bytes, "見積り {} 実際 {}", est.bytes, r.bytes);
    // 上限を1バイトでも下回る：作成を開始しない
    let ng = exports.join("ng.pdf");
    let e = pdf::export_ledger_pdf_with(&p, &l, &ng, &Cancel::new(), &mut noop(), pdf::PdfLimits { max_bytes: est.bytes - 1, precheck: true }).err().unwrap();
    assert!(e.message.contains("上限") && e.message.contains("ページを分け"), "{}", e.message);
    assert!(!ng.exists());
    // 作成中に上限へ達する：途中で中止し、完成品も途中ファイルも残さない
    let mid = exports.join("mid.pdf");
    let e = pdf::export_ledger_pdf_with(&p, &l, &mid, &Cancel::new(), &mut noop(), pdf::PdfLimits { max_bytes: r.bytes / 2, precheck: false }).err().unwrap();
    assert!(e.detail.contains("pdf size limit"), "{}", e.detail);
    assert!(!mid.exists());
    assert_eq!(leftovers(), 0);
    // 既定の上限は classic xref の範囲内で、3割以上の余裕
    const { assert!(pdf::PDF_MAX_BYTES * 13 / 10 <= pdf::CLASSIC_XREF_MAX_OFFSET, "classic xref に3割以上の余裕") };
    // 上限を超える見積りは作成前に断る（上限を小さくして確認。原寸は変更しない）
    let big = pdf::estimate(&p, &l, 1_000_000).unwrap();
    assert!(!big.within_limit && big.message.unwrap().contains("作成しません"));
    assert_eq!(hashes, originals_hashes(&p));
}

/// 出力先を確定できない（Windowsで出力先PDFを別ソフトが開いている等）。
/// ここでは出力先と同名の、中身のあるフォルダを置いて最終renameを必ず失敗させる（Linux・Windowsとも失敗する）。
fn occupied_dest(dir: &Path, name: &str) -> PathBuf {
    let dest = dir.join(name);
    fs::create_dir_all(&dest).unwrap();
    fs::write(dest.join("開いている.txt"), b"existing").unwrap();
    dest
}

fn partial_files(dir: &Path) -> Vec<String> {
    fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).filter(|n| n.contains("partial")).collect()
}

fn sync_meta(p: &Project) -> Vec<i64> {
    ["generation", "sync_generation", "sync_edit_seq", "edit_seq"].iter().map(|k| db::meta_i64(&p.conn, k).unwrap()).collect()
}

#[test]
fn final_rename_failure_removes_temp_pdf() {
    let t = tempfile::tempdir().unwrap();
    let (mut p, l, ids) = ledger_with_photos(t.path(), 6);
    let s = slot_ids(&ledger::detail(&p.conn, &l).unwrap());
    ledger::apply_ops(&mut p, &l, &[Op::PlaceMany { from: s[0].clone(), photos: ids.clone() }]).unwrap();
    let hashes = originals_hashes(&p);
    let out = t.path().join("out");
    fs::create_dir_all(&out).unwrap();
    let dest = occupied_dest(&out, "台帳.pdf");
    let e = pdf::export_ledger_pdf(&p, &l, &dest, &Cancel::new(), &mut noop()).expect_err("rename must fail");
    assert_eq!(e.kind, ErrorKind::Locked);
    assert!(e.message.contains("使用中") && e.message.contains("書き込めません"), "{}", e.message);
    assert!(e.detail.contains("finalize rename"), "{}", e.detail);
    assert!(partial_files(&out).is_empty(), "一時ファイルが残った: {:?}", partial_files(&out));
    assert_eq!(fs::read(dest.join("開いている.txt")).unwrap(), b"existing", "既存の出力先は変更しない");
    assert_eq!(hashes, originals_hashes(&p));
    // 出力先が空けば作成できる
    let ok = out.join("台帳2.pdf");
    pdf::export_ledger_pdf(&p, &l, &ok, &Cancel::new(), &mut noop()).unwrap();
    assert!(ok.exists() && partial_files(&out).is_empty());
}

#[test]
fn final_rename_failure_removes_temp_exchange_and_keeps_generation() {
    let t = tempfile::tempdir().unwrap();
    let mut p = new_project(t.path(), "引継ぎ確定失敗");
    let src = t.path().join("src");
    import_files(&mut p, write_photos(&src, 5));
    let hashes = originals_hashes(&p);
    let before = sync_meta(&p);
    let out = t.path().join("out");
    fs::create_dir_all(&out).unwrap();
    let dest = occupied_dest(&out, "工事.aoalb");
    let e = exchange::export(&mut p, &dest, &Cancel::new(), &mut noop()).expect_err("rename must fail");
    assert_eq!(e.kind, ErrorKind::Locked);
    assert!(e.message.contains("使用中"), "{}", e.message);
    assert!(partial_files(&out).is_empty(), "一時ファイルが残った: {:?}", partial_files(&out));
    assert_eq!(fs::read(dest.join("開いている.txt")).unwrap(), b"existing");
    assert_eq!(sync_meta(&p), before, "世代・同期記録は一切更新しない");
    assert_eq!(hashes, originals_hashes(&p));
    assert!(db::integrity_ok(&p.conn).unwrap());
    // 再試行で成功すると世代は1つだけ進み、3項目がそろって更新される
    let ok = out.join("工事2.aoalb");
    let r = exchange::export(&mut p, &ok, &Cancel::new(), &mut noop()).unwrap();
    let after = sync_meta(&p);
    assert_eq!(r.generation, before[0] + 1);
    assert_eq!(after[0], before[0] + 1);
    assert_eq!(after[1], after[0]);
    assert_eq!(after[2], before[3]);
    assert!(partial_files(&out).is_empty());
}
