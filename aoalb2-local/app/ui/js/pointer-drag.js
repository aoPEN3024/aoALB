// マウス・タッチ・ペン共通のドラッグ＆ドロップ。
// ブラウザ標準のドラッグはWindows版のファイルドロップ受付と両立しないため使わない。
// ドロップ先は data-drop 属性を持つ要素。5px以上動かした時だけドラッグとみなす（クリックと区別）。

let current = null;

export function makeDraggable(el, payload, { label = null } = {}) {
  if (el.dataset.draggableBound) return; // 描き直しで二重に登録しない
  el.dataset.draggableBound = "1";
  // ブラウザ標準の画像ドラッグ（pointercancelの原因）を止める
  el.addEventListener("dragstart", e => e.preventDefault());
  el.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY };
    let ghost = null;
    let over = null;
    const move = ev => {
      if (!ghost) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
        current = payload();
        if (!current) return cleanup();
        ghost = document.createElement("div");
        ghost.className = "drag-ghost";
        ghost.textContent = label ? label(current) : "移動";
        document.body.append(ghost);
        document.body.classList.add("dragging");
      }
      ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 12}px)`;
      const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest("[data-drop]");
      if (target !== over) { over?.classList.remove("drop"); over = target; over?.classList.add("drop"); }
      // 端に近づいたら自動スクロール
      const scroller = target?.closest(".pages, .grid-host");
      if (scroller) { const r = scroller.getBoundingClientRect(); if (ev.clientY < r.top + 40) scroller.scrollTop -= 18; else if (ev.clientY > r.bottom - 40) scroller.scrollTop += 18; }
    };
    const up = ev => {
      const data = current;
      const target = ghost ? document.elementFromPoint(ev.clientX, ev.clientY)?.closest("[data-drop]") : null;
      cleanup();
      if (data && target) {
        ev.preventDefault();
        // 直後のclickを打ち消す
        const stop = c => { c.stopPropagation(); c.preventDefault(); };
        window.addEventListener("click", stop, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 0);
        target.dispatchEvent(new CustomEvent("app-drop", { detail: data, bubbles: false }));
      }
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cleanup);
      over?.classList.remove("drop");
      ghost?.remove();
      document.body.classList.remove("dragging");
      current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cleanup);
  });
}

export function onDrop(el, handler) {
  el.dataset.drop = "1";
  el.addEventListener("app-drop", e => handler(e.detail));
}
