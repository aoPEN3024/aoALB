import { loadCloudConfig, loadLocalCloudConfig, saveCloudConfig } from "./cloud/config.js";
import { MockSiteProvider } from "./cloud/mock-provider.js";
import { detectNetworkStatus, formatTransferBytes, networkLabel, NETWORK_STATUS, shouldAutoSync } from "./cloud/network.js";
import { classifyPhotoSyncError, createPhotoPackage } from "./cloud/photo-sync.js";
import { createSupabaseProvider } from "./cloud/supabase-provider.js";
import {
  enqueuePhotosForSync, enqueueSyncEvent, getCloudIdentity, getPhotoSyncQueue, getPhotoSyncSettings,
  pendingSyncEvents, recoverInterruptedPhotoUploads, retryPhotoQueueErrors, saveCloudIdentity,
  savePhotoSyncSettings, setPhotoQueuePaused, summarizePhotoQueue, updatePhotoQueueItem, updateQueueItem
} from "./cloud/queue.js";
import { getPhotoByUid, getPhotoFile, getPhotosByProjectUid, getProjectByUid, getProjects } from "./storage.js";

const MODE_KEY = "aoALB:sharingMode";
const shortId = value => value ? `${String(value).slice(0, 8)}…` : "未登録";
const formatDate = value => value ? new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "―";

export function initSiteSharing() {
  const byId = id => document.getElementById(id);
  const ui = {
    mode: byId("sharing-mode-status"), local: byId("sharing-local-mode"), mock: byId("sharing-mock-mode"),
    configForm: byId("sharing-config-form"), projectUrl: byId("sharing-project-url"), publishableKey: byId("sharing-publishable-key"),
    joinForm: byId("sharing-join-form"), siteCode: byId("sharing-site-code"), joinCode: byId("sharing-join-code"),
    deviceName: byId("sharing-device-name"), deviceId: byId("sharing-device-id"), currentSite: byId("sharing-current-site"),
    currentRole: byId("sharing-current-role"), pending: byId("sharing-pending-count"), send: byId("sharing-send-test"),
    retry: byId("sharing-retry"), message: byId("sharing-message"), events: byId("sharing-events"),
    photoPanel: byId("photo-sync-panel"), photoProject: byId("photo-sync-project"), photoEnqueue: byId("photo-sync-enqueue"),
    photoMode: byId("photo-sync-mode"), photoNetwork: byId("photo-sync-network"), photoPending: byId("photo-sync-pending-count"),
    photoBytes: byId("photo-sync-pending-bytes"), photoUploading: byId("photo-sync-uploading-count"),
    photoSynced: byId("photo-sync-synced-count"), photoError: byId("photo-sync-error-count"),
    photoLast: byId("photo-sync-last-time"), photoProgress: byId("photo-sync-progress"),
    photoProgressText: byId("photo-sync-progress-text"), photoNow: byId("photo-sync-now"),
    photoPause: byId("photo-sync-pause"), photoResume: byId("photo-sync-resume"),
    photoRetry: byId("photo-sync-retry"), photoNote: byId("photo-sync-note")
  };
  let active = false;
  let provider = null;
  let unsubscribe = null;
  let identity = null;
  let received = [];
  let testBusy = false;
  let photoBusy = false;
  let siteSwitching = false;

  function sharingMode() {
    const mode = localStorage.getItem(MODE_KEY);
    return mode === "mock" || mode === "cloud" ? mode : "local";
  }

  function setMessage(message, error = false) {
    ui.message.textContent = message;
    ui.message.classList.toggle("error", error);
  }

  function setPhotoMessage(message, error = false) {
    ui.photoNote.textContent = message;
    ui.photoNote.classList.toggle("error", error);
  }

  function renderEvents() {
    ui.events.replaceChildren(...received.slice(-20).reverse().map(event => {
      const item = document.createElement("li");
      const time = new Date(event.createdAt).toLocaleString("ja-JP");
      item.textContent = `${time} / ${event.deviceName || "端末名なし"} / ${event.payload?.note || event.eventType || "接続試験"}`;
      return item;
    }));
  }

  async function populatePhotoProjects() {
    const projects = (await getProjects()).sort((a, b) => String(a.name).localeCompare(String(b.name), "ja"));
    const current = ui.photoProject.value;
    ui.photoProject.replaceChildren(...projects.map(project => new Option(project.name, project.projectUid)));
    if (projects.some(project => project.projectUid === current)) ui.photoProject.value = current;
    ui.photoEnqueue.disabled = !identity?.siteId || projects.length === 0 || photoBusy;
  }

  async function renderPhotoStatus() {
    const joined = Boolean(provider && identity?.siteId);
    ui.photoPanel.hidden = !joined;
    if (!joined) return;
    const [settings, queue] = await Promise.all([getPhotoSyncSettings(), getPhotoSyncQueue()]);
    const summary = summarizePhotoQueue(queue, identity.siteId);
    const network = detectNetworkStatus();
    ui.photoMode.value = settings.mode;
    ui.photoNetwork.textContent = networkLabel(network);
    ui.photoPending.textContent = `${summary.pending + summary.paused + summary.error}件`;
    ui.photoBytes.textContent = formatTransferBytes(summary.pendingBytes);
    ui.photoUploading.textContent = `${summary.uploading}件`;
    ui.photoSynced.textContent = `${summary.synced}件`;
    ui.photoError.textContent = `${summary.error}件`;
    ui.photoLast.textContent = formatDate(summary.lastSyncedAt);
    ui.photoProgress.max = Math.max(1, summary.total);
    ui.photoProgress.value = Math.min(summary.total, summary.synced + summary.error);
    ui.photoProgressText.textContent = summary.total
      ? `${summary.synced + summary.error}/${summary.total}件を処理済み（未送信容量は推定${formatTransferBytes(summary.pendingBytes)}）`
      : "同期対象はありません。";
    const hasReady = summary.pending > 0;
    ui.photoNow.disabled = photoBusy || !hasReady || network === NETWORK_STATUS.OFFLINE || siteSwitching;
    ui.photoPause.disabled = summary.pending === 0;
    ui.photoResume.disabled = summary.paused === 0;
    ui.photoRetry.disabled = photoBusy || summary.error === 0;
    ui.photoMode.disabled = photoBusy || siteSwitching;
    await populatePhotoProjects();
  }

  async function renderStatus() {
    const pending = await pendingSyncEvents();
    const mode = sharingMode();
    ui.mode.textContent = mode === "mock" ? "端末内試作" : mode === "cloud" ? "現場共有" : "ローカルのみ";
    ui.deviceId.textContent = shortId(identity?.deviceId || identity?.userId);
    ui.currentSite.textContent = identity?.siteName || identity?.siteCode || "未参加";
    ui.currentRole.textContent = identity?.role || "―";
    ui.pending.textContent = `${pending.length}件`;
    const joined = Boolean(provider && identity?.siteId);
    ui.send.disabled = !joined || testBusy;
    ui.retry.disabled = !joined || !pending.length || testBusy;
    await renderPhotoStatus();
  }

  function receiveEvent(event) {
    if (!received.some(item => item.eventId === event.eventId)) received.push(event);
    renderEvents();
    if (active) setMessage("所属現場のメタデータ更新を受信しました。");
  }

  function subscribeCurrentSite() {
    unsubscribe?.();
    unsubscribe = identity?.siteId && provider ? provider.subscribe(identity.siteId, receiveEvent) : null;
  }

  async function connect(mode = sharingMode()) {
    unsubscribe?.();
    unsubscribe = null;
    provider?.unsubscribe?.();
    provider = null;
    if (mode === "local") {
      localStorage.setItem(MODE_KEY, "local");
      setMessage("クラウドへ接続せず、従来どおり端末内データだけを使用します。");
      await renderStatus();
      return;
    }
    try {
      if (mode === "mock") {
        const previous = identity?.provider === mode ? identity : null;
        const deviceId = previous?.deviceId || crypto.randomUUID();
        identity = { ...(previous || {}), deviceId, provider: "mock" };
        provider = new MockSiteProvider(deviceId);
      } else {
        if (identity?.provider !== mode) identity = null;
        const config = loadCloudConfig();
        if (!config) throw new Error("SupabaseのProject URLと公開用publishable keyを先に設定してください。");
        provider = await createSupabaseProvider(config);
      }
      const auth = await provider.authenticate();
      identity = { ...(identity || {}), userId: auth.userId, deviceId: identity?.deviceId || auth.userId, provider: mode };
      await saveCloudIdentity(identity);
      localStorage.setItem(MODE_KEY, mode);
      subscribeCurrentSite();
      setMessage(identity?.siteId ? `${identity.siteName || identity.siteCode}へ再接続しました。` : mode === "mock"
        ? "端末内試作を開始しました。参加コードはDEMO-ONLYです。"
        : "匿名端末認証が完了しました。現場IDと参加コードを入力してください。");
    } catch (error) {
      localStorage.setItem(MODE_KEY, "local");
      setMessage(error?.message || "共有接続を開始できませんでした。", true);
    }
    await renderStatus();
  }

  async function flushQueue() {
    if (!provider || !identity?.siteId || testBusy) return;
    testBusy = true;
    await renderStatus();
    const mode = sharingMode();
    const items = (await pendingSyncEvents()).filter(item => item.siteId === identity.siteId && (!item.providerMode || item.providerMode === mode));
    for (const item of items) {
      try {
        await updateQueueItem(item.eventId, { status: "uploading", attempts: Number(item.attempts || 0) + 1, lastError: "" });
        await provider.pushTestMetadata(item);
        await updateQueueItem(item.eventId, { status: "synced", syncedAt: new Date().toISOString(), lastError: "" });
      } catch (error) {
        await updateQueueItem(item.eventId, { status: "error", lastError: error?.message || "送信に失敗しました。" });
      }
    }
    testBusy = false;
    const remaining = await pendingSyncEvents();
    setMessage(remaining.length ? `${remaining.length}件が未送信です。通信を確認して再送してください。` : "同期キューの送信が完了しました。", remaining.length > 0);
    await renderStatus();
  }

  async function enqueueSelectedProject() {
    if (!identity?.siteId || !ui.photoProject.value) return;
    const project = await getProjectByUid(ui.photoProject.value);
    const photos = await getPhotosByProjectUid(ui.photoProject.value);
    await enqueuePhotosForSync(photos.map(photo => ({
      siteId: identity.siteId, projectUid: project.projectUid, photoUid: photo.photoUid,
      photoInternalId: photo.internalId, sha256: photo.sha256, bytes: photo.bytes
    })));
    setPhotoMessage(`${project.name}の写真${photos.length}件を確認し、未登録分を同期対象へ追加しました。`);
    await renderPhotoStatus();
    await startAutomaticPhotoSync();
  }

  async function syncPhotos({ manual = false } = {}) {
    if (!active || !provider || !identity?.siteId || photoBusy || siteSwitching) return;
    const network = detectNetworkStatus();
    if (network === NETWORK_STATUS.OFFLINE) {
      setPhotoMessage("オフラインのため送信を開始できません。", true);
      return renderPhotoStatus();
    }
    const settings = await getPhotoSyncSettings();
    if (!manual && !shouldAutoSync(settings, network)) return renderPhotoStatus();
    const queueBefore = await getPhotoSyncQueue();
    const summary = summarizePhotoQueue(queueBefore, identity.siteId);
    if (manual && [NETWORK_STATUS.MOBILE, NETWORK_STATUS.UNKNOWN].includes(network)) {
      const label = network === NETWORK_STATUS.MOBILE ? "モバイル通信" : "回線種別を確認できない通信";
      const allowed = window.confirm(`${summary.pending}枚、約${formatTransferBytes(summary.readyBytes)}を${label}で送信します。よろしいですか？\nこの許可は今回の同期だけに適用されます。`);
      if (!allowed) return setPhotoMessage("今回の手動同期を中止しました。");
    }
    photoBusy = true;
    setPhotoMessage("写真を1枚ずつ同期しています。画面を閉じないでください。");
    await renderPhotoStatus();
    const runSiteId = identity.siteId;
    try {
      while (active && identity?.siteId === runSiteId && !siteSwitching) {
        const currentNetwork = detectNetworkStatus();
        const currentSettings = await getPhotoSyncSettings();
        if (currentNetwork === NETWORK_STATUS.OFFLINE || (!manual && !shouldAutoSync(currentSettings, currentNetwork))) break;
        const queue = await getPhotoSyncQueue();
        const item = queue.find(entry => entry.siteId === runSiteId && entry.status === "pending");
        if (!item) break;
        await updatePhotoQueueItem(item.queueId, { status: "uploading", attempts: Number(item.attempts || 0) + 1, lastError: "", errorType: "" });
        await renderPhotoStatus();
        try {
          const [photo, project, file] = await Promise.all([
            getPhotoByUid(item.photoUid), getProjectByUid(item.projectUid), getPhotoFile(item.photoInternalId)
          ]);
          if (!photo || !project || !file?.blob) throw new Error("端末内の写真または工事情報を読み込めません。");
          const photoPackage = await createPhotoPackage({
            photo, project, file, siteId: runSiteId, eventId: item.eventId,
            deviceName: identity.deviceName || "名称未設定端末"
          });
          await provider.uploadPhotoPackage(photoPackage);
          await updatePhotoQueueItem(item.queueId, { status: "synced", syncedAt: new Date().toISOString(), lastError: "", errorType: "" });
        } catch (error) {
          const classified = classifyPhotoSyncError(error);
          await updatePhotoQueueItem(item.queueId, { status: "error", lastError: classified.message, errorType: classified.type });
          if (["auth", "permission", "quota", "integrity", "network"].includes(classified.type)) break;
        }
        await renderPhotoStatus();
      }
    } finally {
      photoBusy = false;
    }
    const after = summarizePhotoQueue(await getPhotoSyncQueue(), runSiteId);
    if (after.error) setPhotoMessage(`${after.error}件でエラーが発生しました。内容を確認して再送してください。`, true);
    else if (after.pending || after.paused) setPhotoMessage("未送信写真を残して安全に停止しました。条件が整うと再開できます。");
    else setPhotoMessage("写真同期が完了しました。端末内の元写真は保持されています。");
    await renderPhotoStatus();
  }

  async function startAutomaticPhotoSync() {
    const settings = await getPhotoSyncSettings();
    if (shouldAutoSync(settings, detectNetworkStatus())) await syncPhotos({ manual: false });
    else await renderPhotoStatus();
  }

  async function handleNetworkChange() {
    if (!active) return;
    await renderPhotoStatus();
    await startAutomaticPhotoSync();
  }

  ui.local.addEventListener("click", () => connect("local"));
  ui.mock.addEventListener("click", () => connect("mock"));
  ui.configForm.addEventListener("submit", async event => {
    event.preventDefault();
    try {
      const existing = loadCloudConfig();
      saveCloudConfig({ projectUrl: ui.projectUrl.value, publishableKey: ui.publishableKey.value || existing?.publishableKey });
      ui.publishableKey.value = "";
      await connect("cloud");
    } catch (error) {
      ui.publishableKey.value = "";
      setMessage(error?.message || "接続設定を保存できませんでした。", true);
    }
  });
  ui.joinForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (!provider) return setMessage("先に端末内試作またはSupabase接続を開始してください。", true);
    siteSwitching = true;
    try {
      const membership = await provider.joinSite({ siteCode: ui.siteCode.value, joinCode: ui.joinCode.value, deviceName: ui.deviceName.value.trim() || "名称未設定端末" });
      ui.joinCode.value = "";
      identity = { ...identity, ...membership };
      await saveCloudIdentity(identity);
      subscribeCurrentSite();
      setMessage(`${membership.siteName}へ${membership.role}として参加しました。`);
    } catch (error) {
      ui.joinCode.value = "";
      setMessage(error?.message || "現場へ参加できませんでした。", true);
    } finally {
      siteSwitching = false;
    }
    await renderStatus();
    await startAutomaticPhotoSync();
  });
  ui.send.addEventListener("click", async () => {
    const event = {
      eventId: crypto.randomUUID(), siteId: identity.siteId, entityId: crypto.randomUUID(), deviceName: identity.deviceName || "名称未設定端末",
      providerMode: sharingMode(), createdAt: new Date().toISOString(), payload: { source: "aoALB", test: true, note: "テスト用メタデータ1件" }
    };
    await enqueueSyncEvent(event);
    await flushQueue();
  });
  ui.retry.addEventListener("click", flushQueue);
  ui.photoEnqueue.addEventListener("click", () => enqueueSelectedProject().catch(error => setPhotoMessage(error?.message || "同期対象へ追加できませんでした。", true)));
  ui.photoMode.addEventListener("change", async () => {
    const current = await getPhotoSyncSettings();
    const requested = ui.photoMode.value;
    if (requested === "any_network" && !current.anyNetworkConfirmed) {
      const allowed = window.confirm("モバイル通信を含むすべての回線で写真を自動送信すると、通信量が増える場合があります。この端末で有効にしますか？");
      if (!allowed) { ui.photoMode.value = current.mode; return; }
      current.anyNetworkConfirmed = true;
    }
    current.mode = requested;
    await savePhotoSyncSettings(current);
    setPhotoMessage("この端末の同期設定を保存しました。");
    await startAutomaticPhotoSync();
  });
  ui.photoNow.addEventListener("click", () => syncPhotos({ manual: true }));
  ui.photoPause.addEventListener("click", async () => { await setPhotoQueuePaused(identity.siteId, true); setPhotoMessage("未開始の写真を一時停止しました。"); await renderPhotoStatus(); });
  ui.photoResume.addEventListener("click", async () => { await setPhotoQueuePaused(identity.siteId, false); setPhotoMessage("同期キューを再開しました。"); await startAutomaticPhotoSync(); });
  ui.photoRetry.addEventListener("click", async () => { await retryPhotoQueueErrors(identity.siteId); await syncPhotos({ manual: true }); });
  window.addEventListener("online", handleNetworkChange);
  window.addEventListener("offline", handleNetworkChange);
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  connection?.addEventListener?.("change", handleNetworkChange);

  async function activate() {
    active = true;
    identity = await getCloudIdentity();
    await recoverInterruptedPhotoUploads();
    try {
      await loadLocalCloudConfig();
    } catch (error) {
      localStorage.setItem(MODE_KEY, "local");
      setMessage(error?.message || "ローカル接続設定を読み込めませんでした。", true);
      await renderStatus();
      return;
    }
    const config = loadCloudConfig();
    ui.projectUrl.value = config?.projectUrl || "";
    ui.publishableKey.value = "";
    await connect(sharingMode());
    if (provider && identity?.siteId) {
      await flushQueue();
      await startAutomaticPhotoSync();
    }
    await renderStatus();
  }

  function deactivate() {
    active = false;
    unsubscribe?.();
    unsubscribe = null;
  }

  return { activate, deactivate };
}
