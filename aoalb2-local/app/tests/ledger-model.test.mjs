// 画面側の台帳モデルと自動保存キューの検証。 node --test app/tests
import test from "node:test";
import assert from "node:assert/strict";
import { applyLocal, computeInverse, orderedSlots, captionLengthLevel } from "../ui/js/ledger-model.js";
import { SaveQueue, SaveStatus } from "../ui/js/save-queue.js";

let n = 0;
const id = () => `id-${++n}`;
const page = () => ({ uuid: id(), kind: "photo", position: 1, slots: [0, 1, 2].map(index => ({ uuid: id(), index, kind: "empty", photoUuid: null })) });
const ledger = (pages = 1) => ({ uuid: "L", title: "台帳", showCover: true, cover: {}, viewMode: "single", captions: {}, pages: Array.from({ length: pages }, page) });
const contents = d => orderedSlots(d).map(s => (s.kind === "blank" ? "B" : s.photoUuid));
const P = i => `photo-${i}`;

test("配置・入替え・移動（同じ写真は1か所だけ）", () => {
  const d0 = ledger(2);
  const s = orderedSlots(d0).map(x => x.uuid);
  let d = applyLocal(d0, [{ op: "PlaceMany", from: s[0], photos: [P(1), P(2), P(3), P(4)] }], { idGen: id }).detail;
  assert.deepEqual(contents(d).slice(0, 4), [P(1), P(2), P(3), P(4)]);
  d = applyLocal(d, [{ op: "Swap", a: s[0], b: s[3] }]).detail;
  assert.deepEqual(contents(d).slice(0, 4), [P(4), P(2), P(3), P(1)]);
  d = applyLocal(d, [{ op: "Place", slot: s[5], photo: P(2) }]).detail;
  assert.equal(contents(d).filter(x => x === P(2)).length, 1);
  assert.equal(contents(d)[1], null);
  d = applyLocal(d, [{ op: "Move", from: s[5], to: s[0] }]).detail;
  assert.deepEqual([contents(d)[0], contents(d)[5]], [P(2), P(4)]);
  assert.deepEqual(contents(d0), [null, null, null, null, null, null], "元の値は変更しない");
});

test("空白の挿入と詰め、ページ追加・削除・並べ替え", () => {
  let d = ledger(1);
  const s = orderedSlots(d).map(x => x.uuid);
  d = applyLocal(d, [{ op: "PlaceMany", from: s[0], photos: [P(1), P(2), P(3)] }], { idGen: id }).detail;
  d = applyLocal(d, [{ op: "InsertBlank", slot: s[1] }], { idGen: id }).detail;
  assert.equal(d.pages.length, 2);
  assert.deepEqual(contents(d).slice(0, 4), [P(1), "B", P(2), P(3)]);
  d = applyLocal(d, [{ op: "RemoveSlot", slot: s[1] }]).detail;
  assert.deepEqual(contents(d).slice(0, 3), [P(1), P(2), P(3)]);
  const p2 = d.pages[1].uuid;
  d = applyLocal(d, [{ op: "MovePage", page: p2, after: null }]).detail;
  assert.equal(d.pages[0].uuid, p2);
  const deleted = new Map();
  d = applyLocal(d, [{ op: "DeletePage", page: p2 }], { deletedPages: deleted }).detail;
  assert.equal(d.pages.length, 1);
  assert.throws(() => applyLocal(d, [{ op: "DeletePage", page: d.pages[0].uuid }]), /最後の1ページ/);
});

test("元に戻す・やり直す（差分から逆操作を作る）", () => {
  let d = ledger(1);
  const s = orderedSlots(d).map(x => x.uuid);
  d = applyLocal(d, [{ op: "PlaceMany", from: s[0], photos: [P(1), P(2)] }], { idGen: id }).detail;
  const before = structuredClone(d);
  const after = applyLocal(d, [{ op: "Swap", a: s[0], b: s[1] }, { op: "SetTitle", title: "新しい名前" }, { op: "SetCaption", photo: P(1), fields: { body: "手入力" } }]).detail;
  const inv = computeInverse(before, after);
  const back = applyLocal(after, inv).detail;
  assert.deepEqual(contents(back), contents(before));
  assert.equal(back.title, "台帳");
  assert.equal(back.captions[P(1)], undefined);
  const redo = computeInverse(after, back); // back → after へ進める操作
  const again = applyLocal(back, redo).detail;
  assert.deepEqual(contents(again), contents(after));
  assert.equal(again.captions[P(1)].body, "手入力");
});

test("入力チェックと長文警告", () => {
  const d = ledger(1);
  const s = orderedSlots(d)[0].uuid;
  assert.throws(() => applyLocal(d, [{ op: "SetTitle", title: "  " }]), /台帳名/);
  assert.throws(() => applyLocal(d, [{ op: "SetCaption", photo: P(1), fields: { body: "あ".repeat(1001) } }]), /1000文字/);
  const placed = applyLocal(d, [{ op: "Place", slot: s, photo: P(1) }]).detail;
  assert.throws(() => applyLocal(placed, [{ op: "SetBlank", slot: s, blank: true }]), /写真がある枠/);
  assert.throws(() => applyLocal(d, [{ op: "Place", slot: s, photo: P(9) }], { trashedPhotos: new Set([P(9)]) }), /ごみ箱/);
  assert.equal(captionLengthLevel("短い").level, "ok");
  assert.equal(captionLengthLevel("あ".repeat(200)).level, "warn");
  assert.equal(captionLengthLevel("あ".repeat(300)).level, "over");
});

function fakeTimers() {
  const q = [];
  return { setTimer: (f, ms) => { const t = { f, ms }; q.push(t); return t; }, clearTimer: t => { const i = q.indexOf(t); if (i >= 0) q.splice(i, 1); }, run: async () => { while (q.length) { const t = q.shift(); await t.f(); } }, q };
}

test("自動保存：連続操作は1回にまとめ、保存中の操作は次回へ（自己競合しない）", async () => {
  const sent = [];
  let release;
  const timers = fakeTimers();
  const queue = new SaveQueue(ops => { sent.push(ops.map(o => o.op)); return new Promise(r => { release = () => r({ detail: {} }); }); }, timers);
  queue.push([{ op: "Place" }]); queue.push([{ op: "Swap" }]); queue.push([{ op: "Clear" }]);
  assert.equal(queue.status, SaveStatus.pending);
  assert.equal(timers.q.length, 1, "タイマーは1本だけ");
  const f = queue.flush();
  await Promise.resolve();
  assert.deepEqual(sent, [["Place", "Swap", "Clear"]]);
  queue.push([{ op: "SetTitle" }]);
  assert.equal(sent.length, 1, "保存中は2本目を送らない");
  release(); await f;
  assert.equal(sent.length, 1, "保存中に増えた操作は短い待ち時間の後でまとめて送る");
  const run = timers.run();
  await new Promise(r => setTimeout(r, 0));
  release(); await run;
  assert.deepEqual(sent, [["Place", "Swap", "Clear"], ["SetTitle"]]);
  assert.equal(queue.status, SaveStatus.saved);
});

test("自動保存：一時的な失敗は再試行し、上限で止めて操作を消さない／入力不正は再試行しない", async () => {
  const timers = fakeTimers();
  let calls = 0;
  const statuses = [];
  const q = new SaveQueue(async () => { calls++; throw { kind: "internal", message: "x" }; }, { ...timers, maxRetries: 3, onStatus: s => statuses.push(s) });
  q.push([{ op: "Place" }], true);
  await timers.run();
  assert.equal(calls, 3);
  assert.equal(q.status, SaveStatus.error);
  assert.equal(q.pending.length, 1, "未保存の操作は残す");
  let rejected = null;
  const q2 = new SaveQueue(async () => { throw { kind: "invalid", message: "台帳名を入力してください。" }; }, { ...fakeTimers(), onRejected: e => { rejected = e; } });
  q2.push([{ op: "SetTitle" }]);
  await q2.flush();
  assert.equal(rejected.message, "台帳名を入力してください。");
  assert.equal(q2.pending.length, 0);
});
