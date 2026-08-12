import {
  completeClassificationChange, completeCloudLedgerChange, getCloudChanges, getCloudConflicts, getLedgers,
  getPhotosByProjectUid, getProjects, recordCloudConflict, resolveClassificationConflict, resolveLedgerConflict, saveLedger,
  saveLedgerWithCloudChange, mergeCloudClassificationOverrides, updateCloudChange
} from "../storage.js";

let provider = null;
let identity = null;
let flushing = null;
const online = () => globalThis.navigator?.onLine !== false;
const isConflict = error => error?.code === "40001" || /revision_conflict/i.test(String(error?.message || ""));

export function configureCloudLedgerSync(nextProvider, nextIdentity) {
  provider = nextProvider || null;
  identity = nextIdentity?.siteId ? { ...nextIdentity } : null;
  if (provider && identity && online()) flushCloudChanges().catch(() => {});
}

export function disconnectCloudLedgerSync() { provider = null; identity = null; }

async function createLedgerChange(ledger, project, photos) {
  const remoteByLocal = new Map(photos.filter(p => p.cloud?.remotePhotoId).map(p => [p.internalId, p.cloud.remotePhotoId]));
  const pages = ledger.pages.map(page => ({ slots: page.slots.map(slot => {
    if (slot.type !== "photo") return { type: "blank" };
    const photoId = remoteByLocal.get(slot.photoId);
    if (!photoId) throw new Error("クラウドへ未保存の写真が台帳にあります。写真の同期後に再試行してください。");
    return { type: "photo", photoId };
  }) }));
  const captions = Object.entries(ledger.captionOverrides || {}).map(([localPhotoId, captionOverride]) => {
    const photoId = remoteByLocal.get(localPhotoId);
    if (!photoId) throw new Error("台帳文言の写真がクラウドへ保存されていません。");
    return { photoId, captionOverride };
  });
  return {
    changeId: crypto.randomUUID(), entityKey: `ledger:${ledger.ledgerId}`,
    entityType: "ledger", siteId: project.siteId, localLedgerId: ledger.internalId,
    payload: {
      siteId: project.siteId, remoteProjectId: project.cloud.remoteProjectId,
      remoteLedgerId: ledger.cloud?.remoteLedgerId || null, ledgerUid: ledger.ledgerId,
      expectedRevision: Number(ledger.cloud?.revision || 0), title: ledger.title,
      template: ledger.template, showCover: ledger.showCover, viewMode: ledger.viewMode || "single",
      pages, captions, eventId: crypto.randomUUID()
    }
  };
}

export async function saveLedgerForProject(ledger, project, photos) {
  if (!project?.siteId || !project?.cloud?.remoteProjectId) return saveLedger(ledger);
  if (!identity || identity.siteId !== project.siteId || !["admin", "editor"].includes(identity.role)) {
    throw new Error("この共有工事の台帳を編集する権限がありません。");
  }
  const change = await createLedgerChange(ledger, project, photos);
  const local = { ...ledger, cloud: { ...(ledger.cloud || {}), siteId: project.siteId }, syncStatus: "pending" };
  await saveLedgerWithCloudChange(local, change);
  globalThis.dispatchEvent?.(new CustomEvent("aoalb:ledger-sync-status", { detail: { pending: true } }));
  if (!online()) return local;
  await flushCloudChanges();
  return (await getLedgers()).find(row => row.internalId === local.internalId) || local;
}

async function sendChange(change) {
  await updateCloudChange(change.changeId, { status: "uploading", attempts: Number(change.attempts || 0) + 1 });
  if (change.entityType === "classification") {
    const result = await provider.saveClassificationOverride({
      remotePhotoId: change.remotePhotoId, expectedRevision: change.expectedRevision,
      overrideData: change.payload, eventId: change.eventId
    });
    await completeClassificationChange(change.changeId, change.localPhotoId, result);
    return;
  }
  const result = await provider.saveLedgerSnapshot(change.payload);
  const ledger = (await getLedgers()).find(row => row.internalId === change.localLedgerId);
  if (!ledger) throw new Error("保存対象の台帳がこの端末にありません。");
  await completeCloudLedgerChange(change.changeId, {
    ...ledger, syncStatus: "synced", cloud: {
      ...(ledger.cloud || {}), siteId: change.siteId, remoteLedgerId: result.ledger_id,
      revision: Number(result.revision), updatedAt: result.updated_at
    }
  });
}

export async function flushCloudChanges() {
  if (!provider || !identity?.siteId || !online()) return { skipped: true };
  if (flushing) return flushing;
  const siteId = identity.siteId;
  flushing = (async () => {
    const changes = (await getCloudChanges(siteId)).filter(row => row.status !== "synced");
    let synced = 0, conflicts = 0, errors = 0;
    for (const change of changes) {
      if (identity?.siteId !== siteId) break;
      try { await sendChange(change); synced += 1; }
      catch (error) {
        if (isConflict(error)) {
          const localLedger = change.entityType === "ledger"
            ? (await getLedgers()).find(row => row.internalId === change.localLedgerId) : change.payload;
          await recordCloudConflict({ entityKey: change.entityKey, entityType: change.entityType, siteId,
            localValue: localLedger, cloudValue: null,
            localPhotoId: change.localPhotoId, remotePhotoId: change.remotePhotoId,
            message: "別の端末で先に更新されています。" }, change.changeId);
          conflicts += 1;
        } else {
          await updateCloudChange(change.changeId, { status: "error", error: String(error?.message || error) });
          errors += 1;
        }
      }
    }
    const result = { synced, conflicts, errors };
    globalThis.dispatchEvent?.(new CustomEvent("aoalb:ledger-sync-status", { detail: result }));
    return result;
  })().finally(() => { flushing = null; });
  return flushing;
}

export async function syncCloudLedgers() {
  if (!provider || !identity?.siteId || !online()) return { skipped: true };
  const siteId = identity.siteId;
  const [snapshots, overrides, projects, ledgers, changes, existingConflicts] = await Promise.all([
    provider.listLedgerSnapshots(siteId), provider.listClassificationOverrides(siteId),
    getProjects(), getLedgers(), getCloudChanges(siteId), getCloudConflicts(siteId)
  ]);
  const pending = new Set(changes.map(row => row.entityKey));
  const pendingClassification = new Set(changes.filter(row => row.entityType === "classification").map(row => row.remotePhotoId));
  const conflictByKey = new Map(existingConflicts.filter(row => !row.resolved).map(row => [row.entityKey, row]));
  const conflictClassification = new Set(existingConflicts
    .filter(row => !row.resolved && row.entityType === "classification" && row.remotePhotoId)
    .map(row => row.remotePhotoId));
  const projectByRemote = new Map(projects.filter(p => p.cloud?.remoteProjectId).map(p => [p.cloud.remoteProjectId, p]));
  const photoMaps = new Map();
  for (const project of projects) photoMaps.set(project.internalId, await getPhotosByProjectUid(project.projectUid));
  let merged = 0, conflicts = 0;
  for (const snapshot of snapshots) {
    const project = projectByRemote.get(snapshot.projectId);
    if (!project) continue;
    const entityKey = `ledger:${snapshot.ledgerUid}`;
    const local = ledgers.find(row => row.ledgerId === snapshot.ledgerUid);
    const photos = photoMaps.get(project.internalId) || [];
    const localByRemote = new Map(photos.filter(p => p.cloud?.remotePhotoId).map(p => [p.cloud.remotePhotoId, p.internalId]));
    const cloudLedger = {
      ...(local || {}), internalId: local?.internalId || crypto.randomUUID(), ledgerId: snapshot.ledgerUid,
      schemaVersion: 2, projectId: project.internalId, title: snapshot.title,
      template: snapshot.template, showCover: snapshot.showCover, viewMode: snapshot.viewMode,
      pages: snapshot.pages.map(page => ({ slots: page.slots.map(slot => slot.type === "photo"
        ? { type: "photo", photoId: localByRemote.get(slot.photoId) || "" } : { type: "blank" }) })),
      captionOverrides: Object.fromEntries(snapshot.captions
        .map(item => [localByRemote.get(item.photoId), item.captionOverride]).filter(([id]) => id)),
      cloud: { siteId, remoteLedgerId: snapshot.id, revision: Number(snapshot.revision), updatedAt: snapshot.updatedAt },
      syncStatus: "synced", createdAt: local?.createdAt || snapshot.updatedAt, updatedAt: snapshot.updatedAt
    };
    const existingConflict = conflictByKey.get(entityKey);
    if (pending.has(entityKey) || existingConflict) {
      const change = changes.find(row => row.entityKey === entityKey);
      await recordCloudConflict({ entityKey, entityType: "ledger", siteId,
        localValue: existingConflict?.localValue || local, cloudValue: cloudLedger,
        message: "この端末の未送信変更とクラウド版が競合しています。" }, change?.changeId || "");
      conflicts += 1;
    } else { await saveLedger(cloudLedger); merged += 1; }
  }
  const allPhotos = [...photoMaps.values()].flat();
  for (const row of overrides.filter(item => pendingClassification.has(item.photo_id) || conflictClassification.has(item.photo_id))) {
    const change = changes.find(item => item.remotePhotoId === row.photo_id);
    const entityKey = change?.entityKey || `classification:${row.photo_id}`;
    const existingConflict = conflictByKey.get(entityKey);
    const photo = allPhotos.find(item => item.cloud?.remotePhotoId === row.photo_id);
    await recordCloudConflict({ entityKey, entityType: "classification", siteId,
      localValue: existingConflict?.localValue || change?.payload || photo?.classificationOverride || {},
      cloudValue: row.override_data, localPhotoId: existingConflict?.localPhotoId || change?.localPhotoId || photo?.internalId,
      remotePhotoId: row.photo_id, cloudRevision: Number(row.revision || 0), cloudUpdatedAt: row.updated_at,
      message: "この端末の分類変更とクラウド版が競合しています。" }, change?.changeId || "");
    conflicts += 1;
  }
  const blockedClassification = new Set([...pendingClassification, ...conflictClassification]);
  const overrideCount = await mergeCloudClassificationOverrides(overrides, blockedClassification);
  globalThis.dispatchEvent?.(new CustomEvent("aoalb:ledger-cloud-updated", {
    detail: { merged, conflicts, overrideCount }
  }));
  return { merged, conflicts, overrideCount };
}

export async function cloudLedgerSyncStatus() {
  return {
    changes: await getCloudChanges(identity?.siteId || ""),
    conflicts: await getCloudConflicts(identity?.siteId || "")
  };
}

export function initCloudLedgerSyncUI() {
  const message = document.getElementById("ledger-sync-message");
  const list = document.getElementById("ledger-conflict-list");
  if (!message || !list) return { render: async () => {} };
  async function render() {
    const { changes, conflicts } = await cloudLedgerSyncStatus();
    message.textContent = conflicts.length
      ? `競合が${conflicts.length}件あります。内容を選んで解決してください。`
      : changes.length ? `未送信の台帳・分類変更が${changes.length}件あります。オンライン時に再送します。`
        : "台帳と分類の変更は最新です。";
    list.replaceChildren(...conflicts.map(conflict => {
      const item = document.createElement("li");
      const text = document.createElement("span");
      text.textContent = conflict.message || "別端末の変更と競合しています。";
      item.append(text);
      if (conflict.entityType === "ledger") {
        const cloud = document.createElement("button"); cloud.type = "button"; cloud.className = "secondary";
        cloud.textContent = "クラウド版を使う"; cloud.disabled = !conflict.cloudValue;
        cloud.addEventListener("click", async () => { await resolveLedgerConflict(conflict.conflictId, "cloud"); await render(); });
        const copy = document.createElement("button"); copy.type = "button"; copy.className = "secondary";
        copy.textContent = "自分の変更を複製して残す";
        copy.addEventListener("click", async () => { await resolveLedgerConflict(conflict.conflictId, "copy"); await render(); });
        item.append(cloud, copy);
      } else if (conflict.entityType === "classification") {
        const cloud = document.createElement("button"); cloud.type = "button"; cloud.className = "secondary";
        cloud.textContent = "クラウド版を使う"; cloud.disabled = !conflict.cloudValue;
        cloud.addEventListener("click", async () => { await resolveClassificationConflict(conflict.conflictId, "cloud"); await render(); });
        const retry = document.createElement("button"); retry.type = "button"; retry.className = "secondary";
        retry.textContent = "この端末の変更を再送"; retry.disabled = !conflict.cloudValue;
        retry.addEventListener("click", async () => { await resolveClassificationConflict(conflict.conflictId, "retry"); await render(); });
        item.append(cloud, retry);
      }
      return item;
    }));
  }
  globalThis.addEventListener?.("aoalb:ledger-sync-status", render);
  globalThis.addEventListener?.("aoalb:ledger-cloud-updated", render);
  return { render };
}

globalThis.addEventListener?.("online", () => flushCloudChanges().catch(() => {}));
globalThis.addEventListener?.("aoalb:cloud-change-pending", () => flushCloudChanges().catch(() => {}));
