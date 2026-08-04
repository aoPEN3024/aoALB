import {
  isVisiblePhoto, ledgerPhotoReferences, photoLifecycle, photoSourceKind
} from "./photo-delete.js";

const DB_NAME = "aoALBDB";
const DB_VERSION = 4;

let dbPromise;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error("データ保存を中止しました。"));
    transaction.onerror = () => reject(transaction.error || new Error("データ保存に失敗しました。"));
  });
}

export function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = event => {
      const db = request.result;
      if (!db.objectStoreNames.contains("imports")) {
        const imports = db.createObjectStore("imports", { keyPath: "internalId" });
        imports.createIndex("exportId", "exportId", { unique: true });
        imports.createIndex("importedAt", "importedAt");
        imports.createIndex("projectUid", "projectUid");
      }
      if (!db.objectStoreNames.contains("projects")) {
        const projects = db.createObjectStore("projects", { keyPath: "internalId" });
        projects.createIndex("projectUid", "projectUid", { unique: true });
        projects.createIndex("lastImportedAt", "lastImportedAt");
      }
      if (!db.objectStoreNames.contains("photos")) {
        const photos = db.createObjectStore("photos", { keyPath: "internalId" });
        photos.createIndex("photoUid", "photoUid", { unique: true });
        photos.createIndex("projectUid", "projectUid");
        photos.createIndex("capturedAt", "capturedAt");
      }
      if (!db.objectStoreNames.contains("photoFiles")) {
        const photoFiles = db.createObjectStore("photoFiles", { keyPath: "photoInternalId" });
        photoFiles.createIndex("photoUid", "photoUid", { unique: true });
      }
      if (!db.objectStoreNames.contains("ledgers")) db.createObjectStore("ledgers", { keyPath: "internalId" });
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
      if (!db.objectStoreNames.contains("cloudFiles")) {
        const cloudFiles = db.createObjectStore("cloudFiles", { keyPath: "cacheKey" });
        cloudFiles.createIndex("photoUid", "photoUid");
        cloudFiles.createIndex("siteId", "siteId");
        cloudFiles.createIndex("kind", "kind");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("別のaoALB画面を閉じてから再読み込みしてください。"));
  });
  return dbPromise;
}

async function getByIndex(storeName, indexName, value) {
  const db = await openDatabase();
  const tx = db.transaction(storeName, "readonly");
  return requestResult(tx.objectStore(storeName).index(indexName).get(value));
}

async function getAll(storeName) {
  const db = await openDatabase();
  const tx = db.transaction(storeName, "readonly");
  return requestResult(tx.objectStore(storeName).getAll());
}

export async function getSetting(key) {
  const db = await openDatabase();
  const tx = db.transaction("settings", "readonly");
  const record = await requestResult(tx.objectStore("settings").get(key));
  return record?.value;
}

export async function setSetting(key, value) {
  const db = await openDatabase();
  const tx = db.transaction("settings", "readwrite");
  const done = transactionDone(tx);
  tx.objectStore("settings").put({ key, value: structuredClone(value), updatedAt: new Date().toISOString() });
  await done;
  return value;
}

export const getImportByExportId = exportId => getByIndex("imports", "exportId", exportId);
export const getProjectByUid = projectUid => getByIndex("projects", "projectUid", projectUid);
export const getPhotoByUid = photoUid => getByIndex("photos", "photoUid", photoUid);
export const getProjects = () => getAll("projects");
export const getImports = () => getAll("imports");
export const getLedgers = () => getAll("ledgers");

export async function getLedger(internalId) {
  const db = await openDatabase();
  const tx = db.transaction("ledgers", "readonly");
  return requestResult(tx.objectStore("ledgers").get(internalId));
}

export async function getLedgersByProjectId(projectId) {
  const ledgers = await getAll("ledgers");
  return ledgers.filter(ledger => ledger.projectId === projectId);
}

export async function saveLedger(ledger) {
  const db = await openDatabase();
  const tx = db.transaction("ledgers", "readwrite");
  const done = transactionDone(tx);
  try {
    tx.objectStore("ledgers").put(structuredClone(ledger));
    await done;
    return ledger;
  } catch (error) {
    try { tx.abort(); } catch (_) { /* already completed or aborted */ }
    await done.catch(() => {});
    throw error;
  }
}

const STORAGE_BASE_RESERVE = 8 * 1024 * 1024;
const STORAGE_METADATA_MINIMUM = 512 * 1024;

function serializedByteLength(value) {
  const text = JSON.stringify(value);
  if (typeof TextEncoder === "function") return new TextEncoder().encode(text).byteLength;
  return text.length * 3;
}

export async function estimateImportStorage(validated, estimateProvider = globalThis.navigator?.storage?.estimate?.bind(globalThis.navigator.storage)) {
  let newJpegBytes = 0;
  for (const photo of validated.photos) {
    if (!await getPhotoByUid(photo.photoUid)) newJpegBytes += photo.bytes;
  }

  const metadata = {
    manifestVersion: validated.manifestVersion,
    exportId: validated.exportId,
    exportedAt: validated.exportedAt,
    project: validated.project,
    photos: validated.photos.map(({ blob: _blob, ...photo }) => photo)
  };
  const metadataBytes = serializedByteLength(metadata);
  const metadataReserve = Math.max(STORAGE_METADATA_MINIMUM, metadataBytes * 3);
  const transactionReserve = Math.max(STORAGE_BASE_RESERVE, Math.ceil(newJpegBytes * 0.75));
  const requiredBytes = Math.ceil(newJpegBytes + metadataReserve + transactionReserve);

  if (typeof estimateProvider !== "function") {
    return { supported: false, requiredBytes, newJpegBytes, metadataBytes };
  }

  try {
    const estimate = await estimateProvider();
    const quota = Number(estimate?.quota);
    const usage = Number(estimate?.usage || 0);
    if (!Number.isFinite(quota) || quota <= 0 || !Number.isFinite(usage) || usage < 0) {
      return { supported: false, requiredBytes, newJpegBytes, metadataBytes };
    }
    const availableBytes = Math.max(0, quota - usage);
    return {
      supported: true,
      sufficient: availableBytes >= requiredBytes,
      requiredBytes,
      availableBytes,
      newJpegBytes,
      metadataBytes
    };
  } catch (_) {
    return { supported: false, requiredBytes, newJpegBytes, metadataBytes };
  }
}

export async function getPhotosByProjectUid(projectUid) {
  const db = await openDatabase();
  const tx = db.transaction("photos", "readonly");
  const photos = await requestResult(tx.objectStore("photos").index("projectUid").getAll(projectUid));
  return photos.filter(isVisiblePhoto);
}

export async function getTrashedPhotosBySite(siteId) {
  const photos = await getAll("photos");
  return photos.filter(photo => photo?.cloud?.siteId === siteId && photoLifecycle(photo) === "trashed");
}

export async function getPhotoFile(photoInternalId) {
  const db = await openDatabase();
  const tx = db.transaction("photoFiles", "readonly");
  return requestResult(tx.objectStore("photoFiles").get(photoInternalId));
}

export async function getPhotoByInternalId(photoInternalId) {
  const db = await openDatabase();
  const tx = db.transaction("photos", "readonly");
  return requestResult(tx.objectStore("photos").get(photoInternalId));
}

export async function updatePhotoClassificationOverrides(photoInternalIds, changes, reset = false, resetFields = []) {
  const ids = [...new Set((photoInternalIds || []).map(String).filter(Boolean))];
  if (!ids.length) throw new Error("分類を変更する写真を選択してください。");
  const allowed = new Set(["koushu", "shubetsu", "saibetsu", "sokuten", "tekiyo"]);
  const entries = Object.entries(changes || {}).filter(([field]) => allowed.has(field));
  const fieldsToReset = [...new Set((resetFields || []).filter(field => allowed.has(field)))];
  if (!reset && !entries.length && !fieldsToReset.length) throw new Error("変更する分類項目を選択してください。");
  const db = await openDatabase();
  const tx = db.transaction("photos", "readwrite");
  const done = transactionDone(tx);
  const store = tx.objectStore("photos");
  try {
    for (const id of ids) {
      const photo = await requestResult(store.get(id));
      if (!photo) throw new Error("選択した写真が見つかりません。再読み込みしてください。");
      if (reset) {
        delete photo.classificationOverride;
        delete photo.classificationOverrideUpdatedAt;
      } else {
        const override = photo.classificationOverride && typeof photo.classificationOverride === "object"
          ? { ...photo.classificationOverride }
          : {};
        for (const field of fieldsToReset) delete override[field];
        for (const [field, value] of entries) override[field] = String(value ?? "");
        if (Object.keys(override).length) {
          photo.classificationOverride = override;
          photo.classificationOverrideUpdatedAt = new Date().toISOString();
        } else {
          delete photo.classificationOverride;
          delete photo.classificationOverrideUpdatedAt;
        }
      }
      store.put(photo);
    }
    await done;
    return ids.length;
  } catch (error) {
    try { tx.abort(); } catch (_) { /* already completed or aborted */ }
    await done.catch(() => {});
    throw error;
  }
}

const PHOTO_DELETE_STORES = ["photos", "photoFiles", "cloudFiles", "ledgers", "settings"];

async function readPhotoDeleteData(transaction) {
  const requests = Object.fromEntries(PHOTO_DELETE_STORES.map(name => [name, transaction.objectStore(name).getAll()]));
  const values = await Promise.all(PHOTO_DELETE_STORES.map(name => requestResult(requests[name])));
  return Object.fromEntries(PHOTO_DELETE_STORES.map((name, index) => [name, values[index]]));
}

function photoQueueReferences(setting, photos) {
  if (setting?.key !== PHOTO_SYNC_QUEUE_KEY) return [];
  const ids = new Set(photos.flatMap(photo => [photo.internalId, photo.photoUid].filter(Boolean)));
  return (Array.isArray(setting.value) ? setting.value : []).filter(item => referencesAny(item, ids));
}

export function buildPhotoDeletionPreviewForData(data, photoInternalIds) {
  const requested = [...new Set((photoInternalIds || []).filter(value => typeof value === "string" && value))];
  if (!requested.length) throw new Error("写真を1枚以上選択してください。");
  if (requested.length > 200) throw new Error("一度に削除できる写真は200枚までです。");
  const photos = requested.map(id => data.photos.find(photo => photo.internalId === id));
  if (photos.some(photo => !photo)) throw new Error("削除対象の写真が見つかりません。");

  const projectUids = new Set(photos.map(photo => photo.projectUid));
  if (projectUids.size !== 1) throw new Error("異なる工事の写真は分けて削除してください。");
  const sources = photos.map(photoSourceKind);
  const sourceKinds = new Set(sources.map(kind => kind === "mixed" ? "cloud" : kind));
  const reasons = [];
  if (sources.includes("unknown")) reasons.push("保存元を安全に確認できない写真が含まれています。");
  if (sourceKinds.size > 1) reasons.push("この端末だけの写真と共有写真は、分けて削除してください。");

  const photoIds = new Set(photos.map(photo => photo.internalId));
  const photoUids = new Set(photos.map(photo => photo.photoUid));
  const files = data.photoFiles.filter(file => photoIds.has(file.photoInternalId) || photoUids.has(file.photoUid));
  const cachedFiles = data.cloudFiles.filter(file => photoUids.has(file.photoUid));
  const references = ledgerPhotoReferences(data.ledgers, photoIds);
  if (references.length) reasons.push(`台帳で使用中の写真が${new Set(references.map(ref => ref.photoId)).size}枚あります。`);

  const queueItems = data.settings.flatMap(setting => photoQueueReferences(setting, photos));
  const unsafeQueueItems = queueItems.filter(item => item?.status !== "synced");
  if (unsafeQueueItems.length) reasons.push(`未送信または送信処理中の写真が${unsafeQueueItems.length}件あります。`);

  const kind = sourceKinds.size === 1 ? [...sourceKinds][0] : "mixed_selection";
  const localBytes = files.reduce((sum, file) => sum + Number(file.blob?.size || 0), 0);
  const cacheBytes = cachedFiles.reduce((sum, file) => sum + Number(file.blob?.size || file.bytes || 0), 0);
  const versionToken = JSON.stringify({
    photos: photos.map(photo => structuredClone(photo)),
    files: files.map(file => [file.photoInternalId, file.photoUid, Number(file.blob?.size || 0)]),
    cachedFiles: cachedFiles.map(file => [file.cacheKey, file.photoUid, Number(file.blob?.size || 0)]),
    references,
    queueItems
  });
  return {
    eligible: reasons.length === 0,
    reasons,
    kind,
    photos: photos.map(photo => structuredClone(photo)),
    photoCount: photos.length,
    zipCount: sources.filter(source => source === "zip").length,
    cloudCount: sources.filter(source => source === "cloud").length,
    mixedCount: sources.filter(source => source === "mixed").length,
    ledgerReferences: references,
    queueCount: unsafeQueueItems.length,
    estimatedBytes: localBytes + cacheBytes,
    versionToken
  };
}

export async function getPhotoDeletionPreview(photoInternalIds) {
  const db = await openDatabase();
  const tx = db.transaction(PHOTO_DELETE_STORES, "readonly");
  return buildPhotoDeletionPreviewForData(await readPhotoDeleteData(tx), photoInternalIds);
}

export async function deleteLocalPhotos(photoInternalIds, expectedVersionToken) {
  const db = await openDatabase();
  const tx = db.transaction(PHOTO_DELETE_STORES, "readwrite");
  const done = transactionDone(tx);
  try {
    const data = await readPhotoDeleteData(tx);
    const preview = buildPhotoDeletionPreviewForData(data, photoInternalIds);
    if (!preview.eligible) throw new Error(preview.reasons[0] || "写真を削除できません。");
    if (preview.kind !== "zip") throw new Error("共有写真は共有のごみ箱から削除してください。");
    if (!expectedVersionToken || preview.versionToken !== expectedVersionToken) {
      throw new Error("確認後に写真または台帳が変更されました。内容を確認し直してください。");
    }
    const ids = new Set(preview.photos.map(photo => photo.internalId));
    const uids = new Set(preview.photos.map(photo => photo.photoUid));
    const stores = Object.fromEntries(PHOTO_DELETE_STORES.map(name => [name, tx.objectStore(name)]));
    for (const file of data.photoFiles) {
      if (ids.has(file.photoInternalId) || uids.has(file.photoUid)) stores.photoFiles.delete(file.photoInternalId);
    }
    for (const file of data.cloudFiles) {
      if (uids.has(file.photoUid)) stores.cloudFiles.delete(file.cacheKey);
    }
    for (const photo of preview.photos) stores.photos.delete(photo.internalId);
    for (const setting of data.settings) {
      if (setting.key !== PHOTO_SYNC_QUEUE_KEY || !Array.isArray(setting.value)) continue;
      const value = setting.value.filter(item => !referencesAny(item, new Set([...ids, ...uids])));
      if (value.length !== setting.value.length) {
        stores.settings.put({ ...setting, value, updatedAt: new Date().toISOString() });
      }
    }
    await done;
    const verify = await Promise.all(preview.photos.map(async photo => ({
      photo: await getPhotoByInternalId(photo.internalId),
      file: await getPhotoFile(photo.internalId),
      caches: (await getAll("cloudFiles")).filter(file => file.photoUid === photo.photoUid)
    })));
    if (verify.some(result => result.photo || result.file || result.caches.length)) {
      throw new Error("削除後の確認で写真データが残っています。");
    }
    return { deleted: preview.photoCount, photoInternalIds: [...ids], photoUids: [...uids] };
  } catch (error) {
    try { tx.abort(); } catch (_) { /* transaction already completed or aborted */ }
    await done.catch(() => {});
    throw error;
  }
}

const LOCAL_PROJECT_DELETE_STORES = ["imports", "projects", "photos", "photoFiles", "cloudFiles", "ledgers", "settings"];
const SYNC_QUEUE_KEY = "cloud:syncQueue";
const PHOTO_SYNC_QUEUE_KEY = "cloud:photoSyncQueue";
const CLOUD_IDENTITY_KEY = "cloud:identity";
const SAFE_QUEUE_STATE = "synced";

function importProjectUids(record) {
  const values = new Set();
  if (typeof record?.projectUid === "string" && record.projectUid) values.add(record.projectUid);
  if (Array.isArray(record?.projectUids)) {
    for (const value of record.projectUids) if (typeof value === "string" && value) values.add(value);
  }
  if (Array.isArray(record?.projects)) {
    for (const project of record.projects) {
      const value = typeof project === "string" ? project : project?.projectUid;
      if (typeof value === "string" && value) values.add(value);
    }
  }
  return values;
}

function hasCloudSource(record) {
  return record?.source === "cloud"
    || record?.sources?.includes?.("cloud")
    || Boolean(record?.siteId)
    || Boolean(record?.cloud?.siteId);
}

function hasZipSource(record) {
  return record?.source === "zip" || record?.sources?.includes?.("zip");
}

function cloudSiteIds(record, values = new Set()) {
  if (typeof record?.siteId === "string" && record.siteId) values.add(record.siteId);
  if (typeof record?.cloud?.siteId === "string" && record.cloud.siteId) values.add(record.cloud.siteId);
  return values;
}

function ledgerPhotoIds(ledger) {
  const values = new Set(Object.keys(ledger?.captionOverrides || {}));
  for (const page of ledger?.pages || []) {
    for (const slot of page?.slots || []) {
      if (slot?.type === "photo" && typeof slot.photoId === "string") values.add(slot.photoId);
    }
  }
  return values;
}

function referencesAny(value, identifiers, seen = new Set()) {
  if (typeof value === "string") return identifiers.has(value);
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some(item => referencesAny(item, identifiers, seen));
  return Object.values(value).some(item => referencesAny(item, identifiers, seen));
}

function settingPlan(setting, identifiers, project) {
  if (!referencesAny(setting?.value, identifiers)) return null;
  if (setting.key === SYNC_QUEUE_KEY || setting.key === PHOTO_SYNC_QUEUE_KEY) {
    const queue = Array.isArray(setting.value) ? setting.value : [];
    return {
      key: setting.key,
      action: "put",
      value: queue.filter(item => !referencesAny(item, identifiers)),
      matched: queue.filter(item => referencesAny(item, identifiers))
    };
  }
  const projectScoped = setting.key.includes(project.internalId)
    || setting.key.includes(project.projectUid)
    || setting.value?.projectInternalId === project.internalId
    || setting.value?.projectUid === project.projectUid;
  if (projectScoped) return { key: setting.key, action: "delete", matched: [setting.value] };
  if (Array.isArray(setting.value)) {
    return {
      key: setting.key,
      action: "put",
      value: setting.value.filter(item => !referencesAny(item, identifiers)),
      matched: setting.value.filter(item => referencesAny(item, identifiers))
    };
  }
  return { key: setting.key, action: "block", matched: [setting.value] };
}

function deletionVersionToken({ project, photos, files, cloudFiles, ledgers, imports, settingPlans }) {
  const comparableFiles = files.map(file => [
    file.photoInternalId, file.photoUid, file.mimeType, Number(file.blob?.size || 0)
  ]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const comparableCloudFiles = cloudFiles.map(file => [
    file.cacheKey, file.siteId, file.photoUid, file.kind, file.sha256,
    Number(file.bytes || file.blob?.size || 0), Number(file.blob?.size || 0)
  ]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return JSON.stringify({
    project,
    photos: photos.map(photo => structuredClone(photo)).sort((a, b) => String(a.internalId).localeCompare(String(b.internalId))),
    files: comparableFiles,
    cloudFiles: comparableCloudFiles,
    ledgers: ledgers.map(ledger => structuredClone(ledger)).sort((a, b) => String(a.internalId).localeCompare(String(b.internalId))),
    imports: imports.map(record => structuredClone(record)).sort((a, b) => String(a.internalId).localeCompare(String(b.internalId))),
    settings: settingPlans.map(plan => [plan.key, plan.action, plan.matched]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  });
}

function buildLocalProjectDeletionPreview(data, projectInternalId) {
  const project = data.projects.find(item => item.internalId === projectInternalId);
  if (!project) throw new Error("削除対象の工事が見つかりません。");

  const photos = data.photos.filter(photo => photo.projectInternalId === project.internalId
    || (!photo.projectInternalId && photo.projectUid === project.projectUid));
  const photoIds = new Set(photos.map(photo => photo.internalId));
  const photoUids = new Set(photos.map(photo => photo.photoUid));
  const files = data.photoFiles.filter(file => photoIds.has(file.photoInternalId) || photoUids.has(file.photoUid));
  const cachedFiles = data.cloudFiles.filter(file => photoUids.has(file.photoUid));
  const ledgers = data.ledgers.filter(ledger => ledger.projectId === project.internalId);
  const imports = data.imports.filter(record => importProjectUids(record).has(project.projectUid));
  const otherLedgers = data.ledgers.filter(ledger => ledger.projectId !== project.internalId);
  const foreignLedgerReferences = otherLedgers.filter(ledger => [...ledgerPhotoIds(ledger)].some(photoId => photoIds.has(photoId)));
  const integrityErrors = [];

  const conflictingProjects = data.projects.filter(item => item.internalId !== project.internalId && item.projectUid === project.projectUid);
  if (conflictingProjects.length) integrityErrors.push("同じ工事識別情報を持つ別工事があるため、削除を中止しました。");
  const conflictingPhotos = data.photos.filter(photo => photo.projectInternalId && photo.projectInternalId !== project.internalId
    && photo.projectUid === project.projectUid);
  if (conflictingPhotos.length) integrityErrors.push("別工事に属する写真が同じ工事識別情報を参照しています。");
  for (const photo of photos) {
    if (photo.projectUid !== project.projectUid || (photo.projectInternalId && photo.projectInternalId !== project.internalId)) {
      integrityErrors.push("写真と工事の関連が一致しません。");
      break;
    }
  }
  for (const file of files) {
    if (!photoIds.has(file.photoInternalId) || !photoUids.has(file.photoUid)) {
      integrityErrors.push("写真ファイルと写真情報の関連が一致しません。");
      break;
    }
  }
  if (foreignLedgerReferences.length) integrityErrors.push("別工事の台帳が対象写真を参照しています。");

  const cloudBacked = hasCloudSource(project) || photos.some(hasCloudSource) || cachedFiles.length > 0;
  const importBacked = hasZipSource(project) || photos.some(hasZipSource) || imports.some(record => record.status === "success");
  const siteIds = cloudSiteIds(project);
  for (const photo of photos) cloudSiteIds(photo, siteIds);
  for (const file of cachedFiles) if (typeof file.siteId === "string" && file.siteId) siteIds.add(file.siteId);
  const identity = data.settings.find(record => record.key === CLOUD_IDENTITY_KEY)?.value;
  const destinationStatus = !cloudBacked ? "none"
    : siteIds.size === 1 && identity?.siteId === [...siteIds][0] ? "known"
      : "unknown_or_removed";
  const sourceKind = importBacked && cloudBacked ? "mixed"
    : importBacked ? "zip_only"
      : cloudBacked ? (destinationStatus === "known" ? "cloud_only" : "cloud_unknown")
        : "unknown";
  const sourceLabel = {
    zip_only: "ZIP取込みのみ",
    cloud_only: "共有受信のみ",
    mixed: "ZIP・共有混在",
    cloud_unknown: "共有先不明または削除済み",
    unknown: "判定不能"
  }[sourceKind];

  const identifiers = new Set([
    project.internalId, project.projectUid,
    ...photoIds, ...photoUids,
    ...ledgers.map(ledger => ledger.internalId)
  ].filter(value => typeof value === "string" && value));
  const settingPlans = data.settings.map(setting => settingPlan(setting, identifiers, project)).filter(Boolean);
  const photoQueuePlan = settingPlans.find(plan => plan.key === PHOTO_SYNC_QUEUE_KEY);
  const syncQueuePlan = settingPlans.find(plan => plan.key === SYNC_QUEUE_KEY);
  const photoQueueBlockers = (photoQueuePlan?.matched || []).filter(item => item?.status !== SAFE_QUEUE_STATE);
  const syncQueueBlockers = (syncQueuePlan?.matched || []).filter(item => item?.status !== SAFE_QUEUE_STATE);
  const unknownSettingPlans = settingPlans.filter(plan => plan.action === "block");
  const uploadingCount = photoQueueBlockers.filter(item => item?.status === "uploading").length;
  const unsentPhotoCount = photoQueueBlockers.length;
  const pendingCloudChangeCount = syncQueueBlockers.length;

  const metadataBytes = serializedByteLength({ project, photos, ledgers, imports });
  const localImageBytes = files.reduce((sum, file) => sum + Number(file.blob?.size || 0), 0);
  const cloudCacheBytes = cachedFiles.reduce((sum, file) => sum + Number(file.blob?.size || file.bytes || 0), 0);
  const versionToken = deletionVersionToken({
    project, photos, files, cloudFiles: cachedFiles, ledgers, imports, settingPlans
  });
  const reasons = [];
  if (unsentPhotoCount) reasons.push(`未送信または送信処理中の写真が${unsentPhotoCount}件あるため削除できません。`);
  if (pendingCloudChangeCount) reasons.push(`共有先へ未反映の更新が${pendingCloudChangeCount}件あるため削除できません。`);
  if (unknownSettingPlans.length) reasons.push("対象工事を参照する端末設定を安全に分離できません。");
  reasons.push(...integrityErrors);

  return {
    project: structuredClone(project),
    eligible: reasons.length === 0,
    dataKind: sourceKind,
    sourceLabel,
    cloudBacked,
    importBacked,
    destinationStatus,
    cloudSiteCount: siteIds.size,
    reasons,
    photoCount: photos.length,
    ledgerCount: ledgers.length,
    importCount: imports.length,
    localImageBytes,
    cloudCacheBytes,
    estimatedBytes: localImageBytes + cloudCacheBytes + metadataBytes,
    fileCount: files.length,
    cloudFileCount: cachedFiles.length,
    importedAt: project.lastImportedAt || imports.map(record => record.importedAt).sort().at(-1) || null,
    versionToken,
    unsentPhotoCount,
    uploadingCount,
    pendingCloudChangeCount,
    photoInternalIds: [...photoIds],
    photoUids: [...photoUids],
    ledgerIds: ledgers.map(ledger => ledger.internalId),
    importIds: imports.map(record => record.internalId),
    sharedImportCount: imports.filter(record => importProjectUids(record).size > 1).length,
    settingPlans
  };
}

async function readLocalProjectDeletionData(transaction) {
  const requests = Object.fromEntries(LOCAL_PROJECT_DELETE_STORES.map(name => [name, transaction.objectStore(name).getAll()]));
  const values = await Promise.all(LOCAL_PROJECT_DELETE_STORES.map(name => requestResult(requests[name])));
  return Object.fromEntries(LOCAL_PROJECT_DELETE_STORES.map((name, index) => [name, values[index]]));
}

export async function getLocalProjectDeletionPreview(projectInternalId) {
  const db = await openDatabase();
  const tx = db.transaction(LOCAL_PROJECT_DELETE_STORES, "readonly");
  const data = await readLocalProjectDeletionData(tx);
  return buildLocalProjectDeletionPreview(data, projectInternalId);
}

function detachProjectFromImport(record, projectUid) {
  const related = importProjectUids(record);
  if (!related.has(projectUid)) return { action: "keep", record };
  related.delete(projectUid);
  if (related.size === 0) return { action: "delete", record };

  const next = structuredClone(record);
  if (next.projectUid === projectUid) next.projectUid = [...related][0] || null;
  if (Array.isArray(next.projectUids)) next.projectUids = next.projectUids.filter(value => value !== projectUid);
  if (Array.isArray(next.projects)) {
    next.projects = next.projects.filter(project => (typeof project === "string" ? project : project?.projectUid) !== projectUid);
  }
  return { action: "update", record: next };
}

async function verifyDeletedProjectData(db, preview) {
  const tx = db.transaction(LOCAL_PROJECT_DELETE_STORES, "readonly");
  const data = await readLocalProjectDeletionData(tx);
  const identifiers = new Set([
    preview.project.internalId, preview.project.projectUid,
    ...preview.photoInternalIds, ...preview.photoUids, ...preview.ledgerIds
  ]);
  const remains = {
    projects: data.projects.filter(item => item.internalId === preview.project.internalId || item.projectUid === preview.project.projectUid).length,
    photos: data.photos.filter(item => preview.photoInternalIds.includes(item.internalId) || preview.photoUids.includes(item.photoUid)).length,
    photoFiles: data.photoFiles.filter(item => preview.photoInternalIds.includes(item.photoInternalId) || preview.photoUids.includes(item.photoUid)).length,
    cloudFiles: data.cloudFiles.filter(item => preview.photoUids.includes(item.photoUid)).length,
    ledgers: data.ledgers.filter(item => preview.ledgerIds.includes(item.internalId) || item.projectId === preview.project.internalId).length,
    imports: data.imports.filter(item => importProjectUids(item).has(preview.project.projectUid)).length,
    settings: data.settings.filter(item => item.key !== CLOUD_IDENTITY_KEY && referencesAny(item.value, identifiers)).length
  };
  if (Object.values(remains).some(Boolean)) throw new Error("削除後の確認で対象工事の端末データが残っています。");
  return remains;
}

export async function deleteLocalProjectData(projectInternalId, expectedVersionToken) {
  const db = await openDatabase();
  const tx = db.transaction(LOCAL_PROJECT_DELETE_STORES, "readwrite");
  const done = transactionDone(tx);
  try {
    const data = await readLocalProjectDeletionData(tx);
    const preview = buildLocalProjectDeletionPreview(data, projectInternalId);
    if (!preview.eligible) throw new Error(preview.reasons[0] || "この工事は削除できません。");
    if (!expectedVersionToken || preview.versionToken !== expectedVersionToken) {
      throw new Error("確認後に工事データが変更されました。内容を確認し直してください。");
    }

    const photoIds = new Set(preview.photoInternalIds);
    const photoUids = new Set(preview.photoUids);
    const stores = Object.fromEntries(LOCAL_PROJECT_DELETE_STORES.map(name => [name, tx.objectStore(name)]));

    for (const file of data.photoFiles) {
      if (photoIds.has(file.photoInternalId) || photoUids.has(file.photoUid)) stores.photoFiles.delete(file.photoInternalId);
    }
    for (const file of data.cloudFiles) {
      if (photoUids.has(file.photoUid)) stores.cloudFiles.delete(file.cacheKey);
    }
    for (const photo of data.photos) if (photoIds.has(photo.internalId)) stores.photos.delete(photo.internalId);
    for (const ledger of data.ledgers) if (ledger.projectId === preview.project.internalId) stores.ledgers.delete(ledger.internalId);
    for (const record of data.imports) {
      const detached = detachProjectFromImport(record, preview.project.projectUid);
      if (detached.action === "delete") stores.imports.delete(record.internalId);
      if (detached.action === "update") stores.imports.put(detached.record);
    }
    for (const plan of preview.settingPlans) {
      if (plan.action === "delete") stores.settings.delete(plan.key);
      if (plan.action === "put") {
        const original = data.settings.find(setting => setting.key === plan.key);
        stores.settings.put({ ...original, value: structuredClone(plan.value), updatedAt: new Date().toISOString() });
      }
    }
    stores.projects.delete(preview.project.internalId);

    await done;
    const remains = await verifyDeletedProjectData(db, preview);
    return {
      project: preview.project,
      deleted: {
        photos: preview.photoCount,
        files: preview.fileCount,
        cloudFiles: preview.cloudFileCount,
        ledgers: preview.ledgerCount,
        imports: preview.importCount - preview.sharedImportCount
      },
      preservedSharedImports: preview.sharedImportCount,
      photoInternalIds: preview.photoInternalIds,
      ledgerIds: preview.ledgerIds,
      remains
    };
  } catch (error) {
    try { tx.abort(); } catch (_) { /* already completed or aborted */ }
    await done.catch(() => {});
    throw error;
  }
}

// PR #17までの呼出し名を残し、既存ブックマークや検証コードとの互換性を維持する。
export const deleteLocalImportedProject = deleteLocalProjectData;

const cloudCacheKey = (photoUid, kind) => `${photoUid}:${kind}`;

export async function getCloudFile(photoUid, kind) {
  const db = await openDatabase();
  const tx = db.transaction("cloudFiles", "readonly");
  return requestResult(tx.objectStore("cloudFiles").get(cloudCacheKey(photoUid, kind)));
}

export async function saveCloudFile({ siteId, photoUid, kind, blob, sha256, bytes }) {
  if (!(blob instanceof Blob) || !["thumbnail", "original"].includes(kind)) throw new Error("クラウド画像キャッシュが不正です。");
  const db = await openDatabase();
  const tx = db.transaction("cloudFiles", "readwrite");
  const done = transactionDone(tx);
  tx.objectStore("cloudFiles").put({
    cacheKey: cloudCacheKey(photoUid, kind), siteId, photoUid, kind, blob,
    sha256, bytes: Number(bytes || blob.size), cachedAt: new Date().toISOString()
  });
  await done;
}

export async function getCloudCacheSummary(siteId = "") {
  const records = await getAll("cloudFiles");
  const selected = siteId ? records.filter(item => item.siteId === siteId) : records;
  return {
    count: selected.length,
    bytes: selected.reduce((sum, item) => sum + Number(item.bytes || item.blob?.size || 0), 0),
    originals: selected.filter(item => item.kind === "original").length,
    thumbnails: selected.filter(item => item.kind === "thumbnail").length
  };
}

export async function clearCloudCache(siteId) {
  const db = await openDatabase();
  const tx = db.transaction("cloudFiles", "readwrite");
  const done = transactionDone(tx);
  const index = tx.objectStore("cloudFiles").index("siteId");
  const range = IDBKeyRange.only(siteId);
  const request = index.openKeyCursor(range);
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    tx.objectStore("cloudFiles").delete(cursor.primaryKey);
    cursor.continue();
  };
  await done;
}

function normalizeCloudPhoto(row, project, existing, syncedAt) {
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const classification = metadata.classification && typeof metadata.classification === "object" ? metadata.classification : {};
  const boardSnapshot = metadata.boardSnapshot && typeof metadata.boardSnapshot === "object" ? metadata.boardSnapshot : {};
  const ledger = metadata.ledger && typeof metadata.ledger === "object" ? metadata.ledger : {};
  const cloud = {
    siteId: row.siteId, remotePhotoId: row.id, status: "complete",
    lifecycleStatus: row.lifecycleStatus || "active", revision: Number(row.revision || 1),
    trashedAt: row.trashedAt || null,
    originalPath: row.objectPath, thumbnailPath: row.thumbnailPath,
    thumbnailSha256: row.thumbnailSha256, thumbnailBytes: Number(row.thumbnailBytes || 0),
    thumbnailWidth: Number(row.thumbnailWidth || 0), thumbnailHeight: Number(row.thumbnailHeight || 0),
    completedAt: row.completedAt
  };
  if (existing) {
    const sources = new Set(existing.sources || [existing.source || "zip"]);
    sources.add("cloud");
    return { ...existing, sources: [...sources], cloud, cloudSyncedAt: syncedAt };
  }
  return {
    internalId: crypto.randomUUID(), projectInternalId: project.internalId,
    projectUid: project.projectUid, photoUid: row.photoUid, legacyId: metadata.legacyId ?? null,
    capturedAt: row.capturedAt || null, sha256: row.sha256, mimeType: "image/jpeg",
    width: Number(row.width), height: Number(row.height), bytes: Number(row.bytes),
    classification: {
      koushu: String(classification.koushu || ""), shubetsu: String(classification.shubetsu || ""),
      saibetsu: String(classification.saibetsu || ""), sokuten: String(classification.sokuten || ""), tekiyo: String(classification.tekiyo || "")
    },
    boardSnapshot: {
      koujimei: String(boardSnapshot.koujimei || ""), contractor: String(boardSnapshot.contractor || ""),
      koushu: String(boardSnapshot.koushu || ""), shubetsu: String(boardSnapshot.shubetsu || ""),
      saibetsu: String(boardSnapshot.saibetsu || ""), sokuten: String(boardSnapshot.sokuten || ""), tekiyo: String(boardSnapshot.tekiyo || "")
    },
    ledger: { title: String(ledger.title || ""), description: String(ledger.description || ""), manual: ledger.manual === true },
    source: "cloud", sources: ["cloud"], cloud, importedAt: syncedAt, cloudSyncedAt: syncedAt
  };
}

export async function mergeCloudSnapshot(siteId, remoteProjects, remotePhotos) {
  const db = await openDatabase();
  const tx = db.transaction(["projects", "photos"], "readwrite");
  const done = transactionDone(tx);
  const projectStore = tx.objectStore("projects");
  const photoStore = tx.objectStore("photos");
  const syncedAt = new Date().toISOString();
  let added = 0;
  let reused = 0;
  try {
    const projects = new Map();
    const activePhotoUids = new Set(remotePhotos.map(photo => photo.photoUid));
    for (const remote of remoteProjects) {
      let project = await requestResult(projectStore.index("projectUid").get(remote.projectUid));
      if (!project) {
        project = {
          internalId: crypto.randomUUID(), projectUid: remote.projectUid, koujiId: remote.koujiId ?? null,
          name: remote.name, contractor: remote.contractor || "", source: "cloud", sources: ["cloud"],
          siteId, createdAt: syncedAt, lastImportedAt: syncedAt, lastCloudSyncedAt: syncedAt
        };
        projectStore.add(project);
      } else {
        if (project.siteId && project.siteId !== siteId && project.sources?.includes("cloud")) {
          throw new Error(`projectUid ${remote.projectUid} は別の現場に関連付けられています。`);
        }
        const sources = new Set(project.sources || [project.source || "zip"]);
        sources.add("cloud");
        project = { ...project, sources: [...sources], siteId, lastCloudSyncedAt: syncedAt };
        projectStore.put(project);
      }
      projects.set(remote.id, project);
    }
    for (const remote of remotePhotos) {
      const project = projects.get(remote.projectId);
      if (!project) throw new Error(`クラウド写真 ${remote.photoUid} の工事情報がありません。`);
      const existing = await requestResult(photoStore.index("photoUid").get(remote.photoUid));
      if (existing && existing.sha256 !== remote.sha256) throw new Error(`photoUid ${remote.photoUid} のSHA-256が端末内写真と異なります。`);
      if (existing?.cloud?.siteId && existing.cloud.siteId !== siteId) throw new Error(`photoUid ${remote.photoUid} は別の現場に関連付けられています。`);
      const normalized = normalizeCloudPhoto({ ...remote, siteId }, project, existing, syncedAt);
      photoStore.put(normalized);
      existing ? reused += 1 : added += 1;
    }
    const allLocalPhotos = await requestResult(photoStore.getAll());
    for (const photo of allLocalPhotos) {
      if (photo?.cloud?.siteId !== siteId || activePhotoUids.has(photo.photoUid)) continue;
      photoStore.put({
        ...photo,
        cloud: { ...photo.cloud, lifecycleStatus: "trashed" },
        cloudSyncedAt: syncedAt
      });
    }
    await done;
    return { added, reused, projectCount: projects.size, photoCount: remotePhotos.length };
  } catch (error) {
    try { tx.abort(); } catch (_) { /* already completed or aborted */ }
    await done.catch(() => {});
    throw error;
  }
}

export async function mergeCloudTrashSnapshot(siteId, remoteProjects, remotePhotos) {
  const rows = remotePhotos.map(photo => ({ ...photo, lifecycleStatus: "trashed" }));
  const db = await openDatabase();
  const tx = db.transaction(["projects", "photos"], "readwrite");
  const done = transactionDone(tx);
  const projectStore = tx.objectStore("projects");
  const photoStore = tx.objectStore("photos");
  const syncedAt = new Date().toISOString();
  try {
    const projectByRemoteId = new Map();
    for (const remote of remoteProjects) {
      let project = await requestResult(projectStore.index("projectUid").get(remote.projectUid));
      if (!project) {
        project = {
          internalId: crypto.randomUUID(), projectUid: remote.projectUid, koujiId: remote.koujiId ?? null,
          name: remote.name, contractor: remote.contractor || "", source: "cloud", sources: ["cloud"],
          siteId, createdAt: syncedAt, lastImportedAt: syncedAt, lastCloudSyncedAt: syncedAt
        };
        projectStore.add(project);
      }
      projectByRemoteId.set(remote.id, project);
    }
    for (const remote of rows) {
      const project = projectByRemoteId.get(remote.projectId);
      if (!project) continue;
      const existing = await requestResult(photoStore.index("photoUid").get(remote.photoUid));
      if (existing && existing.sha256 !== remote.sha256) {
        throw new Error(`photoUid ${remote.photoUid} のSHA-256が端末内写真と異なります。`);
      }
      photoStore.put(normalizeCloudPhoto({ ...remote, siteId }, project, existing, syncedAt));
    }
    await done;
    return { trashedCount: rows.length };
  } catch (error) {
    try { tx.abort(); } catch (_) { /* already completed or aborted */ }
    await done.catch(() => {});
    throw error;
  }
}

function comparablePhoto(photo) {
  return {
    capturedAt: photo.capturedAt || "",
    legacyId: photo.legacyId ?? null,
    classification: photo.classification,
    boardSnapshot: photo.boardSnapshot,
    ledger: photo.ledger
  };
}

export async function analyzeImportConflicts(validated) {
  const conflicts = [];
  const fatal = [];
  const existingProject = await getProjectByUid(validated.project.projectUid);
  if (existingProject && (existingProject.name !== validated.project.name || existingProject.contractor !== validated.project.contractor)) {
    conflicts.push({ type: "project", id: validated.project.projectUid, fields: ["工事名または施工者"] });
  }
  for (const photo of validated.photos) {
    const existing = await getPhotoByUid(photo.photoUid);
    if (!existing) continue;
    if (existing.sha256 !== photo.sha256) {
      fatal.push(`photoUid ${photo.photoUid} は既存写真とSHA-256が異なります。`);
      continue;
    }
    if (JSON.stringify(comparablePhoto(existing)) !== JSON.stringify(comparablePhoto(photo))) {
      const fields = [];
      if (JSON.stringify(existing.classification) !== JSON.stringify(photo.classification)) fields.push("分類");
      if (JSON.stringify(existing.boardSnapshot) !== JSON.stringify(photo.boardSnapshot)) fields.push("boardSnapshot");
      if (JSON.stringify(existing.ledger) !== JSON.stringify(photo.ledger)) fields.push("ledger");
      if ((existing.capturedAt || "") !== (photo.capturedAt || "")) fields.push("撮影日時");
      conflicts.push({ type: "photo", id: photo.photoUid, fields });
    }
  }
  return { conflicts, fatal };
}

export async function saveValidatedImport(validated, mode = "preserve") {
  const db = await openDatabase();
  const tx = db.transaction(["imports", "projects", "photos", "photoFiles"], "readwrite");
  const done = transactionDone(tx);
  const importStore = tx.objectStore("imports");
  const projectStore = tx.objectStore("projects");
  const photoStore = tx.objectStore("photos");
  const fileStore = tx.objectStore("photoFiles");
  const importedAt = new Date().toISOString();
  let added = 0;
  let reused = 0;
  let updated = 0;

  try {
    const duplicate = await requestResult(importStore.index("exportId").get(validated.exportId));
    if (duplicate) throw new Error("このexportIdは既に取り込み済みです。");

    let project = await requestResult(projectStore.index("projectUid").get(validated.project.projectUid));
    if (!project) {
      project = {
        internalId: crypto.randomUUID(),
        projectUid: validated.project.projectUid,
        koujiId: validated.project.koujiId ?? null,
        name: validated.project.name,
        contractor: validated.project.contractor,
        source: "zip",
        sources: ["zip"],
        createdAt: importedAt,
        lastImportedAt: importedAt
      };
      projectStore.add(project);
    } else {
      const sources = new Set(project.sources || [project.source || "zip"]);
      sources.add("zip");
      project.sources = [...sources];
      project.source ||= "zip";
      project.lastImportedAt = importedAt;
      if (mode === "update") {
        project.name = validated.project.name;
        project.contractor = validated.project.contractor;
        project.koujiId = validated.project.koujiId ?? project.koujiId;
      }
      projectStore.put(project);
    }

    for (const incoming of validated.photos) {
      const existing = await requestResult(photoStore.index("photoUid").get(incoming.photoUid));
      if (existing) {
        if (existing.sha256 !== incoming.sha256) throw new Error(`photoUid ${incoming.photoUid} のSHA-256が既存写真と異なります。`);
        const sources = new Set(existing.sources || [existing.source || "zip"]);
        sources.add("zip");
        if (mode === "update") {
          const { blob: _blob, ...metadata } = incoming;
          photoStore.put({ ...existing, ...metadata, source: existing.source || "zip", sources: [...sources], internalId: existing.internalId, projectInternalId: project.internalId, updatedAt: importedAt });
          updated += 1;
        } else {
          if (!existing.sources?.includes?.("zip")) photoStore.put({ ...existing, source: existing.source || "zip", sources: [...sources], updatedAt: importedAt });
          reused += 1;
        }
        continue;
      }
      const internalId = crypto.randomUUID();
      const { blob, ...metadata } = incoming;
      photoStore.add({ ...metadata, internalId, projectInternalId: project.internalId, source: "zip", sources: ["zip"], importedAt });
      fileStore.add({ photoInternalId: internalId, photoUid: incoming.photoUid, blob, mimeType: "image/jpeg" });
      added += 1;
    }

    importStore.add({
      internalId: crypto.randomUUID(),
      exportId: validated.exportId,
      projectUid: validated.project.projectUid,
      projectName: validated.project.name,
      importedAt,
      exportedAt: validated.exportedAt || null,
      photoCount: validated.photos.length,
      status: "success",
      warnings: validated.warnings || [],
      added,
      reused,
      updated,
      manifestVersion: 1
    });
    await done;
    return { project, added, reused, updated };
  } catch (error) {
    try { tx.abort(); } catch (_) { /* already completed or aborted */ }
    await done.catch(() => {});
    throw error;
  }
}

export async function recordFailedImport({ observedExportId = null, projectName = "", errors = [] } = {}) {
  const db = await openDatabase();
  const tx = db.transaction("imports", "readwrite");
  tx.objectStore("imports").add({
    internalId: crypto.randomUUID(),
    exportId: null,
    observedExportId,
    projectUid: null,
    projectName,
    importedAt: new Date().toISOString(),
    photoCount: 0,
    status: "failure",
    warnings: errors.slice(0, 20)
  });
  await transactionDone(tx);
}

export const databaseInfo = Object.freeze({
  name: DB_NAME,
  version: DB_VERSION,
  stores: ["imports", "projects", "photos", "photoFiles", "cloudFiles", "ledgers", "settings"]
});
