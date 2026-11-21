// Chromium（WebView2と同じ系統）で、実サムネイルを使った一覧・台帳スクロール時のブラウザ全プロセスのメモリを計測する。
// 準備：app/ui を http://localhost:8765/ で配信し、計測用工事の thumbnails を app/ui/_thumbs として見えるようにする（コミットしない）。
// 実行：node app/tests/chromium-memory.mjs <thumbnailsフォルダ>

// Chromium（WebView2と同系統）で、実サムネイル3,000枚を使った同じ操作のメモリを計測する
import { chromium } from "playwright-core";
import fs from "node:fs";
import { execSync } from "node:child_process";
const thumbs = fs.readdirSync(process.argv[2]).filter(f => f.endsWith(".jpg"));
const udd = fs.mkdtempSync("/tmp/chrome-mem-");
const browser = await chromium.launchPersistentContext(udd, { executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", args: ["--no-sandbox"], viewport: { width: 1440, height: 900 } });
const page = browser.pages()[0] || await browser.newPage();
const samples = [];
const sample = label => {
  const all = new Set(execSync(`pgrep -f ${udd} || true`).toString().trim().split(/\s+/).filter(Boolean));
  let pss = 0;
  for (const p of all) { try { const t = fs.readFileSync(`/proc/${p}/smaps_rollup`, "utf8"); pss += Number(/Pss:\s+(\d+)/.exec(t)[1]); } catch {} }
  samples.push({ label, processes: all.size, pssMB: Math.round(pss / 1024) });
};
const timer = setInterval(() => sample("t"), 500);
await page.goto("http://localhost:8765/index.html?demo=3000");
await page.waitForSelector(".photo-card");
await page.evaluate(list => { const r = window.__aoalb.repo; const m = new Map(); r.thumbUrl = p => { if (!m.has(p.uuid)) m.set(p.uuid, `/_thumbs/${list[m.size % list.length]}`); return m.get(p.uuid); }; window.__aoalb.go("photos"); }, thumbs);
await page.waitForTimeout(1500);
sample("一覧表示");
const scroll = async (sel, ratio) => page.evaluate(async ([sel, ratio]) => { const el = document.querySelector(sel); el.scrollTop = 0; while (el.scrollTop + el.clientHeight < el.scrollHeight - 2) { el.scrollTop += el.clientHeight * ratio; await new Promise(r => requestAnimationFrame(r)); await new Promise(r => setTimeout(r, 40)); } }, [sel, ratio]);
await scroll(".grid-host", 0.8);
sample("一覧スクロール後");
// 1,000ページの台帳（全写真を配置）
await page.evaluate(async () => { const { repo, go } = window.__aoalb; const l = await repo.createLedger("計測台帳"); const ps = await repo.listPhotos({}); await repo.applyLedgerOps(l.uuid, [{ op: "PlaceMany", from: l.pages[0].slots[0].uuid, photos: ps.map(p => p.uuid) }]); await go("editor", { ledgerUuid: l.uuid }); });
await page.waitForSelector(".slot.photo");
await page.waitForTimeout(1500);
sample("台帳表示");
await scroll(".pages", 2.5);
sample("台帳スクロール後");
const dom = await page.evaluate(() => ({ pages: document.querySelectorAll(".page-frame > .page").length, imgs: document.querySelectorAll(".pages canvas[data-loaded='1']").length }));
clearInterval(timer);
const peak = Math.max(...samples.map(s => s.pssMB));
console.log(JSON.stringify({ marks: samples.filter(s => s.label !== "t"), peakPssMB: peak, startPssMB: samples[0].pssMB, ledgerDom: dom }, null, 1));
await browser.close();
