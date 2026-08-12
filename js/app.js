import { validateAoalbZip, ImportValidationError } from "./importer.js";
import {
  openDatabase, getImportByExportId, getProjects, getImports, getPhotosByProjectUid,
  analyzeImportConflicts, estimateImportStorage, saveValidatedImport, recordFailedImport,
  getLocalProjectDeletionPreview, deleteLocalProjectData, getTrashedPhotosBySite,
  getPhotoDeletionPreview, deleteLocalPhotos, updatePhotoClassificationOverrides
} from "./storage.js";
import { initLedgerEditor } from "./ledger.js";
import { initSiteSharing } from "./sharing.js?v=20260810-account-auth2";
import { loadPhotoAsset, syncCloudTrash } from "./cloud/receiver.js";
import { photoDeleteConfirmation, photoSourceKind } from "./photo-delete.js";
import { CLASSIFICATION_FIELDS, effectiveClassification, hasClassificationOverride } from "./classification.js";
import { initAccountUI } from "./account.js?v=20260810-account-auth2";

const views = ["import", "projects", "photos", "ledgers", "history", "sharing"];
const elements = Object.fromEntries(Array.from(document.querySelectorAll("[id]"), element => [element.id, element]));
let selectedProjectUid = localStorage.getItem("aoALB:selectedProjectUid") || "";
let currentProject = null;
let allPhotos = [];
let pendingImport = null;
let importing = false;
let detailUrl = null;
let thumbnailObserver = null;
const thumbnailUrls = new Set();
let ledgerEditor = null;
let sharingController = null;
let accountController = null;
let projectDeletionPreview = null;
let deletingProject = false;
let photoSelectionMode = false;
let photoListMode = "active";
let selectedPhotoIds = new Set();
let currentDetailPhoto = null;
let photoDeletionPreview = null;
let deletingPhotos = false;
let classificationTargetIds = [];
let savingClassification = false;

class StorageCapacityError extends Error {
  constructor(requiredBytes, availableBytes) {
    super("端末またはブラウザの保存容量が不足しています。");
    this.name = "StorageCapacityError";
    this.requiredBytes = requiredBytes;
    this.availableBytes = availableBytes;
  }
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  const units = [[1024 ** 3, "GB"], [1024 ** 2, "MB"], [1024, "KB"]];
  const [base, unit] = units.find(([size]) => bytes >= size) || [1, "bytes"];
  const digits = base === 1 ? 0 : bytes / base >= 10 ? 1 : 2;
  return `${new Intl.NumberFormat("ja-JP", { maximumFractionDigits: digits }).format(bytes / base)} ${unit}`;
}

function photoLifecycleContext() {
  return sharingController?.photoLifecycleContext?.() || { provider: null, identity: null, mode: "local" };
}

function setPhotoActionMessage(message = "", error = false) {
  elements["photo-action-message"].textContent = message;
  elements["photo-action-message"].className = `project-message${error ? " error" : message ? " success" : ""}`;
}

function isQuotaError(error) {
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1, current = current.cause) {
    const name = String(current.name || "");
    const message = String(current.message || "");
    if (name === "QuotaExceededError" || /quota|not enough (?:storage|space)|storage (?:is )?full|disk (?:is )?full|容量.*不足|空き容量/i.test(message)) return true;
  }
  return false;
}

function messagesForImportError(error) {
  if (error instanceof StorageCapacityError) {
    return [
      `必要容量の概算: ${formatBytes(error.requiredBytes)}`,
      `現在利用できる容量の概算: ${formatBytes(error.availableBytes)}`,
      "写真は1枚も保存されていません。",
      "より小さいZIPを使用するか、端末の空き容量を確保してから再度お試しください。"
    ];
  }
  if (isQuotaError(error)) {
    return ["端末またはブラウザの保存容量が不足しているため、写真を取り込めませんでした。今回の写真は保存されていません。"];
  }
  return error instanceof ImportValidationError ? error.errors : [error?.message || "取込み処理に失敗しました。"];
}

function withNoSaveNotice(messages) {
  return messages.some(message => message.includes("保存されていません")) ? messages : [...messages, "工事と写真は保存されていません。"];
}

function showPersistFailure(error) {
  elements["import-progress"].hidden = true;
  showResult("error", "保存できませんでした", withNoSaveNotice(messagesForImportError(error)));
}

function textElement(tag, text, className = "") {
  const element = document.createElement(tag);
  element.textContent = text == null || text === "" ? "―" : String(text);
  if (className) element.className = className;
  return element;
}

function formatDate(value) {
  if (!value) return "―";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function shortId(value) {
  return value ? `${value.slice(0, 8)}…` : "―";
}

function showView(name) {
  const target = views.includes(name) ? name : "import";
  if (target === "photos" || target === "ledgers") selectedProjectUid = localStorage.getItem("aoALB:selectedProjectUid") || "";
  for (const view of views) elements[`view-${view}`].hidden = view !== target;
  document.querySelectorAll("[data-view]").forEach(button => button.classList.toggle("active", button.dataset.view === target));
  if (target !== "photos") revokeThumbnailUrls();
  if (target !== "ledgers") ledgerEditor?.deactivate();
  if (target !== "sharing") sharingController?.deactivate();
  if (target === "projects") renderProjects();
  if (target === "photos") renderPhotoView();
  if (target === "ledgers") ledgerEditor?.activate(selectedProjectUid);
  if (target === "history") renderHistory();
  if (target === "sharing") sharingController?.activate();
  if (location.hash !== `#${target}`) history.replaceState(null, "", `#${target}`);
  elements.app.focus({ preventScroll: true });
}

function setProgress({ message = "", percent = 0, current = 0, total = 0 } = {}) {
  elements["import-progress"].hidden = false;
  elements["progress-bar"].value = Math.max(0, Math.min(100, percent));
  elements["progress-count"].textContent = total ? `${current}/${total}` : "";
  elements["progress-message"].textContent = message;
}

function showResult(kind, title, messages) {
  const panel = elements["import-result"];
  panel.hidden = false;
  panel.className = `result-panel ${kind}`;
  elements["result-title"].textContent = title;
  elements["result-messages"].replaceChildren(...messages.map(message => textElement("li", message)));
}

function resetImportMessages() {
  elements["import-result"].hidden = true;
  elements["conflict-panel"].hidden = true;
  elements["conflict-list"].replaceChildren();
}

async function persistValidated(validated, mode) {
  setProgress({ message: "保存に必要な空き容量を確認しています", percent: 100 });
  const capacity = await estimateImportStorage(validated);
  if (capacity.supported && !capacity.sufficient) {
    throw new StorageCapacityError(capacity.requiredBytes, capacity.availableBytes);
  }
  setProgress({ message: "この端末へ安全に保存しています", percent: 100 });
  const result = await saveValidatedImport(validated, mode);
  pendingImport = null;
  elements["conflict-panel"].hidden = true;
  showResult("success", "取込みが完了しました", [
    `工事: ${validated.project.name}`,
    `写真: ${validated.photos.length}件（新規${result.added}件・既存${result.reused}件・更新${result.updated}件）`,
    `exportId: ${validated.exportId}`
  ]);
  selectedProjectUid = validated.project.projectUid;
  localStorage.setItem("aoALB:selectedProjectUid", selectedProjectUid);
  await Promise.all([renderProjects(), renderHistory()]);
}

async function handleZip(file) {
  if (!file || importing) return;
  importing = true;
  elements["choose-zip"].disabled = true;
  resetImportMessages();
  pendingImport = null;
  setProgress({ message: "ZIPを読み込んでいます", percent: 0 });
  let failureContext = {};
  try {
    const validated = await validateAoalbZip(file, setProgress);
    failureContext = { observedExportId: validated.exportId, projectName: validated.project.name };
    const duplicate = await getImportByExportId(validated.exportId);
    if (duplicate) throw new ImportValidationError(["このexportIdは既に取り込み済みです。"], failureContext);
    const analysis = await analyzeImportConflicts(validated);
    if (analysis.fatal.length) throw new ImportValidationError(analysis.fatal, failureContext);
    if (analysis.conflicts.length) {
      pendingImport = validated;
      elements["conflict-list"].replaceChildren(...analysis.conflicts.map(conflict => {
        const subject = conflict.type === "project" ? "工事" : "写真";
        return textElement("li", `${subject} ${shortId(conflict.id)}: ${conflict.fields.join("、")}に差分があります。`);
      }));
      elements["conflict-panel"].hidden = false;
      elements["import-progress"].hidden = true;
      return;
    }
    await persistValidated(validated, "preserve");
  } catch (error) {
    const messages = messagesForImportError(error);
    failureContext = { ...failureContext, ...(error.context || {}) };
    showResult("error", "ZIPを取り込めませんでした", withNoSaveNotice(messages));
    elements["import-progress"].hidden = true;
    await recordFailedImport({ ...failureContext, errors: messages }).catch(() => {});
    await renderHistory();
  } finally {
    importing = false;
    elements["choose-zip"].disabled = false;
    elements["zip-file"].value = "";
  }
}

async function renderProjects() {
  const projects = (await getProjects()).sort((a, b) => (b.lastImportedAt || "").localeCompare(a.lastImportedAt || ""));
  const cards = await Promise.all(projects.map(async project => {
    const preview = await getLocalProjectDeletionPreview(project.internalId);
    const card = document.createElement("article");
    card.className = "project-card";
    const header = document.createElement("div");
    header.className = "project-card-header";
    header.append(
      textElement("h2", project.name),
      textElement("span", preview.sourceLabel, `project-kind ${preview.dataKind}`)
    );
    card.append(header, textElement("p", `施工者: ${project.contractor || "―"}`));
    const meta = document.createElement("div");
    meta.className = "project-meta";
    meta.append(
      textElement("span", `写真 ${preview.photoCount}件`),
      textElement("span", `台帳 ${preview.ledgerCount}件`),
      textElement("span", `使用容量 約${formatBytes(preview.estimatedBytes)}`),
      textElement("span", `取込日時 ${formatDate(preview.importedAt)}`)
    );
    card.append(meta);

    const actions = document.createElement("div");
    actions.className = "project-card-actions";
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "primary";
    openButton.textContent = "この工事を開く";
    openButton.addEventListener("click", () => {
      selectedProjectUid = project.projectUid;
      localStorage.setItem("aoALB:selectedProjectUid", selectedProjectUid);
      showView("photos");
    });
    actions.append(openButton);
    if (preview.eligible) {
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "local-delete-button";
      deleteButton.textContent = "工事データをこの端末から削除";
      deleteButton.addEventListener("click", () => openProjectDeletionDialog(project.internalId));
      actions.append(deleteButton);
    } else {
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "local-delete-button";
      deleteButton.textContent = "工事データをこの端末から削除";
      deleteButton.disabled = true;
      actions.append(deleteButton);
      actions.append(textElement("p", preview.reasons[0] || "この工事は安全確認ができないため削除できません。", "project-card-note"));
    }
    card.append(actions);
    return card;
  }));
  elements["project-list"].replaceChildren(...cards);
  elements["project-empty"].hidden = cards.length > 0;
}

function projectDeletionPhrase(project) {
  return project.name || "（工事名なし）";
}

function renderProjectDeletionDialog(preview) {
  projectDeletionPreview = preview;
  const phrase = projectDeletionPhrase(preview.project);
  elements["project-delete-name"].textContent = phrase;
  elements["project-delete-source"].textContent = preview.sourceLabel;
  elements["project-delete-internal-id"].textContent = String(preview.project.internalId || "").slice(0, 8);
  elements["project-delete-photo-count"].textContent = `${preview.photoCount}件`;
  elements["project-delete-ledger-count"].textContent = `${preview.ledgerCount}件`;
  elements["project-delete-import-count"].textContent = `${preview.importCount}件`;
  elements["project-delete-cache-count"].textContent = `${preview.cloudFileCount}件`;
  elements["project-delete-bytes"].textContent = `約${formatBytes(preview.estimatedBytes)}`;
  elements["project-delete-imported-at"].textContent = formatDate(preview.importedAt);
  elements["project-delete-cloud-warning"].hidden = !preview.cloudBacked;
  elements["project-delete-destination-warning"].hidden = !preview.cloudBacked;
  elements["project-delete-destination-warning"].textContent = preview.destinationStatus === "known"
    ? "共有中の工事は、再度開いたり最新情報を取得すると、この端末へ再表示される場合があります。"
    : "共有先を確認できません。この端末に残っているデータだけを削除します。";
  elements["project-delete-confirm-name"].value = "";
  elements["project-delete-confirm-name"].placeholder = phrase;
  elements["project-delete-error"].hidden = true;
  elements["project-delete-error"].textContent = "";
  elements["project-delete-submit"].disabled = true;
}

async function openProjectDeletionDialog(projectInternalId) {
  if (deletingProject) return;
  try {
    const preview = await getLocalProjectDeletionPreview(projectInternalId);
    if (!preview.eligible) throw new Error(preview.reasons[0] || "この工事は削除できません。");
    renderProjectDeletionDialog(preview);
    elements["project-delete-dialog"].showModal();
    elements["project-delete-confirm-name"].focus();
  } catch (error) {
    elements["project-message"].textContent = error?.message || "削除内容を確認できませんでした。";
    elements["project-message"].className = "project-message error";
  }
}

function releaseProjectDisplay(projectUid, ledgerIds) {
  const wasSelected = selectedProjectUid === projectUid
    || localStorage.getItem("aoALB:selectedProjectUid") === projectUid;
  if (currentProject?.projectUid === projectUid || wasSelected) {
    if (elements["photo-detail"].open) elements["photo-detail"].close();
    revokeThumbnailUrls();
    if (detailUrl) URL.revokeObjectURL(detailUrl);
    detailUrl = null;
    allPhotos = [];
    currentProject = null;
  }
  if (wasSelected) {
    selectedProjectUid = "";
    localStorage.removeItem("aoALB:selectedProjectUid");
    ledgerEditor?.deactivate();
  }
  if (ledgerIds.includes(localStorage.getItem("aoALB:selectedLedgerId"))) localStorage.removeItem("aoALB:selectedLedgerId");
}

async function confirmProjectDeletion(event) {
  event.preventDefault();
  if (deletingProject || !projectDeletionPreview) return;
  const phrase = projectDeletionPhrase(projectDeletionPreview.project);
  if (elements["project-delete-confirm-name"].value !== phrase) return;

  deletingProject = true;
  elements["project-delete-submit"].disabled = true;
  elements["project-delete-cancel"].disabled = true;
  elements["project-delete-close"].disabled = true;
  elements["project-delete-progress"].hidden = false;
  elements["project-delete-error"].hidden = true;
  try {
    const result = await deleteLocalProjectData(projectDeletionPreview.project.internalId, projectDeletionPreview.versionToken);
    releaseProjectDisplay(result.project.projectUid, result.ledgerIds);
    elements["project-delete-dialog"].close();
    projectDeletionPreview = null;
    elements["project-message"].textContent = `「${result.project.name || "工事名なし"}」をこの端末から削除しました。共有先や別の端末のデータは変更していません。`;
    elements["project-message"].className = "project-message success";
    await Promise.all([renderProjects(), renderHistory()]);
    window.dispatchEvent(new CustomEvent("aoalb:local-project-deleted", { detail: { projectUid: result.project.projectUid } }));
  } catch (error) {
    const message = error?.message || "工事データを削除できませんでした。今回のデータは変更されていません。";
    if (message.includes("確認し直して")) {
      const refreshed = await getLocalProjectDeletionPreview(projectDeletionPreview.project.internalId).catch(() => null);
      if (refreshed?.eligible) renderProjectDeletionDialog(refreshed);
    }
    elements["project-delete-error"].textContent = message;
    elements["project-delete-error"].hidden = false;
  } finally {
    deletingProject = false;
    elements["project-delete-cancel"].disabled = false;
    elements["project-delete-close"].disabled = false;
    elements["project-delete-progress"].hidden = true;
    const preview = projectDeletionPreview;
    elements["project-delete-submit"].disabled = !preview
      || elements["project-delete-confirm-name"].value !== projectDeletionPhrase(preview.project);
  }
}

function setSelectOptions(select, values) {
  const current = select.value;
  const options = [new Option("すべて", ""), ...Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b, "ja")).map(value => new Option(value, value))];
  select.replaceChildren(...options);
  select.value = options.some(option => option.value === current) ? current : "";
}

function setupFilterOptions() {
  setSelectOptions(elements["filter-koushu"], allPhotos.map(photo => effectiveClassification(photo).koushu));
  setSelectOptions(elements["filter-shubetsu"], allPhotos.map(photo => effectiveClassification(photo).shubetsu));
  setSelectOptions(elements["filter-saibetsu"], allPhotos.map(photo => effectiveClassification(photo).saibetsu));
  setSelectOptions(elements["filter-sokuten"], allPhotos.map(photo => effectiveClassification(photo).sokuten));
}

function filteredPhotos() {
  const filters = {
    koushu: elements["filter-koushu"].value,
    shubetsu: elements["filter-shubetsu"].value,
    saibetsu: elements["filter-saibetsu"].value,
    sokuten: elements["filter-sokuten"].value
  };
  const query = elements["filter-search"].value.trim().toLocaleLowerCase("ja");
  const unclassified = elements["filter-unclassified"].checked;
  const result = allPhotos.filter(photo => {
    const classification = effectiveClassification(photo);
    if (Object.entries(filters).some(([key, value]) => value && classification[key] !== value)) return false;
    if (unclassified && Object.values(classification).some(value => value.trim())) return false;
    if (query) {
      const searchable = [...Object.values(classification), photo.ledger.title, photo.ledger.description, photo.capturedAt].join(" ").toLocaleLowerCase("ja");
      if (!searchable.includes(query)) return false;
    }
    return true;
  });
  const sort = elements["photo-sort"].value;
  result.sort((a, b) => {
    if (sort === "captured-desc") return (b.capturedAt || "").localeCompare(a.capturedAt || "");
    if (sort === "koushu") return effectiveClassification(a).koushu.localeCompare(effectiveClassification(b).koushu, "ja") || (a.capturedAt || "").localeCompare(b.capturedAt || "");
    return (a.capturedAt || "").localeCompare(b.capturedAt || "");
  });
  return result;
}

function revokeThumbnailUrls() {
  thumbnailObserver?.disconnect();
  thumbnailObserver = null;
  thumbnailUrls.forEach(url => URL.revokeObjectURL(url));
  thumbnailUrls.clear();
}

function createPhotoCard(photo) {
  const classification = effectiveClassification(photo);
  const wrapper = document.createElement("div");
  wrapper.className = `photo-select-card${selectedPhotoIds.has(photo.internalId) ? " selected" : ""}`;
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "photo-select-check";
  checkbox.checked = selectedPhotoIds.has(photo.internalId);
  checkbox.hidden = !photoSelectionMode || photoListMode !== "active";
  checkbox.setAttribute("aria-label", `${formatDate(photo.capturedAt)}の写真を選択`);
  checkbox.addEventListener("change", () => togglePhotoSelection(photo.internalId, checkbox.checked));
  const button = document.createElement("button");
  button.type = "button";
  button.className = "photo-card";
  const image = document.createElement("img");
  image.className = "photo-thumb";
  image.alt = "";
  image.dataset.photoInternalId = photo.internalId;
  const info = document.createElement("div");
  info.className = "photo-info";
  info.append(
    textElement("h2", photo.ledger.title || classification.saibetsu || "（台帳タイトルなし）"),
    textElement("p", formatDate(photo.capturedAt)),
    textElement("p", [classification.koushu, classification.sokuten].filter(Boolean).join(" / ") || "未分類")
  );
  if (hasClassificationOverride(photo)) info.append(textElement("span", "この端末で分類変更済み", "status-badge success"));
  button.append(image, info);
  button.addEventListener("click", () => {
    if (photoSelectionMode && photoListMode === "active") {
      togglePhotoSelection(photo.internalId, !selectedPhotoIds.has(photo.internalId));
    } else {
      showPhotoDetail(photo);
    }
  });
  wrapper.append(button, checkbox);
  if (photoListMode === "trashed") wrapper.append(textElement("span", "削除済み", "photo-trash-badge"));
  return wrapper;
}

function observeThumbnails() {
  thumbnailObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const image = entry.target;
      thumbnailObserver.unobserve(image);
      loadPhotoAsset(image.dataset.photoInternalId, "thumbnail").then(file => {
        if (!file?.blob || !image.isConnected) return;
        const url = URL.createObjectURL(file.blob);
        thumbnailUrls.add(url);
        image.src = url;
        image.alt = "工事写真のサムネイル";
      }).catch(() => { image.alt = "画像を読み込めません"; });
    }
  }, { rootMargin: "240px" });
  elements["photo-list"].querySelectorAll("img[data-photo-internal-id]").forEach(image => thumbnailObserver.observe(image));
}

function renderPhotoCards() {
  revokeThumbnailUrls();
  const photos = filteredPhotos();
  elements["photo-count"].textContent = `${photos.length}件 / 全${allPhotos.length}件`;
  elements["photo-list"].replaceChildren(...photos.map(createPhotoCard));
  elements["photo-empty"].hidden = photos.length > 0;
  if (photos.length) observeThumbnails();
  renderPhotoSelectionState();
}

async function renderPhotoView() {
  const projects = await getProjects();
  currentProject = projects.find(project => project.projectUid === selectedProjectUid) || null;
  if (!currentProject) {
    elements["selected-project-name"].textContent = "工事一覧から工事を選択してください。";
    allPhotos = [];
  } else {
    elements["selected-project-name"].textContent = `${currentProject.name} / ${currentProject.contractor || "施工者未設定"}`;
    if (photoListMode === "trashed") {
      const { identity } = photoLifecycleContext();
      if (identity?.role === "admin" && identity.siteId === currentProject.siteId) {
        await syncCloudTrash().catch(error => setPhotoActionMessage(error.message || "削除済み写真を取得できません。", true));
        allPhotos = (await getTrashedPhotosBySite(identity.siteId))
          .filter(photo => photo.projectUid === currentProject.projectUid);
      } else {
        allPhotos = [];
        photoListMode = "active";
      }
    }
    if (photoListMode === "active") allPhotos = await getPhotosByProjectUid(currentProject.projectUid);
  }
  const { identity } = photoLifecycleContext();
  const canViewTrash = Boolean(currentProject?.siteId && identity?.siteId === currentProject.siteId && identity.role === "admin");
  elements["show-trashed-photos"].hidden = !canViewTrash;
  elements["show-active-photos"].classList.toggle("active", photoListMode === "active");
  elements["show-trashed-photos"].classList.toggle("active", photoListMode === "trashed");
  elements["photo-select-mode"].hidden = photoListMode !== "active";
  if (photoListMode !== "active") {
    photoSelectionMode = false;
    selectedPhotoIds.clear();
  }
  setupFilterOptions();
  renderPhotoCards();
}

function renderPhotoSelectionState() {
  const selected = selectedPhotoIds.size;
  const selectedBytes = allPhotos.reduce(
    (total, photo) => selectedPhotoIds.has(photo.internalId) ? total + Math.max(0, Number(photo.bytes) || 0) : total,
    0
  );
  elements["photo-selected-count"].hidden = !photoSelectionMode;
  elements["photo-selected-count"].textContent = `選択中 ${selected}件・約${formatBytes(selectedBytes)}`;
  elements["photo-select-all"].hidden = !photoSelectionMode;
  elements["photo-select-clear"].hidden = !photoSelectionMode;
  elements["photo-classify-selected"].hidden = !photoSelectionMode;
  elements["photo-classify-selected"].disabled = selected === 0 || savingClassification || deletingPhotos;
  elements["photo-delete-selected"].hidden = !photoSelectionMode;
  elements["photo-delete-selected"].disabled = selected === 0 || deletingPhotos;
  elements["photo-select-mode"].textContent = photoSelectionMode ? "選択を終了" : "写真を選択";
}

function togglePhotoSelection(photoInternalId, selected) {
  if (selected) selectedPhotoIds.add(photoInternalId);
  else selectedPhotoIds.delete(photoInternalId);
  renderPhotoCards();
}

function detailGroup(title, fields) {
  const group = document.createElement("section");
  group.className = "detail-group";
  group.append(textElement("h3", title));
  const list = document.createElement("dl");
  for (const [label, value] of fields) {
    const row = document.createElement("div");
    row.className = "detail-field";
    row.append(textElement("dt", label), textElement("dd", value));
    list.append(row);
  }
  group.append(list);
  return group;
}

async function showPhotoDetail(photo) {
  currentDetailPhoto = photo;
  if (detailUrl) URL.revokeObjectURL(detailUrl);
  detailUrl = null;
  elements["detail-image"].removeAttribute("src");
  const file = await loadPhotoAsset(photo.internalId, "original", { includeTrashed: photoListMode === "trashed" });
  if (file?.blob) {
    detailUrl = URL.createObjectURL(file.blob);
    elements["detail-image"].src = detailUrl;
    elements["detail-image"].alt = "工事写真";
  } else {
    elements["detail-image"].alt = "原寸写真はオンライン時に取得できます";
  }
  const c = effectiveClassification(photo);
  const b = photo.boardSnapshot;
  elements["detail-fields"].replaceChildren(
    detailGroup("工事", [["工事名", currentProject?.name], ["施工者", currentProject?.contractor], ["撮影日時", formatDate(photo.capturedAt)]]),
    detailGroup(hasClassificationOverride(photo) ? "分類情報（この端末で変更済み）" : "分類情報", [["工種", c.koushu], ["種別", c.shubetsu], ["細別", c.saibetsu], ["測点", c.sokuten], ["摘要", c.tekiyo]]),
    detailGroup("撮影時の黒板", [["工事名", b.koujimei], ["施工者", b.contractor], ["工種", b.koushu], ["種別", b.shubetsu], ["細別", b.saibetsu], ["測点", b.sokuten], ["摘要", b.tekiyo]]),
    detailGroup("台帳情報", [["タイトル", photo.ledger.title], ["説明文", photo.ledger.description], ["手動編集", photo.ledger.manual ? "はい" : "いいえ"]]),
    detailGroup("ファイル情報", [["保存元", photo.sources?.includes("cloud") ? "端末／クラウド" : "端末"], ["photoUid", photo.photoUid], ["SHA-256", photo.sha256], ["画像サイズ", `${photo.width} × ${photo.height}px`], ["ファイル容量", `${photo.bytes.toLocaleString("ja-JP")} bytes`]])
  );
  elements["detail-delete-photo"].hidden = photoListMode === "trashed";
  elements["detail-restore-photo"].hidden = photoListMode !== "trashed";
  elements["detail-edit-classification"].hidden = photoListMode !== "active";
  elements["detail-edit-classification"].disabled = deletingPhotos || savingClassification;
  elements["photo-detail"].showModal();
}

const classificationLabels = { koushu: "工種", shubetsu: "種別", saibetsu: "細別", sokuten: "測点", tekiyo: "摘要" };

function openClassificationEditor(photoInternalIds) {
  if (deletingPhotos || photoListMode !== "active") return setPhotoActionMessage("削除処理中または削除済みの写真は分類変更できません。", true);
  const ids = [...new Set(photoInternalIds || [])];
  const targets = ids.map(id => allPhotos.find(photo => photo.internalId === id)).filter(Boolean);
  if (!targets.length) return setPhotoActionMessage("分類を変更する写真を選択してください。", true);
  classificationTargetIds = targets.map(photo => photo.internalId);
  const bulk = targets.length > 1;
  elements["classification-target"].textContent = bulk ? `${targets.length}枚を一括変更します。` : `${formatDate(targets[0].capturedAt)}の写真`;
  elements["classification-bulk-guide"].hidden = !bulk;
  const fields = CLASSIFICATION_FIELDS.map(field => {
    const row = document.createElement("div");
    row.className = "classification-field";
    row.dataset.field = field;
    const check = document.createElement("input");
    check.type = "checkbox";
    check.id = `classification-change-${field}`;
    check.checked = !bulk;
    const label = document.createElement("label");
    label.htmlFor = check.id;
    label.textContent = `${classificationLabels[field]}を変更`;
    const values = targets.map(photo => effectiveClassification(photo)[field]);
    const input = field === "tekiyo" ? document.createElement("textarea") : document.createElement("input");
    if (field !== "tekiyo") input.type = "text";
    input.dataset.classificationInput = field;
    input.setAttribute("aria-label", classificationLabels[field]);
    input.maxLength = field === "tekiyo" ? 1000 : 200;
    if (field === "tekiyo") input.rows = 3;
    input.value = values.every(value => value === values[0]) ? values[0] : "";
    input.placeholder = values.every(value => value === values[0]) ? "空欄にする場合は空のまま保存" : "複数の内容があります";
    input.disabled = !check.checked;
    const inputRow = document.createElement("div");
    inputRow.className = "classification-input-row";
    const resetButton = document.createElement("button");
    resetButton.type = "button";
    resetButton.className = "secondary classification-field-reset";
    resetButton.textContent = "この項目を元に戻す";
    resetButton.addEventListener("click", () => {
      const active = row.dataset.resetOriginal !== "true";
      if (active) {
        row.dataset.resetOriginal = "true";
        check.checked = true;
        input.disabled = true;
        resetButton.textContent = "元に戻す指定済み";
        resetButton.classList.add("active");
      } else {
        delete row.dataset.resetOriginal;
        input.disabled = !check.checked;
        resetButton.textContent = "この項目を元に戻す";
        resetButton.classList.remove("active");
      }
    });
    check.addEventListener("change", () => {
      delete row.dataset.resetOriginal;
      resetButton.textContent = "この項目を元に戻す";
      resetButton.classList.remove("active");
      input.disabled = !check.checked;
    });
    inputRow.append(input, resetButton);
    row.append(check, label, inputRow);
    return row;
  });
  elements["classification-fields"].replaceChildren(...fields);
  elements["classification-error"].hidden = true;
  elements["classification-dialog"].showModal();
}

async function saveClassificationChanges(event) {
  event.preventDefault();
  if (savingClassification) return;
  const changes = {};
  const resetFields = [];
  for (const field of CLASSIFICATION_FIELDS) {
    const row = elements["classification-fields"].querySelector(`[data-field="${field}"]`);
    if (!row?.querySelector("input[type=checkbox]")?.checked) continue;
    if (row.dataset.resetOriginal === "true") resetFields.push(field);
    else changes[field] = row.querySelector(`[data-classification-input="${field}"]`).value.trim();
  }
  if (!Object.keys(changes).length && !resetFields.length) {
    elements["classification-error"].textContent = "変更する項目を1つ以上選択してください。";
    elements["classification-error"].hidden = false;
    return;
  }
  savingClassification = true;
  elements["classification-save"].disabled = true;
  try {
    const count = await updatePhotoClassificationOverrides(classificationTargetIds, changes, false, resetFields);
    elements["classification-dialog"].close();
    if (elements["photo-detail"].open) elements["photo-detail"].close();
    selectedPhotoIds.clear();
    photoSelectionMode = false;
    await renderPhotoView();
    setPhotoActionMessage(`${count}枚の分類をこの端末で変更しました。画像内の黒板は変更されません。`);
  } catch (error) {
    elements["classification-error"].textContent = error?.message || "分類を保存できませんでした。";
    elements["classification-error"].hidden = false;
  } finally {
    savingClassification = false;
    elements["classification-save"].disabled = false;
  }
}

function resetClassificationChanges() {
  if (savingClassification || !classificationTargetIds.length) return;
  for (const row of elements["classification-fields"].querySelectorAll("[data-field]")) {
    row.dataset.resetOriginal = "true";
    const check = row.querySelector("input[type=checkbox]");
    const input = row.querySelector("[data-classification-input]");
    const button = row.querySelector(".classification-field-reset");
    check.checked = true;
    input.disabled = true;
    button.textContent = "元に戻す指定済み";
    button.classList.add("active");
  }
  elements["classification-error"].hidden = true;
}

async function buildPhotoDeleteDialogPreview(photoInternalIds) {
  const preview = await getPhotoDeletionPreview(photoInternalIds);
  const context = photoLifecycleContext();
  const cloudPhotos = preview.photos.filter(photo => ["cloud", "mixed"].includes(photoSourceKind(photo)));
  const remoteReferences = [];
  if (cloudPhotos.length) {
    if (context.mode !== "cloud" || context.identity?.role !== "admin") {
      preview.reasons.push("共有写真の削除は管理者だけが操作できます。");
    } else if (cloudPhotos.some(photo => !photo.cloud?.remotePhotoId || !photo.cloud?.revision)) {
      preview.reasons.push("共有写真の識別情報を確認できません。最新情報を取得してから再試行してください。");
    } else {
      for (const photo of cloudPhotos) {
        const references = await context.provider.photoLedgerReferences(photo.cloud.remotePhotoId);
        remoteReferences.push(...references.map(reference => ({
          photoId: photo.internalId,
          ledgerId: reference.ledger_id,
          ledgerTitle: reference.ledger_title,
          pageIndex: Number(reference.page_index),
          slotIndex: Number(reference.slot_index),
          remote: true
        })));
      }
    }
  }
  preview.ledgerReferences = [...preview.ledgerReferences, ...remoteReferences];
  if (remoteReferences.length) preview.reasons.push(`共有台帳で使用中の写真が${new Set(remoteReferences.map(ref => ref.photoId)).size}枚あります。`);
  preview.eligible = preview.reasons.length === 0;
  return preview;
}

function renderPhotoDeleteDialog(preview) {
  photoDeletionPreview = preview;
  const phrase = photoDeleteConfirmation(preview.photoCount);
  const sharedCount = preview.cloudCount + preview.mixedCount;
  elements["photo-delete-count"].textContent = `${preview.photoCount}枚`;
  elements["photo-delete-zip-count"].textContent = `${preview.zipCount}枚`;
  elements["photo-delete-cloud-count"].textContent = `${sharedCount}枚`;
  elements["photo-delete-ledger-count"].textContent = `${new Set(preview.ledgerReferences.map(ref => ref.photoId)).size}枚`;
  elements["photo-delete-bytes"].textContent = `約${formatBytes(preview.estimatedBytes)}`;
  elements["photo-delete-phrase"].textContent = phrase;
  elements["photo-delete-confirm-text"].value = "";
  elements["photo-delete-error"].hidden = preview.reasons.length === 0;
  elements["photo-delete-error"].textContent = preview.reasons.join(" ");
  elements["photo-delete-ledger-references"].hidden = preview.ledgerReferences.length === 0;
  elements["photo-delete-ledger-list"].replaceChildren(...preview.ledgerReferences.map(reference => {
    const item = document.createElement("li");
    item.append(document.createTextNode(`${reference.ledgerTitle} / ${reference.pageIndex + 1}頁 / ${reference.slotIndex + 1}枠 `));
    if (!reference.remote) {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "secondary";
      open.textContent = "台帳を開く";
      open.addEventListener("click", () => {
        localStorage.setItem("aoALB:selectedLedgerId", reference.ledgerId);
        elements["photo-delete-dialog"].close();
        showView("ledgers");
      });
      item.append(open);
    }
    return item;
  }));
  if (preview.kind === "zip") {
    elements["photo-delete-explanation"].textContent = "この端末に保存されている写真情報とJPEGを削除します。共有先への通信は行いません。";
    elements["photo-delete-warning"].textContent = "削除後は元のZIPから再取込みできます。aoPICや別の工事は変更されません。";
  } else {
    elements["photo-delete-explanation"].textContent = "共有写真をごみ箱へ移動します。この端末の元データやaoPICの写真は変更しません。";
    elements["photo-delete-warning"].textContent = "写真本体と一覧画像は共有先に保持され、管理者が「削除済み」から復元できます。完全削除は今回実行しません。";
  }
  elements["photo-delete-submit"].disabled = true;
}

async function openPhotoDeleteDialog(photoInternalIds) {
  if (deletingPhotos) return;
  setPhotoActionMessage();
  try {
    const preview = await buildPhotoDeleteDialogPreview(photoInternalIds);
    renderPhotoDeleteDialog(preview);
    elements["photo-delete-dialog"].showModal();
    elements["photo-delete-confirm-text"].focus();
  } catch (error) {
    setPhotoActionMessage(error?.message || "削除内容を確認できませんでした。", true);
  }
}

async function confirmPhotoDeletion(event) {
  event.preventDefault();
  if (deletingPhotos || !photoDeletionPreview?.eligible) return;
  const phrase = photoDeleteConfirmation(photoDeletionPreview.photoCount);
  if (elements["photo-delete-confirm-text"].value !== phrase) return;
  deletingPhotos = true;
  for (const id of ["photo-delete-submit", "photo-delete-cancel", "photo-delete-close"]) elements[id].disabled = true;
  elements["photo-delete-progress"].hidden = false;
  elements["photo-delete-error"].hidden = true;
  try {
    const deletedCount = photoDeletionPreview.photoCount;
    if (photoDeletionPreview.kind === "zip") {
      await deleteLocalPhotos(
        photoDeletionPreview.photos.map(photo => photo.internalId),
        photoDeletionPreview.versionToken
      );
    } else {
      const context = photoLifecycleContext();
      if (context.identity?.role !== "admin" || !context.provider) throw new Error("共有写真の削除は管理者だけが操作できます。");
      await context.provider.trashPhotos(photoDeletionPreview.photos.map(photo => ({
        remotePhotoId: photo.cloud.remotePhotoId,
        revision: photo.cloud.revision
      })));
      await sharingController.refreshCloudPhotos();
      await syncCloudTrash();
    }
    if (elements["photo-detail"].open) elements["photo-detail"].close();
    selectedPhotoIds.clear();
    photoSelectionMode = false;
    elements["photo-delete-dialog"].close();
    setPhotoActionMessage(`${deletedCount}枚の削除処理が完了しました。`);
    photoDeletionPreview = null;
    await renderPhotoView();
    window.dispatchEvent(new CustomEvent("aoalb:photos-deleted"));
  } catch (error) {
    elements["photo-delete-error"].textContent = error?.message || "写真を削除できませんでした。データは勝手に除外していません。";
    elements["photo-delete-error"].hidden = false;
  } finally {
    deletingPhotos = false;
    for (const id of ["photo-delete-cancel", "photo-delete-close"]) elements[id].disabled = false;
    elements["photo-delete-progress"].hidden = true;
    const preview = photoDeletionPreview;
    elements["photo-delete-submit"].disabled = !preview?.eligible
      || elements["photo-delete-confirm-text"].value !== photoDeleteConfirmation(preview.photoCount);
  }
}

async function restoreCurrentPhoto() {
  if (!currentDetailPhoto || deletingPhotos) return;
  const context = photoLifecycleContext();
  if (context.identity?.role !== "admin" || !context.provider) {
    setPhotoActionMessage("共有写真の復元は管理者だけが操作できます。", true);
    return;
  }
  deletingPhotos = true;
  elements["detail-restore-photo"].disabled = true;
  try {
    await context.provider.restorePhoto(currentDetailPhoto.cloud.remotePhotoId, currentDetailPhoto.cloud.revision);
    elements["photo-detail"].close();
    await sharingController.refreshCloudPhotos();
    await syncCloudTrash();
    await renderPhotoView();
    setPhotoActionMessage("写真を共有一覧へ復元しました。台帳への配置は自動では戻りません。");
  } catch (error) {
    setPhotoActionMessage(error?.message || "写真を復元できませんでした。", true);
  } finally {
    deletingPhotos = false;
    elements["detail-restore-photo"].disabled = false;
  }
}

async function renderHistory() {
  const imports = (await getImports()).sort((a, b) => (b.importedAt || "").localeCompare(a.importedAt || ""));
  const rows = imports.map(record => {
    const row = document.createElement("tr");
    const badge = textElement("span", record.status === "success" ? "成功" : "失敗", `status-badge ${record.status}`);
    const statusCell = document.createElement("td");
    statusCell.append(badge);
    row.append(
      textElement("td", formatDate(record.importedAt)), statusCell,
      textElement("td", record.projectName), textElement("td", record.photoCount),
      textElement("td", record.exportId || record.observedExportId || "―"),
      textElement("td", (record.warnings || []).join(" / ") || "―")
    );
    return row;
  });
  elements["history-body"].replaceChildren(...rows);
  elements["history-empty"].hidden = rows.length > 0;
}

document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => showView(button.dataset.view)));
elements["choose-zip"].addEventListener("click", () => elements["zip-file"].click());
elements["zip-file"].addEventListener("change", event => handleZip(event.target.files[0]));
for (const eventName of ["dragenter", "dragover"]) elements["drop-zone"].addEventListener(eventName, event => { event.preventDefault(); elements["drop-zone"].classList.add("dragover"); });
for (const eventName of ["dragleave", "drop"]) elements["drop-zone"].addEventListener(eventName, event => { event.preventDefault(); elements["drop-zone"].classList.remove("dragover"); });
elements["drop-zone"].addEventListener("drop", event => handleZip(event.dataTransfer.files[0]));
elements["keep-existing"].addEventListener("click", () => pendingImport && persistValidated(pendingImport, "preserve").catch(showPersistFailure));
elements["update-existing"].addEventListener("click", () => pendingImport && persistValidated(pendingImport, "update").catch(showPersistFailure));

for (const id of ["filter-koushu", "filter-shubetsu", "filter-saibetsu", "filter-sokuten", "filter-unclassified", "photo-sort"]) elements[id].addEventListener("change", renderPhotoCards);
elements["filter-search"].addEventListener("input", renderPhotoCards);
elements["clear-filters"].addEventListener("click", () => {
  for (const id of ["filter-koushu", "filter-shubetsu", "filter-saibetsu", "filter-sokuten"]) elements[id].value = "";
  elements["filter-unclassified"].checked = false;
  elements["filter-search"].value = "";
  elements["photo-sort"].value = "captured-asc";
  renderPhotoCards();
});
elements["photo-select-mode"].addEventListener("click", () => {
  photoSelectionMode = !photoSelectionMode;
  if (!photoSelectionMode) selectedPhotoIds.clear();
  renderPhotoCards();
});
elements["photo-select-all"].addEventListener("click", () => {
  for (const photo of filteredPhotos()) selectedPhotoIds.add(photo.internalId);
  renderPhotoCards();
});
elements["photo-select-clear"].addEventListener("click", () => {
  selectedPhotoIds.clear();
  renderPhotoCards();
});
elements["photo-classify-selected"].addEventListener("click", () => openClassificationEditor([...selectedPhotoIds]));
elements["photo-delete-selected"].addEventListener("click", () => openPhotoDeleteDialog([...selectedPhotoIds]));
elements["show-active-photos"].addEventListener("click", async () => {
  photoListMode = "active";
  selectedPhotoIds.clear();
  photoSelectionMode = false;
  await renderPhotoView();
});
elements["show-trashed-photos"].addEventListener("click", async () => {
  photoListMode = "trashed";
  selectedPhotoIds.clear();
  photoSelectionMode = false;
  await renderPhotoView();
});
elements["close-detail"].addEventListener("click", () => elements["photo-detail"].close());
elements["detail-edit-classification"].addEventListener("click", () => {
  const id = currentDetailPhoto?.internalId;
  if (!id) return;
  elements["photo-detail"].close();
  openClassificationEditor([id]);
});
elements["detail-delete-photo"].addEventListener("click", () => {
  const photoInternalId = currentDetailPhoto?.internalId;
  if (!photoInternalId) return;
  elements["photo-detail"].close();
  openPhotoDeleteDialog([photoInternalId]);
});
elements["detail-restore-photo"].addEventListener("click", restoreCurrentPhoto);
elements["photo-detail"].addEventListener("close", () => {
  if (detailUrl) URL.revokeObjectURL(detailUrl);
  detailUrl = null;
  currentDetailPhoto = null;
  elements["detail-image"].removeAttribute("src");
});
elements["classification-form"].addEventListener("submit", saveClassificationChanges);
elements["classification-reset"].addEventListener("click", resetClassificationChanges);
for (const id of ["classification-cancel", "classification-close"]) elements[id].addEventListener("click", () => {
  if (!savingClassification) elements["classification-dialog"].close();
});
elements["classification-dialog"].addEventListener("cancel", event => {
  if (savingClassification) event.preventDefault();
});
elements["classification-dialog"].addEventListener("close", () => {
  if (!savingClassification) {
    classificationTargetIds = [];
    elements["classification-fields"].replaceChildren();
  }
});
elements["photo-delete-form"].addEventListener("submit", confirmPhotoDeletion);
elements["photo-delete-confirm-text"].addEventListener("input", () => {
  const preview = photoDeletionPreview;
  elements["photo-delete-submit"].disabled = deletingPhotos || !preview?.eligible
    || elements["photo-delete-confirm-text"].value !== photoDeleteConfirmation(preview.photoCount);
});
for (const id of ["photo-delete-cancel", "photo-delete-close"]) {
  elements[id].addEventListener("click", () => {
    if (!deletingPhotos) elements["photo-delete-dialog"].close();
  });
}
elements["photo-delete-dialog"].addEventListener("cancel", event => {
  if (deletingPhotos) event.preventDefault();
});
elements["photo-delete-dialog"].addEventListener("close", () => {
  if (!deletingPhotos) {
    photoDeletionPreview = null;
    elements["photo-delete-confirm-text"].value = "";
  }
});
elements["project-delete-form"].addEventListener("submit", confirmProjectDeletion);
elements["project-delete-confirm-name"].addEventListener("input", () => {
  const preview = projectDeletionPreview;
  elements["project-delete-submit"].disabled = deletingProject
    || !preview
    || elements["project-delete-confirm-name"].value !== projectDeletionPhrase(preview.project);
});
elements["project-delete-cancel"].addEventListener("click", () => {
  if (!deletingProject) elements["project-delete-dialog"].close();
});
elements["project-delete-close"].addEventListener("click", () => {
  if (!deletingProject) elements["project-delete-dialog"].close();
});
elements["project-delete-dialog"].addEventListener("cancel", event => {
  if (deletingProject) event.preventDefault();
});
elements["project-delete-dialog"].addEventListener("close", () => {
  if (!deletingProject) {
    projectDeletionPreview = null;
    elements["project-delete-confirm-name"].value = "";
    elements["project-delete-error"].hidden = true;
  }
});
window.addEventListener("hashchange", () => showView(location.hash.slice(1)));
window.addEventListener("beforeunload", () => { revokeThumbnailUrls(); if (detailUrl) URL.revokeObjectURL(detailUrl); });
window.addEventListener("aoalb:cloud-photos-updated", () => {
  renderProjects();
  if (!elements["view-photos"].hidden) renderPhotoView();
  if (!elements["view-ledgers"].hidden) ledgerEditor?.activate(selectedProjectUid);
});
window.addEventListener("aoalb:cloud-cache-cleared", () => {
  revokeThumbnailUrls();
  if (!elements["view-photos"].hidden) renderPhotoCards();
});

try {
  await openDatabase();
  ledgerEditor = initLedgerEditor();
  sharingController = initSiteSharing();
  accountController = initAccountUI();
  await accountController.start();
  await sharingController.start();
  await Promise.all([renderProjects(), renderHistory()]);
  showView(location.hash.slice(1) || "import");
} catch (error) {
  showResult("error", "aoALBを起動できませんでした", [error.message || "IndexedDBを利用できません。"]) ;
}
