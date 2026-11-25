import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { MemoryRepository } from "../ui/js/memory-repository.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

async function repoWithLedgers() {
  const repo = new MemoryRepository(0);
  await repo.createProject("", { name: "架空工事", contractor: "架空建設" });
  const a = await repo.createLedger("出来形");
  const b = await repo.createLedger("品質管理");
  return { repo, a, b };
}

test("既存台帳は未分類で、作成したフォルダへ移動できる", async () => {
  const { repo, a } = await repoWithLedgers();
  assert.equal((await repo.listLedgers())[0].folderUuid, null);
  const folder = await repo.createLedgerFolder("完了分");
  await repo.moveLedgerToFolder(a.uuid, folder.uuid);
  assert.equal((await repo.listLedgers()).find(x => x.uuid === a.uuid).folderUuid, folder.uuid);
});

test("フォルダ削除は台帳を削除せず未分類へ戻す", async () => {
  const { repo, a, b } = await repoWithLedgers();
  const folder = await repo.createLedgerFolder("施工中");
  await repo.moveLedgerToFolder(a.uuid, folder.uuid);
  await repo.moveLedgerToFolder(b.uuid, folder.uuid);
  await repo.deleteLedgerFolder(folder.uuid);
  const rows = await repo.listLedgers();
  assert.equal(rows.length, 2);
  assert.ok(rows.every(x => x.folderUuid === null));
});

test("台帳の複製は元と同じフォルダに入る", async () => {
  const { repo, a } = await repoWithLedgers();
  const folder = await repo.createLedgerFolder("提出済み");
  await repo.moveLedgerToFolder(a.uuid, folder.uuid);
  const copy = await repo.duplicateLedger(a.uuid, "出来形（複製）");
  assert.equal((await repo.listLedgers()).find(x => x.uuid === copy.uuid).folderUuid, folder.uuid);
});

test("同名フォルダと存在しない移動先を拒否する", async () => {
  const { repo, a } = await repoWithLedgers();
  await repo.createLedgerFolder("月別");
  await assert.rejects(() => repo.createLedgerFolder("月別"), /同じ名前/);
  await assert.rejects(() => repo.moveLedgerToFolder(a.uuid, crypto.randomUUID()), /見つかりません/);
});
