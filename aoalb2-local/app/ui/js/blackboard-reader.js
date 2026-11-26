// 黒板の読取り結果を、確定値ではなく台帳文言の「候補」へ変換する純粋ロジック。
// aoPICの保存済み情報を最優先し、OCRはラベルを明確に読めた欄だけ提案する。

const clean = value => String(value || "").replace(/[\u0000-\u001f]+/g, " ").replace(/[ \t　]+/g, " ").trim();
const normalizedLines = input => (input?.lines?.length ? input.lines : String(input?.text || "").split(/\r?\n/)).map(clean).filter(Boolean);

function labeled(lines, labels) {
  const label = labels.map(x => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const exact = new RegExp(`^(?:${label})\\s*[：:]?\\s*(.*)$`);
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(exact);
    if (!match) continue;
    const value = clean(match[1]);
    if (value) return value;
    if (lines[i + 1] && !exact.test(lines[i + 1])) return clean(lines[i + 1]);
  }
  return "";
}

export function candidateFromOcr(input) {
  const lines = normalizedLines(input);
  const koushu = labeled(lines, ["工種", "工事種別"]);
  const sokuten = labeled(lines, ["測点", "場所", "施工箇所"]);
  const body = labeled(lines, ["施工内容", "作業内容", "工事内容", "摘要", "備考"]);
  const found = [koushu, sokuten, body].filter(Boolean).length;
  return {
    source: "ocr",
    sourceLabel: "Windows端末内OCR",
    confidence: found >= 2 ? "中" : "低",
    koushu,
    sokuten,
    body,
    rawLines: lines,
    note: found ? "黒板の項目名と一緒に読めた文字を候補にしました。" : "文字は読み取れましたが、黒板の項目を安全に判別できませんでした。",
  };
}

export function candidateFromAopic(detail) {
  const photo = detail.photo;
  const board = detail.aopic?.boardSnapshot || {};
  const classification = photo.classification || {};
  const koushu = clean(classification.koushu || board.koushu);
  const sokuten = clean(classification.sokuten || board.sokuten);
  const body = clean(photo.ledgerText || classification.tekiyo || board.tekiyo);
  return {
    source: "aopic",
    sourceLabel: "aoPICの保存済み黒板情報",
    confidence: "高",
    koushu,
    sokuten,
    body,
    rawLines: [],
    note: "画像認識ではなく、aoPICが撮影時に保存した情報を使用します。",
  };
}
