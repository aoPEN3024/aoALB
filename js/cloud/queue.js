import { getSetting, setSetting } from "../storage.js";

const QUEUE_KEY = "cloud:syncQueue";
const IDENTITY_KEY = "cloud:identity";
const PHOTO_QUEUE_KEY = "cloud:photoSyncQueue";
const PHOTO_SETTINGS_KEY = "cloud:photoSyncSettings";

export const DEFAULT_PHOTO_SYNC_SETTINGS = Object.freeze({ mode: "wifi_only", anyNetworkConfirmed: false });
export const PHOTO_SYNC_MODES = Object.freeze(["wifi_only", "any_network", "manual"]);
export const PHOTO_QUEUE_STATES = Object.freeze(["pending", "uploading", "synced", "error", "paused"]);

export const getCloudIdentity = async () => (await getSetting(IDENTITY_KEY)) || null;
export const saveCloudIdentity = identity => setSetting(IDENTITY_KEY, identity);

export async function getSyncQueue() {
  const queue = await getSetting(QUEUE_KEY);
  return Array.isArray(queue) ? queue : [];
}

export async function enqueueSyncEvent(event) {
  const queue = await getSyncQueue();
  if (!queue.some(item => item.eventId === event.eventId)) {
    queue.push({ ...structuredClone(event), status: "pending", attempts: 0, lastError: "", queuedAt: new Date().toISOString() });
    await setSetting(QUEUE_KEY, queue);
  }
  return queue;
}

export async function updateQueueItem(eventId, patch) {
  const queue = await getSyncQueue();
  const index = queue.findIndex(item => item.eventId === eventId);
  if (index < 0) return queue;
  queue[index] = { ...queue[index], ...structuredClone(patch), updatedAt: new Date().toISOString() };
  await setSetting(QUEUE_KEY, queue);
  return queue;
}

export async function pendingSyncEvents() {
  return (await getSyncQueue()).filter(item => item.status === "pending" || item.status === "uploading" || item.status === "error");
}

export async function getPhotoSyncSettings() {
  const value = await getSetting(PHOTO_SETTINGS_KEY);
  const mode = PHOTO_SYNC_MODES.includes(value?.mode) ? value.mode : DEFAULT_PHOTO_SYNC_SETTINGS.mode;
  return { mode, anyNetworkConfirmed: value?.anyNetworkConfirmed === true };
}

export async function savePhotoSyncSettings(settings) {
  const mode = PHOTO_SYNC_MODES.includes(settings?.mode) ? settings.mode : DEFAULT_PHOTO_SYNC_SETTINGS.mode;
  return setSetting(PHOTO_SETTINGS_KEY, { mode, anyNetworkConfirmed: settings?.anyNetworkConfirmed === true });
}

export async function getPhotoSyncQueue() {
  const queue = await getSetting(PHOTO_QUEUE_KEY);
  return Array.isArray(queue) ? queue.filter(item => PHOTO_QUEUE_STATES.includes(item?.status)) : [];
}

async function savePhotoSyncQueue(queue) {
  await setSetting(PHOTO_QUEUE_KEY, queue);
  return queue;
}

export async function enqueuePhotosForSync(records) {
  const queue = await getPhotoSyncQueue();
  const now = new Date().toISOString();
  for (const record of records) {
    const samePhoto = queue.find(item => item.siteId === record.siteId && item.photoUid === record.photoUid);
    if (samePhoto) {
      if (samePhoto.sha256 !== record.sha256) throw new Error(`photoUid ${record.photoUid} のSHA-256が同期キューと異なります。`);
      continue;
    }
    queue.push({
      queueId: crypto.randomUUID(), eventId: crypto.randomUUID(), status: "pending", attempts: 0,
      lastError: "", errorType: "", queuedAt: now, updatedAt: now, ...structuredClone(record)
    });
  }
  return savePhotoSyncQueue(queue);
}

export async function updatePhotoQueueItem(queueId, patch) {
  const queue = await getPhotoSyncQueue();
  const index = queue.findIndex(item => item.queueId === queueId);
  if (index < 0) return queue;
  queue[index] = { ...queue[index], ...structuredClone(patch), updatedAt: new Date().toISOString() };
  return savePhotoSyncQueue(queue);
}

export async function recoverInterruptedPhotoUploads() {
  const queue = await getPhotoSyncQueue();
  let changed = false;
  for (const item of queue) {
    if (item.status !== "uploading") continue;
    item.status = "pending";
    item.lastError = "前回中断されたため再開待ちへ戻しました。";
    item.errorType = "interrupted";
    item.updatedAt = new Date().toISOString();
    changed = true;
  }
  return changed ? savePhotoSyncQueue(queue) : queue;
}

export async function setPhotoQueuePaused(siteId, paused) {
  const queue = await getPhotoSyncQueue();
  let changed = false;
  for (const item of queue) {
    if (item.siteId !== siteId) continue;
    let itemChanged = false;
    if (paused && item.status === "pending") { item.status = "paused"; itemChanged = true; }
    if (!paused && item.status === "paused") { item.status = "pending"; itemChanged = true; }
    if (itemChanged) { item.updatedAt = new Date().toISOString(); changed = true; }
  }
  return changed ? savePhotoSyncQueue(queue) : queue;
}

export async function retryPhotoQueueErrors(siteId) {
  const queue = await getPhotoSyncQueue();
  let changed = false;
  for (const item of queue) {
    if (item.siteId !== siteId || item.status !== "error") continue;
    item.status = "pending";
    item.lastError = "";
    item.errorType = "";
    item.updatedAt = new Date().toISOString();
    changed = true;
  }
  return changed ? savePhotoSyncQueue(queue) : queue;
}

export function summarizePhotoQueue(queue, siteId) {
  const summary = { pending: 0, uploading: 0, synced: 0, error: 0, paused: 0, pendingBytes: 0, readyBytes: 0, total: 0, lastSyncedAt: "" };
  for (const item of queue) {
    if (siteId && item.siteId !== siteId) continue;
    summary.total += 1;
    if (Object.hasOwn(summary, item.status)) summary[item.status] += 1;
    if (["pending", "error", "paused"].includes(item.status)) summary.pendingBytes += Number(item.bytes) || 0;
    if (item.status === "pending") summary.readyBytes += Number(item.bytes) || 0;
    if (item.syncedAt && item.syncedAt > summary.lastSyncedAt) summary.lastSyncedAt = item.syncedAt;
  }
  return summary;
}
