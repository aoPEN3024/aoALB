import {
  clearCloudCache, getCloudCacheSummary, getCloudFile, getPhotoByInternalId, getPhotoByUid, getPhotoFile,
  getPhotosByProjectUid, getProjects, mergeCloudSnapshot, saveCloudFile
} from "../storage.js";

let provider = null;
let identity = null;
let syncPromise = null;
let changeCallback = null;

const toHex = buffer => Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, "0")).join("");

async function hashBlob(blob) {
  return toHex(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
}

async function imageDimensions(blob) {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    try { return { width: bitmap.width, height: bitmap.height }; } finally { bitmap.close(); }
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("クラウド画像をJPEGとして表示できません。"));
      element.src = url;
    });
    return { width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function validateJpeg(blob, expectedSha256, expectedBytes, expectedWidth, expectedHeight) {
  const header = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
  if (header.length !== 3 || header[0] !== 0xff || header[1] !== 0xd8 || header[2] !== 0xff) {
    throw new Error("クラウド画像のJPEG形式を確認できません。");
  }
  if (Number(expectedBytes) > 0 && blob.size !== Number(expectedBytes)) throw new Error("クラウド画像の容量が写真情報と一致しません。");
  const actual = await hashBlob(blob);
  if (actual !== expectedSha256) throw new Error("クラウド画像のSHA-256が写真情報と一致しません。");
  const dimensions = await imageDimensions(blob);
  if (Number(expectedWidth) > 0 && (dimensions.width !== Number(expectedWidth) || dimensions.height !== Number(expectedHeight))) {
    throw new Error("クラウド画像の寸法が写真情報と一致しません。");
  }
}

function online() {
  return globalThis.navigator?.onLine !== false;
}

export function configureCloudReceiver(nextProvider, nextIdentity, onChange = null) {
  provider = nextProvider || null;
  identity = nextIdentity?.siteId ? { ...nextIdentity } : null;
  changeCallback = typeof onChange === "function" ? onChange : null;
}

export function disconnectCloudReceiver() {
  provider = null;
  identity = null;
  changeCallback = null;
}

export async function syncCloudPhotos() {
  if (!provider || !identity?.siteId) return { skipped: true, reason: "not-connected" };
  if (!online()) return { skipped: true, reason: "offline" };
  if (syncPromise) return syncPromise;
  const siteId = identity.siteId;
  syncPromise = (async () => {
    const snapshot = await provider.listCompletePhotoSnapshot(siteId);
    if (identity?.siteId !== siteId) return { skipped: true, reason: "site-changed" };
    const result = await mergeCloudSnapshot(siteId, snapshot.projects, snapshot.photos);
    changeCallback?.(result);
    globalThis.dispatchEvent?.(new CustomEvent("aoalb:cloud-photos-updated", { detail: result }));
    return result;
  })().finally(() => { syncPromise = null; });
  return syncPromise;
}

export async function loadPhotoAsset(photoInternalId, kind = "original", options = {}) {
  const local = await getPhotoFile(photoInternalId);
  if (local?.blob) return { ...local, source: "local" };
  const photo = await getPhotoByInternalId(photoInternalId);
  if (!photo?.cloud || photo.cloud.status !== "complete") return null;
  const cached = await getCloudFile(photo.photoUid, kind);
  if (cached?.blob) return { ...cached, source: "cloud-cache" };
  if (!provider || identity?.siteId !== photo.cloud.siteId || !online()) return null;
  if (kind === "original" && options.network === "wifi_only") {
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const type = String(connection?.type || "").toLowerCase();
    if (!["wifi", "ethernet"].includes(type)) return null;
  }
  const path = kind === "thumbnail" ? photo.cloud.thumbnailPath : photo.cloud.originalPath;
  const sha256 = kind === "thumbnail" ? photo.cloud.thumbnailSha256 : photo.sha256;
  const bytes = kind === "thumbnail" ? photo.cloud.thumbnailBytes : photo.bytes;
  const width = kind === "thumbnail" ? photo.cloud.thumbnailWidth : photo.width;
  const height = kind === "thumbnail" ? photo.cloud.thumbnailHeight : photo.height;
  const blob = await provider.downloadPhotoObject(path);
  await validateJpeg(blob, sha256, bytes, width, height);
  await saveCloudFile({ siteId: photo.cloud.siteId, photoUid: photo.photoUid, kind, blob, sha256, bytes });
  return { photoUid: photo.photoUid, kind, blob, sha256, bytes, source: "cloud" };
}

export async function cloudDownloadSummary(siteId = identity?.siteId || "") {
  const cache = await getCloudCacheSummary(siteId);
  let photoCount = 0;
  let uncachedOriginals = 0;
  let uncachedOriginalBytes = 0;
  let thumbnailBytes = 0;
  for (const project of await getProjects()) {
    for (const photo of await getPhotosByProjectUid(project.projectUid)) {
      if (photo.cloud?.siteId !== siteId || photo.cloud?.status !== "complete") continue;
      photoCount += 1;
      thumbnailBytes += Number(photo.cloud.thumbnailBytes || 0);
      if (!await getCloudFile(photo.photoUid, "original") && !await getPhotoFile(photo.internalId)) {
        uncachedOriginals += 1;
        uncachedOriginalBytes += Number(photo.bytes || 0);
      }
    }
  }
  return { siteId, photoCount, uncachedOriginals, uncachedOriginalBytes, thumbnailBytes, cache };
}

export async function cacheAllOriginals(onProgress = null) {
  if (!provider || !identity?.siteId || !online()) throw new Error("オンラインで現場へ接続してから実行してください。");
  const candidates = [];
  for (const project of await getProjects()) {
    for (const photo of await getPhotosByProjectUid(project.projectUid)) {
      if (photo.cloud?.siteId !== identity.siteId || photo.cloud?.status !== "complete") continue;
      if (!await getPhotoFile(photo.internalId) && !await getCloudFile(photo.photoUid, "original")) candidates.push(photo);
    }
  }
  let completed = 0;
  for (const photo of candidates) {
    await loadPhotoAsset(photo.internalId, "original");
    completed += 1;
    onProgress?.({ completed, total: candidates.length, photoUid: photo.photoUid });
  }
  return { completed, total: candidates.length };
}

export async function clearCurrentSiteCloudCache() {
  if (!identity?.siteId) throw new Error("現場へ接続していません。");
  await clearCloudCache(identity.siteId);
  globalThis.dispatchEvent?.(new CustomEvent("aoalb:cloud-cache-cleared", { detail: { siteId: identity.siteId } }));
}

export async function getCloudPhotoByUid(photoUid) {
  const photo = await getPhotoByUid(photoUid);
  return photo?.cloud?.status === "complete" ? photo : null;
}
