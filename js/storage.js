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
  return requestResult(tx.objectStore("photos").index("projectUid").getAll(projectUid));
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
    await done;
    return { added, reused, projectCount: projects.size, photoCount: remotePhotos.length };
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
        createdAt: importedAt,
        lastImportedAt: importedAt
      };
      projectStore.add(project);
    } else {
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
        if (mode === "update") {
          const { blob: _blob, ...metadata } = incoming;
          photoStore.put({ ...existing, ...metadata, internalId: existing.internalId, projectInternalId: project.internalId, updatedAt: importedAt });
          updated += 1;
        } else {
          reused += 1;
        }
        continue;
      }
      const internalId = crypto.randomUUID();
      const { blob, ...metadata } = incoming;
      photoStore.add({ ...metadata, internalId, projectInternalId: project.internalId, importedAt });
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
