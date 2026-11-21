// 写真一覧の仮想スクロール。表示中の行（前後1画面分）だけDOMを作り、画像はサムネイルのみ読む。
// カードの大きさは写真枚数で変えない（縦・横写真は同じ枠の中に収める）。

export class VirtualGrid {
  /**
   * @param {HTMLElement} host スクロールする要素
   * @param {{cardWidth?: number, cardHeight?: number, gap?: number, render: (el: HTMLElement, item: object, index: number) => void}} opts
   */
  constructor(host, opts) {
    this.host = host;
    this.cardW = opts.cardWidth ?? 168;
    this.cardH = opts.cardHeight ?? 172;
    this.gap = opts.gap ?? 10;
    this.render = opts.render;
    this.items = [];
    this.pool = new Map(); // index → element
    this.spacer = document.createElement("div");
    this.spacer.className = "vgrid-spacer";
    this.layer = document.createElement("div");
    this.layer.className = "vgrid-layer";
    host.replaceChildren(this.spacer, this.layer);
    host.classList.add("vgrid");
    this.onScroll = () => this.schedule();
    host.addEventListener("scroll", this.onScroll, { passive: true });
    this.ro = new ResizeObserver(() => this.refresh());
    this.ro.observe(host);
    this.frame = 0;
  }
  get columns() { return Math.max(1, Math.floor((this.host.clientWidth - this.gap) / (this.cardW + this.gap))); }
  setItems(items, { keepScroll = true } = {}) {
    const top = this.host.scrollTop;
    this.items = items;
    for (const el of this.pool.values()) { this.release(el); el.remove(); }
    this.pool.clear();
    this.refresh();
    this.host.scrollTop = keepScroll ? top : 0;
    this.update();
  }
  refresh() {
    const rows = Math.ceil(this.items.length / this.columns);
    this.spacer.style.height = `${rows * (this.cardH + this.gap) + this.gap}px`;
    for (const el of this.pool.values()) { this.release(el); el.remove(); }
    this.pool.clear();
    this.update();
  }
  schedule() { if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.update(); }); }
  update() {
    const cols = this.columns;
    const rowH = this.cardH + this.gap;
    const view = this.host.clientHeight || 600;
    const first = Math.max(0, Math.floor(this.host.scrollTop / rowH) - Math.ceil(view / rowH));
    const last = Math.min(Math.ceil(this.items.length / cols), Math.ceil((this.host.scrollTop + view) / rowH) + Math.ceil(view / rowH));
    const want = new Set();
    for (let r = first; r < last; r++) for (let c = 0; c < cols; c++) { const i = r * cols + c; if (i < this.items.length) want.add(i); }
    for (const [i, el] of this.pool) if (!want.has(i)) { this.release(el); el.remove(); this.pool.delete(i); }
    for (const i of want) {
      if (this.pool.has(i)) continue;
      const el = document.createElement("div");
      el.className = "vgrid-cell";
      el.style.transform = `translate(${this.gap + (i % cols) * (this.cardW + this.gap)}px, ${this.gap + Math.floor(i / cols) * rowH}px)`;
      el.style.width = `${this.cardW}px`;
      el.style.height = `${this.cardH}px`;
      el.dataset.index = String(i);
      this.render(el, this.items[i], i);
      this.layer.append(el);
      this.pool.set(i, el);
    }
  }
  /** カードの画像の読み込みを止めて画素を解放する */
  release(el) { el.querySelectorAll("canvas").forEach(c => { c._cancel?.(); c.width = 1; c.height = 1; }); el.querySelectorAll("img").forEach(img => img.removeAttribute("src")); }
  /** 表示中のカードだけ描き直す（選択・サムネイル完成など）。画像は描き直さず使い回す */
  redrawVisible(filter = null) {
    for (const [i, el] of this.pool) if (!filter || filter(this.items[i])) {
      const keep = filter ? null : el.querySelector("canvas.thumb-canvas[data-loaded='1']");
      if (!keep) this.release(el);
      el.replaceChildren(); this.render(el, this.items[i], i);
      const fresh = keep && el.querySelector("canvas.thumb-canvas");
      if (fresh) { fresh._cancel?.(); fresh.replaceWith(keep); }
    }
  }
  scrollToIndex(i) { const rowH = this.cardH + this.gap; this.host.scrollTop = Math.floor(i / this.columns) * rowH; }
  get renderedCount() { return this.pool.size; }
  destroy() { this.host.removeEventListener("scroll", this.onScroll); this.ro.disconnect(); for (const el of this.pool.values()) { this.release(el); el.remove(); } this.pool.clear(); }
}
