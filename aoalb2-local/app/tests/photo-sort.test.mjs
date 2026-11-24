import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { MemoryRepository } from "../ui/js/memory-repository.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const blank = () => ({ koushu: "", shubetsu: "", saibetsu: "", sokuten: "", tekiyo: "" });
const photo = (uuid, photoNumber, takenAt, originalName, koushu) => ({
  uuid, photoUid: null, sourceKind: "general", photoNumber, takenAt, takenAtSource: "exif",
  width: 640, height: 480, orientation: 1, bytes: 1000, originalName, folderLabel: "",
  original: { ...blank(), koushu }, override: {}, thumbState: "ready", createdAt: "2026-10-10T00:00:00", deletedAt: null, ledgerText: "",
});

async function repoWithPhotos() {
  const repo = new MemoryRepository(0);
  await repo.createProject("", { name: "並び替え工事" });
  repo.photos.push(
    photo("p1", 1, "2026-10-03T10:00:00", "B_002.jpg", "塗装工"),
    photo("p2", 2, "2026-10-01T10:00:00", "C_003.jpg", ""),
    photo("p3", 3, "2026-10-02T10:00:00", "A_001.jpg", "仮設工"),
  );
  return repo;
}

const ids = rows => rows.map(row => row.uuid);

test("撮影日は古い順と新しい順に並べられる", async () => {
  const repo = await repoWithPhotos();
  assert.deepEqual(ids(await repo.listPhotos({ sortBy: "date" })), ["p2", "p3", "p1"]);
  assert.deepEqual(ids(await repo.listPhotos({ sortBy: "date", sortDesc: true })), ["p1", "p3", "p2"]);
});

test("工種順では未分類を末尾に置く", async () => {
  const repo = await repoWithPhotos();
  assert.deepEqual(ids(await repo.listPhotos({ sortBy: "koushu" })), ["p3", "p1", "p2"]);
  assert.deepEqual(ids(await repo.listPhotos({ sortBy: "koushu", sortDesc: true })), ["p1", "p3", "p2"]);
});

test("写真名は昇順と降順に並べられる", async () => {
  const repo = await repoWithPhotos();
  assert.deepEqual(ids(await repo.listPhotos({ sortBy: "name" })), ["p3", "p1", "p2"]);
  assert.deepEqual(ids(await repo.listPhotos({ sortBy: "name", sortDesc: true })), ["p2", "p1", "p3"]);
});

test("絞り込み後にも指定した並び順を保つ", async () => {
  const repo = await repoWithPhotos();
  assert.deepEqual(ids(await repo.listPhotos({ text: ".jpg", sortBy: "date", sortDesc: true })), ["p1", "p3", "p2"]);
});
