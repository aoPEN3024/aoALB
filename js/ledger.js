import {
  getProjects, getPhotosByProjectUid, getPhotoFile,
  getLedgersByProjectId, getLedger, saveLedger
} from "./storage.js";
import {
  PRINT_TEMPLATE, automaticCaptionFields, renderLedgerPages,
  validateLedgerPages, printLedger
} from "./print.js";

export const LEDGER_SCHEMA_VERSION = 2;
export const blankSlot = () => ({ type: "blank" });
export const CAPTION_LIMITS = Object.freeze({ koushu: 200, sokuten: 200, text: 1000 });
export const LEDGER_VIEW_KEY = "aoALB:ledgerViewMode";
export const LEDGER_SELECT_KEY = "aoALB:selectedLedgerId";

const clone = value => structuredClone(value);

function normalizeSlot(slot) {
  return slot?.type === "photo" && typeof slot.photoId === "string" && slot.photoId
    ? { type: "photo", photoId: slot.photoId }
    : blankSlot();
}

function normalizeCaptionOverride(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const normalized = {};
  for (const key of Object.keys(CAPTION_LIMITS)) {
    normalized[key] = source[key] === null || source[key] === undefined
      ? null
      : typeof source[key] === "string" ? source[key] : null;
  }
  return normalized;
}

function normalizeCaptionOverrides(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [photoId, override] of Object.entries(value)) {
    if (typeof photoId === "string" && photoId) result[photoId] = normalizeCaptionOverride(override);
  }
  return result;
}

export function pagesFromSlots(slots) {
  const normalized = slots.map(normalizeSlot);
  if (!normalized.length) normalized.push(blankSlot(), blankSlot(), blankSlot());
  while (normalized.length % 3) normalized.push(blankSlot());
  const pages = [];
  for (let index = 0; index < normalized.length; index += 3) pages.push({ slots: normalized.slice(index, index + 3) });
  return pages;
}

export function flattenSlots(ledger) {
  return (ledger.pages || []).flatMap(page => (page.slots || []).map(normalizeSlot));
}

export function normalizeLedger(value) {
  const now = new Date().toISOString();
  const ledgerId = value?.ledgerId || value?.internalId || crypto.randomUUID();
  const pages = pagesFromSlots(flattenSlots(value || {}));
  return {
    internalId: value?.internalId || ledgerId,
    ledgerId,
    schemaVersion: LEDGER_SCHEMA_VERSION,
    projectId: value?.projectId || "",
    title: String(value?.title || "施工状況写真"),
    coverKoushu: String(value?.coverKoushu || ""),
    template: PRINT_TEMPLATE,
    showCover: value?.showCover !== false,
    captionOverrides: normalizeCaptionOverrides(value?.captionOverrides),
    pages,
    createdAt: value?.createdAt || now,
    updatedAt: value?.updatedAt || now
  };
}

export function createLedger(projectId, title = "施工状況写真") {
  return normalizeLedger({ projectId, title, pages: [{ slots: [blankSlot(), blankSlot(), blankSlot()] }] });
}

export function placedPhotoIds(ledger) {
  return flattenSlots(ledger).filter(slot => slot.type === "photo").map(slot => slot.photoId);
}

export function assertUniquePhotos(ledger) {
  const ids = placedPhotoIds(ledger);
  if (new Set(ids).size !== ids.length) throw new Error("同じ写真を1つの台帳へ重複配置できません。");
  return true;
}

export function captionOverrideFor(ledger, photoId) {
  return normalizeCaptionOverride(ledger?.captionOverrides?.[photoId]);
}

export function setCaptionOverride(ledger, photoId, override) {
  if (!photoId) throw new Error("写真を特定できません。");
  const normalized = normalizeCaptionOverride(override);
  for (const [key, limit] of Object.entries(CAPTION_LIMITS)) {
    if ([...String(normalized[key] ?? "")].length > limit) throw new Error(`${key}の文字数が上限を超えています。`);
  }
  const next = clone(ledger);
  next.captionOverrides ||= {};
  if (Object.values(normalized).every(value => value === null)) delete next.captionOverrides[photoId];
  else next.captionOverrides[photoId] = normalized;
  return next;
}

function withSlots(ledger, slots) {
  const next = clone(ledger);
  next.pages = pagesFromSlots(slots);
  assertUniquePhotos(next);
  return next;
}

export function autoArrangeLedger(ledger, photos) {
  const ordered = [...photos].sort((a, b) => (a.capturedAt || "").localeCompare(b.capturedAt || ""));
  return withSlots(ledger, ordered.map(photo => ({ type: "photo", photoId: photo.internalId })));
}

export function placePhoto(ledger, slotIndex, photoId) {
  const slots = flattenSlots(ledger);
  if (slotIndex < 0 || slotIndex >= slots.length) return ledger;
  const existing = slots.findIndex(slot => slot.type === "photo" && slot.photoId === photoId);
  if (existing >= 0 && existing !== slotIndex) throw new Error("この写真はすでに台帳へ配置されています。");
  slots[slotIndex] = { type: "photo", photoId };
  return withSlots(ledger, slots);
}

export function swapSlots(ledger, fromIndex, toIndex) {
  const slots = flattenSlots(ledger);
  if (fromIndex < 0 || toIndex < 0 || fromIndex >= slots.length || toIndex >= slots.length || fromIndex === toIndex) return ledger;
  [slots[fromIndex], slots[toIndex]] = [slots[toIndex], slots[fromIndex]];
  return withSlots(ledger, slots);
}

export function moveSlot(ledger, index, direction) {
  return swapSlots(ledger, index, index + direction);
}

export function unplacePhoto(ledger, index) {
  const slots = flattenSlots(ledger);
  if (index >= 0 && index < slots.length) slots[index] = blankSlot();
  return withSlots(ledger, slots);
}

export function insertBlank(ledger, index) {
  const slots = flattenSlots(ledger);
  const canReuseTrailingBlank = slots.at(-1)?.type === "blank";
  slots.splice(Math.max(0, Math.min(index, slots.length)), 0, blankSlot());
  if (canReuseTrailingBlank) slots.pop();
  return withSlots(ledger, slots);
}

export function removeBlank(ledger, index) {
  const slots = flattenSlots(ledger);
  if (slots[index]?.type !== "blank" || slots.length <= 3) return ledger;
  slots.splice(index, 1);
  return withSlots(ledger, slots);
}

export function addBlankPage(ledger) {
  return withSlots(ledger, [...flattenSlots(ledger), blankSlot(), blankSlot(), blankSlot()]);
}

export function removeBlankPage(ledger, pageIndex) {
  if (ledger.pages.length <= 1 || !ledger.pages[pageIndex]?.slots.every(slot => slot.type === "blank")) return ledger;
  const next = clone(ledger);
  next.pages.splice(pageIndex, 1);
  return normalizeLedger(next);
}

function option(text, value = "") {
  const item = document.createElement("option");
  item.value = value;
  item.textContent = text;
  return item;
}

function setOptions(select, values, allLabel = "すべて") {
  const current = select.value;
  const unique = [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja"));
  select.replaceChildren(option(allLabel), ...unique.map(value => option(value, value)));
  select.value = unique.includes(current) ? current : "";
}

function element(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== "") node.textContent = text;
  return node;
}

function releaseUrls(urls) {
  for (const url of urls) URL.revokeObjectURL(url);
  urls.clear();
}

export function initLedgerEditor() {
  const byId = id => document.getElementById(id);
  const ui = {
    project: byId("ledger-project"), select: byId("ledger-select"), create: byId("ledger-new"),
    title: byId("ledger-title"), showCover: byId("ledger-show-cover"), auto: byId("ledger-auto"),
    addPage: byId("ledger-add-page"), print: byId("ledger-print"), status: byId("ledger-save-status"),
    viewModes: [...document.querySelectorAll('input[name="ledger-view-mode"]')], viewNote: byId("ledger-view-note"),
    workspace: byId("ledger-workspace"), photoList: byId("ledger-photo-list"), unplacedCount: byId("ledger-unplaced-count"),
    empty: byId("ledger-photo-empty"), preview: byId("ledger-preview-pane"), pages: byId("ledger-pages"), guide: byId("ledger-empty-guide"),
    warnings: byId("ledger-warning-panel"), tabPhotos: byId("ledger-tab-photos"), tabPages: byId("ledger-tab-pages"),
    mobileUnplaced: byId("ledger-mobile-unplaced"),
    captionDialog: byId("caption-editor"), captionForm: byId("caption-editor-form"),
    captionPhoto: byId("caption-editor-photo"), captionError: byId("caption-editor-error"),
    captionClose: byId("caption-editor-close"), captionCancel: byId("caption-editor-cancel"),
    captionReset: byId("caption-editor-reset"), captionSave: byId("caption-editor-save"),
    captionInputs: { koushu: byId("caption-koushu"), sokuten: byId("caption-sokuten"), text: byId("caption-text") },
    filters: {
      koushu: byId("ledger-filter-koushu"), shubetsu: byId("ledger-filter-shubetsu"),
      saibetsu: byId("ledger-filter-saibetsu"), sokuten: byId("ledger-filter-sokuten"),
      search: byId("ledger-filter-search")
    }, clearFilters: byId("ledger-clear-filters")
  };
  let projects = [];
  let currentProject = null;
  let photos = [];
  let ledgers = [];
  let currentLedger = null;
  let selectedPhotoId = "";
  let selectedSlotIndex = -1;
  let active = false;
  let mutationQueue = Promise.resolve();
  let previewUrls = new Set();
  let libraryUrls = new Set();
  let libraryObserver = null;
  let validation = { valid: false, empty: true, issues: [] };
  let viewMode = localStorage.getItem(LEDGER_VIEW_KEY) === "spread" ? "spread" : "single";
  let captionEditor = null;
  let previewResizeObserver = null;
  let previewScaleFrame = 0;
  let previewValidationTimer = 0;
  const mobileScroll = { photos: 0, pages: 0 };
  const narrowScreen = window.matchMedia("(max-width: 900px)");

  function status(message, error = false) {
    ui.status.textContent = message;
    ui.status.classList.toggle("error", error);
  }

  function clearLibraryUrls() {
    libraryObserver?.disconnect();
    libraryObserver = null;
    releaseUrls(libraryUrls);
  }

  function selectedProjectUid() {
    return ui.project.value;
  }

  function effectiveViewMode() {
    return viewMode === "spread" && !narrowScreen.matches ? "spread" : "single";
  }

  function applyViewMode() {
    const effective = effectiveViewMode();
    ui.pages.dataset.layout = effective;
    ui.viewNote.hidden = !(viewMode === "spread" && narrowScreen.matches);
    for (const control of ui.viewModes) {
      control.checked = control.value === effective;
      control.disabled = control.value === "spread" && narrowScreen.matches;
    }
    schedulePreviewScale();
    schedulePreviewValidation();
  }

  function updatePreviewScale() {
    previewScaleFrame = 0;
    const page = ui.pages.querySelector(".ledger-page");
    if (!page || !ui.pages.clientWidth) return;
    const baseWidth = page.offsetWidth;
    const baseHeight = page.offsetHeight;
    if (!baseWidth || !baseHeight) return;
    const columns = effectiveViewMode() === "spread" ? 2 : 1;
    const gap = Number.parseFloat(getComputedStyle(ui.pages).columnGap) || 0;
    const availableWidth = Math.max(0, ui.pages.clientWidth - (gap * (columns - 1)));
    const scale = Math.max(0.01, Math.min(1, availableWidth / (baseWidth * columns)));
    ui.pages.style.setProperty("--ledger-preview-scale", String(scale));
    ui.pages.style.setProperty("--ledger-frame-width", `${baseWidth * scale}px`);
    ui.pages.style.setProperty("--ledger-frame-height", `${baseHeight * scale}px`);
    const nextScale = scale.toFixed(6);
    const changed = ui.pages.dataset.previewScale !== nextScale;
    ui.pages.dataset.previewScale = nextScale;
    if (changed) schedulePreviewValidation();
  }

  function schedulePreviewScale() {
    if (previewScaleFrame) cancelAnimationFrame(previewScaleFrame);
    previewScaleFrame = requestAnimationFrame(updatePreviewScale);
  }

  function startPreviewObserver() {
    if (previewResizeObserver || typeof ResizeObserver === "undefined") return;
    previewResizeObserver = new ResizeObserver(schedulePreviewScale);
    previewResizeObserver.observe(ui.preview);
    document.fonts?.ready?.then(schedulePreviewValidation);
  }

  function stopPreviewObserver() {
    previewResizeObserver?.disconnect();
    previewResizeObserver = null;
    if (previewScaleFrame) cancelAnimationFrame(previewScaleFrame);
    previewScaleFrame = 0;
    if (previewValidationTimer) clearTimeout(previewValidationTimer);
    previewValidationTimer = 0;
  }

  function photoById(photoId) {
    return photos.find(photo => photo.internalId === photoId) || null;
  }

  function closeCaptionEditor() {
    captionEditor = null;
    if (ui.captionDialog.open) ui.captionDialog.close();
  }

  function setCaptionEditorField(key, mode, value) {
    if (!captionEditor) return;
    captionEditor.modes[key] = mode;
    ui.captionInputs[key].value = value;
    ui.captionInputs[key].dataset.mode = mode;
    ui.captionInputs[key].closest(".caption-editor-field")?.classList.toggle("uses-automatic", mode === "auto");
  }

  function openCaptionEditor(slotIndex) {
    const slot = flattenSlots(currentLedger)[slotIndex];
    const photo = slot?.type === "photo" ? photoById(slot.photoId) : null;
    if (!photo) return;
    const automatic = automaticCaptionFields(photo);
    const existing = currentLedger.captionOverrides?.[photo.internalId] || {};
    captionEditor = { slotIndex, photoId: photo.internalId, automatic, modes: {} };
    ui.captionPhoto.textContent = `写真枠${slotIndex + 1}：${photo.ledger?.title || photo.classification?.saibetsu || "台帳文なし"}`;
    ui.captionError.hidden = true;
    for (const key of Object.keys(CAPTION_LIMITS)) {
      const overridden = Object.prototype.hasOwnProperty.call(existing, key) && existing[key] !== null;
      setCaptionEditorField(key, overridden ? "override" : "auto", overridden ? existing[key] : automatic[key]);
      const note = ui.captionInputs[key].closest(".caption-editor-field")?.querySelector(".caption-auto-value");
      if (note) note.textContent = `自動文言：${automatic[key] || "（空欄）"}`;
    }
    ui.captionDialog.showModal();
    ui.captionInputs.koushu.focus();
  }

  function renderProjectOptions(preferredUid = "") {
    const value = preferredUid || ui.project.value;
    ui.project.replaceChildren(option("工事を選択してください"), ...projects.map(project => option(project.name, project.projectUid)));
    if (projects.some(project => project.projectUid === value)) ui.project.value = value;
  }

  function renderLedgerOptions() {
    ui.select.replaceChildren(option(ledgers.length ? "台帳を選択してください" : "台帳はまだありません"), ...ledgers.map(ledger => option(ledger.title, ledger.internalId)));
    if (currentLedger && ledgers.some(ledger => ledger.internalId === currentLedger.internalId)) ui.select.value = currentLedger.internalId;
  }

  function setupFilters() {
    for (const key of ["koushu", "shubetsu", "saibetsu", "sokuten"]) {
      setOptions(ui.filters[key], photos.map(photo => photo.classification?.[key] || ""));
    }
  }

  function filteredUnplaced() {
    if (!currentLedger) return [];
    const used = new Set(placedPhotoIds(currentLedger));
    const query = ui.filters.search.value.trim().toLocaleLowerCase("ja");
    return photos.filter(photo => {
      if (used.has(photo.internalId)) return false;
      const classification = photo.classification || {};
      for (const key of ["koushu", "shubetsu", "saibetsu", "sokuten"]) {
        if (ui.filters[key].value && classification[key] !== ui.filters[key].value) return false;
      }
      if (query) {
        const text = [...Object.values(classification), photo.ledger?.title, photo.ledger?.description].filter(Boolean).join(" ").toLocaleLowerCase("ja");
        if (!text.includes(query)) return false;
      }
      return true;
    }).sort((a, b) => (a.capturedAt || "").localeCompare(b.capturedAt || ""));
  }

  function observeLibraryImages() {
    libraryObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const image = entry.target;
        libraryObserver.unobserve(image);
        getPhotoFile(image.dataset.photoId).then(file => {
          if (!file?.blob || !image.isConnected) return;
          const url = URL.createObjectURL(file.blob);
          libraryUrls.add(url);
          image.src = url;
        }).catch(() => { image.alt = "画像を読み込めません"; });
      }
    }, { rootMargin: "200px" });
    ui.photoList.querySelectorAll("img[data-photo-id]").forEach(image => libraryObserver.observe(image));
  }

  function renderLibrary() {
    clearLibraryUrls();
    const available = filteredUnplaced();
    ui.unplacedCount.textContent = `${available.length}枚`;
    ui.mobileUnplaced.textContent = String(available.length);
    const cards = available.map(photo => {
      const card = element("button", `ledger-photo-card${selectedPhotoId === photo.internalId ? " selected" : ""}`);
      card.type = "button";
      card.draggable = true;
      card.dataset.photoId = photo.internalId;
      const image = document.createElement("img");
      image.alt = "";
      image.dataset.photoId = photo.internalId;
      const info = element("span", "ledger-photo-card-info");
      info.append(element("strong", "", photo.ledger?.title || photo.classification?.saibetsu || "台帳文なし"));
      info.append(element("small", "", [photo.classification?.koushu, photo.classification?.sokuten].filter(Boolean).join(" / ") || "未分類"));
      card.append(image, info);
      card.addEventListener("click", () => {
        selectedPhotoId = selectedPhotoId === photo.internalId ? "" : photo.internalId;
        selectedSlotIndex = -1;
        renderLibrary();
        status(selectedPhotoId ? "配置先の枠をタップしてください。" : "写真の選択を解除しました。");
      });
      card.addEventListener("dragstart", event => {
        event.dataTransfer.setData("application/x-aoalb-photo", photo.internalId);
        event.dataTransfer.effectAllowed = "move";
      });
      return card;
    });
    ui.photoList.replaceChildren(...cards);
    ui.empty.hidden = cards.length > 0;
    if (cards.length) observeLibraryImages();
  }

  function renderWarnings(result) {
    validation = result;
    ui.warnings.replaceChildren();
    if (result.empty) {
      ui.warnings.append(element("strong", "", "写真を1枚以上配置してください。"));
      ui.warnings.hidden = false;
      ui.print.disabled = true;
      return;
    }
    if (!result.issues.length) {
      ui.warnings.hidden = true;
      ui.print.disabled = false;
      return;
    }
    ui.warnings.append(element("strong", "", "最小文字サイズでも枠内に収まらない項目があります。文字を短くしてください。"));
    const list = document.createElement("ul");
    for (const issue of result.issues) {
      const fields = issue.fields.map(field => `${field.label}（${field.count}文字）`).join("、");
      const item = element("li");
      if (issue.kind === "cover") {
        item.append(document.createTextNode(`表紙: ${fields}`));
      } else {
        item.append(document.createTextNode(`写真枠${issue.index + 1}: ${fields} `));
        const edit = element("button", "ledger-warning-edit", "文言を編集");
        edit.type = "button";
        edit.addEventListener("click", () => openCaptionEditor(issue.index));
        item.append(edit);
      }
      list.append(item);
    }
    ui.warnings.append(list);
    ui.warnings.hidden = false;
    ui.print.disabled = true;
  }

  function bindPreviewActions() {
    for (const button of ui.pages.querySelectorAll("[data-ledger-action]")) {
      button.addEventListener("click", event => {
        event.stopPropagation();
        const index = Number(button.dataset.slotIndex);
        const action = button.dataset.ledgerAction;
        if (action === "edit-caption") return openCaptionEditor(index);
        if (action === "move-prev") mutate(ledger => moveSlot(ledger, index, -1));
        if (action === "move-next") mutate(ledger => moveSlot(ledger, index, 1));
        if (action === "blank-before") mutate(ledger => insertBlank(ledger, index));
        if (action === "blank-after") mutate(ledger => insertBlank(ledger, index + 1));
        if (action === "unplace") mutate(ledger => unplacePhoto(ledger, index));
        if (action === "remove-blank") mutate(ledger => removeBlank(ledger, index));
      });
    }
    for (const button of ui.pages.querySelectorAll("[data-delete-page]")) {
      button.addEventListener("click", () => mutate(ledger => removeBlankPage(ledger, Number(button.dataset.deletePage))));
    }
    for (const slot of ui.pages.querySelectorAll(".ledger-slot[data-slot-index]")) {
      const index = Number(slot.dataset.slotIndex);
      slot.addEventListener("click", event => {
        if (event.target.closest("button")) return;
        if (selectedPhotoId) {
          mutate(ledger => placePhoto(ledger, index, selectedPhotoId)).then(success => { if (success) selectedPhotoId = ""; });
          return;
        }
        const slotData = flattenSlots(currentLedger)[index];
        if (selectedSlotIndex >= 0 && selectedSlotIndex !== index) {
          mutate(ledger => swapSlots(ledger, selectedSlotIndex, index));
          selectedSlotIndex = -1;
        } else if (slotData?.type === "photo") {
          selectedSlotIndex = selectedSlotIndex === index ? -1 : index;
          renderPreview();
          status(selectedSlotIndex >= 0 ? "入れ替え先の枠をタップしてください。" : "枠の選択を解除しました。");
        }
      });
      slot.addEventListener("dragover", event => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; });
      slot.addEventListener("drop", event => {
        event.preventDefault();
        const photoId = event.dataTransfer.getData("application/x-aoalb-photo");
        const source = event.dataTransfer.getData("application/x-aoalb-slot");
        if (photoId) mutate(ledger => placePhoto(ledger, index, photoId));
        else if (source !== "") mutate(ledger => swapSlots(ledger, Number(source), index));
      });
      slot.addEventListener("dragstart", event => {
        event.dataTransfer.setData("application/x-aoalb-slot", String(index));
        event.dataTransfer.effectAllowed = "move";
      });
      slot.addEventListener("dblclick", event => {
        if (event.target.closest("button")) return;
        const slotData = flattenSlots(currentLedger)[index];
        if (slotData?.type === "photo") openCaptionEditor(index);
      });
    }
    for (const field of ui.pages.querySelectorAll('[data-ledger-cover-field="koushu"]')) {
      field.contentEditable = "true";
      field.spellcheck = false;
      field.title = "ダブルクリックで工種を編集（空にすると自動反映に戻ります）";
      field.addEventListener("blur", () => {
        const text = field.textContent.trim();
        mutate(ledger => { ledger.coverKoushu = text; return ledger; });
      });
      field.addEventListener("keydown", event => {
        if (event.key === "Enter") { event.preventDefault(); field.blur(); }
      });
    }
  }

  async function validatePreview() {
    const images = [...ui.pages.querySelectorAll("img")];
    await Promise.all(images.map(image => image.decode?.().catch(() => {}) || Promise.resolve()));
    return validateLedgerPages(ui.pages, photos, currentLedger);
  }

  function schedulePreviewValidation() {
    if (!active || !currentLedger) return;
    if (previewValidationTimer) clearTimeout(previewValidationTimer);
    const ledgerId = currentLedger.internalId;
    previewValidationTimer = setTimeout(async () => {
      previewValidationTimer = 0;
      if (!active || currentLedger?.internalId !== ledgerId) return;
      const result = await validatePreview();
      if (active && currentLedger?.internalId === ledgerId) renderWarnings(result);
    }, 80);
  }

  async function renderPreview() {
    releaseUrls(previewUrls);
    if (!currentLedger || !currentProject) {
      ui.pages.replaceChildren();
      ui.guide.hidden = false;
      ui.print.disabled = true;
      return;
    }
    ui.guide.hidden = true;
    const rendered = await renderLedgerPages(ui.pages, {
      ledger: currentLedger, project: currentProject, photos, loadPhotoFile: getPhotoFile,
      interactive: true, selectedSlotIndex
    });
    previewUrls = rendered.objectUrls;
    bindPreviewActions();
    applyViewMode();
    updatePreviewScale();
    renderWarnings(await validatePreview());
  }

  async function renderAll() {
    ui.title.value = currentLedger?.title || "施工状況写真";
    ui.showCover.checked = currentLedger?.showCover !== false;
    ui.title.disabled = !currentLedger;
    ui.showCover.disabled = !currentLedger;
    ui.auto.disabled = !currentLedger;
    ui.addPage.disabled = !currentLedger;
    renderLedgerOptions();
    renderLibrary();
    await renderPreview();
  }

  function mutate(transform, { preserveSelection = false } = {}) {
    const requestedLedgerId = currentLedger?.internalId || "";
    const run = async () => {
      if (!currentLedger || currentLedger.internalId !== requestedLedgerId) return false;
      const previous = clone(currentLedger);
      let transformed = null;
      try {
        status("保存中…");
        transformed = normalizeLedger(transform(clone(currentLedger)) || currentLedger);
        assertUniquePhotos(transformed);
        transformed.updatedAt = new Date().toISOString();
        currentLedger = transformed;
        await saveLedger(transformed);
        if (currentLedger?.internalId !== transformed.internalId || currentProject?.internalId !== transformed.projectId) return true;
        const listIndex = ledgers.findIndex(item => item.internalId === transformed.internalId);
        if (listIndex >= 0) ledgers[listIndex] = clone(transformed);
        else ledgers.push(clone(transformed));
        if (!preserveSelection) selectedSlotIndex = -1;
        await renderAll();
        status("保存しました");
        return true;
      } catch (error) {
        if (!transformed || currentLedger?.internalId === transformed.internalId) {
          currentLedger = previous;
          await renderAll();
          status(`保存できませんでした。直前の状態を維持しています。${error.message || ""}`, true);
        }
        return false;
      }
    };
    const result = mutationQueue.then(run, run);
    mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function loadProject(projectUid, preferredLedgerId = "") {
    releaseUrls(previewUrls);
    clearLibraryUrls();
    currentProject = projects.find(project => project.projectUid === projectUid) || null;
    photos = currentProject ? await getPhotosByProjectUid(currentProject.projectUid) : [];
    ledgers = currentProject ? (await getLedgersByProjectId(currentProject.internalId)).map(normalizeLedger) : [];
    currentLedger = preferredLedgerId ? ledgers.find(item => item.internalId === preferredLedgerId) || null : ledgers[0] || null;
    selectedPhotoId = "";
    selectedSlotIndex = -1;
    setupFilters();
    await renderAll();
  }

  async function activate(preferredProjectUid = "") {
    active = true;
    startPreviewObserver();
    projects = await getProjects();
    renderProjectOptions(preferredProjectUid);
    await loadProject(selectedProjectUid(), localStorage.getItem(LEDGER_SELECT_KEY) || "");
  }

  function deactivate() {
    active = false;
    closeCaptionEditor();
    stopPreviewObserver();
    releaseUrls(previewUrls);
    clearLibraryUrls();
  }

  ui.project.addEventListener("change", () => {
    const projectUid = selectedProjectUid();
    if (projectUid) localStorage.setItem("aoALB:selectedProjectUid", projectUid);
    else localStorage.removeItem("aoALB:selectedProjectUid");
    loadProject(projectUid);
  });
  ui.select.addEventListener("change", async () => {
    if (ui.select.value) localStorage.setItem(LEDGER_SELECT_KEY, ui.select.value);
    else localStorage.removeItem(LEDGER_SELECT_KEY);
    currentLedger = ui.select.value ? normalizeLedger(await getLedger(ui.select.value)) : null;
    selectedPhotoId = "";
    selectedSlotIndex = -1;
    await renderAll();
  });
  ui.create.addEventListener("click", async () => {
    if (!currentProject) return status("先に工事を選択してください。", true);
    const ledger = createLedger(currentProject.internalId);
    try {
      await saveLedger(ledger);
      ledgers.push(ledger);
      currentLedger = ledger;
      await renderAll();
      status("新しい台帳を作成しました。");
    } catch (error) {
      status(`台帳を作成できませんでした。${error.message || ""}`, true);
    }
  });
  ui.title.addEventListener("change", () => mutate(ledger => { ledger.title = ui.title.value.trim() || "施工状況写真"; return ledger; }));
  ui.showCover.addEventListener("change", () => mutate(ledger => { ledger.showCover = ui.showCover.checked; return ledger; }));
  ui.auto.addEventListener("click", () => mutate(ledger => autoArrangeLedger(ledger, photos)));
  ui.addPage.addEventListener("click", () => mutate(addBlankPage));
  ui.print.addEventListener("click", async () => {
    const result = await validatePreview();
    renderWarnings(result);
    if (!validation.valid) return status("印刷できない項目があります。警告内容を確認してください。", true);
    await printLedger(ui.pages, photos, currentLedger, result);
  });
  for (const control of ui.viewModes) {
    control.addEventListener("change", () => {
      if (!control.checked) return;
      viewMode = control.value === "spread" ? "spread" : "single";
      localStorage.setItem(LEDGER_VIEW_KEY, viewMode);
      applyViewMode();
    });
  }
  if (narrowScreen.addEventListener) narrowScreen.addEventListener("change", applyViewMode);
  else narrowScreen.addListener(applyViewMode);
  for (const key of ["koushu", "shubetsu", "saibetsu", "sokuten"]) ui.filters[key].addEventListener("change", renderLibrary);
  ui.filters.search.addEventListener("input", renderLibrary);
  ui.clearFilters.addEventListener("click", () => {
    for (const key of ["koushu", "shubetsu", "saibetsu", "sokuten"]) ui.filters[key].value = "";
    ui.filters.search.value = "";
    renderLibrary();
  });
  function setMobilePane(pane) {
    const previous = ui.workspace.dataset.mobilePane || "photos";
    mobileScroll[previous] = window.scrollY;
    ui.workspace.dataset.mobilePane = pane;
    ui.tabPhotos.setAttribute("aria-selected", String(pane === "photos"));
    ui.tabPages.setAttribute("aria-selected", String(pane === "pages"));
    requestAnimationFrame(() => window.scrollTo({ top: mobileScroll[pane] || 0, behavior: "auto" }));
    schedulePreviewScale();
  }
  ui.tabPhotos.addEventListener("click", () => setMobilePane("photos"));
  ui.tabPages.addEventListener("click", () => setMobilePane("pages"));
  for (const [key, input] of Object.entries(ui.captionInputs)) {
    input.addEventListener("input", () => {
      if (!captionEditor) return;
      captionEditor.modes[key] = "override";
      input.dataset.mode = "override";
      input.closest(".caption-editor-field")?.classList.remove("uses-automatic");
    });
  }
  for (const button of document.querySelectorAll("[data-caption-auto]")) {
    button.addEventListener("click", () => {
      const key = button.dataset.captionAuto;
      if (captionEditor && key in CAPTION_LIMITS) setCaptionEditorField(key, "auto", captionEditor.automatic[key]);
    });
  }
  for (const button of document.querySelectorAll("[data-caption-blank]")) {
    button.addEventListener("click", () => {
      const key = button.dataset.captionBlank;
      if (captionEditor && key in CAPTION_LIMITS) setCaptionEditorField(key, "override", "");
    });
  }
  ui.captionReset.addEventListener("click", () => {
    if (!captionEditor) return;
    for (const key of Object.keys(CAPTION_LIMITS)) setCaptionEditorField(key, "auto", captionEditor.automatic[key]);
  });
  ui.captionClose.addEventListener("click", closeCaptionEditor);
  ui.captionCancel.addEventListener("click", closeCaptionEditor);
  ui.captionForm.addEventListener("submit", event => {
    event.preventDefault();
    if (!captionEditor) return;
    const { photoId, slotIndex, modes } = captionEditor;
    const override = {};
    for (const [key, limit] of Object.entries(CAPTION_LIMITS)) {
      const value = ui.captionInputs[key].value;
      if ([...value].length > limit) {
        ui.captionError.textContent = `${key === "text" ? "台帳文" : key === "koushu" ? "工種" : "測点"}は${limit}文字以内で入力してください。`;
        ui.captionError.hidden = false;
        return;
      }
      override[key] = modes[key] === "auto" ? null : value;
    }
    closeCaptionEditor();
    selectedSlotIndex = slotIndex;
    mutate(ledger => setCaptionOverride(ledger, photoId, override), { preserveSelection: true });
  });
  ui.captionDialog.addEventListener("cancel", event => { event.preventDefault(); closeCaptionEditor(); });
  applyViewMode();
  window.addEventListener("beforeunload", () => { stopPreviewObserver(); releaseUrls(previewUrls); clearLibraryUrls(); });

  return { activate, deactivate, get active() { return active; } };
}
