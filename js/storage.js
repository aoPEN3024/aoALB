const DB_NAME = "aoALBDB";
const DB_VERSION = 1;

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
    request.onupgradeneeded = () => {
      const db = request.result;
      const imports = db.createObjectStore("imports", { keyPath: "internalId" });
      imports.createIndex("exportId", "exportId", { unique: true });
      imports.createIndex("importedAt", "importedAt");
      imports.createIndex("projectUid", "projectUid");

      const projects = db.createObjectStore("projects", { keyPath: "internalId" });
      projects.createIndex("projectUid", "projectUid", { unique: true });
      projects.createIndex("lastImportedAt", "lastImportedAt");

      const photos = db.createObjectStore("photos", { keyPath: "internalId" });
      photos.createIndex("photoUid", "photoUid", { unique: true });
      photos.createIndex("projectUid", "projectUid");
      photos.createIndex("capturedAt", "capturedAt");

      const photoFiles = db.createObjectStore("photoFiles", { keyPath: "photoInternalId" });
      photoFiles.createIndex("photoUid", "photoUid", { unique: true });

      db.createObjectStore("ledgers", { keyPath: "internalId" });
      db.createObjectStore("settings", { keyPath: "key" });
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

export const getImportByExportId = exportId => getByIndex("imports", "exportId", exportId);
export const getProjectByUid = projectUid => getByIndex("projects", "projectUid", projectUid);
export const getPhotoByUid = photoUid => getByIndex("photos", "photoUid", photoUid);
export const getProjects = () => getAll("projects");
export const getImports = () => getAll("imports");

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
  stores: ["imports", "projects", "photos", "photoFiles", "ledgers", "settings"]
});
