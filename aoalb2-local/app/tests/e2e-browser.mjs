// 実ブラウザでの画面操作確認（架空データ）。
// 準備：npm i playwright-core、app/ui を http://localhost:8765/ で配信（python3 -m http.server 8765）。
// 実行：node app/tests/e2e-browser.mjs <写真枚数> <画像の出力先>

import { chromium } from "playwright-core";
const N = Number(process.argv[2] || 300);
const out = process.argv[3] || "/tmp/e2e";
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args: ["--no-sandbox", "--lang=ja-JP"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "ja-JP" });
const errors = [];
page.on("pageerror", e => errors.push(String(e)));
page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
page.on("dialog", d => d.accept(d.type() === "prompt" ? "名前を変えた台帳" : undefined));
const results = {};
const t0 = Date.now();
await page.goto(`http://localhost:8765/index.html?demo=${N}`);
await page.waitForSelector(".photo-card");
results.firstListMs = Date.now() - t0;
results.cardsRendered = await page.locator(".vgrid-cell").count();
results.countText = await page.locator(".count").first().textContent();
// スクロール性能
const scroll = await page.evaluate(async () => {
  const host = document.querySelector(".grid-host"); const start = performance.now(); let frames = 0; let maxCells = 0;
  for (let i = 0; i < 60; i++) { host.scrollTop += host.clientHeight * 0.7; await new Promise(r => requestAnimationFrame(r)); frames++; maxCells = Math.max(maxCells, document.querySelectorAll(".vgrid-cell").length); }
  return { ms: Math.round(performance.now() - start), frames, maxCells, scrollHeight: host.scrollHeight };
});
results.scroll = scroll;
await page.evaluate(() => { document.querySelector(".grid-host").scrollTop = 0; });
await page.screenshot({ path: `${out}-photos.png` });
// 未分類だけ → 表示中を全選択 → 一括分類
await page.getByLabel("未分類だけ").check();
await page.waitForTimeout(200);
results.unclassified = await page.locator(".count").first().textContent();
const tSel = Date.now();
await page.getByRole("button", { name: "表示中を全選択" }).click();
results.selectAllMs = Date.now() - tSel;
results.selInfo = await page.locator(".sel-info").textContent();
await page.locator(".class-panel input").nth(0).fill("塗装工");
await page.locator(".class-panel input").nth(1).fill("橋梁塗装");
const tCls = Date.now();
await page.locator(".class-panel button.primary").click();
await page.waitForSelector(".toast");
results.classifyMs = Date.now() - tCls;
results.afterClassifyUnclassified = await page.locator(".count").first().textContent();
await page.getByRole("button", { name: "元に戻す" }).click();
await page.waitForTimeout(300);
results.afterUndo = await page.locator(".count").first().textContent();
await page.getByRole("button", { name: "やり直す" }).click();
await page.waitForTimeout(300);
results.afterRedo = await page.locator(".count").first().textContent();
await page.getByLabel("未分類だけ").uncheck();
// 台帳を作る
await page.getByRole("button", { name: "台帳一覧" }).click();
await page.getByPlaceholder("例：第1回 出来形写真").fill("第1回 塗装写真");
await page.getByRole("button", { name: "台帳を作る" }).click();
await page.waitForSelector(".slot");
// 左で3枚選んで空き枠をクリック（連続配置）
const cards = page.locator(".ed-left .photo-card");
await cards.nth(0).click(); await cards.nth(1).click({ modifiers: ["Control"] }); await cards.nth(2).click({ modifiers: ["Control"] }); await cards.nth(3).click({ modifiers: ["Control"] });
const tPlace = Date.now();
await page.locator(".slot").first().click();
await page.waitForFunction(() => document.querySelectorAll(".slot.photo").length >= 4);
results.placeManyMs = Date.now() - tPlace;
results.pagesAfterPlace = await page.locator(".page-frame:not(.cover)").count();
// ドラッグで1枚配置
async function drag(from, to) {
  await to.scrollIntoViewIfNeeded(); await from.scrollIntoViewIfNeeded();
  const a = await from.boundingBox(); const b = await to.boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 20, a.y + a.height / 2 + 10, { steps: 3 });
  await page.mouse.move(b.x + b.width / 3, b.y + b.height / 2, { steps: 8 }); await page.mouse.up();
}
const leftCard = page.locator(".ed-left .photo-card").first();
const emptySlot = page.locator(".slot.empty").first();
await page.keyboard.press("Escape");

const tDrop = Date.now();
await drag(leftCard, emptySlot);
await page.waitForFunction(() => document.querySelectorAll(".slot.photo").length >= 5, null, { timeout: 5000 }).catch(async () => { await page.screenshot({ path: "/tmp/dragfail.png" }); throw new Error("drag failed"); });
results.dragPlaceMs = Date.now() - tDrop;
// 配置済み同士の入替え（ドラッグ）
const before = await page.$$eval(".slot.photo img", ims => ims.map(i => i.src.slice(-30)));
const tSwap = Date.now();
await drag(page.locator(".slot.photo").nth(0), page.locator(".slot.photo").nth(2));
await page.waitForTimeout(50);
results.swapReflectMs = Date.now() - tSwap;
const after = await page.$$eval(".slot.photo img", ims => ims.map(i => i.src.slice(-30)));
results.swapped = before[0] === after[2] && before[2] === after[0];
results.statusDuringSave = await page.locator("#save-status").textContent();
await page.waitForTimeout(1200);
results.statusAfterSave = await page.locator("#save-status").textContent();
// 枠を左の一覧へドラッグ＝未配置へ戻す
const placedN = await page.locator(".slot.photo").count();
await drag(page.locator(".slot.photo").nth(3), page.locator(".ed-left .filters"));
await page.waitForTimeout(100);
results.dragToLeftUnplace = placedN - (await page.locator(".slot.photo").count());
await page.keyboard.press("Control+z");
await page.waitForTimeout(300);
// 枠を選んで文言編集（長文警告）
await page.locator(".slot.photo").nth(1).click();
await page.locator(".ed-right textarea").fill("長い台帳文".repeat(40));
await page.locator(".ed-right textarea").blur();
await page.waitForTimeout(900);
results.longWarn = await page.locator(".ed-right textarea + .warn").textContent();
results.slotWarn = await page.locator(".len-warn").count();
// キーボード：Deleteで未配置へ、Ctrl+Zで戻す
await page.locator(".slot.photo").nth(0).click();
const placedBefore = await page.locator(".slot.photo").count();
await page.keyboard.press("Delete");
await page.waitForTimeout(100);
const placedAfterDelete = await page.locator(".slot.photo").count();
await page.keyboard.press("Control+z");
await page.waitForTimeout(300);
results.keyboard = { placedBefore, placedAfterDelete, afterUndo: await page.locator(".slot.photo").count() };
// 空白挿入
await page.locator(".slot.photo").nth(1).click();
await page.getByRole("button", { name: "この位置に空白を入れる" }).click();
await page.waitForTimeout(200);
results.blankSlots = await page.locator(".slot.blank").count();
await page.screenshot({ path: `${out}-editor.png` });
// 見開き
await page.getByRole("button", { name: "見開き" }).click();
await page.waitForTimeout(200);
await page.screenshot({ path: `${out}-spread.png` });
// 台帳一覧：名前変更・複製・削除・復元
await page.getByRole("button", { name: "台帳一覧" }).click();
await page.waitForSelector(".table");
await page.getByRole("button", { name: "名前変更" }).first().click();
await page.waitForTimeout(200);
await page.getByRole("button", { name: "複製" }).first().click();
await page.waitForTimeout(200);
results.ledgerRows = await page.locator(".table tbody tr").count();
await page.screenshot({ path: `${out}-ledgers.png` });
await page.getByRole("button", { name: "削除" }).first().click();
await page.waitForTimeout(200);
results.rowsAfterTrash = await page.locator(".table tbody tr").count();
await page.getByRole("button", { name: "ごみ箱" }).click();
await page.getByRole("button", { name: "元に戻す" }).first().click();
await page.waitForTimeout(200);
await page.getByRole("button", { name: "台帳", exact: true }).click();
await page.waitForTimeout(200);
results.rowsAfterRestore = await page.locator(".table tbody tr").count();
results.titles = await page.$$eval(".table tbody tr td:first-child", t => t.map(x => x.textContent));
// 写真が台帳削除の影響を受けていない
results.photoCountEnd = await page.evaluate(async () => (await window.__aoalb.repo.listPhotos({})).length);
results.heapMB = await page.evaluate(() => Math.round((performance.memory?.usedJSHeapSize || 0) / 1048576));
results.errors = errors;
console.log(JSON.stringify(results, null, 1));
await browser.close();
