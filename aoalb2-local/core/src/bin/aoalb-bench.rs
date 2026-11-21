//! 性能計測（架空データ）。 aoalb-bench <写真枚数> <作業フォルダ>
//! 一般写真（4000x3000）とaoPIC写真（1280x960）を7:3で混ぜ、取込み〜PDF・引継ぎまでを計測する。
use aoalb_core::classify::{self, FieldChange};
use aoalb_core::exchange::{self, ImportMode};
use aoalb_core::ledger::{self, Op};
use aoalb_core::photos::{self, ImportOptions, ImportSource, PhotoFilter};
use aoalb_core::project::{self, NewProject};
use aoalb_core::util::Cancel;
use aoalb_core::{backup, pdf, synth};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Instant;

fn proc_kv(file: &str, key: &str) -> u64 {
    std::fs::read_to_string(file).unwrap_or_default().lines().find(|l| l.starts_with(key))
        .and_then(|l| l.split_whitespace().nth(1)).and_then(|v| v.parse().ok()).unwrap_or(0)
}
fn rss_mb() -> f64 { proc_kv("/proc/self/status", "VmRSS:") as f64 / 1024.0 }
fn peak_mb() -> f64 { proc_kv("/proc/self/status", "VmHWM:") as f64 / 1024.0 }
fn io() -> (u64, u64) { (proc_kv("/proc/self/io", "rchar:"), proc_kv("/proc/self/io", "wchar:")) }

struct M { out: BTreeMap<String, Value> }
impl M {
    fn time<T>(&mut self, name: &str, f: impl FnOnce() -> T) -> T {
        let (r0, w0) = io();
        let t = Instant::now();
        let v = f();
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        let (r1, w1) = io();
        self.out.insert(name.into(), json!({"ms": (ms * 10.0).round() / 10.0, "readMB": ((r1 - r0) as f64 / 1048576.0 * 10.0).round() / 10.0,
            "writeMB": ((w1 - w0) as f64 / 1048576.0 * 10.0).round() / 10.0, "rssMB": rss_mb().round()}));
        v
    }
    fn note(&mut self, name: &str, v: Value) { self.out.insert(name.into(), v); }
}

fn main() {
    let n: usize = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(100);
    let work = PathBuf::from(std::env::args().nth(2).unwrap_or_else(|| "bench-work".into()));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(work.join("src")).unwrap();
    let mut m = M { out: BTreeMap::new() };
    // 架空写真の準備（計測外）
    let cams = [synth::jpeg(4000, 3000, 1, 88), synth::jpeg(4000, 3000, 2, 88), synth::jpeg(3000, 4000, 3, 88)];
    let general = n * 7 / 10;
    let mut files = Vec::new();
    for i in 0..general {
        let f = work.join("src").join(format!("DSC{i:05}.JPG"));
        std::fs::write(&f, synth::with_exif(&synth::with_comment(&cams[i % 3], &format!("b{i}")), Some(&format!("2026:10:{:02} {:02}:{:02}:00", 1 + (i / 200) % 28, 8 + (i / 60) % 10, i % 60)), Some(1))).unwrap();
        files.push(f);
    }
    let aopic_n = n - general;
    if aopic_n > 0 { synth::aopic_zip(&work.join("src/aopic.zip"), aopic_n); }
    let src_mb: f64 = files.iter().map(|f| std::fs::metadata(f).unwrap().len()).sum::<u64>() as f64 / 1048576.0;
    m.note("photos", json!({"total": n, "general": general, "aopic": aopic_n, "generalSourceMB": src_mb.round()}));

    let start_rss = rss_mb();
    let mut p = m.time("create_project", || project::create_project(&work.join("data"), &NewProject { name: "性能計測工事".into(), ..Default::default() }, "bench").unwrap());
    let r = m.time("import_general", || photos::import(&mut p, &ImportSource::Files { paths: files.clone() }, ImportOptions::default(), &Cancel::new(), &mut |_| {}).unwrap());
    assert_eq!(r.accepted as usize, general);
    if aopic_n > 0 { m.time("import_aopic_zip", || photos::import(&mut p, &ImportSource::Zip { path: work.join("src/aopic.zip") }, ImportOptions::default(), &Cancel::new(), &mut |_| {}).unwrap()); }
    let thumbs = m.time("thumbnails_all", || { let mut t = 0; loop { let k = photos::process_pending_thumbnails(&p.conn, &p.root, 200, &Cancel::new()).unwrap(); if k == 0 { break t; } t += k; } });
    m.note("thumbnail_count", json!(thumbs));
    let root = p.root.clone();
    m.time("close_project", || ());
    p.close().unwrap();
    let (mut p, _) = m.time("open_project", || project::open_project(&root, "bench").unwrap());
    let list = m.time("list_photos_first", || photos::list_photos(&p.conn, &PhotoFilter::default()).unwrap());
    m.time("list_photos_again", || photos::list_photos(&p.conn, &PhotoFilter::default()).unwrap());
    m.time("list_unclassified", || photos::list_photos(&p.conn, &PhotoFilter { unclassified_only: true, ..Default::default() }).unwrap());
    m.note("list_json_kb", json!(serde_json::to_vec(&list).unwrap().len() / 1024));
    let ids: Vec<String> = list.iter().map(|x| x.uuid.clone()).collect();
    if !ids.is_empty() {
        let sel: Vec<String> = ids.iter().take(100).cloned().collect();
        let mut ch = BTreeMap::new();
        ch.insert("koushu".into(), FieldChange::Set("塗装工".into()));
        ch.insert("shubetsu".into(), FieldChange::Set("橋梁塗装".into()));
        let undo = m.time("classify_100", || classify::apply(&mut p, &sel, &ch).unwrap());
        m.time("classify_undo_100", || classify::restore_states(&mut p, &undo).unwrap());
        let all = ids.clone();
        let mut ch1 = BTreeMap::new();
        ch1.insert("tekiyo".into(), FieldChange::Set("一括".into()));
        m.time("classify_all", || classify::apply(&mut p, &all, &ch1).unwrap());
    }
    // 台帳：全写真を配置（3枚/ページ）
    let l = m.time("ledger_create", || ledger::create(&mut p, "計測台帳", 1).unwrap());
    if !ids.is_empty() {
        let s0 = l.pages[0].slots[0].uuid.clone();
        let r = m.time("ledger_place_all", || ledger::apply_ops(&mut p, &l.uuid, &[Op::PlaceMany { from: s0, photos: ids.clone() }]).unwrap());
        m.note("ledger_pages", json!(r.detail.pages.len()));
        let d = m.time("ledger_open", || ledger::detail(&p.conn, &l.uuid).unwrap());
        let slots: Vec<String> = d.pages.iter().flat_map(|pg| pg.slots.iter().map(|s| s.uuid.clone())).collect();
        if slots.len() >= 2 {
            let last = slots[slots.len() - 1].clone();
            let r = m.time("op_swap_first_last", || ledger::apply_ops(&mut p, &l.uuid, &[Op::Swap { a: slots[0].clone(), b: last.clone() }]).unwrap());
            m.note("op_swap_changed_slots", json!(r.changed_slots));
            let r = m.time("op_clear_one", || ledger::apply_ops(&mut p, &l.uuid, &[Op::Clear { slot: slots[1].clone() }]).unwrap());
            m.note("op_clear_changed_slots", json!(r.changed_slots));
            let r = m.time("op_place_one", || ledger::apply_ops(&mut p, &l.uuid, &[Op::Place { slot: slots[1].clone(), photo: ids[1.min(ids.len() - 1)].clone() }]).unwrap());
            m.note("op_place_changed_slots", json!(r.changed_slots));
            let burst: Vec<Op> = (0..20).map(|k| Op::Swap { a: slots[k % slots.len()].clone(), b: slots[(k + 1) % slots.len()].clone() }).collect();
            m.time("op_burst_20_swaps", || ledger::apply_ops(&mut p, &l.uuid, &burst).unwrap());
        }
        // 他の台帳を増やして一覧
        for k in 0..9 { ledger::create(&mut p, &format!("台帳{k}"), 2).unwrap(); }
        m.time("ledger_list_10", || ledger::list(&p.conn, false).unwrap());
        for k in 0..40 { ledger::create(&mut p, &format!("追加台帳{k}"), 2).unwrap(); }
        m.time("ledger_list_50", || ledger::list(&p.conn, false).unwrap());
        let pdf_path = p.root.join("exports").join("計測台帳.pdf");
        let pr = m.time("pdf_ledger_all", || pdf::export_ledger_pdf(&p, &l.uuid, &pdf_path, &Cancel::new(), &mut |_| {}).unwrap());
        m.note("pdf", json!({"pages": pr.pages, "images": pr.images, "MB": (pr.bytes as f64 / 1048576.0).round(), "decodedOriginals": 0}));
    }
    m.time("backup_db", || backup::create(&p, backup::Reason::Manual).unwrap());
    let ex = work.join("transfer").join("計測.aoalb");
    let er = m.time("export_aoalb", || exchange::export(&mut p, &ex, &Cancel::new(), &mut |_| {}).unwrap());
    m.note("export_MB", json!((er.bytes as f64 / 1048576.0).round()));
    let ir = m.time("import_aoalb", || exchange::import(&ex, &work.join("deviceB"), ImportMode::New, "bench-b", &Cancel::new(), &mut |_| {}).unwrap());
    m.note("import_photos", json!(ir.photos));
    m.note("memory", json!({"startRssMB": start_rss.round(), "peakRssMB": peak_mb().round()}));
    println!("{}", serde_json::to_string_pretty(&m.out).unwrap());
    if std::env::var("BENCH_KEEP").is_err() { let _ = std::fs::remove_dir_all(&work); }
}
