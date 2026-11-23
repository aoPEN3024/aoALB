import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { MemoryRepository } from "../ui/js/memory-repository.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const blank = () => ({ koushu: "", shubetsu: "", saibetsu: "", sokuten: "", tekiyo: "" });
const photo = (folderLabel, { sourceKind = "general", original = blank(), override = {} } = {}) => ({
  uuid: crypto.randomUUID(), photoUid: null, sourceKind, photoNumber: 1, takenAt: "2026-10-01T10:00:00", takenAtSource: "exif",
  width: 640, height: 480, orientation: 1, bytes: 1000, originalName: "20261001_001.jpg", folderLabel,
  original, override, thumbState: "ready", createdAt: new Date().toISOString(), deletedAt: null, ledgerText: "",
});

test("フォルダ分類は空欄だけを補完し、手動値を維持する", async () => {
  const repo = new MemoryRepository(0);
  await repo.createProject("", { name: "架空工事" });
  const p = photo("仮設工/足場架設/枠組足場設置", { override: { koushu: "手動工種" } });
  repo.photos.push(p);
  const preview = await repo.previewFolderClassification();
  assert.deepEqual(
    { photos: preview.photoCount, koushu: preview.koushuCount, shubetsu: preview.shubetsuCount, saibetsu: preview.saibetsuCount },
    { photos: 1, koushu: 0, shubetsu: 1, saibetsu: 1 },
  );
  const result = await repo.applyFolderClassification();
  assert.equal(result.changedPhotos, 1);
  assert.equal(p.override.koushu, "手動工種");
  assert.equal(p.override.shubetsu, "足場架設");
  assert.equal(p.override.saibetsu, "枠組足場設置");
});

test("aoPIC正式分類と未分類フォルダはフォルダ復元の対象外", async () => {
  const repo = new MemoryRepository(0);
  await repo.createProject("", { name: "架空工事" });
  repo.photos.push(
    photo("別工種/別種別/別細別", { sourceKind: "aopic", original: { ...blank(), koushu: "正式工種" } }),
    photo("未分類"),
  );
  const preview = await repo.previewFolderClassification();
  assert.equal(preview.photoCount, 0);
  const result = await repo.applyFolderClassification();
  assert.equal(result.changedPhotos, 0);
});
