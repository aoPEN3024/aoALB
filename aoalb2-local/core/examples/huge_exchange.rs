//! 4GB超の引継ぎファイル（ZIP64）の通し試験と計測。架空JPEGだけを使い、終わったら作業フォルダを消す。
//! 書出し（書出し後の全件再検証を含む）→ 全件再検証 → 別フォルダへの取込み → SHA-256照合 →
//! manifest容量の再計算一致 → 既存工事（同名）への影響なし、を確認し、工程ごとの所要時間と最大メモリを出力する。
//! cargo run --release -p aoalb_core --example huge_exchange -- <作業フォルダ> [枚数=46] [1枚のMB=95]
use aoalb_core::exchange::{self, ImportMode};
use aoalb_core::photos::{self, ImportOptions, ImportSource};
use aoalb_core::project::{self, NewProject};
use aoalb_core::{synth, util, util::Cancel};
use serde_json::json;
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

fn kv(file: &str, key: &str) -> u64 {
    std::fs::read_to_string(file)
        .unwrap_or_default()
        .lines()
        .find(|l| l.starts_with(key))
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}
fn step<T>(name: &str, out: &mut serde_json::Map<String, serde_json::Value>, f: impl FnOnce() -> T) -> T {
    // VmHWM（最大常駐メモリ）を工程ごとにリセットして計る（Linux）
    let _ = std::fs::write("/proc/self/clear_refs", "5");
    let t = Instant::now();
    let v = f();
    out.insert(name.into(), json!({"seconds": (t.elapsed().as_secs_f64() * 10.0).round() / 10.0, "peakRssMB": kv("/proc/self/status", "VmHWM:") / 1024}));
    v
}

/// フォルダ以下の全ファイルの SHA-256（相対パス → ハッシュ）
fn tree_hashes(root: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                stack.push(p);
            } else {
                let rel = p.strip_prefix(root).unwrap().to_string_lossy().to_string();
                out.insert(rel, util::hash_file(&p, &Cancel::new()).unwrap().0);
            }
        }
    }
    out
}

fn originals(dir: &Path) -> BTreeMap<String, String> {
    std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .map(|p| (p.file_name().unwrap().to_string_lossy().to_string(), util::hash_file(&p, &Cancel::new()).unwrap().0))
        .collect()
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let base = PathBuf::from(a.get(1).cloned().unwrap_or_else(|| "/tmp/aoalb2-huge".into()));
    let n: usize = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(46);
    let mb: usize = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(95);
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(base.join("src")).unwrap();
    let mut out = serde_json::Map::new();
    let jpeg = synth::jpeg(640, 480, 1, 80);

    // 取込み先に、同じ名前の既存工事を先に置く（影響がないことを確認する）
    let dest_parent = base.join("B");
    std::fs::create_dir_all(&dest_parent).unwrap();
    let existing_root = {
        let mut e = project::create_project(&dest_parent, &NewProject { name: "巨大工事".into(), ..Default::default() }, "device-b").unwrap();
        let f = base.join("src").join("existing.jpg");
        std::fs::write(&f, synth::with_comment(&jpeg, "existing")).unwrap();
        photos::import(&mut e, &ImportSource::Files { paths: vec![f.clone()] }, ImportOptions::default(), &Cancel::new(), &mut |_| {}).unwrap();
        std::fs::remove_file(&f).unwrap();
        let root = e.root.clone();
        e.close().unwrap();
        root
    };
    let existing_before = tree_hashes(&existing_root);

    let mut p = project::create_project(&base.join("A"), &NewProject { name: "巨大工事".into(), ..Default::default() }, "device-a").unwrap();
    let pad = vec![0x5Au8; mb * 1024 * 1024];
    step("import_photos", &mut out, || {
        for i in 0..n {
            let f = base.join("src").join(format!("big{i}.jpg"));
            let mut w = std::fs::File::create(&f).unwrap();
            w.write_all(&synth::with_comment(&jpeg, &format!("huge{i}"))).unwrap();
            w.write_all(&pad).unwrap();
            drop(w);
            photos::import(&mut p, &ImportSource::Files { paths: vec![f.clone()] }, ImportOptions::default(), &Cancel::new(), &mut |_| {}).unwrap();
            std::fs::remove_file(&f).unwrap();
        }
    });
    drop(pad);
    let a_originals = originals(&p.originals_dir());
    let originals_bytes: u64 = std::fs::read_dir(p.originals_dir()).unwrap().map(|e| e.unwrap().metadata().unwrap().len()).sum();

    let file = base.join("受渡し").join("巨大.aoalb");
    let r = step("export_with_verify", &mut out, || exchange::export(&mut p, &file, &Cancel::new(), &mut |_| {}).unwrap());
    let a_root = p.root.clone();
    p.close().unwrap();
    assert_eq!(a_originals, originals(&a_root.join("originals")), "書出しで原寸が変わった");

    // 全件再検証（全ファイルのSHA-256）と manifest 容量の再計算
    let ins = step("verify_all", &mut out, || exchange::inspect(&file, &Cancel::new(), true).unwrap());
    let recomputed: u64 = ins.manifest.files.iter().map(|f| f.bytes).sum();
    let recheck = exchange::verify_manifest_sizes(&ins.manifest).unwrap();
    assert_eq!(ins.verified_total, recomputed);
    assert_eq!(recheck, recomputed);
    assert_eq!(ins.manifest.total_bytes, recomputed, "manifest の総容量と再計算値が一致しない");

    // 別フォルダへ取込み（同名の既存工事がある場所）
    let imp = step("import_aoalb", &mut out, || exchange::import(&file, &dest_parent, ImportMode::New, "device-b", &Cancel::new(), &mut |_| {}).unwrap());
    let imp_root = PathBuf::from(&imp.root);
    assert_ne!(imp_root, existing_root, "既存工事のフォルダへ取り込んだ");
    let b_originals = step("compare_sha256", &mut out, || originals(&imp_root.join("originals")));
    assert_eq!(a_originals, b_originals, "取込み後の原寸のSHA-256が一致しない");
    assert_eq!(existing_before, tree_hashes(&existing_root), "既存工事が変更された");
    let leftovers: Vec<String> = std::fs::read_dir(file.parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .filter(|n| n.contains("partial"))
        .collect();
    assert!(leftovers.is_empty(), "一時ファイルが残った: {leftovers:?}");

    out.insert("photos".into(), json!(imp.photos));
    out.insert("originalsBytes".into(), json!(originals_bytes));
    out.insert("aoalbBytes".into(), json!(r.bytes));
    out.insert("manifestTotalBytes".into(), json!(ins.manifest.total_bytes));
    out.insert("recomputedTotalBytes".into(), json!(recomputed));
    out.insert("zip64".into(), json!(r.bytes > u32::MAX as u64));
    out.insert("sha256AllMatch".into(), json!(true));
    out.insert("existingProjectUnchanged".into(), json!(true));
    out.insert("importedFolder".into(), json!(imp_root.file_name().unwrap().to_string_lossy()));
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
    let _ = std::fs::remove_dir_all(&base);
}
