export const PHOTO_LIFECYCLE_ACTIVE = "active";
export const PHOTO_LIFECYCLE_TRASHED = "trashed";

export function photoLifecycle(photo) {
  return photo?.cloud?.lifecycleStatus || photo?.lifecycleStatus || PHOTO_LIFECYCLE_ACTIVE;
}

export function photoSourceKind(photo) {
  const sources = new Set(photo?.sources || [photo?.source].filter(Boolean));
  const cloud = sources.has("cloud") || Boolean(photo?.cloud?.siteId);
  const zip = sources.has("zip") || photo?.source === "zip";
  if (cloud && zip) return "mixed";
  if (cloud) return "cloud";
  if (zip) return "zip";
  return "unknown";
}

export function isVisiblePhoto(photo) {
  return photoLifecycle(photo) === PHOTO_LIFECYCLE_ACTIVE;
}

export function ledgerPhotoReferences(ledgers, photoIds) {
  const wanted = new Set(photoIds);
  const references = [];
  for (const ledger of ledgers || []) {
    for (let pageIndex = 0; pageIndex < (ledger.pages || []).length; pageIndex += 1) {
      const page = ledger.pages[pageIndex];
      for (let slotIndex = 0; slotIndex < (page?.slots || []).length; slotIndex += 1) {
        const slot = page.slots[slotIndex];
        if (slot?.type !== "photo" || !wanted.has(slot.photoId)) continue;
        references.push({
          photoId: slot.photoId,
          ledgerId: ledger.internalId,
          ledgerTitle: ledger.title || "名称未設定の台帳",
          pageIndex,
          slotIndex
        });
      }
    }
  }
  return references;
}

export function photoDeleteConfirmation(count) {
  const amount = Number(count) || 0;
  return amount === 1 ? "削除" : `写真${amount}枚を削除`;
}

export function photoDeleteSourceLabel(kind) {
  return {
    zip: "この端末だけの写真",
    cloud: "共有写真",
    mixed: "ZIP・共有混在写真",
    unknown: "由来を確認できない写真"
  }[kind] || "由来を確認できない写真";
}
