// 台帳の画面側モデル（純粋関数）。
// - applyLocal: 操作を画面へ即時反映する（保存は後でまとめて行う）。中核（Rust）の ledger::apply_ops と同じ規則。
// - computeInverse: 変更前後の差分から「元に戻す」操作を作る。やり直しも同じ仕組みで作る。
// 保存先（ローカル／将来のクラウド）には依存しない。

export const SLOTS_PER_PAGE = 3;
export const CAPTION_LIMITS = { koushu: 200, sokuten: 200, body: 1000 };

export const clone = d => (typeof structuredClone === "function" ? structuredClone(d) : JSON.parse(JSON.stringify(d)));

/** 写真ページの枠を順番に並べる */
export function orderedSlots(detail) {
  const out = [];
  for (const page of detail.pages) if (page.kind === "photo") for (const slot of page.slots) out.push(slot);
  return out;
}

export function findSlot(detail, uuid) {
  for (const page of detail.pages) for (const slot of page.slots) if (slot.uuid === uuid) return { page, slot };
  return null;
}

export function slotOfPhoto(detail, photo) {
  for (const page of detail.pages) for (const slot of page.slots) if (slot.photoUuid === photo) return slot;
  return null;
}

/** 画面で即時反映できる操作か（ページ構成を変える操作は保存結果を待つ） */
export function isStructural(op) {
  return ["InsertBlank", "RemoveSlot", "PlaceMany", "AddPage", "DeletePage", "RestorePage", "MovePage"].includes(op.op);
}

function set(slot, kind, photoUuid = null) { slot.kind = kind; slot.photoUuid = kind === "photo" ? photoUuid : null; }

function newPage(idGen, blank) {
  const uuid = idGen();
  return { uuid, kind: blank ? "blank" : "photo", position: 0, slots: blank ? [] : [0, 1, 2].map(index => ({ uuid: idGen(), index, kind: "empty", photoUuid: null })) };
}

function renumber(detail) { detail.pages.forEach((p, i) => { p.position = i + 1; }); }

export class LedgerOpError extends Error {}

/**
 * 操作を適用した新しい台帳を返す（元の値は変更しない）。
 * @param {object} detail 台帳
 * @param {object[]} ops 操作
 * @param {{idGen?: () => string, trashedPhotos?: Set<string>, deletedPages?: Map<string, object>}} opts
 */
export function applyLocal(detail, ops, opts = {}) {
  const d = clone(detail);
  const idGen = opts.idGen || (() => crypto.randomUUID());
  const deleted = opts.deletedPages || new Map();
  const skipped = [];
  const need = uuid => { const f = findSlot(d, uuid); if (!f) throw new LedgerOpError("枠が見つかりません。"); return f.slot; };
  for (const op of ops) {
    switch (op.op) {
      case "Place": {
        if (opts.trashedPhotos?.has(op.photo)) throw new LedgerOpError("ごみ箱にある写真は配置できません。");
        const target = need(op.slot);
        const cur = slotOfPhoto(d, op.photo);
        if (cur && cur.uuid === target.uuid) break;
        if (cur) { const k = target.kind, p = target.photoUuid; set(target, "photo", op.photo); set(cur, k, p); }
        else set(target, "photo", op.photo);
        break;
      }
      case "Swap": case "Move": {
        const a = need(op.a ?? op.from), b = need(op.b ?? op.to);
        if (a === b) break;
        const ak = a.kind, ap = a.photoUuid;
        set(a, b.kind, b.photoUuid); set(b, ak, ap);
        break;
      }
      case "Clear": set(need(op.slot), "empty"); break;
      case "SetBlank": {
        const s = need(op.slot);
        if (s.kind === "photo") throw new LedgerOpError("写真がある枠は空白にできません。先に写真を外してください。");
        set(s, op.blank ? "blank" : "empty");
        break;
      }
      case "InsertBlank": {
        let list = orderedSlots(d);
        const i = list.findIndex(s => s.uuid === op.slot);
        if (i < 0) throw new LedgerOpError("枠が見つかりません。");
        let stop = list.findIndex((s, k) => k >= i && s.kind === "empty");
        if (stop < 0) { d.pages.push(newPage(idGen, false)); renumber(d); list = orderedSlots(d); stop = list.length - SLOTS_PER_PAGE; }
        for (let k = stop; k > i; k--) set(list[k], list[k - 1].kind, list[k - 1].photoUuid);
        set(list[i], "blank");
        break;
      }
      case "RemoveSlot": {
        const list = orderedSlots(d);
        const i = list.findIndex(s => s.uuid === op.slot);
        if (i < 0) throw new LedgerOpError("枠が見つかりません。");
        let stop = list.findIndex((s, k) => k > i && s.kind === "empty");
        if (stop < 0) stop = list.length;
        for (let k = i; k < stop; k++) { if (k + 1 < stop) set(list[k], list[k + 1].kind, list[k + 1].photoUuid); else set(list[k], "empty"); }
        break;
      }
      case "PlaceMany": {
        let list = orderedSlots(d);
        const i = list.findIndex(s => s.uuid === op.from);
        if (i < 0) throw new LedgerOpError("枠が見つかりません。");
        const free = list.slice(i).filter(s => s.kind === "empty");
        let n = 0;
        for (const photo of op.photos) {
          if (opts.trashedPhotos?.has(photo)) throw new LedgerOpError("ごみ箱にある写真は配置できません。");
          if (slotOfPhoto(d, photo)) { skipped.push(photo); continue; }
          if (n >= free.length) { const p = newPage(idGen, false); d.pages.push(p); free.push(...p.slots); }
          set(free[n++], "photo", photo);
        }
        renumber(d);
        break;
      }
      case "AddPage": {
        const p = newPage(() => idGen(), op.blank);
        if (op.page) p.uuid = op.page;
        const at = op.after ? d.pages.findIndex(x => x.uuid === op.after) + 1 : d.pages.length;
        d.pages.splice(at, 0, p);
        renumber(d);
        break;
      }
      case "DeletePage": {
        const i = d.pages.findIndex(p => p.uuid === op.page);
        if (i < 0) throw new LedgerOpError("ページが見つかりません。");
        if (d.pages.length === 1) throw new LedgerOpError("最後の1ページは削除できません。");
        const [p] = d.pages.splice(i, 1);
        p.slots.forEach(s => set(s, "empty"));
        deleted.set(p.uuid, p);
        renumber(d);
        break;
      }
      case "RestorePage": {
        const p = deleted.get(op.page);
        if (!p) throw new LedgerOpError("ページが見つかりません。");
        d.pages.push(p); deleted.delete(op.page);
        break;
      }
      case "MovePage": {
        const i = d.pages.findIndex(p => p.uuid === op.page);
        if (i < 0) throw new LedgerOpError("ページが見つかりません。");
        const [p] = d.pages.splice(i, 1);
        const at = op.after ? d.pages.findIndex(x => x.uuid === op.after) + 1 : 0;
        d.pages.splice(at, 0, p);
        renumber(d);
        break;
      }
      case "SetSlots": {
        const touched = op.slots.map(s => [need(s.uuid), s]);
        touched.forEach(([slot]) => set(slot, "empty"));
        touched.forEach(([slot, s]) => set(slot, s.kind, s.photoUuid));
        break;
      }
      case "SetCaption": {
        const c = { ...(d.captions[op.photo] || { koushu: null, sokuten: null, body: null }) };
        for (const [k, v] of Object.entries(op.fields)) {
          if (!(k in CAPTION_LIMITS)) throw new LedgerOpError("文言の項目が正しくありません。");
          if (v !== null && [...String(v)].length > CAPTION_LIMITS[k]) throw new LedgerOpError(`文言は${CAPTION_LIMITS[k]}文字以内にしてください。`);
          c[k] = v;
        }
        if (c.koushu == null && c.sokuten == null && c.body == null) delete d.captions[op.photo]; else d.captions[op.photo] = c;
        break;
      }
      case "SetTitle": {
        const t = String(op.title || "").trim();
        if (!t) throw new LedgerOpError("台帳名を入力してください。");
        d.title = t; break;
      }
      case "SetCover": d.cover = { title: "", koushu: "", project: "", contractor: "", ...op.cover }; break;
      case "SetShowCover": d.showCover = !!op.show; break;
      case "SetViewMode": d.viewMode = op.mode === "spread" ? "spread" : "single"; break;
      default: throw new LedgerOpError("対応していない操作です。");
    }
  }
  return { detail: d, skipped };
}

/** 変更後(after)を変更前(before)へ戻す操作列 */
export function computeInverse(before, after) {
  const ops = [];
  const beforeIds = new Set(before.pages.map(p => p.uuid));
  const afterIds = new Set(after.pages.map(p => p.uuid));
  for (const p of after.pages) if (!beforeIds.has(p.uuid)) ops.push({ op: "DeletePage", page: p.uuid });
  for (const p of before.pages) if (!afterIds.has(p.uuid)) ops.push({ op: "RestorePage", page: p.uuid });
  const orderBefore = before.pages.map(p => p.uuid).join();
  const orderAfter = after.pages.filter(p => beforeIds.has(p.uuid)).map(p => p.uuid).join();
  if (orderBefore !== orderAfter || [...beforeIds].some(id => !afterIds.has(id))) {
    let prev = null;
    for (const p of before.pages) { ops.push({ op: "MovePage", page: p.uuid, after: prev }); prev = p.uuid; }
  }
  const afterSlots = new Map();
  for (const p of after.pages) for (const s of p.slots) afterSlots.set(s.uuid, s);
  const restore = [];
  for (const p of before.pages) for (const s of p.slots) {
    const a = afterSlots.get(s.uuid);
    if (!a || a.kind !== s.kind || (a.photoUuid || null) !== (s.photoUuid || null)) restore.push({ uuid: s.uuid, index: s.index, kind: s.kind, photoUuid: s.photoUuid || null });
  }
  if (restore.length) ops.push({ op: "SetSlots", slots: restore });
  const keys = new Set([...Object.keys(before.captions || {}), ...Object.keys(after.captions || {})]);
  for (const k of keys) {
    const b = before.captions?.[k] || {}, a = after.captions?.[k] || {};
    if ((b.koushu ?? null) !== (a.koushu ?? null) || (b.sokuten ?? null) !== (a.sokuten ?? null) || (b.body ?? null) !== (a.body ?? null)) {
      ops.push({ op: "SetCaption", photo: k, fields: { koushu: b.koushu ?? null, sokuten: b.sokuten ?? null, body: b.body ?? null } });
    }
  }
  if (before.title !== after.title) ops.push({ op: "SetTitle", title: before.title });
  if (JSON.stringify(before.cover) !== JSON.stringify(after.cover)) ops.push({ op: "SetCover", cover: before.cover });
  if (before.showCover !== after.showCover) ops.push({ op: "SetShowCover", show: before.showCover });
  if (before.viewMode !== after.viewMode) ops.push({ op: "SetViewMode", mode: before.viewMode });
  return ops;
}

/** 文言の長さの目安（印刷時に文字が小さくなる／収まらない） */
export function captionLengthLevel(text) {
  const n = [...String(text || "")].length;
  if (n > 260) return { level: "over", message: "文字が多すぎて、印刷時に途中までしか入らない可能性があります。" };
  if (n > 120) return { level: "warn", message: "文字が多いため、印刷時に文字が小さくなります。" };
  return { level: "ok", message: "" };
}

/** 文言の表示値（手入力 → 自動） */
export function resolvedCaption(detail, photo) {
  const c = detail.captions?.[photo.uuid] || {};
  return {
    koushu: c.koushu ?? photo.classification.koushu,
    sokuten: c.sokuten ?? photo.classification.sokuten,
    body: c.body ?? photo.ledgerText,
    manual: { koushu: c.koushu != null, sokuten: c.sokuten != null, body: c.body != null },
  };
}
