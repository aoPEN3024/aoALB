import assert from "node:assert/strict";
import {
  isVisiblePhoto,
  ledgerPhotoReferences,
  photoDeleteConfirmation,
  photoLifecycle,
  photoSourceKind
} from "../js/photo-delete.js";
import { buildPhotoDeletionPreviewForData } from "../js/storage.js";

assert.equal(photoSourceKind({ source: "zip", sources: ["zip"] }), "zip");
assert.equal(photoSourceKind({ source: "cloud", sources: ["cloud"], cloud: { siteId: "site-a" } }), "cloud");
assert.equal(photoSourceKind({ source: "zip", sources: ["zip", "cloud"], cloud: { siteId: "site-a" } }), "mixed");
assert.equal(photoSourceKind({}), "unknown");

assert.equal(photoLifecycle({}), "active");
assert.equal(photoLifecycle({ cloud: { lifecycleStatus: "trashed" } }), "trashed");
assert.equal(isVisiblePhoto({ cloud: { lifecycleStatus: "trashed" } }), false);
assert.equal(isVisiblePhoto({ source: "zip" }), true);

assert.equal(photoDeleteConfirmation(1), "削除");
assert.equal(photoDeleteConfirmation(2), "写真2枚を削除");
assert.equal(photoDeleteConfirmation(50), "写真50枚を削除");

const references = ledgerPhotoReferences([
  {
    internalId: "ledger-a",
    title: "施工状況",
    pages: [
      { slots: [{ type: "photo", photoId: "photo-a" }, { type: "blank" }, { type: "photo", photoId: "photo-b" }] },
      { slots: [{ type: "photo", photoId: "photo-c" }] }
    ]
  },
  {
    internalId: "ledger-b",
    title: "完成",
    pages: [{ slots: [{ type: "photo", photoId: "photo-a" }] }]
  }
], ["photo-a", "photo-c"]);

assert.deepEqual(references, [
  { photoId: "photo-a", ledgerId: "ledger-a", ledgerTitle: "施工状況", pageIndex: 0, slotIndex: 0 },
  { photoId: "photo-c", ledgerId: "ledger-a", ledgerTitle: "施工状況", pageIndex: 1, slotIndex: 0 },
  { photoId: "photo-a", ledgerId: "ledger-b", ledgerTitle: "完成", pageIndex: 0, slotIndex: 0 }
]);

const emptyData = { photos: [], photoFiles: [], cloudFiles: [], ledgers: [], settings: [] };
const zipPhoto = { internalId: "zip-a", projectUid: "project-a", photoUid: "uid-zip", source: "zip", sources: ["zip"] };
const cloudPhoto = {
  internalId: "cloud-a", projectUid: "project-a", photoUid: "uid-cloud",
  source: "cloud", sources: ["cloud"], cloud: { siteId: "site-a", remotePhotoId: "remote-a", revision: 1 }
};
const mixedPhoto = {
  ...cloudPhoto, internalId: "mixed-a", photoUid: "uid-mixed", source: "zip", sources: ["zip", "cloud"]
};
const file = photo => ({ photoInternalId: photo.internalId, photoUid: photo.photoUid, blob: new Blob(["jpeg"]) });

const zipPreview = buildPhotoDeletionPreviewForData(
  { ...emptyData, photos: [zipPhoto], photoFiles: [file(zipPhoto)] },
  [zipPhoto.internalId]
);
assert.equal(zipPreview.eligible, true);
assert.equal(zipPreview.kind, "zip");
assert.equal(zipPreview.zipCount, 1);

const cloudPreview = buildPhotoDeletionPreviewForData(
  { ...emptyData, photos: [cloudPhoto] },
  [cloudPhoto.internalId]
);
assert.equal(cloudPreview.eligible, true);
assert.equal(cloudPreview.kind, "cloud");

const mixedPreview = buildPhotoDeletionPreviewForData(
  { ...emptyData, photos: [mixedPhoto] },
  [mixedPhoto.internalId]
);
assert.equal(mixedPreview.eligible, true);
assert.equal(mixedPreview.kind, "cloud");
assert.equal(mixedPreview.mixedCount, 1);

const crossSourcePreview = buildPhotoDeletionPreviewForData(
  { ...emptyData, photos: [zipPhoto, cloudPhoto], photoFiles: [file(zipPhoto)] },
  [zipPhoto.internalId, cloudPhoto.internalId]
);
assert.equal(crossSourcePreview.eligible, false);
assert.match(crossSourcePreview.reasons.join(" "), /分けて削除/);

const ledgerBlocked = buildPhotoDeletionPreviewForData(
  {
    ...emptyData,
    photos: [zipPhoto],
    photoFiles: [file(zipPhoto)],
    ledgers: [{ internalId: "ledger-a", title: "施工状況", pages: [{ slots: [{ type: "photo", photoId: zipPhoto.internalId }] }] }]
  },
  [zipPhoto.internalId]
);
assert.equal(ledgerBlocked.eligible, false);
assert.equal(ledgerBlocked.ledgerReferences.length, 1);

const queueBlocked = buildPhotoDeletionPreviewForData(
  {
    ...emptyData,
    photos: [zipPhoto],
    photoFiles: [file(zipPhoto)],
    settings: [{ key: "cloud:photoSyncQueue", value: [{ photoUid: zipPhoto.photoUid, status: "uploading" }] }]
  },
  [zipPhoto.internalId]
);
assert.equal(queueBlocked.eligible, false);
assert.equal(queueBlocked.queueCount, 1);

console.log("photo deletion domain verification: OK");
