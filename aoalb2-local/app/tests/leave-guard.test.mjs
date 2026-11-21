// 保存失敗時に画面移動・工事終了・アプリ終了を止めることの検証。 node --test app/tests
import test from "node:test";
import assert from "node:assert/strict";
import { SaveQueue } from "../ui/js/save-queue.js";
import { LeaveGuard, createExitHandler, describeOps } from "../ui/js/leave-guard.js";

const timers = () => ({ setTimer: () => ({}), clearTimer: () => {} }); // 自動の再試行タイマーは動かさない（利用者の操作だけで進める）

/** send の結果を順に返す架空の保存先 */
function fakeSender(results) {
  const calls = [];
  const send = async ops => { calls.push(ops.map(o => o.op)); const r = results.shift() ?? "ok"; if (r === "ok") return { detail: {} }; throw { kind: r, message: r === "invalid" ? "台帳名を入力してください。" : "保存先に書き込めません。" }; };
  return { send, calls };
}

function setup(results, answers = []) {
  const { send, calls } = fakeSender(results);
  const rejected = [];
  const q = new SaveQueue(send, { ...timers(), onRejected: (e, ops) => rejected.push({ e, ops }) });
  const asked = [];
  const guard = new LeaveGuard({ getQueue: () => q, askOnFailure: async (err, n) => { asked.push({ err, n }); return answers.shift() ?? "stay"; } });
  return { q, guard, calls, asked, rejected };
}

test("保存成功後だけ画面を移る", async () => {
  const { q, guard, calls, asked } = setup(["ok"]);
  q.push([{ op: "Place" }, { op: "Swap" }]);
  assert.equal(await guard.ensureSaved(), true);
  assert.deepEqual(calls, [["Place", "Swap"]]);
  assert.equal(asked.length, 0);
  assert.equal(q.hasUnsaved, false);
});

test("一時的な失敗では画面を移らず、未保存の操作を残す", async () => {
  const { q, guard, asked } = setup(["internal"], ["stay"]);
  q.push([{ op: "Place" }, { op: "SetTitle" }]);
  assert.equal(await guard.ensureSaved(), false);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].n, 2);
  assert.equal(asked[0].err.message, "保存先に書き込めません。");
  assert.deepEqual(q.pending.map(o => o.op), ["Place", "SetTitle"], "pending を破棄しない");
});

test("再試行で保存できたら移る", async () => {
  const { q, guard, calls, asked } = setup(["internal", "ok"], ["retry"]);
  q.push([{ op: "Clear" }]);
  assert.equal(await guard.ensureSaved(), true);
  assert.equal(asked.length, 1);
  assert.deepEqual(calls, [["Clear"], ["Clear"]], "同じ操作をもう一度送る");
  assert.equal(q.hasUnsaved, false);
});

test("保存失敗時は工事を閉じない", async () => {
  const { q, guard } = setup(["disk_full"], ["stay"]);
  let closed = false;
  const closeProject = async () => { if (!(await guard.ensureSaved())) return; closed = true; };
  q.push([{ op: "Place" }]);
  await closeProject();
  assert.equal(closed, false);
  assert.equal(q.pending.length, 1);
});

test("保存失敗時はアプリを終了しない。成功後だけウィンドウを破棄する", async () => {
  const { q, guard } = setup(["internal", "internal", "ok"], ["stay", "retry"]);
  let closed = 0, destroyed = 0;
  const exit = createExitHandler({ guard, closeProject: async () => { closed++; }, destroy: async () => { destroyed++; } });
  q.push([{ op: "Place" }]);
  assert.equal(await exit(), false);
  assert.deepEqual([closed, destroyed], [0, 0], "失敗時は閉じない・破棄しない");
  assert.equal(q.pending.length, 1);
  assert.equal(await exit(), true);
  assert.deepEqual([closed, destroyed], [1, 1]);
});

test("工事を閉じる処理が失敗したらウィンドウを破棄しない", async () => {
  const { guard } = setup([]);
  let destroyed = 0, err = null;
  const exit = createExitHandler({ guard, closeProject: async () => { throw { message: "閉じられません" }; }, destroy: async () => { destroyed++; }, onError: e => { err = e; } });
  assert.equal(await exit(), false);
  assert.equal(destroyed, 0);
  assert.equal(err.message, "閉じられません");
});

test("終了操作を繰り返しても保存は1回だけ", async () => {
  let release;
  const calls = [];
  const q = new SaveQueue(ops => { calls.push(ops.length); return new Promise(r => { release = () => r({ detail: {} }); }); }, timers());
  const guard = new LeaveGuard({ getQueue: () => q, askOnFailure: async () => "stay" });
  let destroyed = 0;
  const exit = createExitHandler({ guard, closeProject: async () => {}, destroy: async () => { destroyed++; } });
  q.push([{ op: "Place" }]);
  const a = exit(), b = exit(), c = exit();
  assert.equal(a, b); assert.equal(b, c);
  await new Promise(r => setTimeout(r, 0));
  release();
  assert.deepEqual(await Promise.all([a, b, c]), [true, true, true]);
  assert.deepEqual(calls, [1], "二重保存しない");
  assert.equal(destroyed, 1, "二重終了しない");
});

test("直らない失敗は、取り消した操作と理由を利用者へ渡して移れる", async () => {
  const { q, guard, rejected, asked } = setup(["invalid"]);
  q.push([{ op: "SetTitle" }, { op: "Place" }, { op: "Place" }]);
  assert.equal(await guard.ensureSaved(), true);
  assert.equal(asked.length, 0);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].e.message, "台帳名を入力してください。");
  assert.deepEqual(describeOps(rejected[0].ops), ["台帳名", "写真の配置（2件）"]);
});
