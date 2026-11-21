// サムネイルの描画。<img> を使わず、読み込み→表示サイズに縮小してcanvasへ描画→元データをすぐ解放する。
// ブラウザ（WebView2・WebKit）の画像キャッシュに溜まらないため、何千枚スクロールしてもメモリが増えない。
// 同時に読む数を制限し、画面外へ出たカードの読み込みは中止する。

const MAX_PARALLEL = 6;
let running = 0;
const queue = [];

function next() {
  while (running < MAX_PARALLEL && queue.length) {
    const job = queue.shift();
    if (job.signal.aborted) continue;
    running++;
    job.run().finally(() => { running--; next(); });
  }
}

/**
 * canvas に画像を「枠に収めて」描く。戻り値の関数で中止できる。
 * @param {HTMLCanvasElement} canvas
 * @param {string} url
 */
export function drawThumb(canvas, url) {
  const ctrl = new AbortController();
  const signal = ctrl.signal;
  const run = async () => {
    try {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round((rect.width || canvas.width) * dpr));
      const h = Math.max(1, Math.round((rect.height || canvas.height) * dpr));
      const res = await fetch(url, { cache: "no-store", signal });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      if (signal.aborted) return;
      const probe = await createImageBitmap(blob);
      const s = Math.min(w / probe.width, h / probe.height);
      const dw = Math.max(1, Math.round(probe.width * s)), dh = Math.max(1, Math.round(probe.height * s));
      probe.close();
      if (signal.aborted) return;
      const bmp = await createImageBitmap(blob, { resizeWidth: dw, resizeHeight: dh, resizeQuality: "medium" });
      if (signal.aborted) { bmp.close(); return; }
      canvas.width = w; canvas.height = h;
      const g = canvas.getContext("2d");
      g.clearRect(0, 0, w, h);
      g.drawImage(bmp, Math.round((w - dw) / 2), Math.round((h - dh) / 2));
      bmp.close();
      canvas.dataset.loaded = "1";
    } catch (e) {
      if (!signal.aborted) { canvas.dataset.loaded = "error"; canvas.dataset.error = String(e?.message || e).slice(0, 120); }
    }
  };
  queue.push({ run, signal });
  next();
  return () => ctrl.abort();
}

/** 描画済みのcanvasの画素を解放する */
export function releaseCanvas(canvas) { canvas.width = 1; canvas.height = 1; delete canvas.dataset.loaded; }
