import { getSetting, setSetting } from "../storage.js";

const QUEUE_KEY = "cloud:syncQueue";
const IDENTITY_KEY = "cloud:identity";

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
