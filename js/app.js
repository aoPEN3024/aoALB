import { validateAoalbZip, ImportValidationError } from "./importer.js";
import {
  openDatabase, getImportByExportId, getProjects, getImports, getPhotosByProjectUid,
  getPhotoFile, analyzeImportConflicts, saveValidatedImport, recordFailedImport
} from "./storage.js";

const views = ["import", "projects", "photos", "history"];
const elements = Object.fromEntries(Array.from(document.querySelectorAll("[id]"), element => [element.id, element]));
let selectedProjectUid = localStorage.getItem("aoALB:selectedProjectUid") || "";
let currentProject = null;
let allPhotos = [];
let pendingImport = null;
let importing = false;
let detailUrl = null;
let thumbnailObserver = null;
const thumbnailUrls = new Set();

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
  for (const view of views) elements[`view-${view}`].hidden = view !== target;
  document.querySelectorAll("[data-view]").forEach(button => button.classList.toggle("active", button.dataset.view === target));
  if (target !== "photos") revokeThumbnailUrls();
  if (target === "projects") renderProjects();
  if (target === "photos") renderPhotoView();
  if (target === "history") renderHistory();
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
    const messages = error instanceof ImportValidationError ? error.errors : [error?.message || "取込み処理に失敗しました。"];
    failureContext = { ...failureContext, ...(error.context || {}) };
    showResult("error", "ZIPを取り込めませんでした", [...messages, "工事と写真は保存されていません。"]);
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
    const count = (await getPhotosByProjectUid(project.projectUid)).length;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "project-card";
    button.append(textElement("h2", project.name), textElement("p", `施工者: ${project.contractor || "―"}`));
    const meta = document.createElement("div");
    meta.className = "project-meta";
    meta.append(textElement("span", `写真 ${count}件`), textElement("span", `最終取込 ${formatDate(project.lastImportedAt)}`));
    button.append(meta, textElement("p", `ID ${shortId(project.projectUid)}`));
    button.addEventListener("click", () => {
      selectedProjectUid = project.projectUid;
      localStorage.setItem("aoALB:selectedProjectUid", selectedProjectUid);
      showView("photos");
    });
    return button;
  }));
  elements["project-list"].replaceChildren(...cards);
  elements["project-empty"].hidden = cards.length > 0;
}

function setSelectOptions(select, values) {
  const current = select.value;
  const options = [new Option("すべて", ""), ...Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b, "ja")).map(value => new Option(value, value))];
  select.replaceChildren(...options);
  select.value = options.some(option => option.value === current) ? current : "";
}

function setupFilterOptions() {
  setSelectOptions(elements["filter-koushu"], allPhotos.map(photo => photo.classification.koushu));
  setSelectOptions(elements["filter-shubetsu"], allPhotos.map(photo => photo.classification.shubetsu));
  setSelectOptions(elements["filter-saibetsu"], allPhotos.map(photo => photo.classification.saibetsu));
  setSelectOptions(elements["filter-sokuten"], allPhotos.map(photo => photo.classification.sokuten));
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
    if (Object.entries(filters).some(([key, value]) => value && photo.classification[key] !== value)) return false;
    if (unclassified && Object.values(photo.classification).some(value => value.trim())) return false;
    if (query) {
      const searchable = [...Object.values(photo.classification), photo.ledger.title, photo.ledger.description, photo.capturedAt].join(" ").toLocaleLowerCase("ja");
      if (!searchable.includes(query)) return false;
    }
    return true;
  });
  const sort = elements["photo-sort"].value;
  result.sort((a, b) => {
    if (sort === "captured-desc") return (b.capturedAt || "").localeCompare(a.capturedAt || "");
    if (sort === "koushu") return (a.classification.koushu || "").localeCompare(b.classification.koushu || "", "ja") || (a.capturedAt || "").localeCompare(b.capturedAt || "");
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
    textElement("h2", photo.ledger.title || photo.classification.saibetsu || "（台帳タイトルなし）"),
    textElement("p", formatDate(photo.capturedAt)),
    textElement("p", [photo.classification.koushu, photo.classification.sokuten].filter(Boolean).join(" / ") || "未分類")
  );
  button.append(image, info);
  button.addEventListener("click", () => showPhotoDetail(photo));
  return button;
}

function observeThumbnails() {
  thumbnailObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const image = entry.target;
      thumbnailObserver.unobserve(image);
      getPhotoFile(image.dataset.photoInternalId).then(file => {
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
}

async function renderPhotoView() {
  const projects = await getProjects();
  currentProject = projects.find(project => project.projectUid === selectedProjectUid) || null;
  if (!currentProject) {
    elements["selected-project-name"].textContent = "工事一覧から工事を選択してください。";
    allPhotos = [];
  } else {
    elements["selected-project-name"].textContent = `${currentProject.name} / ${currentProject.contractor || "施工者未設定"}`;
    allPhotos = await getPhotosByProjectUid(currentProject.projectUid);
  }
  setupFilterOptions();
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
  if (detailUrl) URL.revokeObjectURL(detailUrl);
  detailUrl = null;
  elements["detail-image"].removeAttribute("src");
  const file = await getPhotoFile(photo.internalId);
  if (file?.blob) {
    detailUrl = URL.createObjectURL(file.blob);
    elements["detail-image"].src = detailUrl;
  }
  const c = photo.classification;
  const b = photo.boardSnapshot;
  elements["detail-fields"].replaceChildren(
    detailGroup("工事", [["工事名", currentProject?.name], ["施工者", currentProject?.contractor], ["撮影日時", formatDate(photo.capturedAt)]]),
    detailGroup("分類情報", [["工種", c.koushu], ["種別", c.shubetsu], ["細別", c.saibetsu], ["測点", c.sokuten], ["摘要", c.tekiyo]]),
    detailGroup("撮影時の黒板", [["工事名", b.koujimei], ["施工者", b.contractor], ["工種", b.koushu], ["種別", b.shubetsu], ["細別", b.saibetsu], ["測点", b.sokuten], ["摘要", b.tekiyo]]),
    detailGroup("台帳情報", [["タイトル", photo.ledger.title], ["説明文", photo.ledger.description], ["手動編集", photo.ledger.manual ? "はい" : "いいえ"]]),
    detailGroup("ファイル情報", [["photoUid", photo.photoUid], ["SHA-256", photo.sha256], ["画像サイズ", `${photo.width} × ${photo.height}px`], ["ファイル容量", `${photo.bytes.toLocaleString("ja-JP")} bytes`]])
  );
  elements["photo-detail"].showModal();
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
elements["keep-existing"].addEventListener("click", () => pendingImport && persistValidated(pendingImport, "preserve").catch(error => showResult("error", "保存できませんでした", [error.message])));
elements["update-existing"].addEventListener("click", () => pendingImport && persistValidated(pendingImport, "update").catch(error => showResult("error", "保存できませんでした", [error.message])));

for (const id of ["filter-koushu", "filter-shubetsu", "filter-saibetsu", "filter-sokuten", "filter-unclassified", "photo-sort"]) elements[id].addEventListener("change", renderPhotoCards);
elements["filter-search"].addEventListener("input", renderPhotoCards);
elements["clear-filters"].addEventListener("click", () => {
  for (const id of ["filter-koushu", "filter-shubetsu", "filter-saibetsu", "filter-sokuten"]) elements[id].value = "";
  elements["filter-unclassified"].checked = false;
  elements["filter-search"].value = "";
  elements["photo-sort"].value = "captured-asc";
  renderPhotoCards();
});
elements["close-detail"].addEventListener("click", () => elements["photo-detail"].close());
elements["photo-detail"].addEventListener("close", () => { if (detailUrl) URL.revokeObjectURL(detailUrl); detailUrl = null; elements["detail-image"].removeAttribute("src"); });
window.addEventListener("hashchange", () => showView(location.hash.slice(1)));
window.addEventListener("beforeunload", () => { revokeThumbnailUrls(); if (detailUrl) URL.revokeObjectURL(detailUrl); });

try {
  await openDatabase();
  await Promise.all([renderProjects(), renderHistory()]);
  showView(location.hash.slice(1) || "import");
} catch (error) {
  showResult("error", "aoALBを起動できませんでした", [error.message || "IndexedDBを利用できません。"]) ;
}
