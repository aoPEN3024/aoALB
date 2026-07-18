export const PRINT_TEMPLATE = "construction-3";
export const LEDGER_FONT_SIZES = Object.freeze([10.5, 10, 9.5, 9, 8.5, 8]);

const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

function element(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== "") node.textContent = text;
  return node;
}

function captionText(photo) {
  const title = String(photo?.ledger?.title || "").trim();
  return title || String(photo?.ledger?.description || "").trim();
}

function captionFields(photo) {
  const classification = photo?.classification || {};
  return {
    koushu: String(classification.koushu || ""),
    sokuten: String(classification.sokuten || ""),
    caption: captionText(photo),
    captionLabel: String(photo?.ledger?.title || "").trim() ? "台帳タイトル" : "台帳説明文"
  };
}

function addGuides(body) {
  for (const name of ["g1", "g2", "g3"]) body.append(element("span", `ledger-caption-guide ${name}`));
}

function createCaption(photo) {
  const values = captionFields(photo);
  const caption = element("div", "ledger-caption");
  const koushu = element("div", "ledger-caption-field");
  koushu.dataset.ledgerField = "koushu";
  koushu.append(element("span", "ledger-caption-field-content", `工種：${values.koushu}`));
  const sokuten = element("div", "ledger-caption-field");
  sokuten.dataset.ledgerField = "sokuten";
  sokuten.append(element("span", "ledger-caption-field-content", `測点：${values.sokuten}`));
  const body = element("div", "ledger-caption-body");
  body.dataset.ledgerField = "caption";
  body.append(element("span", "ledger-caption-body-text", values.caption));
  addGuides(body);
  caption.append(koushu, sokuten, body);
  return caption;
}

function createSlotActions(slotIndex, slot) {
  const actions = element("div", "ledger-slot-actions no-print");
  const specs = [
    ["move-prev", "前へ"], ["move-next", "後へ"],
    ["blank-before", "前に空白"], ["blank-after", "後に空白"],
    slot.type === "photo" ? ["unplace", "未配置へ"] : ["remove-blank", "空白削除"]
  ];
  for (const [action, label] of specs) {
    const button = element("button", "ledger-mini-button", label);
    button.type = "button";
    button.dataset.ledgerAction = action;
    button.dataset.slotIndex = String(slotIndex);
    actions.append(button);
  }
  return actions;
}

async function createSlot(slot, slotIndex, photosById, loadPhotoFile, objectUrls, interactive, selectedSlotIndex) {
  const photo = slot.type === "photo" ? photosById.get(slot.photoId) : null;
  const wrapper = element("div", `ledger-slot${photo ? "" : " empty"}${selectedSlotIndex === slotIndex ? " selected" : ""}`);
  wrapper.dataset.slotIndex = String(slotIndex);
  if (photo) wrapper.dataset.photoId = photo.internalId;
  wrapper.draggable = Boolean(interactive && photo);
  const warning = element("div", "ledger-slot-warning no-print", "⚠ 台帳出力不可");
  const imageCell = element("div", "ledger-photo-cell");
  if (photo) {
    const image = document.createElement("img");
    image.alt = `写真${slotIndex + 1}`;
    const file = await loadPhotoFile(photo.internalId);
    if (file?.blob) {
      const url = URL.createObjectURL(file.blob);
      objectUrls.add(url);
      image.src = url;
    }
    imageCell.append(image);
  } else {
    imageCell.textContent = "余 白";
  }
  wrapper.append(warning, imageCell, createCaption(photo));
  if (interactive) wrapper.append(createSlotActions(slotIndex, slot));
  return wrapper;
}

function createCover(ledger, project) {
  const cover = element("section", "ledger-page ledger-cover");
  cover.dataset.pageType = "cover";
  const firstKoushu = ledger._coverKoushu || "";
  cover.append(
    element("div", "ledger-cover-title", ledger.title || "施工状況写真"),
    element("div", "ledger-cover-koushu", firstKoushu),
    element("div", "ledger-cover-kouji", project?.name || ""),
    element("div", "ledger-cover-contractor", project?.contractor || "")
  );
  return cover;
}

export async function renderLedgerPages(container, {
  ledger, project, photos, loadPhotoFile, interactive = true, selectedSlotIndex = -1
}) {
  const objectUrls = new Set();
  const photosById = new Map(photos.map(photo => [photo.internalId, photo]));
  const firstPhotoSlot = ledger.pages.flatMap(page => page.slots).find(slot => slot.type === "photo");
  const firstPhoto = firstPhotoSlot ? photosById.get(firstPhotoSlot.photoId) : null;
  const renderLedger = { ...ledger, _coverKoushu: firstPhoto?.classification?.koushu || "" };
  const nodes = [];
  if (ledger.showCover) nodes.push(createCover(renderLedger, project));
  let flatIndex = 0;
  for (let pageIndex = 0; pageIndex < ledger.pages.length; pageIndex += 1) {
    const pageData = ledger.pages[pageIndex];
    const page = element("section", "ledger-page ledger-photo-page");
    page.dataset.pageIndex = String(pageIndex);
    if (interactive && ledger.pages.length > 1 && pageData.slots.every(slot => slot.type === "blank")) {
      const remove = element("button", "ledger-delete-page no-print", "空ページを削除");
      remove.type = "button";
      remove.dataset.deletePage = String(pageIndex);
      page.append(remove);
    }
    for (const slot of pageData.slots) {
      page.append(await createSlot(slot, flatIndex, photosById, loadPhotoFile, objectUrls, interactive, selectedSlotIndex));
      flatIndex += 1;
    }
    nodes.push(page);
  }
  container.replaceChildren(...nodes);
  return { objectUrls, photosById };
}

function fieldFits(field) {
  const content = field.querySelector(".ledger-caption-field-content,.ledger-caption-body-text");
  if (!content) return true;
  const fieldRect = field.getBoundingClientRect();
  const contentRect = content.getBoundingClientRect();
  const safety = 2;
  return field.scrollHeight <= field.clientHeight
    && field.scrollWidth <= field.clientWidth
    && contentRect.bottom <= fieldRect.bottom - safety
    && contentRect.right <= fieldRect.right - safety;
}

function issueFields(slot, photo) {
  const values = captionFields(photo);
  const items = [];
  const add = (label, value) => items.push({ label, count: [...String(value)].length });
  const koushu = slot.querySelector('[data-ledger-field="koushu"]');
  const sokuten = slot.querySelector('[data-ledger-field="sokuten"]');
  const caption = slot.querySelector('[data-ledger-field="caption"]');
  if (koushu && !fieldFits(koushu)) add("工種", values.koushu);
  if (sokuten && !fieldFits(sokuten)) add("測点", values.sokuten);
  if (caption && !fieldFits(caption)) add(values.captionLabel, values.caption);
  if (!items.length) add(values.captionLabel, values.caption);
  return items;
}

export async function validateLedgerPages(container, photos) {
  const photosById = new Map(photos.map(photo => [photo.internalId, photo]));
  if (document.fonts?.ready) await document.fonts.ready;
  await nextFrame();
  const issues = [];
  let photoCount = 0;
  for (const slot of container.querySelectorAll(".ledger-slot[data-slot-index]")) {
    const index = Number(slot.dataset.slotIndex);
    const caption = slot.querySelector(".ledger-caption");
    const image = slot.querySelector(".ledger-photo-cell img");
    slot.classList.remove("ledger-unfit");
    if (!image) continue;
    photoCount += 1;
    let fits = false;
    for (const size of LEDGER_FONT_SIZES) {
      caption.style.setProperty("--ledger-font-size", `${size}pt`);
      const fields = [...slot.querySelectorAll("[data-ledger-field]")];
      if (fields.every(fieldFits) && caption.scrollHeight <= caption.clientHeight) {
        fits = true;
        break;
      }
    }
    if (!fits) {
      slot.classList.add("ledger-unfit");
      const photo = photosById.get(slot.dataset.photoId) || {};
      issues.push({ index, photo, fields: issueFields(slot, photo) });
    }
  }
  return { valid: photoCount > 0 && issues.length === 0, empty: photoCount === 0, photoCount, issues };
}

export async function printLedger(container, photos) {
  const validation = await validateLedgerPages(container, photos);
  if (!validation.valid) return validation;
  const images = [...container.querySelectorAll("img")];
  await Promise.all(images.map(image => image.decode?.().catch(() => {}) || Promise.resolve()));
  document.body.classList.add("ledger-printing");
  const cleanup = () => document.body.classList.remove("ledger-printing");
  window.addEventListener("afterprint", cleanup, { once: true });
  window.print();
  setTimeout(cleanup, 30000);
  return validation;
}
