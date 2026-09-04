import { loadCloudConfig, loadLocalCloudConfig, saveCloudConfig } from "./cloud/config.js";
import { MockSiteProvider } from "./cloud/mock-provider.js";
import { detectNetworkStatus, formatTransferBytes, networkLabel, NETWORK_STATUS, shouldAutoSync } from "./cloud/network.js";
import { classifyPhotoSyncError, createPhotoPackage } from "./cloud/photo-sync.js";
import { createSupabaseProvider } from "./cloud/supabase-provider.js?v=20260904-auth-callback3";
import {
  cacheAllOriginals, clearCurrentSiteCloudCache, cloudDownloadSummary,
  configureCloudReceiver, disconnectCloudReceiver, syncCloudPhotos
} from "./cloud/receiver.js";
import {
  configureCloudLedgerSync, disconnectCloudLedgerSync, flushCloudChanges, syncCloudLedgers
} from "./cloud/ledger-sync.js?v=20260805-ledger1";
import {
  enqueuePhotosForSync, enqueueSyncEvent, getCloudIdentity, getPhotoSyncQueue, getPhotoSyncSettings,
  pendingSyncEvents, recoverInterruptedPhotoUploads, retryPhotoQueueErrors, saveCloudIdentity,
  savePhotoSyncSettings, setPhotoQueuePaused, summarizePhotoQueue, updatePhotoQueueItem, updateQueueItem
} from "./cloud/queue.js";
import { getPhotoByUid, getPhotoFile, getPhotosByProjectUid, getProjectByUid, getProjects } from "./storage.js";

const MODE_KEY = "aoALB:sharingMode";
const AUTH_STORAGE_KEY = "aoALB:supabase-auth";
const CLOUD_ORIGINAL_MODE_KEY = "aoALB:cloudOriginalMode";
const shortId = value => value ? `${String(value).slice(0, 8)}…` : "未登録";
const formatDate = value => value ? new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "―";
const roleLabel = value => ({ admin: "管理者", editor: "メンバー", viewer: "閲覧のみ" })[value] || "―";
function validateAdminCode(value, confirmation) {
  const code = String(value || "");
  if (code !== String(confirmation || "")) throw new Error("管理者PASSと確認入力が一致しません。");
  const categories = [
    /[a-z]/.test(code), /[A-Z]/.test(code), /[0-9]/.test(code), /[^A-Za-z0-9]/.test(code)
  ].filter(Boolean).length;
  if (code.length < 8 || code.length > 64 || new TextEncoder().encode(code).length > 72
      || /[\s\u0000-\u001f\u007f]/.test(code) || categories < 2
      || /^(password|admin|administrator|qwerty|letmein|aopen|aoalb|aopic|12345678|87654321)$/i.test(code)
      || /^(.)\1{7,}$/.test(code)) {
    throw new Error("管理者PASSは空白を含まない8～64文字で、英字・数字・記号のうち2種類以上を使用してください。");
  }
  return code;
}

export function initSiteSharing() {
  const byId = id => document.getElementById(id);
  const ui = {
    mode: byId("sharing-mode-status"), local: byId("sharing-local-mode"), mock: byId("sharing-mock-mode"),
    configForm: byId("sharing-config-form"), projectUrl: byId("sharing-project-url"), publishableKey: byId("sharing-publishable-key"),
    joinForm: byId("sharing-join-form"), siteCode: byId("sharing-site-code"), joinCode: byId("sharing-join-code"),
    adminClaimForm: byId("sharing-admin-claim-form"), adminClaimSiteCode: byId("sharing-admin-claim-site-code"),
    adminClaimCode: byId("sharing-admin-claim-code"), adminClaimDevice: byId("sharing-admin-claim-device"),
    adminClaimMessage: byId("sharing-admin-claim-message"),
    operationMenu: byId("sharing-operation-menu"), createPanel: byId("sharing-create-panel"),
    joinPanel: byId("sharing-join-panel"), adminClaimPanel: byId("sharing-admin-claim-panel"),
    createForm: byId("sharing-create-form"), createName: byId("sharing-create-name"),
    createCode: byId("sharing-create-code"), createJoinCode: byId("sharing-create-join-code"),
    createAdminCode: byId("sharing-create-admin-code"), createAdminConfirm: byId("sharing-create-admin-confirm"),
    createDevice: byId("sharing-create-device"),
    sitesPanel: byId("sharing-site-list-panel"), sites: byId("sharing-site-list"),
    sitesEmpty: byId("sharing-site-list-empty"), nonAdminNote: byId("sharing-non-admin-note"),
    openAdminClaim: byId("sharing-open-admin-claim"), adminCodeUnavailable: byId("sharing-admin-code-unavailable"),
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
    photoRetry: byId("photo-sync-retry"), photoNote: byId("photo-sync-note"),
    receivePanel: byId("cloud-receive-panel"), receiveMode: byId("cloud-original-mode"),
    receiveRefresh: byId("cloud-refresh"), receiveCache: byId("cloud-cache-originals"),
    receiveClear: byId("cloud-clear-cache"), receiveMessage: byId("cloud-receive-message"),
    receivePhotoCount: byId("cloud-photo-count"), receiveUncachedCount: byId("cloud-uncached-count"),
    receiveUncachedBytes: byId("cloud-uncached-bytes"), receiveThumbnailBytes: byId("cloud-thumbnail-bytes"),
    receiveCacheBytes: byId("cloud-cache-bytes"), receiveCacheOriginals: byId("cloud-cache-original-count"),
    adminPanel: byId("sharing-admin-panel"), adminName: byId("sharing-admin-name"),
    adminCode: byId("sharing-admin-code"), adminSave: byId("sharing-admin-save"),
    adminJoinCode: byId("sharing-admin-join-code"), adminJoinConfirm: byId("sharing-admin-join-code-confirm"),
    adminRotate: byId("sharing-admin-rotate"), adminClose: byId("sharing-admin-close"),
    adminReopen: byId("sharing-admin-reopen"), adminTrash: byId("sharing-admin-trash"),
    adminRestore: byId("sharing-admin-restore"), adminDeleteEmpty: byId("sharing-admin-delete-empty"),
    deleteEmptyBox: byId("sharing-delete-empty-box"), adminAccessCode: byId("sharing-admin-access-code"),
    adminAccessConfirm: byId("sharing-admin-access-confirm"), adminAccessSave: byId("sharing-admin-access-save"),
    adminAccessStatus: byId("sharing-admin-code-status"), memberList: byId("sharing-member-list")
  };
  let active = false;
  let provider = null;
  let unsubscribe = null;
  let identity = null;
  let received = [];
  let testBusy = false;
  let photoBusy = false;
  let siteSwitching = false;
  let receiveBusy = false;
  let receiveQueued = false;
  let memberships = [];
  let siteStatusFilter = "active";
  let accountActive = false;
  let selectedOperation = "sites";
  const sharingSecrets = [
    ui.publishableKey, ui.joinCode, ui.adminClaimCode, ui.adminJoinCode,
    ui.adminJoinConfirm, ui.adminAccessCode, ui.adminAccessConfirm,
    ui.createJoinCode, ui.createAdminCode, ui.createAdminConfirm
  ].filter(Boolean);
  const clearSharingSecrets = (...inputs) => inputs.flat().filter(Boolean).forEach(input => { input.value = ""; });

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

  function hasStoredAuthSession() {
    try {
      const stored = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) || "null");
      return Boolean(stored?.access_token && stored?.refresh_token);
    } catch (_) {
      return false;
    }
  }

  function setAdminClaimMessage(message, error = false) {
    ui.adminClaimMessage.textContent = message;
    ui.adminClaimMessage.classList.toggle("error", error);
  }

  async function ensureMembershipAuth() {
    if (!accountActive) throw new Error("有効なアカウントでログインしてください。");
    const auth = await provider.authenticate({ allowAnonymous: false });
    if (identity?.userId && identity.userId !== auth.userId) identity = null;
    identity = {
      ...(identity || {}),
      userId: auth.userId,
      deviceId: identity?.deviceId || auth.userId,
      provider: sharingMode()
    };
  }

  function setReceiveMessage(message, error = false) {
    ui.receiveMessage.textContent = message;
    ui.receiveMessage.classList.toggle("error", error);
  }

  async function renderReceiveStatus() {
    const joined = Boolean(provider && identity?.siteId && sharingMode() === "cloud");
    ui.receivePanel.hidden = !joined;
    if (!joined) return;
    const summary = await cloudDownloadSummary(identity.siteId);
    ui.receiveMode.value = localStorage.getItem(CLOUD_ORIGINAL_MODE_KEY) === "wifi_only" ? "wifi_only" : "thumbnail_only";
    ui.receivePhotoCount.textContent = `${summary.photoCount}件`;
    ui.receiveUncachedCount.textContent = `${summary.uncachedOriginals}件`;
    ui.receiveUncachedBytes.textContent = formatTransferBytes(summary.uncachedOriginalBytes);
    ui.receiveThumbnailBytes.textContent = formatTransferBytes(summary.thumbnailBytes);
    ui.receiveCacheBytes.textContent = formatTransferBytes(summary.cache.bytes);
    ui.receiveCacheOriginals.textContent = `${summary.cache.originals}件`;
    ui.receiveRefresh.disabled = receiveBusy;
    ui.receiveCache.disabled = receiveBusy || summary.uncachedOriginals === 0;
    ui.receiveClear.disabled = receiveBusy || summary.cache.count === 0;
  }

  async function maybeAutoCacheOriginals() {
    if (localStorage.getItem(CLOUD_ORIGINAL_MODE_KEY) !== "wifi_only") return;
    const network = detectNetworkStatus();
    if (network !== NETWORK_STATUS.WIFI) return;
    await cacheOriginals(false);
  }

  async function refreshCloudPhotos({ quiet = false } = {}) {
    if (!provider || !identity?.siteId || sharingMode() !== "cloud") return;
    if (receiveBusy) { receiveQueued = true; return; }
    receiveBusy = true;
    if (!quiet) setReceiveMessage("所属現場の完成写真を確認しています。");
    await renderReceiveStatus();
    try {
      const result = await syncCloudPhotos();
      if (!result.skipped) setReceiveMessage(`完成写真${result.photoCount}件を確認しました（新規${result.added}件）。`);
      else if (!quiet) setReceiveMessage(result.reason === "offline" ? "オフラインのため、この端末に保存済みの写真を表示します。" : "共有写真の確認を開始できませんでした。", result.reason !== "offline");
    } catch (error) {
      setReceiveMessage(error?.message || "共有写真を確認できませんでした。", true);
    } finally {
      receiveBusy = false;
      await renderReceiveStatus();
    }
    await maybeAutoCacheOriginals();
    if (receiveQueued) {
      receiveQueued = false;
      await refreshCloudPhotos({ quiet: true });
    }
  }

  async function cacheOriginals(requireConfirmation = true) {
    if (receiveBusy) return;
    const summary = await cloudDownloadSummary(identity?.siteId);
    if (!summary.uncachedOriginals) return setReceiveMessage("未取得の写真はありません。");
    const network = detectNetworkStatus();
    if (network === NETWORK_STATUS.OFFLINE) return setReceiveMessage("オフラインのため写真本体を取得できません。", true);
    if (requireConfirmation || [NETWORK_STATUS.MOBILE, NETWORK_STATUS.UNKNOWN].includes(network)) {
      const label = network === NETWORK_STATUS.MOBILE ? "モバイル通信" : network === NETWORK_STATUS.UNKNOWN ? "回線種別不明" : networkLabel(network);
      if (!window.confirm(`${summary.uncachedOriginals}枚、約${formatTransferBytes(summary.uncachedOriginalBytes)}の写真本体を${label}で取得します。よろしいですか？\n表示量は推定で、実際の通信量は少し増える場合があります。`)) return;
    }
    receiveBusy = true;
    try {
      await cacheAllOriginals(progress => setReceiveMessage(`写真本体を取得中 ${progress.completed}/${progress.total}件`));
      setReceiveMessage("写真本体をこの端末へ保存しました。共有先の写真は変更していません。");
    } catch (error) {
      setReceiveMessage(error?.message || "写真本体の取得を完了できませんでした。", true);
    } finally {
      receiveBusy = false;
      await renderReceiveStatus();
    }
    if (receiveQueued) {
      receiveQueued = false;
      await refreshCloudPhotos({ quiet: true });
    }
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
      : "送信待ちの写真はありません。";
    const hasReady = summary.pending > 0;
    const writable = !["closed", "trashed"].includes(identity?.siteStatus);
    ui.photoNow.disabled = photoBusy || !hasReady || !writable || network === NETWORK_STATUS.OFFLINE || siteSwitching;
    ui.photoPause.disabled = summary.pending === 0;
    ui.photoResume.disabled = summary.paused === 0;
    ui.photoRetry.disabled = photoBusy || summary.error === 0;
    ui.photoRetry.hidden = summary.error === 0;
    ui.photoMode.disabled = photoBusy || !writable || siteSwitching;
    await populatePhotoProjects();
  }

  async function renderStatus() {
    const pending = await pendingSyncEvents();
    const mode = sharingMode();
    ui.mode.textContent = mode === "mock" ? "この端末だけ（確認用）" : mode === "cloud" ? "現場で共有" : "この端末だけ";
    ui.deviceId.textContent = shortId(identity?.deviceId || identity?.userId);
    ui.currentSite.textContent = identity?.siteName || identity?.siteCode || "未参加";
    ui.currentRole.textContent = roleLabel(identity?.role);
    ui.pending.textContent = `${pending.length}件`;
    const joined = Boolean(provider && identity?.siteId);
    ui.send.disabled = !joined || testBusy;
    ui.retry.disabled = !joined || !pending.length || testBusy;
    const admin = joined && identity?.role === "admin";
    ui.adminPanel.hidden = !admin;
    ui.nonAdminNote.hidden = !joined || admin;
    ui.adminCodeUnavailable.hidden = !joined || Boolean(identity?.adminCodeConfigured);
    ui.openAdminClaim.hidden = !identity?.adminCodeConfigured;
    const accountCloudReady = accountActive && Boolean(provider) && mode === "cloud";
    ui.operationMenu.hidden = !accountCloudReady;
    ui.createPanel.hidden = !accountCloudReady || selectedOperation !== "create";
    ui.joinPanel.hidden = !accountCloudReady || selectedOperation !== "join";
    ui.adminClaimPanel.hidden = !accountCloudReady || selectedOperation !== "admin";
    ui.sitesPanel.hidden = !accountCloudReady || selectedOperation !== "sites";
    renderSiteList();
    if (admin) {
      if (document.activeElement !== ui.adminName) ui.adminName.value = identity.siteName || "";
      if (document.activeElement !== ui.adminCode) ui.adminCode.value = identity.siteCode || "";
      ui.adminClose.hidden = identity.siteStatus === "closed";
      ui.adminReopen.hidden = identity.siteStatus !== "closed";
      ui.adminTrash.hidden = identity.siteStatus === "trashed";
      ui.adminRestore.hidden = identity.siteStatus !== "trashed";
      ui.deleteEmptyBox.hidden = identity.siteStatus !== "trashed";
      ui.adminAccessStatus.textContent = identity.adminCodeConfigured
        ? "別端末から管理者として入れる設定済みです。変更すると旧コードは直ちに使えなくなります。"
        : "別端末から管理するため、管理者PASSを設定してください。";
      ui.adminAccessSave.textContent = identity.adminCodeConfigured
        ? "管理者PASSを変更" : "管理者PASSを設定";
      await renderMemberList();
    }
    await Promise.all([renderPhotoStatus(), renderReceiveStatus()]);
  }

  function statusLabel(value) {
    return ({ active: "利用中", closed: "終了済み", trashed: "ごみ箱" })[value] || value;
  }

  function renderSiteList() {
    if (!ui.sites) return;
    const rows = memberships.filter(item => item.siteStatus === siteStatusFilter);
    ui.sites.replaceChildren(...rows.map(item => {
      const card = document.createElement("article");
      card.className = "sharing-site-item";
      if (item.siteId === identity?.siteId) card.classList.add("selected");
      const title = document.createElement("h3");
      title.textContent = item.siteName;
      const meta = document.createElement("p");
      meta.textContent = `${item.siteCode} / ${roleLabel(item.role)} / ${statusLabel(item.siteStatus)} / 最終更新 ${formatDate(item.updatedAt)}`;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary";
      button.textContent = item.siteId === identity?.siteId ? "この工事を表示中" : "この工事を開く";
      button.disabled = item.siteId === identity?.siteId;
      button.addEventListener("click", () => switchSite(item));
      card.append(title, meta, button);
      return card;
    }));
    ui.sitesEmpty.hidden = rows.length > 0;
    document.querySelectorAll("[data-site-status]").forEach(button => {
      button.classList.toggle("active", button.dataset.siteStatus === siteStatusFilter);
    });
  }

  async function refreshMemberships() {
    memberships = provider?.listMySites ? await provider.listMySites() : [];
    if (identity?.siteId) {
      const current = memberships.find(item => item.siteId === identity.siteId);
      if (current) identity = { ...identity, ...current };
    }
  }

  async function switchSite(item) {
    if (siteSwitching || !item?.siteId) return;
    siteSwitching = true;
    try {
      unsubscribe?.();
      disconnectCloudReceiver();
      disconnectCloudLedgerSync();
      identity = { ...identity, ...item };
      await saveCloudIdentity(identity);
      subscribeCurrentSite();
      if (sharingMode() === "cloud") {
        configureCloudReceiver(provider, identity);
        configureCloudLedgerSync(provider, identity);
      }
      setMessage(`${item.siteName}を開きました。`);
      await renderStatus();
      if (sharingMode() === "cloud") await refreshCloudPhotos();
    } catch (error) {
      setMessage(error?.message || "工事を切り替えられませんでした。", true);
    } finally {
      siteSwitching = false;
    }
  }

  async function renderMemberList() {
    if (!provider?.siteRpc || identity?.role !== "admin") return;
    try {
      const rows = await provider.siteRpc("list_site_members_admin", { p_site_id: identity.siteId });
      const members = Array.isArray(rows) ? rows : rows ? [rows] : [];
      ui.memberList.replaceChildren(...members.map(member => {
        const row = document.createElement("div");
        row.className = "sharing-member-item";
        const text = document.createElement("span");
        text.textContent = `${member.device_name} / ${roleLabel(member.member_role)} / ${formatDate(member.last_seen_at)} / ${member.active ? "有効" : "停止中"}${member.is_current_device ? "（この端末）" : ""}`;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "secondary";
        button.textContent = member.active ? "停止" : "再開";
        button.addEventListener("click", () => toggleMember(member));
        row.append(text, button);
        return row;
      }));
    } catch (error) {
      ui.memberList.replaceChildren();
      const note = document.createElement("p");
      note.className = "limit-note";
      note.textContent = "端末一覧を確認できませんでした。";
      ui.memberList.append(note);
    }
  }

  async function toggleMember(member) {
    const nextActive = !member.active;
    if (member.is_current_device && !nextActive
        && !window.confirm("この端末を停止すると、この工事を操作できなくなります。別の有効な管理者端末があることを確認しましたか？")) return;
    if (!member.is_current_device
        && !window.confirm(`${member.device_name}を${nextActive ? "再開" : "停止"}しますか？`)) return;
    await runAdminAction(nextActive ? "端末を再開" : "端末を停止", async () => {
      await provider.siteRpc("set_site_member_active_v2", {
        p_site_id: identity.siteId, p_member_id: member.member_id,
        p_active: nextActive, p_expected_revision: identity.siteRevision
      });
      if (member.is_current_device && !nextActive) {
        unsubscribe?.();
        unsubscribe = null;
        disconnectCloudReceiver();
        disconnectCloudLedgerSync();
        identity = { userId: identity.userId, deviceId: identity.deviceId, provider: identity.provider };
        await refreshMemberships();
        await saveCloudIdentity(identity);
        return { skipRefresh: true };
      }
      return null;
    });
  }

  function receiveEvent(event) {
    if (!received.some(item => item.eventId === event.eventId)) received.push(event);
    renderEvents();
    if (active) setMessage("所属現場のメタデータ更新を受信しました。");
    if (event.payload?.photoUid || event.eventType === "photo_synced") refreshCloudPhotos({ quiet: true });
    if (/ledger|classification_override/.test(String(event.eventType || event.entityType || ""))) syncCloudLedgers().catch(() => {});
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
    disconnectCloudReceiver();
    disconnectCloudLedgerSync();
    if (mode === "local") {
      localStorage.setItem(MODE_KEY, "local");
      setMessage("この端末に保存されたデータだけを使用します。");
      disconnectCloudReceiver();
      disconnectCloudLedgerSync();
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
        if (!config) throw new Error("工事共有の接続設定を確認できません。管理者へ連絡してください。");
        provider = await createSupabaseProvider(config);
      }
      const auth = await provider.authenticate();
      if (identity?.userId && identity.userId !== auth.userId) identity = null;
      identity = { ...(identity || {}), userId: auth.userId, deviceId: identity?.deviceId || auth.userId, provider: mode };
      if (mode === "cloud") {
        await refreshMemberships();
        const selected = memberships.find(item => item.siteId === identity.siteId);
        if (selected) identity = { ...identity, ...selected };
        else if (memberships.length === 1) identity = { ...identity, ...memberships[0] };
        else if (identity.siteId) {
          identity = { userId: identity.userId, deviceId: identity.deviceId, provider: mode };
        }
      }
      await saveCloudIdentity(identity);
      localStorage.setItem(MODE_KEY, mode);
      subscribeCurrentSite();
      if (mode === "cloud" && identity?.siteId) {
        configureCloudReceiver(provider, identity);
        configureCloudLedgerSync(provider, identity);
      }
      setMessage(identity?.siteId ? `${identity.siteName || identity.siteCode}へ再接続しました。` : mode === "mock"
        ? "端末内試作を開始しました。工事PASSはDEMO-ONLYです。"
        : "共有の準備ができました。工事IDと工事PASSを入力してください。");
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
    setMessage(remaining.length ? `${remaining.length}件が送信待ちです。通信を確認してもう一度送ってください。` : "送信が完了しました。", remaining.length > 0);
    await renderStatus();
  }

  async function enqueueSelectedProject() {
    if (!identity?.siteId || ["closed", "trashed"].includes(identity.siteStatus) || !ui.photoProject.value) return;
    const project = await getProjectByUid(ui.photoProject.value);
    const photos = await getPhotosByProjectUid(ui.photoProject.value);
    await enqueuePhotosForSync(photos.map(photo => ({
      siteId: identity.siteId, projectUid: project.projectUid, photoUid: photo.photoUid,
      photoInternalId: photo.internalId, sha256: photo.sha256, bytes: photo.bytes
    })));
    setPhotoMessage(`${project.name}の写真${photos.length}件を確認し、未登録分を送信待ちへ追加しました。`);
    await renderPhotoStatus();
    await startAutomaticPhotoSync();
  }

  async function syncPhotos({ manual = false } = {}) {
    if (!active || !provider || !identity?.siteId || ["closed", "trashed"].includes(identity.siteStatus) || photoBusy || siteSwitching) return;
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
    setPhotoMessage("写真を1枚ずつ送っています。画面を閉じないでください。");
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
    else setPhotoMessage("写真の送信が完了しました。この端末の元写真は保持されています。");
    await renderPhotoStatus();
  }

  async function startAutomaticPhotoSync() {
    const settings = await getPhotoSyncSettings();
    if (shouldAutoSync(settings, detectNetworkStatus())) await syncPhotos({ manual: false });
    else await renderPhotoStatus();
  }

  async function refreshIdentitySite() {
    if (!provider?.refreshSite || !identity?.siteId) return;
    identity = { ...identity, ...(await provider.refreshSite(identity.siteId)) };
    await saveCloudIdentity(identity);
    await renderStatus();
  }

  async function runAdminAction(label, action) {
    if (identity?.role !== "admin" || siteSwitching) return;
    siteSwitching = true;
    try {
      setMessage(`${label}しています…`);
      const result = await action();
      if (!result?.skipRefresh) {
        await refreshIdentitySite();
        await refreshMemberships();
      }
      setMessage(`${label}しました。`);
    } catch (error) {
      setMessage(/revision_conflict/i.test(error?.message || "")
        ? "別の端末で工事情報が更新されました。最新にしてから、もう一度操作してください。"
        : (error?.message || `${label}できませんでした。`), true);
    } finally {
      siteSwitching = false;
      await renderStatus();
    }
  }

  async function handleNetworkChange() {
    if (!active) return;
    await renderPhotoStatus();
    await startAutomaticPhotoSync();
  }

  ui.local.addEventListener("click", () => { clearSharingSecrets(sharingSecrets); connect("local"); });
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
  document.querySelectorAll("[data-sharing-operation]").forEach(button => button.addEventListener("click", async () => {
    selectedOperation = button.dataset.sharingOperation;
    clearSharingSecrets(sharingSecrets);
    await renderStatus();
    const target = selectedOperation === "create" ? ui.createName
      : selectedOperation === "join" ? ui.siteCode
      : selectedOperation === "admin" ? ui.adminClaimSiteCode : null;
    target?.focus();
  }));
  ui.createForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (!provider?.createSiteForAccount) return setMessage("先にアカウントでログインしてください。", true);
    if (siteSwitching) return;
    siteSwitching = true;
    try {
      await ensureMembershipAuth();
      const adminCode = validateAdminCode(ui.createAdminCode.value, ui.createAdminConfirm.value);
      const joinCode = String(ui.createJoinCode.value || "");
      if (joinCode.length < 8 || joinCode.length > 64 || /[\s\u0000-\u001f\u007f]/.test(joinCode)) {
        throw new Error("工事PASSは空白を含まない8～64文字で設定してください。");
      }
      const membership = await provider.createSiteForAccount({
        siteName: ui.createName.value.trim(), siteCode: ui.createCode.value.trim(),
        joinCode, adminCode, deviceName: ui.createDevice.value.trim() || "この端末"
      });
      identity = { ...identity, ...membership };
      await refreshMemberships();
      await saveCloudIdentity(identity);
      subscribeCurrentSite();
      if (sharingMode() === "cloud") {
        configureCloudReceiver(provider, identity);
        configureCloudLedgerSync(provider, identity);
      }
      ui.createForm.reset();
      selectedOperation = "sites";
      setMessage(`${membership.siteName}を作成し、管理者として接続しました。`);
    } catch (error) {
      setMessage(error?.message || "工事を作成できませんでした。", true);
    } finally {
      clearSharingSecrets(ui.createJoinCode, ui.createAdminCode, ui.createAdminConfirm);
      siteSwitching = false;
      await renderStatus();
    }
  });
  ui.joinForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (!provider) return setMessage("先に工事の共有を開始してください。", true);
    siteSwitching = true;
    try {
      await ensureMembershipAuth();
      const membership = await provider.joinSite({ siteCode: ui.siteCode.value, joinCode: ui.joinCode.value, deviceName: ui.deviceName.value.trim() || "名称未設定端末" });
      ui.joinCode.value = "";
      identity = { ...identity, ...membership };
      await saveCloudIdentity(identity);
      if (provider.refreshSite) {
        identity = { ...identity, ...(await provider.refreshSite(identity.siteId)) };
        await saveCloudIdentity(identity);
      }
      await refreshMemberships();
      subscribeCurrentSite();
      if (sharingMode() === "cloud") {
        configureCloudReceiver(provider, identity);
        configureCloudLedgerSync(provider, identity);
      }
      setMessage(`${membership.siteName}へ参加しました（${roleLabel(membership.role)}）。`);
    } catch (error) {
      ui.joinCode.value = "";
      setMessage(error?.message || "工事へ参加できませんでした。", true);
    } finally {
      siteSwitching = false;
    }
    await renderStatus();
    if (sharingMode() === "cloud") await refreshCloudPhotos();
    await startAutomaticPhotoSync();
  });
  ui.adminClaimForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (!provider?.claimSiteAdmin) {
      setAdminClaimMessage("先に工事の共有を開始してください。", true);
      return setMessage("先に工事の共有を開始してください。", true);
    }
    if (siteSwitching) return;
    siteSwitching = true;
    setAdminClaimMessage("管理者として確認しています…");
    try {
      await ensureMembershipAuth();
      const membership = await provider.claimSiteAdmin({
        siteCode: ui.adminClaimSiteCode.value,
        adminCode: ui.adminClaimCode.value,
        deviceName: ui.adminClaimDevice.value.trim() || "名称未設定端末"
      });
      identity = { ...identity, ...membership };
      await refreshMemberships();
      await saveCloudIdentity(identity);
      subscribeCurrentSite();
      if (sharingMode() === "cloud") {
        configureCloudReceiver(provider, identity);
        configureCloudLedgerSync(provider, identity);
      }
      const successMessage = `管理者として接続しました。工事：${membership.siteName}／権限：${roleLabel(membership.role)}`;
      setAdminClaimMessage(successMessage);
      setMessage(successMessage);
    } catch (error) {
      const safeMessage = /15分|しばらく待って/i.test(error?.message || "")
        ? error.message : "管理者PASSが違うか、現在利用できません。";
      setAdminClaimMessage(safeMessage, true);
      setMessage(safeMessage, true);
    } finally {
      ui.adminClaimCode.value = "";
      siteSwitching = false;
      await renderStatus();
    }
  });
  ui.openAdminClaim.addEventListener("click", () => {
    selectedOperation = "admin";
    renderStatus();
    ui.adminClaimSiteCode.value = identity?.siteCode || "";
    ui.adminClaimDevice.value = identity?.deviceName || "";
    clearSharingSecrets(ui.adminClaimCode);
    setAdminClaimMessage("");
    ui.adminClaimCode.focus();
  });
  document.querySelectorAll("[data-site-status]").forEach(button => button.addEventListener("click", () => {
    siteStatusFilter = button.dataset.siteStatus;
    renderSiteList();
  }));
  ui.send.addEventListener("click", async () => {
    const event = {
      eventId: crypto.randomUUID(), siteId: identity.siteId, entityId: crypto.randomUUID(), deviceName: identity.deviceName || "名称未設定端末",
      providerMode: sharingMode(), createdAt: new Date().toISOString(), payload: { source: "aoALB", test: true, note: "テスト用メタデータ1件" }
    };
    await enqueueSyncEvent(event);
    await flushQueue();
  });
  ui.retry.addEventListener("click", flushQueue);
  ui.photoEnqueue.addEventListener("click", () => enqueueSelectedProject().catch(error => setPhotoMessage(error?.message || "送信待ちへ追加できませんでした。", true)));
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
    setPhotoMessage("この端末の写真送信設定を保存しました。");
    await startAutomaticPhotoSync();
  });
  ui.photoNow.addEventListener("click", () => syncPhotos({ manual: true }));
  ui.photoPause.addEventListener("click", async () => { await setPhotoQueuePaused(identity.siteId, true); setPhotoMessage("未開始の写真を一時停止しました。"); await renderPhotoStatus(); });
  ui.photoResume.addEventListener("click", async () => { await setPhotoQueuePaused(identity.siteId, false); setPhotoMessage("写真の送信を再開しました。"); await startAutomaticPhotoSync(); });
  ui.photoRetry.addEventListener("click", async () => { await retryPhotoQueueErrors(identity.siteId); await syncPhotos({ manual: true }); });
  ui.adminSave.addEventListener("click", () => runAdminAction("工事情報を保存", () => provider.siteRpc("update_site", {
    p_site_id: identity.siteId, p_expected_revision: identity.siteRevision,
    p_name: ui.adminName.value, p_site_code: ui.adminCode.value
  })));
  ui.adminRotate.addEventListener("click", () => runAdminAction("工事PASSを変更", async () => {
    try {
      if (!ui.adminJoinCode.value || ui.adminJoinCode.value !== ui.adminJoinConfirm.value) throw new Error("工事PASSと確認入力が一致しません。");
      await provider.siteRpc("rotate_site_join_code", {
        p_site_id: identity.siteId, p_new_code: ui.adminJoinCode.value, p_grant_role: "editor"
      });
    } finally {
      clearSharingSecrets(ui.adminJoinCode, ui.adminJoinConfirm);
    }
  }));
  ui.adminAccessSave.addEventListener("click", () => runAdminAction(
    identity?.adminCodeConfigured ? "管理者PASSを変更" : "管理者PASSを設定",
    async () => {
      try {
        const code = validateAdminCode(ui.adminAccessCode.value, ui.adminAccessConfirm.value);
        const name = identity.adminCodeConfigured
          ? "rotate_site_admin_code" : "set_initial_site_admin_code";
        await provider.siteRpc(name, {
          p_site_id: identity.siteId,
          p_expected_revision: identity.siteRevision,
          p_new_code: code
        });
        identity.adminCodeConfigured = true;
      } finally {
        ui.adminAccessCode.value = "";
        ui.adminAccessConfirm.value = "";
      }
    }
  ));
  ui.adminClose.addEventListener("click", async () => {
    const queue = summarizePhotoQueue(await getPhotoSyncQueue(), identity.siteId);
    if (!window.confirm(`工事を終了すると新しい参加と写真送信が止まります。写真・台帳・参加者は削除されません。${queue.pending + queue.paused + queue.error ? `\n送信待ちの写真が${queue.pending + queue.paused + queue.error}件あります。` : ""}\nよろしいですか？`)) return;
    runAdminAction("工事を終了", () => provider.siteRpc("close_site", {
      p_site_id: identity.siteId, p_expected_revision: identity.siteRevision
    }));
  });
  ui.adminReopen.addEventListener("click", () => runAdminAction("工事を再開", () => provider.siteRpc("reopen_site", {
    p_site_id: identity.siteId, p_expected_revision: identity.siteRevision
  })));
  ui.adminTrash.addEventListener("click", () => {
    if (window.prompt("写真は削除されません。確認のため工事名を入力してください。") !== identity.siteName) return;
    runAdminAction("工事をごみ箱へ移動", () => provider.siteRpc("trash_site", {
      p_site_id: identity.siteId, p_expected_revision: identity.siteRevision
    }));
  });
  ui.adminRestore.addEventListener("click", () => runAdminAction("工事を復元", () => provider.siteRpc("restore_site", {
    p_site_id: identity.siteId, p_expected_revision: identity.siteRevision
  })));
  ui.adminDeleteEmpty.addEventListener("click", () => {
    const confirmed = window.prompt("空工事であることを共有先で再確認します。完全削除する工事名を入力してください。");
    if (confirmed !== identity.siteName) return;
    runAdminAction("この工事を完全に削除", async () => {
      await provider.siteRpc("delete_empty_site", {
        p_site_id: identity.siteId, p_expected_revision: identity.siteRevision, p_confirm_name: confirmed
      });
      identity = { userId: identity.userId, deviceId: identity.deviceId, provider: identity.provider };
      await refreshMemberships();
      await saveCloudIdentity(identity);
      return { skipRefresh: true };
    });
  });
  document.querySelectorAll(".friendly-details").forEach(details => details.addEventListener("toggle", () => {
    if (!details.open) clearSharingSecrets(...details.querySelectorAll('input[type="password"]'));
  }));
  document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => clearSharingSecrets(sharingSecrets)));
  window.addEventListener("pagehide", () => clearSharingSecrets(sharingSecrets));
  ui.receiveRefresh.addEventListener("click", () => refreshCloudPhotos());
  ui.receiveCache.addEventListener("click", () => cacheOriginals(true));
  ui.receiveMode.addEventListener("change", async () => {
    localStorage.setItem(CLOUD_ORIGINAL_MODE_KEY, ui.receiveMode.value === "wifi_only" ? "wifi_only" : "thumbnail_only");
    setReceiveMessage("この端末の写真保存設定を保存しました。");
    await maybeAutoCacheOriginals();
  });
  ui.receiveClear.addEventListener("click", async () => {
    const summary = await cloudDownloadSummary(identity?.siteId);
    if (!window.confirm(`この端末に保存した写真データ約${formatTransferBytes(summary.cache.bytes)}を削除します。\n共有先の写真・写真情報・台帳配置は削除されません。`)) return;
    receiveBusy = true;
    try {
      await clearCurrentSiteCloudCache();
      setReceiveMessage("この端末の写真データを削除しました。共有先の写真は保持されています。");
    } catch (error) {
      setReceiveMessage(error?.message || "この端末の写真データを削除できませんでした。", true);
    } finally {
      receiveBusy = false;
      await renderReceiveStatus();
    }
  });
  window.addEventListener("online", handleNetworkChange);
  window.addEventListener("offline", handleNetworkChange);
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  connection?.addEventListener?.("change", handleNetworkChange);

  async function activate() {
    active = true;
    identity = await getCloudIdentity();
    const defaultDeviceName = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)
      ? "このスマートフォン" : "この端末";
    if (!ui.deviceName.value) ui.deviceName.value = defaultDeviceName;
    if (!ui.adminClaimDevice.value) ui.adminClaimDevice.value = identity?.deviceName || defaultDeviceName;
    await recoverInterruptedPhotoUploads();
    try {
      await loadLocalCloudConfig();
    } catch (error) {
      localStorage.setItem(MODE_KEY, "local");
      setMessage(error?.message || "この端末の設定を読み込めませんでした。", true);
      await renderStatus();
      return;
    }
    const config = loadCloudConfig();
    ui.projectUrl.value = config?.projectUrl || "";
    ui.publishableKey.value = "";
    if (sharingMode() === "cloud" && (!hasStoredAuthSession() || !accountActive)) {
      localStorage.setItem(MODE_KEY, "local");
      setMessage("この端末だけで開始しました。工事を共有する場合は「工事の共有を開始」を押してください。");
      await connect("local");
    } else {
      await connect(sharingMode());
    }
    if (provider && identity?.siteId) {
      await flushQueue();
      await startAutomaticPhotoSync();
      if (sharingMode() === "cloud") {
        configureCloudReceiver(provider, identity);
        configureCloudLedgerSync(provider, identity);
        await refreshCloudPhotos();
        await syncCloudLedgers();
        await flushCloudChanges();
      }
    }
    await renderStatus();
  }

  function deactivate() {
    active = false;
  }

  const handleAccountContext = event => {
    accountActive = event.detail?.active === true;
    if (!accountActive) selectedOperation = "sites";
    renderStatus().catch(() => {});
  };
  window.addEventListener("aoalb:account-context", handleAccountContext);

  return {
    activate,
    deactivate,
    start: activate,
    photoLifecycleContext() {
      return {
        provider,
        identity: identity?.siteId ? { ...identity } : null,
        mode: sharingMode()
      };
    },
    refreshCloudPhotos,
    destroy() { window.removeEventListener("aoalb:account-context", handleAccountContext); }
  };
}
