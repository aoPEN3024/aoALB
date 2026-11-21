//! 台帳PDFの書き出し。
//!
//! - 原寸JPEGをデコード・再圧縮せず、そのままPDFへ埋め込む（DCTDecode）。メモリには1枚分のバッファしか持たない。
//! - EXIFの向きは画像を書き換えず、PDFの座標変換で補正する。
//! - 書出し中は `*.partial` に書き、完成後に名前を確定する（途中失敗を完成品として残さない）。
//! - レイアウトは現行aoALBの印刷CSS（A4縦・1ページ3枠・写真68.3%／文言31.7%）に合わせる。
//! - 日本語はアプリに同梱した BIZ UDゴシック（SIL OFL 1.1、fonts/ 参照）から使用文字だけを抜き出して埋め込む。
//!   端末や閲覧ソフトのフォントには依存しない。収録外の文字は「〓」にして警告する。

use crate::error::{AppError, Result};
use crate::ledger::{self, LedgerDetail};
use crate::photos::{self, PhotoFilter, PhotoRow};
use crate::project::Project;
use crate::util::{self, Cancel, Progress, ProgressFn};
use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufWriter, Seek, Write};
use std::path::Path;

/// 同梱フォント（BIZ UDゴシック Regular 1.05、SIL OFL 1.1。ライセンスは core/fonts/OFL.txt）
pub const BUNDLED_FONT: &[u8] = include_bytes!("../fonts/BIZUDGothic-Regular.ttf");
pub const BUNDLED_FONT_NAME: &str = "BIZ UDゴシック（同梱）";
pub const BUNDLED_FONT_LICENSE: &str = include_str!("../fonts/OFL.txt");

const MM: f64 = 72.0 / 25.4;
const PAGE_W: f64 = 210.0;
const PAGE_H: f64 = 297.0;
const PAD_T: f64 = 20.0;
const PAD_R: f64 = 14.0;
const PAD_L: f64 = 24.0;
const GAP: f64 = 2.0;
const SLOT_H: f64 = 87.4;
const PHOTO_RATIO: f64 = 0.683;
const FONT_STEPS: [f64; 6] = [10.5, 10.0, 9.5, 9.0, 8.5, 8.0];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfWarning {
    pub page: usize,
    pub slot: usize,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfReport {
    pub path: String,
    pub pages: usize,
    pub images: usize,
    pub bytes: u64,
    pub font: String,
    pub warnings: Vec<PdfWarning>,
}

/// classic xref（`{offset:010}`）で表せる最大のバイト位置
pub const CLASSIC_XREF_MAX_OFFSET: u64 = 9_999_999_999;
/// 作成するPDFの上限（7.0GB）。classic xref の上限（約10GB）に対して3割の余裕を持たせる
pub const PDF_MAX_BYTES: u64 = 7_000_000_000;

#[derive(Debug, Clone, Copy)]
pub struct PdfLimits {
    /// これを超えるPDFは作らない（作成前の見積りと作成中の両方で確認）
    pub max_bytes: u64,
    /// 作成前の見積りで止めるか（試験で作成中の中止を確認する時だけ false）
    pub precheck: bool,
}
impl Default for PdfLimits {
    fn default() -> Self {
        Self { max_bytes: PDF_MAX_BYTES, precheck: true }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfEstimate {
    /// 推定容量（安全側に多めに見積もる）
    pub bytes: u64,
    pub pages: usize,
    pub images: usize,
    pub limit: u64,
    pub within_limit: bool,
    /// 上限を超える場合の案内
    pub message: Option<String>,
}

/// PDFの容量を見積もる。原寸JPEGはそのまま入るため、写真の合計＋ページごとの文字・枠＋フォントの上限で計算する。
pub fn estimate(project: &Project, ledger_uuid: &str, limit: u64) -> Result<PdfEstimate> {
    let detail = ledger::detail(&project.conn, ledger_uuid)?;
    let ids: Vec<String> = detail.pages.iter().flat_map(|p| p.slots.iter().filter_map(|s| s.photo_uuid.clone())).collect();
    let images: u64 = project.conn.query_row(
        "select coalesce(sum(bytes), 0) from photos where uuid in (select value from json_each(?1))",
        [serde_json::to_string(&ids)?],
        |r| r.get::<_, i64>(0),
    )? as u64;
    let pages = detail.pages.len() + detail.show_cover as usize;
    let bytes = images
        .saturating_add(ids.len() as u64 * 400) // 画像ごとの見出し
        .saturating_add(pages as u64 * 16 * 1024) // ページごとの線・文字・見出し（実測は1〜4KB）
        .saturating_add(BUNDLED_FONT.len() as u64) // 埋め込むフォント（抜き出しなので必ずこれ以下）
        .saturating_add(2 * 1024 * 1024); // 文字対応表・相互参照表など
    let within = bytes <= limit;
    let gb = |b: u64| format!("{:.1}GB", b as f64 / 1e9);
    Ok(PdfEstimate { bytes, pages, images: ids.len(), limit, within_limit: within,
        message: (!within).then(|| format!("この台帳のPDFは約{}になり、1つのPDFの上限（{}）を超えるため作成しません。台帳を複製して前半・後半のようにページを分けてから、それぞれPDFにしてください。（分割出力・印刷用の縮小版は今後対応予定です。原寸写真は変更しません）", gb(bytes), gb(limit))) })
}

struct Pdf<W: Write + Seek> {
    w: W,
    offsets: Vec<u64>,
    pos: u64,
    max: u64,
}

impl<W: Write + Seek> Pdf<W> {
    fn raw(&mut self, s: &[u8]) -> Result<()> {
        self.w.write_all(s)?;
        self.pos += s.len() as u64;
        self.guard()
    }
    /// 作成中に上限へ近づいたら中止する（途中のファイルは呼出し側で削除し、完成品として残さない）
    fn guard(&self) -> Result<()> {
        if self.pos > self.max || self.pos > CLASSIC_XREF_MAX_OFFSET {
            return Err(AppError::invalid("PDFが上限の大きさに近づいたため作成を中止しました。台帳のページを分けてからPDFにしてください。")
                .with_detail(format!("pdf size limit {} reached at {}", self.max, self.pos)));
        }
        Ok(())
    }
    fn reserve(&mut self) -> usize {
        self.offsets.push(0);
        self.offsets.len()
    }
    fn begin(&mut self, id: usize) -> Result<()> {
        self.offsets[id - 1] = self.pos;
        self.raw(format!("{id} 0 obj\n").as_bytes())
    }
    fn obj(&mut self, id: usize, body: &str) -> Result<()> {
        self.begin(id)?;
        self.raw(body.as_bytes())?;
        self.raw(b"\nendobj\n")
    }
    fn stream(&mut self, id: usize, dict: &str, data: &[u8]) -> Result<()> {
        self.begin(id)?;
        self.raw(format!("<< {dict} /Length {} >>\nstream\n", data.len()).as_bytes())?;
        self.raw(data)?;
        self.raw(b"\nendstream\nendobj\n")
    }
}

/// UTF-16BEの16進文字列（BMP外の文字は「〓」に置換）
fn hex_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 4 + 2);
    out.push('<');
    for c in s.chars() {
        let u = if (c as u32) > 0xFFFF || c.is_control() { 0x3013 } else { c as u32 };
        out.push_str(&format!("{u:04X}"));
    }
    out.push('>');
    out
}

/// 文字幅の計算と文字コード化。埋込みフォントがあれば実際の字幅を使う。
pub struct TextFont<'a> {
    face: Option<ttf_parser::Face<'a>>,
    data: &'a [u8],
    index: u32,
    remapper: subsetter::GlyphRemapper,
    /// 新グリフID → 文字（コピー・検索用のToUnicode）
    used: std::collections::BTreeMap<u16, char>,
    /// フォントに無かった文字（「〓」で代用）
    pub missing: std::collections::BTreeSet<char>,
    pub name: String,
}

impl<'a> TextFont<'a> {
    pub fn builtin() -> Self {
        Self {
            face: None,
            data: &[],
            index: 0,
            remapper: subsetter::GlyphRemapper::new(),
            used: Default::default(),
            missing: Default::default(),
            name: "builtin".into(),
        }
    }
    pub fn embedded(data: &'a [u8], index: u32, name: String) -> Option<Self> {
        let face = ttf_parser::Face::parse(data, index).ok()?;
        if matches!(face.permissions(), Some(ttf_parser::Permissions::Restricted)) || !face.is_subsetting_allowed() {
            return None;
        }
        face.glyph_index('あ')?;
        let mut remapper = subsetter::GlyphRemapper::new();
        remapper.remap(0);
        Some(Self { face: Some(face), data, index, remapper, used: Default::default(), missing: Default::default(), name })
    }
    fn glyph(&self, c: char) -> Option<ttf_parser::GlyphId> {
        self.face.as_ref().and_then(|f| f.glyph_index(c).or_else(|| f.glyph_index('〓')))
    }
    pub fn char_w(&self, c: char) -> f64 {
        if let (Some(f), Some(g)) = (&self.face, self.glyph(c)) {
            return f.glyph_hor_advance(g).unwrap_or(f.units_per_em()) as f64 / f.units_per_em() as f64;
        }
        if (' '..='~').contains(&c) || ('\u{FF61}'..='\u{FF9F}').contains(&c) { 0.5 } else { 1.0 }
    }
    fn encode(&mut self, s: &str) -> String {
        if self.face.is_none() {
            return hex_text(s);
        }
        let mut out = String::from("<");
        for c in s.chars() {
            let c = if c == '\t' { ' ' } else { c };
            if self.face.as_ref().map(|f| f.glyph_index(c).is_none()).unwrap_or(false) {
                self.missing.insert(c);
            }
            let g = self.glyph(c).map(|g| g.0).unwrap_or(0);
            let n = self.remapper.remap(g);
            self.used.entry(n).or_insert(c);
            out.push_str(&format!("{n:04X}"));
        }
        out.push('>');
        out
    }
    /// フォント関連オブジェクトを書き出す（全ページを書いた後に呼ぶ）
    fn write<W: Write + Seek>(&self, pdf: &mut Pdf<W>, font: usize, cid: usize, desc: usize) -> Result<()> {
        let Some(face) = &self.face else {
            pdf.obj(font, &format!("<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiKakuGo-W5 /Encoding /UniJIS-UCS2-HW-H /DescendantFonts [{cid} 0 R] >>"))?;
            pdf.obj(cid, &format!("<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiKakuGo-W5 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 2 >> /FontDescriptor {desc} 0 R /DW 1000 /W [231 325 500] >>"))?;
            return pdf.obj(desc, "<< /Type /FontDescriptor /FontName /HeiseiKakuGo-W5 /Flags 4 /FontBBox [-92 -250 1010 922] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 737 /StemV 114 >>");
        };
        let sub = subsetter::subset(self.data, self.index, &self.remapper).map_err(|e| AppError::internal(format!("font subset: {e:?}")))?;
        let cff = face.tables().cff.is_some();
        let upem = face.units_per_em() as f64;
        let mut widths = String::new();
        for old in self.remapper.remapped_gids() {
            let new = self.remapper.get(old).unwrap_or(0);
            let w = face.glyph_hor_advance(ttf_parser::GlyphId(old)).unwrap_or(0) as f64 * 1000.0 / upem;
            widths.push_str(&format!("{new} [{w:.0}] "));
        }
        let ff = pdf.reserve();
        let tu = pdf.reserve();
        let base = "AAAAAA+BIZUDGothic-Regular";
        let (subtype, file_key) = if cff { ("/CIDFontType0", "/FontFile3") } else { ("/CIDFontType2", "/FontFile2") };
        pdf.obj(font, &format!("<< /Type /Font /Subtype /Type0 /BaseFont /{base} /Encoding /Identity-H /DescendantFonts [{cid} 0 R] /ToUnicode {tu} 0 R >>"))?;
        pdf.obj(cid, &format!("<< /Type /Font /Subtype {subtype} /BaseFont /{base} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor {desc} 0 R /DW 1000 /W [{widths}]{} >>",
            if cff { "" } else { " /CIDToGIDMap /Identity" }))?;
        let bb = face.global_bounding_box();
        let sc = |v: i16| (v as f64 * 1000.0 / upem).round();
        pdf.obj(desc, &format!("<< /Type /FontDescriptor /FontName /{base} /Flags 4 /FontBBox [{} {} {} {}] /ItalicAngle 0 /Ascent {} /Descent {} /CapHeight {} /StemV 80 {file_key} {ff} 0 R >>",
            sc(bb.x_min), sc(bb.y_min), sc(bb.x_max), sc(bb.y_max), sc(face.ascender()), sc(face.descender()), sc(face.capital_height().unwrap_or(face.ascender()))))?;
        pdf.stream(ff, if cff { "/Subtype /OpenType" } else { "" }, &sub)?;
        let mut cmap = String::from(
            "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n",
        );
        let entries: Vec<_> = self.used.iter().collect();
        for chunk in entries.chunks(100) {
            cmap.push_str(&format!("{} beginbfchar\n", chunk.len()));
            for (g, c) in chunk {
                let mut b = [0u16; 2];
                let units: String = c.encode_utf16(&mut b).iter().map(|u| format!("{u:04X}")).collect();
                cmap.push_str(&format!("<{g:04X}> <{units}>\n"));
            }
            cmap.push_str("endbfchar\n");
        }
        cmap.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
        pdf.stream(tu, "", cmap.as_bytes())
    }
}

/// 幅に収まるよう折り返す（改行は保持）
fn wrap(font: &TextFont, text: &str, width_em: f64) -> Vec<String> {
    let mut lines = Vec::new();
    for para in text.replace("\r\n", "\n").split('\n') {
        let mut cur = String::new();
        let mut w = 0.0;
        for c in para.chars() {
            let cw = font.char_w(c);
            // 行頭禁則：句読点・閉じ括弧などは前の行へぶら下げる
            let no_start = "、。，．,.)）」』】〕〉》ー・：；！？!?ぁぃぅぇぉっゃゅょァィゥェォッャュョ".contains(c);
            if w + cw > width_em && !cur.is_empty() && !(no_start && w <= width_em + 1.0) {
                lines.push(std::mem::take(&mut cur));
                w = 0.0;
            }
            cur.push(c);
            w += cw;
        }
        lines.push(cur);
    }
    lines
}

struct Content {
    ops: String,
}
impl Content {
    fn new() -> Self {
        Self { ops: String::new() }
    }
    fn line(&mut self, x1: f64, y1: f64, x2: f64, y2: f64, width_mm: f64, dashed: bool) {
        self.ops.push_str(&format!(
            "q {:.2} w {} {:.2} {:.2} m {:.2} {:.2} l S Q\n",
            width_mm * MM,
            if dashed { "[3 2] 0 d" } else { "[] 0 d" },
            x1 * MM,
            y1 * MM,
            x2 * MM,
            y2 * MM
        ));
    }
    fn rect(&mut self, x: f64, y: f64, w: f64, h: f64, width_mm: f64) {
        self.ops.push_str(&format!("q {:.2} w {:.2} {:.2} {:.2} {:.2} re S Q\n", width_mm * MM, x * MM, y * MM, w * MM, h * MM));
    }
    fn fill(&mut self, x: f64, y: f64, w: f64, h: f64, gray: f64) {
        self.ops.push_str(&format!("q {gray:.2} g {:.2} {:.2} {:.2} {:.2} re f Q\n", x * MM, y * MM, w * MM, h * MM));
    }
    /// y はベースライン（mm, 下から）
    fn text(&mut self, f: &mut TextFont, x: f64, y: f64, size: f64, s: &str) {
        if s.is_empty() {
            return;
        }
        let enc = f.encode(s);
        self.ops.push_str(&format!("BT /F1 {size:.2} Tf {:.2} {:.2} Td {enc} Tj ET\n", x * MM, y * MM));
    }
    fn text_center(&mut self, f: &mut TextFont, cx: f64, y: f64, size: f64, s: &str) {
        let w_mm = s.chars().map(|c| f.char_w(c)).sum::<f64>() * size / MM;
        self.text(f, cx - w_mm / 2.0, y, size, s);
    }
    fn image(&mut self, name: &str, m: [f64; 6]) {
        self.ops.push_str(&format!(
            "q {:.4} {:.4} {:.4} {:.4} {:.4} {:.4} cm /{name} Do Q\n",
            m[0] * MM,
            m[1] * MM,
            m[2] * MM,
            m[3] * MM,
            m[4] * MM,
            m[5] * MM
        ));
    }
}

/// EXIFの向きを反映して箱(x,y,w,h)の中央に収める変換行列（単位mm）
fn image_matrix(orientation: u32, iw: f64, ih: f64, x: f64, y: f64, bw: f64, bh: f64) -> [f64; 6] {
    let rotated = (5..=8).contains(&orientation);
    let (vw, vh) = if rotated { (ih, iw) } else { (iw, ih) };
    let s = (bw / vw).min(bh / vh);
    let (dw, dh) = (vw * s, vh * s);
    let (x, y) = (x + (bw - dw) / 2.0, y + (bh - dh) / 2.0);
    match orientation {
        2 => [-dw, 0.0, 0.0, dh, x + dw, y],
        3 => [-dw, 0.0, 0.0, -dh, x + dw, y + dh],
        4 => [dw, 0.0, 0.0, -dh, x, y + dh],
        5 => [0.0, -dh, -dw, 0.0, x + dw, y + dh],
        6 => [0.0, -dh, dw, 0.0, x, y + dh],
        7 => [0.0, dh, dw, 0.0, x, y],
        8 => [0.0, dh, -dw, 0.0, x + dw, y],
        _ => [dw, 0.0, 0.0, dh, x, y],
    }
}

fn resolve_caption(detail: &LedgerDetail, p: &PhotoRow) -> (String, String, String) {
    let c = detail.captions.get(&p.uuid);
    let pick = |k: &str, auto: &str| c.and_then(|c| c.get(k)).and_then(|v| v.as_str()).map(String::from).unwrap_or_else(|| auto.to_string());
    (pick("koushu", &p.classification.koushu), pick("sokuten", &p.classification.sokuten), pick("body", &p.ledger_text))
}

/// 文言欄の位置（mm）
#[derive(Clone, Copy)]
struct Area {
    x: f64,
    y_top: f64,
    w: f64,
    h: f64,
}

/// 文言欄へ収まるフォントサイズで描画。8ptでも収まらなければ切り詰めて警告を返す。
fn draw_caption(c: &mut Content, f: &mut TextFont, area: &Area, (koushu, sokuten, body): (&str, &str, &str)) -> bool {
    let Area { x, y_top, w, h } = *area;
    let pad = 2.4;
    for (step, &size) in FONT_STEPS.iter().enumerate() {
        let em_mm = size / MM;
        let lh = em_mm * 1.35;
        let width_em = (w - pad * 2.0) / em_mm;
        let k = wrap(f, &format!("工種：{koushu}"), width_em);
        let s = wrap(f, &format!("測点：{sokuten}"), width_em);
        let field_h = |n: usize| (n as f64 * lh + 3.8).max(10.5);
        let (kh, sh) = (field_h(k.len()), field_h(s.len()));
        let body_h = h - kh - sh;
        let b = wrap(f, body, width_em);
        let fits = body_h > 0.0 && (b.len() as f64) * lh + 4.2 <= body_h;
        let last = step == FONT_STEPS.len() - 1;
        if !fits && !last {
            continue;
        }
        let mut yy = y_top;
        for (lines, fh) in [(&k, kh), (&s, sh)] {
            for (i, l) in lines.iter().enumerate() {
                c.text(f, x + pad, yy - 2.2 - em_mm * 0.88 - i as f64 * lh, size, l);
            }
            yy -= fh;
            c.line(x, yy, x + w, yy, 0.35, true);
        }
        for g in [0.25, 0.5, 0.75] {
            if body_h > 0.0 {
                c.line(x, yy - body_h * g, x + w, yy - body_h * g, 0.35, true);
            }
        }
        let max_lines = if body_h > 4.2 { ((body_h - 4.2) / lh).floor() as usize } else { 0 };
        for (i, l) in b.iter().take(max_lines).enumerate() {
            c.text(f, x + pad, yy - 2.2 - em_mm * 0.88 - i as f64 * lh, size, l);
        }
        return fits;
    }
    true
}

fn draw_cover(c: &mut Content, f: &mut TextFont, cover: &serde_json::Value) {
    let get = |k: &str| cover.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    c.rect(15.0, 15.0, PAGE_W - 30.0, PAGE_H - 30.0, 0.8);
    c.rect(17.0, 17.0, PAGE_W - 34.0, PAGE_H - 34.0, 0.3);
    let left = PAGE_W * 0.06;
    let width = PAGE_W * 0.88;
    for (key, top_pct, size) in [("title", 0.209, 12.8 * 1.6), ("koushu", 0.276, 11.9 * 1.4), ("project", 0.643, 10.4 * 1.2), ("contractor", 0.737, 11.9 * 1.2)]
    {
        let text = get(key);
        let em = size / MM;
        let lines = wrap(f, &text, (width - 4.0) / em);
        for (i, l) in lines.iter().take(4).enumerate() {
            c.text_center(f, left + width / 2.0, PAGE_H - PAGE_H * top_pct - em * (1.0 + i as f64 * 1.3), size, l);
        }
    }
}

pub fn export_ledger_pdf(project: &Project, ledger_uuid: &str, dest: &Path, cancel: &Cancel, progress: ProgressFn) -> Result<PdfReport> {
    export_ledger_pdf_with(project, ledger_uuid, dest, cancel, progress, PdfLimits::default())
}

pub fn export_ledger_pdf_with(
    project: &Project,
    ledger_uuid: &str,
    dest: &Path,
    cancel: &Cancel,
    progress: ProgressFn,
    limits: PdfLimits,
) -> Result<PdfReport> {
    if limits.precheck {
        let est = estimate(project, ledger_uuid, limits.max_bytes.min(CLASSIC_XREF_MAX_OFFSET))?;
        if !est.within_limit {
            return Err(AppError::invalid(est.message.unwrap_or_default()).with_detail(format!("pdf estimate {} > {}", est.bytes, est.limit)));
        }
    }
    // 同梱フォントを必ず使う（端末のフォントの有無で結果を変えない）
    let mut font = TextFont::embedded(BUNDLED_FONT, 0, BUNDLED_FONT_NAME.into()).ok_or_else(|| AppError::internal("bundled font unavailable"))?;
    let detail = ledger::detail(&project.conn, ledger_uuid)?;
    let photo_ids: Vec<String> = detail.pages.iter().flat_map(|p| p.slots.iter().filter_map(|s| s.photo_uuid.clone())).collect();
    let rows = photos::list_photos(&project.conn, &PhotoFilter { uuids: Some(photo_ids.clone()), ..Default::default() })?;
    let trashed = photos::list_photos(&project.conn, &PhotoFilter { uuids: Some(photo_ids.clone()), trashed: true, ..Default::default() })?;
    let mut by_id: HashMap<String, (PhotoRow, i64)> = HashMap::new();
    for r in rows.into_iter().chain(trashed) {
        let comps: (i64, bool) =
            project.conn.query_row("select components, adobe_cmyk from photos where uuid = ?1", [&r.uuid], |x| Ok((x.get(0)?, x.get(1)?)))?;
        let enc = comps.0 * 10 + comps.1 as i64;
        by_id.insert(r.uuid.clone(), (r, enc));
    }
    let needed: u64 = by_id.values().map(|(r, _)| r.bytes as u64).sum();
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
        util::ensure_space(parent, needed)?;
    }
    let tmp = util::tmp_sibling(dest);
    let result = (|| -> Result<PdfReport> {
        let mut pdf =
            Pdf { w: BufWriter::with_capacity(1 << 20, File::create(&tmp)?), offsets: Vec::new(), pos: 0, max: limits.max_bytes.min(CLASSIC_XREF_MAX_OFFSET) };
        pdf.raw(b"%PDF-1.6\n%\xE2\xE3\xCF\xD3\n")?;
        let catalog = pdf.reserve();
        let pages_id = pdf.reserve();
        let font_id = pdf.reserve();
        let cid = pdf.reserve();
        let desc = pdf.reserve();
        let info = pdf.reserve();
        let mut page_ids = Vec::new();
        let mut warnings = Vec::new();
        let mut images = 0;
        let total = detail.pages.len() + detail.show_cover as usize;
        let mut done = 0u64;
        let resources = |img: &str| format!("/Resources << /Font << /F1 {font_id} 0 R >> {img} >>");
        let mut write_page = |pdf: &mut Pdf<BufWriter<File>>, content: Content, img_res: String| -> Result<()> {
            let cid_ = pdf.reserve();
            pdf.stream(cid_, "", content.ops.as_bytes())?;
            let pid = pdf.reserve();
            pdf.obj(
                pid,
                &format!(
                    "<< /Type /Page /Parent {pages_id} 0 R /MediaBox [0 0 {:.2} {:.2}] {} /Contents {cid_} 0 R >>",
                    PAGE_W * MM,
                    PAGE_H * MM,
                    resources(&img_res)
                ),
            )?;
            page_ids.push(pid);
            Ok(())
        };
        if detail.show_cover {
            let mut c = Content::new();
            draw_cover(&mut c, &mut font, &detail.cover);
            write_page(&mut pdf, c, String::new())?;
            done += 1;
        }
        let photo_w = (PAGE_W - PAD_L - PAD_R) * PHOTO_RATIO;
        let cap_w = (PAGE_W - PAD_L - PAD_R) - photo_w;
        for (pi, page) in detail.pages.iter().enumerate() {
            cancel.check()?;
            progress(Progress {
                phase: "pdf", current: done, total: total as u64, message: format!("PDFを作成しています {}/{} ページ", done + 1, total)
            });
            let mut c = Content::new();
            let mut xobjs = String::new();
            if page.kind == "photo" {
                for slot in &page.slots {
                    let top = PAGE_H - PAD_T - slot.index as f64 * (SLOT_H + GAP);
                    let y = top - SLOT_H;
                    let x = PAD_L;
                    if let Some(pid) = &slot.photo_uuid {
                        match by_id.get(pid) {
                            Some((row, enc)) => {
                                if row.deleted_at.is_some() {
                                    warnings.push(PdfWarning {
                                        page: pi + 1,
                                        slot: slot.index as usize + 1,
                                        message: "ごみ箱にある写真が配置されています。".into(),
                                    });
                                }
                                let path = project.original_path(pid);
                                match File::open(&path) {
                                    Ok(mut f) => {
                                        let len = f.metadata()?.len();
                                        // 写真を書く前に、書いた後の位置が上限を超えないか確認する
                                        if pdf.pos.saturating_add(len).saturating_add(64 * 1024) > pdf.max {
                                            pdf.pos = pdf.pos.saturating_add(len);
                                            pdf.guard()?;
                                        }
                                        let (cs, decode) = match enc / 10 {
                                            1 => ("/DeviceGray", ""),
                                            4 => ("/DeviceCMYK", if enc % 10 == 1 { " /Decode [1 0 1 0 1 0 1 0]" } else { "" }),
                                            _ => ("/DeviceRGB", ""),
                                        };
                                        let id = pdf.reserve();
                                        pdf.begin(id)?;
                                        pdf.raw(format!("<< /Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace {cs} /BitsPerComponent 8 /Filter /DCTDecode{decode} /Length {len} >>\nstream\n", row.width, row.height).as_bytes())?;
                                        // 原寸JPEGをデコードせずにそのまま書く
                                        let copied = std::io::copy(&mut f, &mut pdf.w)?;
                                        pdf.pos += copied;
                                        pdf.guard()?;
                                        if copied != len {
                                            return Err(AppError::internal("short image copy"));
                                        }
                                        pdf.raw(b"\nendstream\nendobj\n")?;
                                        let name = format!("Im{id}");
                                        xobjs.push_str(&format!(" /{name} {id} 0 R"));
                                        c.fill(x, y, photo_w, SLOT_H, 0.0);
                                        c.image(&name, image_matrix(row.orientation, row.width as f64, row.height as f64, x, y, photo_w, SLOT_H));
                                        images += 1;
                                    }
                                    Err(_) => {
                                        warnings.push(PdfWarning {
                                            page: pi + 1, slot: slot.index as usize + 1, message: "原寸写真が見つかりません。".into()
                                        })
                                    }
                                }
                                let (k, s, b) = resolve_caption(&detail, row);
                                if !draw_caption(&mut c, &mut font, &Area { x: x + photo_w, y_top: top, w: cap_w, h: SLOT_H }, (&k, &s, &b)) {
                                    warnings.push(PdfWarning {
                                        page: pi + 1,
                                        slot: slot.index as usize + 1,
                                        message: "文言が長く、枠に収まりません（途中まで表示）。".into(),
                                    });
                                }
                            }
                            None => {
                                warnings.push(PdfWarning { page: pi + 1, slot: slot.index as usize + 1, message: "写真が見つかりません。".into() })
                            }
                        }
                    } else {
                        draw_caption(&mut c, &mut font, &Area { x: x + photo_w, y_top: top, w: cap_w, h: SLOT_H }, ("", "", ""));
                    }
                    c.rect(x, y, photo_w + cap_w, SLOT_H, 0.45);
                    c.line(x + photo_w, y, x + photo_w, top, 0.45, false);
                }
            }
            c.text_center(&mut font, PAGE_W / 2.0, 5.0, 9.0, &format!("- {} -", pi + 1));
            let img_res = if xobjs.is_empty() { String::new() } else { format!("/XObject <<{xobjs} >>") };
            write_page(&mut pdf, c, img_res)?;
            done += 1;
        }
        if !font.missing.is_empty() {
            let list: String = font.missing.iter().take(20).collect::<Vec<_>>().iter().map(|c| format!("「{c}」")).collect();
            warnings.push(PdfWarning {
                page: 0,
                slot: 0,
                message: format!("印刷できない文字が{}種類あり、「〓」で表示しています：{list}", font.missing.len()),
            });
        }
        font.write(&mut pdf, font_id, cid, desc)?;
        let kids: String = page_ids.iter().map(|i| format!("{i} 0 R ")).collect();
        pdf.obj(pages_id, &format!("<< /Type /Pages /Kids [{kids}] /Count {} >>", page_ids.len()))?;
        pdf.obj(catalog, &format!("<< /Type /Catalog /Pages {pages_id} 0 R >>"))?;
        pdf.obj(info, &format!("<< /Title {} /Producer (aoALB2) >>", hex_text(&detail.title)))?;
        let xref = pdf.pos;
        let mut x = format!("xref\n0 {}\n0000000000 65535 f \n", pdf.offsets.len() + 1);
        for o in &pdf.offsets {
            x.push_str(&format!("{o:010} 00000 n \n"));
        }
        x.push_str(&format!("trailer\n<< /Size {} /Root {catalog} 0 R /Info {info} 0 R >>\nstartxref\n{xref}\n%%EOF\n", pdf.offsets.len() + 1));
        pdf.raw(x.as_bytes())?;
        let f = pdf.w.into_inner().map_err(|e| AppError::from(e.into_error()))?;
        f.sync_all()?;
        progress(Progress { phase: "pdf", current: total as u64, total: total as u64, message: "PDFを作成しました".into() });
        Ok(PdfReport { path: dest.to_string_lossy().into(), pages: page_ids.len(), images, bytes: 0, font: font.name.clone(), warnings })
    })();
    match result {
        Ok(mut r) => {
            fs::rename(&tmp, dest)?;
            r.bytes = fs::metadata(dest)?.len();
            Ok(r)
        }
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}
