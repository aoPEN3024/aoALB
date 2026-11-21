// 計測用の自動操作。AOALB2_E2E_PROJECT（工事フォルダ）と AOALB2_E2E_OUT（結果の保存先）を指定してアプリを起動した時だけ読み込まれる。
// 工事を開く → 写真一覧を端までスクロール → 全選択 → 最大の台帳を開いて端までスクロール → 結果を書いて終了。
// メモリは外側（scripts/measure-app-memory.*）でWebViewを含む全プロセスを計測する。

const sleep = ms => new Promise(r => setTimeout(r, ms));
const frame = () => new Promise(r => requestAnimationFrame(() => r()));

async function waitFor(fn, timeout = 60000) {
  const t = performance.now();
  while (performance.now() - t < timeout) { const v = fn(); if (v) return v; await sleep(50); }
  throw new Error("timeout");
}

async function scrollThrough(el, stepRatio, pause) {
  let steps = 0, maxCells = 0, maxImgs = 0;
  el.scrollTop = 0;
  while (el.scrollTop + el.clientHeight < el.scrollHeight - 2) {
    el.scrollTop += el.clientHeight * stepRatio;
    await frame(); await sleep(pause);
    maxCells = Math.max(maxCells, el.querySelectorAll(".vgrid-cell, .page-frame > .page").length);
    maxImgs = Math.max(maxImgs, el.querySelectorAll("canvas[data-loaded='1'], img[src]").length);
    steps++;
  }
  return { steps, maxCells, maxImgs, scrollHeight: el.scrollHeight };
}

export async function run(projectRoot) {
  const { repo, go, opened, state } = window.__aoalb;
  const marks = [];
  const mark = (name, extra = {}) => marks.push({ name, at: new Date().toISOString(), ...extra });
  const result = { marks };
  try {
    mark("start");
    const t0 = performance.now();
    await opened(await repo.openProject(projectRoot));
    await waitFor(() => document.querySelector(".photo-card"));
    result.openToFirstListMs = Math.round(performance.now() - t0);
    result.photoCount = (await repo.listPhotos({})).length;
    mark("photos-shown");
    await sleep(2000);
    const cs = [...document.querySelectorAll(".grid-host canvas.thumb-canvas")];
    result.thumbnailsLoaded = { shown: cs.length, drawn: cs.filter(c => c.dataset.loaded === "1").length, errors: [...new Set(cs.map(c => c.dataset.error).filter(Boolean))] };
    result.photoScroll = await scrollThrough(document.querySelector(".grid-host"), 0.8, 40);
    mark("photos-scrolled");
    document.querySelector(".toolbar button")?.click(); // 表示中を全選択
    await sleep(1000);
    result.selected = state.selection.size;
    mark("selected-all");
    const ledgers = (await repo.listLedgers(false)).sort((a, b) => b.pageCount - a.pageCount);
    if (ledgers.length) {
      const t1 = performance.now();
      await go("editor", { ledgerUuid: ledgers[0].uuid });
      await waitFor(() => document.querySelector(".slot.photo"));
      result.ledger = { pages: ledgers[0].pageCount, photos: ledgers[0].photoCount, openMs: Math.round(performance.now() - t1) };
      mark("ledger-open");
      await sleep(2000);
      result.ledgerScroll = await scrollThrough(document.querySelector(".pages"), 2.5, 30);
      mark("ledger-scrolled");
      await sleep(3000);
      mark("idle");
    }
    result.jsHeapMB = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
    result.ok = true;
  } catch (e) {
    result.ok = false;
    result.error = String(e?.message || e);
  }
  mark("end");
  await repo.e2eReport(result);
}
