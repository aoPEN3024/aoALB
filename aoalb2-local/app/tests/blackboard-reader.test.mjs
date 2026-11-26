import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { candidateFromAopic, candidateFromOcr } from "../ui/js/blackboard-reader.js";

test("aoPICは保存済み分類と台帳文を高い確からしさで候補にする", () => {
  const result = candidateFromAopic({ photo: { classification: { koushu: "塗装工", sokuten: "P12", tekiyo: "施工前" }, ledgerText: "上塗り 施工状況" }, aopic: { boardSnapshot: {} } });
  assert.deepEqual([result.koushu, result.sokuten, result.body, result.confidence], ["塗装工", "P12", "上塗り 施工状況", "高"]);
});

test("OCRはラベル付きの行だけを各欄の候補にする", () => {
  const result = candidateFromOcr({ lines: ["工事名 架空橋梁工事", "工種：塗装工", "測点 P12", "施工内容 上塗り 施工状況", "施工者 架空建設"] });
  assert.deepEqual([result.koushu, result.sokuten, result.body, result.confidence], ["塗装工", "P12", "上塗り 施工状況", "中"]);
  assert.equal(result.rawLines.length, 5);
});

test("項目を安全に判別できない全文は台帳へ自動提案しない", () => {
  const result = candidateFromOcr({ text: "架空橋梁工事\n架空建設" });
  assert.deepEqual([result.koushu, result.sokuten, result.body, result.confidence], ["", "", "", "低"]);
});

test("黒板項目名の空白と表記揺れを候補として認識する", () => {
  const result = candidateFromOcr({ lines: ["工 種", "塗装工", "工 事 箇 所：P12", "工 程 上塗り施工状況"] });
  assert.deepEqual([result.koushu, result.sokuten, result.body], ["塗装工", "P12", "上塗り施工状況"]);
});

test("aoPIC写真でも保存済み情報と実画像OCRの両方を選べる", async () => {
  const source = await readFile(new URL("../ui/js/app.js", import.meta.url), "utf8");
  assert.match(source, /aoPICの黒板情報を候補にする/);
  assert.match(source, /写真の黒板を読み取る（試作）/);
  assert.match(source, /useAopicData: false/);
  assert.match(source, /読み取った文字を手動で割り当てる/);
  assert.match(source, /全文を台帳文へ/);
});
