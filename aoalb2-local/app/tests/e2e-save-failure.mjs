// 実ブラウザ：保存に失敗している間は画面を移らず・工事を閉じず・終了しないことの確認（架空データ）。
// 準備は e2e-browser.mjs と同じ。 node app/tests/e2e-save-failure.mjs
import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", e => errors.push(String(e)));
const r = {};
await page.goto("http://localhost:8765/index.html?demo=50");
await page.waitForSelector(".photo-card");
await page.getByRole("button", { name: "台帳一覧" }).click();
await page.getByRole("button", { name: "台帳を作る" }).click();
await page.waitForSelector(".slot");
// 保存を5回連続で失敗させてから写真を配置（自動再試行の上限＝5回）
await page.evaluate(() => { window.__aoalb.repo.failSaves = 1000; });
await page.locator(".ed-left .photo-card").first().click();
await page.locator(".slot").first().click();
await page.waitForTimeout(200);
// 画面移動 → 止まって確認が出る
await page.getByRole("button", { name: "写真を整理する" }).click();
await page.waitForSelector(".modal h2");
r.dialog = await page.locator(".modal h2").textContent();
r.buttons = await page.locator(".modal .modal-actions button").allTextContents();
await page.getByRole("button", { name: "編集画面へ戻る" }).click();
await page.waitForTimeout(100);
r.stayedInEditor = await page.locator(".editor-layout").count() === 1;
r.pending = await page.evaluate(() => window.__aoalb.state.ledger.queue.pending.length);
// 工事を閉じる → 止まる
await page.getByRole("button", { name: "工事を閉じる" }).click();
await page.waitForSelector(".modal h2");
await page.getByRole("button", { name: "編集画面へ戻る" }).click();
r.projectStillOpen = await page.evaluate(() => !!window.__aoalb.state.project);
// アプリ終了 → 止まる（終了を3回連打）
await page.evaluate(() => { const h = window.__aoalb.repo.exitHandler; window.__exitP = Promise.all([h(), h(), h()]).then(v => { window.__exitR = v; }); });
await page.waitForSelector(".modal h2");
await page.getByRole("button", { name: "編集画面へ戻る" }).click();
await page.waitForFunction(() => window.__exitR);
r.exitResults = await page.evaluate(() => window.__exitR);
r.destroyed = await page.evaluate(() => !!window.__aoalb.repo.destroyed);
r.modalsOpen = await page.locator(".modal").count();
// 画面移動時の保存がもう1回だけ失敗し、その後に直る → 再試行で保存され、画面を移れる
await page.evaluate(() => { window.__aoalb.repo.failSaves = 1; });
await page.getByRole("button", { name: "写真を整理する" }).click();
await page.waitForSelector(".modal h2");
await page.getByRole("button", { name: "再試行" }).click();
await page.waitForSelector(".photos-layout");
r.movedAfterRetry = true;
r.savedPlacement = await page.evaluate(async () => { const { repo } = window.__aoalb; const l = (await repo.listLedgers())[0]; return (await repo.ledgerDetail(l.uuid)).pages[0].slots.filter(s => s.photoUuid).length; });
r.errors = errors;
console.log(JSON.stringify(r, null, 1));
await browser.close();
