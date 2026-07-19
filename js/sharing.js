import { loadCloudConfig, saveCloudConfig } from "./cloud/config.js";
import { MockSiteProvider } from "./cloud/mock-provider.js";
import { createSupabaseProvider } from "./cloud/supabase-provider.js";
import {
  enqueueSyncEvent, getCloudIdentity, getSyncQueue, pendingSyncEvents,
  saveCloudIdentity, updateQueueItem
} from "./cloud/queue.js";

const MODE_KEY = "aoALB:sharingMode";
const shortId = value => value ? `${String(value).slice(0, 8)}…` : "未登録";

export function initSiteSharing() {
  const byId = id => document.getElementById(id);
  const ui = {
    mode: byId("sharing-mode-status"), local: byId("sharing-local-mode"), mock: byId("sharing-mock-mode"),
    configForm: byId("sharing-config-form"), projectUrl: byId("sharing-project-url"), publishableKey: byId("sharing-publishable-key"),
    joinForm: byId("sharing-join-form"), siteCode: byId("sharing-site-code"), joinCode: byId("sharing-join-code"),
    deviceName: byId("sharing-device-name"), deviceId: byId("sharing-device-id"), currentSite: byId("sharing-current-site"),
    currentRole: byId("sharing-current-role"), pending: byId("sharing-pending-count"), send: byId("sharing-send-test"),
    retry: byId("sharing-retry"), message: byId("sharing-message"), events: byId("sharing-events")
  };
  let active = false;
  let provider = null;
  let unsubscribe = null;
  let identity = null;
  let received = [];
  let busy = false;

  function sharingMode() {
    const mode = localStorage.getItem(MODE_KEY);
    return mode === "mock" || mode === "cloud" ? mode : "local";
  }

  function setMessage(message, error = false) {
    ui.message.textContent = message;
    ui.message.classList.toggle("error", error);
  }

  function renderEvents() {
    ui.events.replaceChildren(...received.slice(-20).reverse().map(event => {
      const item = document.createElement("li");
      const time = new Date(event.createdAt).toLocaleString("ja-JP");
      item.textContent = `${time} / ${event.deviceName || "端末名なし"} / ${event.payload?.note || "接続試験"}`;
      return item;
    }));
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
    ui.send.disabled = !joined || busy;
    ui.retry.disabled = !joined || !pending.length || busy;
  }

  function receiveEvent(event) {
    if (!received.some(item => item.eventId === event.eventId)) received.push(event);
    renderEvents();
    if (active) setMessage("別端末相当からメタデータ更新を受信しました。");
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
      setMessage(mode === "mock" ? "端末内試作を開始しました。参加コードはDEMO-ONLYです。" : "匿名端末認証が完了しました。現場IDと参加コードを入力してください。");
    } catch (error) {
      localStorage.setItem(MODE_KEY, "local");
      setMessage(error?.message || "共有接続を開始できませんでした。", true);
    }
    await renderStatus();
  }

  async function flushQueue() {
    if (!provider || !identity?.siteId || busy) return;
    busy = true;
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
    busy = false;
    const remaining = await pendingSyncEvents();
    setMessage(remaining.length ? `${remaining.length}件が未送信です。通信を確認して再送してください。` : "同期キューの送信が完了しました。", remaining.length > 0);
    await renderStatus();
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
    try {
      const membership = await provider.joinSite({ siteCode: ui.siteCode.value, joinCode: ui.joinCode.value, deviceName: ui.deviceName.value.trim() || "名称未設定端末" });
      ui.joinCode.value = "";
      identity = { ...identity, ...membership };
      await saveCloudIdentity(identity);
      subscribeCurrentSite();
      setMessage(`${membership.siteName}へ${membership.role}として参加しました。`);
      await renderStatus();
    } catch (error) {
      ui.joinCode.value = "";
      setMessage(error?.message || "現場へ参加できませんでした。", true);
    }
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
  window.addEventListener("online", () => { if (active) flushQueue(); });

  async function activate() {
    active = true;
    identity = await getCloudIdentity();
    const config = loadCloudConfig();
    ui.projectUrl.value = config?.projectUrl || "";
    ui.publishableKey.value = "";
    await connect(sharingMode());
    if (provider && identity?.siteId) await flushQueue();
    await renderStatus();
  }

  function deactivate() {
    active = false;
    unsubscribe?.();
    unsubscribe = null;
  }

  return { activate, deactivate };
}
