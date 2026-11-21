//! 架空データで台帳PDFを作る（見た目確認用）。 cargo run --example demo_pdf -- <出力フォルダ>
use aoalb_core::ledger::{self, Op};
use aoalb_core::photos::{self, ImportOptions, ImportSource, PhotoFilter};
use aoalb_core::project::{self, NewProject};
use aoalb_core::util::Cancel;
use aoalb_core::{pdf, synth};
use std::path::PathBuf;

fn main() {
    let out = PathBuf::from(std::env::args().nth(1).unwrap_or_else(|| "demo-out".into()));
    let _ = std::fs::remove_dir_all(&out);
    std::fs::create_dir_all(out.join("src")).unwrap();
    let mut p = project::create_project(
        &out,
        &NewProject { name: "架空 橋梁塗装工事".into(), kouji_code: "K-1".into(), contractor: "架空建設株式会社".into() },
        "demo",
    )
    .unwrap();
    synth::aopic_zip(&out.join("src/aopic.zip"), 3);
    photos::import(&mut p, &ImportSource::Zip { path: out.join("src/aopic.zip") }, ImportOptions::default(), &Cancel::new(), &mut |_| {}).unwrap();
    let mut files = vec![];
    for (i, o) in [1u16, 6, 3, 8].iter().enumerate() {
        let f = out.join(format!("src/cam{i}.jpg"));
        std::fs::write(&f, synth::with_exif(&synth::jpeg(1600, 1200, 20 + i as u32, 85), Some("2026:11:20 10:00:00"), Some(*o))).unwrap();
        files.push(f);
    }
    photos::import(&mut p, &ImportSource::Files { paths: files }, ImportOptions::default(), &Cancel::new(), &mut |_| {}).unwrap();
    let ids: Vec<String> = photos::list_photos(&p.conn, &PhotoFilter::default()).unwrap().into_iter().map(|x| x.uuid).collect();
    let l = ledger::create(&mut p, "第1回 塗装工事写真", 1).unwrap();
    let s0 = l.pages[0].slots[0].uuid.clone();
    let r = ledger::apply_ops(&mut p, &l.uuid, &[Op::PlaceMany { from: s0, photos: ids.clone() }]).unwrap();
    let s = r.detail.pages[1].slots[0].uuid.clone();
    let mut f = serde_json::Map::new();
    f.insert("body".into(), serde_json::json!("下塗り完了状況。\n膜厚測定：規定値以上を確認。ABC-123 半角混在テスト。髙﨑①㈱"));
    ledger::apply_ops(
        &mut p,
        &l.uuid,
        &[
            Op::InsertBlank { slot: s },
            Op::SetCaption { photo: ids[3].clone(), fields: f },
            Op::SetCover {
                cover: serde_json::json!({"title": "工事写真帳", "koushu": "塗装工", "project": "架空 橋梁塗装工事", "contractor": "架空建設株式会社"}),
            },
        ],
    )
    .unwrap();
    let r = pdf::export_ledger_pdf(&p, &l.uuid, &out.join("ledger.pdf"), &Cancel::new(), &mut |_| {}).unwrap();
    println!("{}", serde_json::to_string_pretty(&r).unwrap());
}
