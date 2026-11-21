//! 4GB超の引継ぎファイル（ZIP64）の計測：所要時間・工程ごとの最大メモリ・ファイル容量。
//! cargo run --release -p aoalb_core --example huge_exchange -- <作業フォルダ> [枚数=46] [1枚のMB=95]
use aoalb_core::exchange::{self, ImportMode};
use aoalb_core::photos::{self, ImportOptions, ImportSource};
use aoalb_core::project::{self, NewProject};
use aoalb_core::{synth, util::Cancel};
use serde_json::json;
use std::io::Write;
use std::time::Instant;

fn kv(file: &str, key: &str) -> u64 { std::fs::read_to_string(file).unwrap_or_default().lines().find(|l| l.starts_with(key)).and_then(|l| l.split_whitespace().nth(1)).and_then(|v| v.parse().ok()).unwrap_or(0) }
fn step<T>(name: &str, out: &mut serde_json::Map<String, serde_json::Value>, f: impl FnOnce() -> T) -> T {
    let _ = std::fs::write("/proc/self/clear_refs", "5");
    let t = Instant::now();
    let v = f();
    out.insert(name.into(), json!({"seconds": (t.elapsed().as_secs_f64() * 10.0).round() / 10.0, "peakRssMB": kv("/proc/self/status", "VmHWM:") / 1024}));
    v
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let base = std::path::PathBuf::from(a.get(1).cloned().unwrap_or_else(|| "/tmp/aoalb2-huge".into()));
    let n: usize = a.get(2).and_then(|s| s.parse().ok()).unwrap_or(46);
    let mb: usize = a.get(3).and_then(|s| s.parse().ok()).unwrap_or(95);
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(base.join("src")).unwrap();
    let mut out = serde_json::Map::new();
    let mut p = project::create_project(&base, &NewProject { name: "巨大工事".into(), ..Default::default() }, "bench").unwrap();
    let jpeg = synth::jpeg(640, 480, 1, 80);
    let pad = vec![0x5Au8; mb * 1024 * 1024];
    step("import", &mut out, || for i in 0..n {
        let f = base.join("src").join(format!("big{i}.jpg"));
        let mut w = std::fs::File::create(&f).unwrap();
        w.write_all(&synth::with_comment(&jpeg, &format!("huge{i}"))).unwrap();
        w.write_all(&pad).unwrap();
        drop(w);
        photos::import(&mut p, &ImportSource::Files { paths: vec![f.clone()] }, ImportOptions::default(), &Cancel::new(), &mut |_| {}).unwrap();
        std::fs::remove_file(&f).unwrap();
    });
    drop(pad);
    let originals: u64 = std::fs::read_dir(p.originals_dir()).unwrap().map(|e| e.unwrap().metadata().unwrap().len()).sum();
    let file = base.join("巨大.aoalb");
    let r = step("export_with_verify", &mut out, || exchange::export(&mut p, &file, &Cancel::new(), &mut |_| {}).unwrap());
    p.close().unwrap();
    let imp = step("import_aoalb", &mut out, || exchange::import(&file, &base.join("B"), ImportMode::New, "bench-b", &Cancel::new(), &mut |_| {}).unwrap());
    out.insert("photos".into(), json!(imp.photos));
    out.insert("originalsBytes".into(), json!(originals));
    out.insert("aoalbBytes".into(), json!(r.bytes));
    out.insert("compressionRatio".into(), json!((r.bytes as f64 / originals as f64 * 10000.0).round() / 10000.0));
    out.insert("zip64".into(), json!(r.bytes > u32::MAX as u64));
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
    let _ = std::fs::remove_dir_all(&base);
}
