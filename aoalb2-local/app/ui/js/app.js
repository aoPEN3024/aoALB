// aoALB 2 画面。保存処理は Repository（repository.js）経由だけで行う。
import { createRepository } from "./repository.js";
import { VirtualGrid } from "./virtual-grid.js";
import { applyLocal, computeInverse, isStructural, findSlot, orderedSlots, resolvedCaption, captionLengthLevel, CAPTION_LIMITS, clone } from "./ledger-model.js";
import { SaveQueue, SaveStatus } from "./save-queue.js";
import { makeDraggable, onDrop } from "./pointer-drag.js";
import { drawThumb, releaseCanvas } from "./thumb-loader.js";
import { LeaveGuard, createExitHandler, describeOps } from "./leave-guard.js";

const repo = createRepository();
const FIELDS = ["koushu", "shubetsu", "saibetsu", "sokuten", "tekiyo"];
const LABEL = { koushu: "工種", shubetsu: "種別", saibetsu: "細別", sokuten: "測点", tekiyo: "摘要" };
const $app = document.getElementById("app");

// ------------------------------------------------------------------ 小道具
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
// 時差つきの日時（保存日時など）は端末の時刻で表示し、時差なしの撮影日時（EXIF）はそのまま表示する
const fmtDate = s => {
  if (!s) return "—";
  const t = String(s);
  if (/(Z|[+-]\d\d:\d\d)$/.test(t)) {
    const d = new Date(t);
    if (!Number.isNaN(d.getTime())) { const p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }
  }
  return t.replace("T", " ").slice(0, 16);
};
const fmtBytes = n => { if (n == null) return "—"; const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; let v = n; while (v >= 1024 && i < 4) { v /= 1024; i++; } return i ? `${v.toFixed(1)}${u[i]}` : `${n}B`; };
const message = e => e?.message || "処理できませんでした。もう一度お試しください。";

function toast(text, kind = "info") {
  const el = h("div", { class: `toast ${kind}`, role: "status" }, text);
  document.getElementById("toasts").append(el);
  setTimeout(() => el.remove(), kind === "error" ? 7000 : 3500);
}

function modal(title, body, actions = []) {
  const close = () => back.remove();
  const back = h("div", { class: "modal-back" }, h("div", { class: "modal", role: "dialog", "aria-label": title },
    h("h2", {}, title), body, h("div", { class: "modal-actions" }, ...actions.map(a => h("button", { class: a.primary ? "primary" : a.danger ? "danger" : "", onclick: async () => { if ((await a.onClick?.()) !== false) close(); } }, a.label)))));
  document.body.append(back);
  return close;
}

/** 保存に失敗した時の選択（再試行／編集画面へ戻る）。決まるまで先へ進まない */
function askSaveFailure(err, count) {
  return new Promise(resolve => {
    modal("保存できていない変更があります", h("div", {},
      h("p", { class: "warn strong" }, `台帳の変更${count}件を保存できていません。このままでは画面を移ったり閉じたりできません。`),
      h("p", {}, `理由：${message(err)}`),
      h("p", { class: "muted" }, "変更はこの画面に残っています。「再試行」で保存し直すか、「編集画面へ戻る」で作業を続けてください。")), [
      { label: "再試行", primary: true, onClick: () => resolve("retry") },
      { label: "編集画面へ戻る", onClick: () => resolve("stay") }]);
  });
}
const guard = new LeaveGuard({ getQueue: () => state.ledger?.queue || null, askOnFailure: askSaveFailure });

/** 進捗とキャンセルのある処理 */
async function runTask(title, fn) {
  const taskId = crypto.randomUUID();
  const bar = h("progress", { max: 100, value: 0 });
  const text = h("p", { class: "muted" }, "準備しています");
  const close = modal(title, h("div", {}, text, bar), [{ label: "中止する", onClick: async () => { await repo.cancelTask(taskId); text.textContent = "中止しています…"; return false; } }]);
  const off = repo.onProgress(p => { if (p.taskId !== taskId) return; text.textContent = p.progress.message; if (p.progress.total) bar.value = Math.round(p.progress.current / p.progress.total * 100); });
  try { return await fn(taskId); } finally { close(); (await off)?.(); }
}

// ------------------------------------------------------------------ 状態
const state = { screen: "home", project: null, info: null, photoFilter: { sortBy: "date", sortDesc: false }, selection: new Set(), lastClicked: null, classUndo: [], classRedo: [], ledger: null };

function header() {
  const saveBadge = h("span", { id: "save-status", class: "save-status" });
  const nav = state.project ? [
    ["import", "写真を取り込む"], ["photos", "写真を整理する"], ["ledgers", "台帳一覧"], ["exchange", "別端末へ引き継ぐ"], ["backup", "バックアップ・復元"],
  ].map(([k, label]) => h("button", { class: `nav ${state.screen === k || (k === "ledgers" && state.screen === "editor") ? "active" : ""}`, onclick: () => k === "import" ? importDialog() : go(k) }, label)) : [];
  return h("header", { class: "top" },
    h("div", { class: "brand" }, "aoALB 2", h("small", {}, repo.kind === "demo" ? " 確認用（架空データ）" : " 工事写真台帳")),
    state.project ? h("div", { class: "project-name", title: state.project.root }, state.info.name) : null,
    h("nav", {}, ...nav), saveBadge,
    state.project ? h("button", { class: "ghost", onclick: closeProject }, "工事を閉じる") : null);
}

async function go(screen, params = {}) {
  // 未保存の変更があれば、保存が成功するまで画面を移らない
  if (!(await guard.ensureSaved())) return false;
  if (screen !== "editor") state.ledger = null;
  state.screen = screen;
  Object.assign(state, params);
  render();
}

function render() {
  const main = h("main", { class: `screen-${state.screen}` });
  $app.replaceChildren(header(), main);
  ({ home: renderHome, photos: renderPhotos, ledgers: renderLedgers, editor: renderEditor, exchange: renderExchange, backup: renderBackup }[state.screen] || renderHome)(main);
}

// ------------------------------------------------------------------ ホーム
async function renderHome(main) {
  const info = await repo.appInfo();
  const name = h("input", { placeholder: "例：○○橋 塗装塗替工事", maxlength: 160 });
  const contractor = h("input", { placeholder: "例：青山塗装株式会社" });
  let parent = info.defaultParent || "";
  const parentLabel = h("span", { class: "path" }, parent || "（未選択）");
  const create = async () => {
    if (!name.value.trim()) return toast("工事名を入力してください。", "error");
    if (!parent) { parent = await repo.pickFolder("工事データを保存するフォルダを選ぶ"); if (!parent) return; }
    try { await opened(await repo.createProject(parent, { name: name.value, contractor: contractor.value })); toast("工事を作りました。"); } catch (e) { toast(message(e), "error"); }
  };
  main.append(
    h("section", { class: "home-grid" },
      h("div", { class: "card" }, h("h2", {}, "工事を作る"),
        h("label", {}, "工事名", name), h("label", {}, "施工者名", contractor),
        h("label", {}, "保存先フォルダ", h("div", { class: "row" }, parentLabel, h("button", { onclick: async () => { const p = await repo.pickFolder("保存先フォルダを選ぶ"); if (p) { parent = p; parentLabel.textContent = p; } } }, "変更"))),
        h("p", { class: "muted" }, "保存先フォルダの中に工事ごとのフォルダを作り、写真と台帳を保存します。外付けSSDへフォルダごとコピーして保管できます。"),
        h("button", { class: "primary", onclick: create }, "工事を作る")),
      h("div", { class: "card" }, h("h2", {}, "工事を開く"),
        h("button", { class: "primary", onclick: async () => { const p = await repo.pickFolder("工事フォルダを選ぶ"); if (p) openRoot(p); } }, "工事フォルダを選んで開く"),
        h("button", { onclick: () => importExchangeFlow(parent) }, "別端末の引継ぎファイルから取り込む"),
        h("h3", {}, "最近の工事"),
        h("button", { class: "link", onclick: showAbout }, "このアプリについて（フォントのライセンス）"),
        info.recent.length ? h("ul", { class: "recent" }, ...info.recent.map(r => h("li", {},
          h("button", { class: "link", disabled: !r.exists, onclick: () => openRoot(r.root) }, r.name),
          h("span", { class: "muted" }, r.exists ? ` ${fmtDate(r.openedAt)}` : "（フォルダが見つかりません。移動した場合は「工事フォルダを選んで開く」から開いてください）")))) : h("p", { class: "muted" }, "まだありません。"))));
  if (repo.kind === "demo" && !state.project) { await opened(await repo.openProject()); }
}

async function showAbout() {
  const a = await repo.about();
  modal("このアプリについて", h("div", {},
    h("p", {}, `aoALB 2 ローカル版 ${a.version}`),
    h("p", {}, `PDFの文字には「${a.font}」を使い、使った文字だけをPDFへ埋め込んでいます。`),
    h("pre", { class: "license" }, a.fontLicense)), [{ label: "閉じる", primary: true }]);
}

async function openRoot(root) { try { await opened(await repo.openProject(root)); } catch (e) { toast(message(e), "error"); } }

async function opened(s) {
  state.project = s; state.info = s.info; state.selection.clear(); state.classUndo = []; state.classRedo = [];
  const r = s.report;
  if (r?.recoveredAfterCrash) {
    const lines = ["前回は正常に終了しませんでした。工事データを確認しました。"];
    lines.push(r.integrityOk ? "台帳と分類のデータに問題はありません。" : "データに不整合があります。「バックアップ・復元」から直前のバックアップへ戻してください。");
    if (r.missingOriginals.length) lines.push(`原寸写真が${r.missingOriginals.length}枚見つかりません。工事フォルダを移動・削除していないか確認してください。`);
    if (r.missingThumbnails) lines.push(`一覧用の小さい画像${r.missingThumbnails}枚を作り直しています。`);
    modal("工事データの確認", h("div", {}, ...lines.map(l => h("p", {}, l))), [{ label: "閉じる", primary: true }]);
  }
  if (r?.unregisteredOriginals) offerRecovery(r.unregisteredOriginals);
  go("photos");
}

/** 一覧に登録されていない原寸写真を、一覧へ戻す（バックアップの記録があれば分類なども戻す） */
function offerRecovery(n) {
  modal("一覧にない写真があります", h("div", {},
    h("p", {}, `工事フォルダに、写真一覧に入っていない写真が${n}枚あります。`),
    h("p", { class: "muted" }, "古いバックアップへ戻した場合や、取込みの途中で終了した場合に起こります。写真のファイルは残っています。一覧へ戻すと、バックアップに記録があれば分類やaoPICの情報も戻します。")), [
    { label: "一覧へ戻す", primary: true, onClick: async () => {
      try { const r = await repo.recoverUnregistered(); showRecovery(r); render(); } catch (e) { toast(message(e), "error"); }
    } },
    { label: "あとで" }]);
}
function showRecovery(r) {
  if (!r?.found) return;
  const ok = r.recoveredFromBackup + r.recoveredFromFile;
  modal("写真を一覧へ戻しました", h("div", {},
    h("p", {}, `一覧へ戻した写真：${ok}枚`),
    r.recoveredFromFile ? h("p", { class: "muted" }, `うち${r.recoveredFromFile}枚は記録が見つからなかったため、撮影日時などを写真から読み取り「復旧した写真」として戻しました（分類は未分類）。`) : null,
    r.failed.length ? h("p", { class: "warn" }, `${r.failed.length}枚は写真として読み取れませんでした。ファイルは削除せず工事フォルダに残しています。`) : null), [{ label: "閉じる", primary: true }]);
}

async function closeProject() {
  // 保存に失敗したら工事を閉じない（変更を失わない）
  if (!(await guard.ensureSaved())) return;
  try { await repo.closeProject(); } catch (e) { toast(message(e), "error"); return; }
  state.project = null; state.info = null; go("home");
}

// ------------------------------------------------------------------ 取込み
async function importDialog(preset = null) {
  const folderClassify = h("input", { type: "checkbox", checked: true });
  const choose = async kind => {
    let source = null;
    if (kind === "files") { const f = await repo.pickFiles(); if (f?.length) source = { kind: "files", paths: Array.isArray(f) ? f : [f] }; }
    if (kind === "folder") { const d = await repo.pickFolder("写真のフォルダを選ぶ（SDカードのDCIM等）"); if (d) source = { kind: "folder", path: d }; }
    if (kind === "zip") { const z = await repo.pickFiles({ zip: true, multiple: false }); if (z) source = { kind: "zip", path: Array.isArray(z) ? z[0] : z }; }
    if (source) { close(); await doImport(source, { folderClassification: kind !== "files" && folderClassify.checked }); }
  };
  const close = modal("写真を取り込む", h("div", { class: "import-choices" },
    h("button", { class: "big", onclick: () => choose("files") }, "写真ファイルを選ぶ", h("small", {}, "JPEG（複数選択可）。aoPICのZIPもここから選べます")),
    h("button", { class: "big", onclick: () => choose("folder") }, "フォルダごと取り込む", h("small", {}, "SDカード・デジカメからコピーしたフォルダ")),
    h("button", { class: "big", onclick: () => choose("zip") }, "ZIPを取り込む", h("small", {}, "aoPICの台帳用ZIP・通常ZIP")),
    h("label", { class: "check" }, folderClassify, "フォルダの1～3階層を工種・種別・細別として取り込む"),
    h("p", { class: "muted" }, "aoPICの正式な分類情報が入っている場合は、そちらを優先します。デジカメのDCIMフォルダを取り込む場合は、このチェックを外してください。"),
    h("p", { class: "muted" }, "この画面へ写真やフォルダをドラッグ＆ドロップしても取り込めます。同じ写真は自動では重ねて取り込みません。")), [{ label: "閉じる" }]);
  if (preset) { close(); await doImport(preset); }
}

async function doImport(source, options = {}) {
  try {
    const r = await runTask("写真を取り込んでいます", id => repo.importPhotos(id, source, options));
    showImportResult(r);
    state.selection = new Set(r.photoUuids);
    go("photos");
  } catch (e) { toast(message(e), "error"); }
}

function showImportResult(r) {
  const dup = r.failures.filter(f => f.kind === "duplicate");
  const bad = r.failures.filter(f => f.kind !== "duplicate");
  const body = h("div", {},
    h("p", { class: "result-line" }, `取り込んだ写真：${r.accepted}枚`),
    r.folderClassified ? h("p", {}, `フォルダ階層から分類を設定した写真：${r.folderClassified}枚`) : null,
    r.cancelled ? h("p", { class: "warn" }, `途中で中止しました。取り込み済みの${r.accepted}枚は残っています。`) : null,
    dup.length ? h("p", {}, `同じ写真がすでにあるため取り込まなかった写真：${dup.length}枚`) : null,
    bad.length ? h("p", { class: "warn" }, `取り込めなかった写真：${bad.length}枚`) : null,
    r.failures.length ? h("div", { class: "failure-list" }, ...r.failures.slice(0, 200).map(f => h("div", {}, h("b", {}, f.sourceName), "：", f.reason))) : null,
    r.failures.length > 200 ? h("p", { class: "muted" }, `ほか${r.failures.length - 200}件`) : null);
  const actions = [{ label: "閉じる", primary: true }];
  const retryable = bad.filter(f => f.kind !== "unsupported");
  if (retryable.length) actions.unshift({ label: "失敗した写真だけ再試行", onClick: () => retry(retryable.map(f => f.id), {}) });
  if (dup.length) actions.unshift({ label: "重複も取り込む", onClick: () => retry(dup.map(f => f.id), { allowDuplicates: true }) });
  modal("取込みの結果", body, actions);
}
async function retry(ids, options) {
  try { const r = await runTask("再試行しています", id => repo.retryImport(id, ids, options)); showImportResult(r); render(); } catch (e) { toast(message(e), "error"); }
}

// ------------------------------------------------------------------ 写真を整理する
let grid = null;
let photoList = [];

async function renderPhotos(main) {
  const f = state.photoFilter;
  const [folders, meta, folderPreview] = await Promise.all([repo.folderLabels(), repo.classifyMeta(), repo.previewFolderClassification()]);
  const count = h("span", { class: "count" });
  const selInfo = h("span", { class: "sel-info" });
  const gridHost = h("div", { class: "grid-host", tabindex: 0 });
  const refresh = async (keepScroll = true) => {
    photoList = await repo.listPhotos({ ...f, unclassifiedOnly: !!f.unclassifiedOnly });
    count.textContent = `表示中 ${photoList.length}枚`;
    grid.setItems(photoList, { keepScroll });
    updateSel();
  };
  const updateSel = () => {
    const visible = photoList.filter(p => state.selection.has(p.uuid)).length;
    const hidden = state.selection.size - visible;
    selInfo.textContent = state.selection.size ? `選択中 ${state.selection.size}枚${hidden ? `（うち絞込みで非表示 ${hidden}枚）` : ""}` : "未選択";
    applyBtn.textContent = `選択中の${state.selection.size}枚へ適用`;
    applyBtn.disabled = !state.selection.size;
  };
  const filters = h("div", { class: "filters" },
    h("label", { class: "check" }, h("input", { type: "checkbox", checked: !!f.unclassifiedOnly, onchange: e => { f.unclassifiedOnly = e.target.checked; refresh(false); } }), "未分類だけ"),
    h("input", { type: "search", placeholder: "ファイル名・分類で探す", value: f.text || "", oninput: debounce(e => { f.text = e.target.value || null; refresh(false); }, 250) }),
    h("select", { onchange: e => { f.folderLabel = e.target.value === "__all" ? null : e.target.value; refresh(false); } },
      h("option", { value: "__all" }, "取込みフォルダ：すべて"), ...folders.map(x => h("option", { value: x.folderLabel, selected: f.folderLabel === x.folderLabel }, `${x.folderLabel || "（フォルダなし）"} ${x.count}枚`))),
    h("label", {}, "撮影日", h("input", { type: "date", value: f.takenFrom?.slice(0, 10) || "", onchange: e => { f.takenFrom = e.target.value || null; refresh(false); } })),
    h("span", {}, "〜"), h("input", { type: "date", value: f.takenToDay || "", onchange: e => { f.takenToDay = e.target.value || null; f.takenTo = e.target.value ? nextDay(e.target.value) : null; refresh(false); } }),
    h("select", { onchange: e => { f.koushu = e.target.value === "__all" ? null : e.target.value; refresh(false); } }, h("option", { value: "__all" }, "工種：すべて"), ...meta.suggestions.koushu.map(v => h("option", { value: v, selected: f.koushu === v }, v))),
    h("select", { "aria-label": "写真の並び順", onchange: e => {
      const [sortBy, direction] = e.target.value.split(":");
      f.sortBy = sortBy; f.sortDesc = direction === "desc"; state.lastClicked = null; refresh(false);
    } },
    ...[
      ["date:asc", "並び順：撮影日（古い順）"], ["date:desc", "並び順：撮影日（新しい順）"],
      ["koushu:asc", "並び順：工種（あいうえお順）"], ["koushu:desc", "並び順：工種（逆順）"],
      ["name:asc", "並び順：写真名（昇順）"], ["name:desc", "並び順：写真名（降順）"],
    ].map(([value, label]) => h("option", { value, selected: value === `${f.sortBy || "date"}:${f.sortDesc ? "desc" : "asc"}` }, label))),
    h("label", { class: "check" }, h("input", { type: "checkbox", checked: !!f.trashed, onchange: e => { f.trashed = e.target.checked; state.selection.clear(); refresh(false); } }), "ごみ箱"));
  const showFolderClassification = () => {
    const rows = folderPreview.mappings.slice(0, 30).map(m => h("tr", {},
      h("td", {}, m.folderLabel), h("td", {}, m.koushu || "—"), h("td", {}, m.shubetsu || "—"), h("td", {}, m.saibetsu || "—"), h("td", { class: "num" }, m.candidateCount)));
    modal("フォルダから分類を復元", h("div", {},
      h("p", {}, `空欄を補完できる写真：${folderPreview.photoCount}枚`),
      h("p", {}, `工種 ${folderPreview.koushuCount}件・種別 ${folderPreview.shubetsuCount}件・細別 ${folderPreview.saibetsuCount}件`),
      h("p", { class: "muted" }, "1階層目を工種、2階層目を種別、3階層目を細別として使います。測点と摘要は変更しません。aoPICの正式な分類と手動編集済みの値は上書きしません。実行前に自動バックアップを作成します。"),
      h("table", { class: "table" }, h("thead", {}, h("tr", {}, ...["取込みフォルダ", "工種", "種別", "細別", "写真"].map(x => h("th", {}, x)))), h("tbody", {}, ...rows)),
      folderPreview.mappings.length > 30 ? h("p", { class: "muted" }, `ほか${folderPreview.mappings.length - 30}件`) : null), [
      { label: "分類を復元する", primary: true, onClick: async () => {
        try {
          const r = await repo.applyFolderClassification();
          state.selection.clear(); state.classUndo = []; state.classRedo = [];
          toast(`${r.changedPhotos}枚の空欄分類を復元しました。`);
          render();
        } catch (e) { toast(message(e), "error"); return false; }
      } },
      { label: "キャンセル" },
    ]);
  };
  const tools = h("div", { class: "toolbar" }, count, selInfo,
    h("button", { onclick: () => { photoList.forEach(p => state.selection.add(p.uuid)); grid.redrawVisible(); updateSel(); } }, "表示中を全選択"),
    h("button", { onclick: () => { state.selection.clear(); grid.redrawVisible(); updateSel(); } }, "選択解除"),
    h("button", { onclick: () => groupByTime() }, "撮影時刻で区切って選ぶ"),
    h("button", { disabled: !folderPreview.photoCount, onclick: showFolderClassification }, folderPreview.photoCount ? `フォルダから分類を復元（${folderPreview.photoCount}枚）` : "フォルダから分類を復元"),
    f.trashed ? h("button", { onclick: async () => { await repo.restorePhotos([...state.selection]); state.selection.clear(); refresh(); toast("写真を戻しました。"); } }, "選択を元に戻す")
      : h("button", { class: "ghost", onclick: async () => { if (!state.selection.size) return; try { await repo.trashPhotos([...state.selection]); state.selection.clear(); refresh(); toast("ごみ箱へ移しました（原寸写真は残っています）。"); } catch (e) { toast(message(e), "error"); } } }, "ごみ箱へ"));
  // 分類パネル
  const inputs = {};
  const modes = {};
  const panel = h("aside", { class: "class-panel" }, h("h2", {}, "分類"), h("p", { class: "muted" }, "入力した項目だけ変更します。空欄の項目は変更しません。"));
  for (const k of FIELDS) {
    const list = h("datalist", { id: `dl-${k}` }, ...meta.suggestions[k].map(v => h("option", { value: v })));
    inputs[k] = h("input", { list: `dl-${k}`, maxlength: 200, placeholder: "変更しない", oninput: () => { modes[k] = inputs[k].value ? "set" : null; } });
    panel.append(h("div", { class: "field" }, h("label", {}, LABEL[k], inputs[k]), list,
      h("div", { class: "field-actions" },
        h("button", { class: "mini", onclick: () => { modes[k] = "clear"; inputs[k].value = ""; inputs[k].placeholder = "空欄にする"; } }, "空欄にする"),
        h("button", { class: "mini", onclick: () => { modes[k] = "original"; inputs[k].value = ""; inputs[k].placeholder = "元の分類へ戻す"; } }, "元の分類へ"))));
  }
  const collect = () => {
    const changes = {};
    for (const k of FIELDS) {
      if (modes[k] === "set" && inputs[k].value.trim()) changes[k] = { mode: "set", value: inputs[k].value.trim() };
      if (modes[k] === "clear") changes[k] = { mode: "set", value: "" };
      if (modes[k] === "original") changes[k] = { mode: "original" };
    }
    return changes;
  };
  const resetInputs = () => { for (const k of FIELDS) { inputs[k].value = ""; inputs[k].placeholder = "変更しない"; modes[k] = null; } };
  const applyChanges = async changes => {
    if (!state.selection.size) return toast("写真を選んでください。", "error");
    if (!Object.keys(changes).length) return toast("変更する項目を入力してください。", "error");
    try {
      const before = await repo.classify([...state.selection], changes);
      state.classUndo.push(before); state.classRedo = [];
      state.lastChanges = changes;
      toast(`${state.selection.size}枚の分類を変更しました。`);
      await refresh();
    } catch (e) { toast(message(e), "error"); }
  };
  const applyBtn = h("button", { class: "primary", onclick: () => applyChanges(collect()) }, "選択中の写真へ適用");
  panel.append(applyBtn,
    h("div", { class: "row" },
      h("button", { onclick: () => state.lastChanges ? applyChanges(state.lastChanges) : toast("直前の分類がありません。", "error") }, "直前の分類を適用"),
      h("button", { onclick: () => { for (const k of FIELDS) { modes[k] = "original"; } applyChanges(Object.fromEntries(FIELDS.map(k => [k, { mode: "original" }]))); resetInputs(); } }, "全項目を元の分類へ")),
    h("div", { class: "row" },
      h("button", { onclick: () => undoClass(refresh) }, "元に戻す"), h("button", { onclick: () => redoClass(refresh) }, "やり直す"), h("button", { class: "ghost", onclick: resetInputs }, "入力を消す")),
    h("h3", {}, "最近使った分類"),
    h("div", { class: "chips" }, ...meta.recent.map(v => h("button", { class: "chip", onclick: () => { for (const k of FIELDS) { if (v[k]) { inputs[k].value = v[k]; modes[k] = "set"; } } } }, Object.values(v).join(" / ")))),
    h("h3", {}, "分類テンプレート"),
    h("div", { class: "chips" }, ...meta.templates.map(t => h("span", { class: "chip" },
      h("button", { class: "link", onclick: () => { for (const k of FIELDS) { if (t.values[k]) { inputs[k].value = t.values[k]; modes[k] = "set"; } } } }, t.name),
      h("button", { class: "x", title: "削除", onclick: async () => { await repo.deleteTemplate(t.uuid); render(); } }, "×")))),
    h("button", { onclick: async () => {
      const values = Object.fromEntries(FIELDS.filter(k => inputs[k].value.trim()).map(k => [k, inputs[k].value.trim()]));
      if (!Object.keys(values).length) return toast("テンプレートにする分類を入力してください。", "error");
      const name = prompt("テンプレート名", Object.values(values).join(" "));
      if (name) { await repo.saveTemplate(null, name, values); render(); }
    } }, "入力中の分類をテンプレートに保存"));

  main.append(h("div", { class: "photos-layout" }, h("section", { class: "photos-main" }, filters, tools, gridHost), panel));
  grid = new VirtualGrid(gridHost, { render: (el, p, i) => photoCard(el, p, i, () => { grid.redrawVisible(); updateSel(); }) });
  await refresh();
  gridHost.addEventListener("keydown", e => {
    if (e.key === "a" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); photoList.forEach(p => state.selection.add(p.uuid)); grid.redrawVisible(); updateSel(); }
    if (e.key === "Escape") { state.selection.clear(); grid.redrawVisible(); updateSel(); }
  });
  function groupByTime() {
    // 撮影間隔が20分以上空いた所で区切り、選んだ写真のまとまりを選択する
    const first = photoList.findIndex(p => state.selection.has(p.uuid));
    if (first < 0) return toast("まとまりの中の写真を1枚選んでから押してください。", "error");
    const t = p => (p.takenAt ? Date.parse(p.takenAt) : NaN);
    let a = first, b = first;
    while (a > 0 && t(photoList[a]) - t(photoList[a - 1]) < 20 * 60000) a--;
    while (b < photoList.length - 1 && t(photoList[b + 1]) - t(photoList[b]) < 20 * 60000) b++;
    for (let i = a; i <= b; i++) state.selection.add(photoList[i].uuid);
    grid.redrawVisible(); updateSel();
    toast(`撮影時刻が続いている${b - a + 1}枚を選びました。`);
  }
}

function nextDay(d) { const x = new Date(`${d}T00:00:00`); x.setDate(x.getDate() + 1); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/** サムネイル用canvas。DOMから外れたら読み込みを中止し画素を解放する */
function thumbCanvas(url) {
  const c = h("canvas", { class: "thumb-canvas", width: 1, height: 1 });
  requestAnimationFrame(() => { if (c.isConnected) c._cancel = drawThumb(c, url); });
  return c;
}
export function releaseThumbs(root) { root.querySelectorAll("canvas.thumb-canvas").forEach(c => { c._cancel?.(); releaseCanvas(c); }); }
window.__releaseThumbs = releaseThumbs;

function photoCard(el, p, index, onChange, { draggable = false, compact = false } = {}) {
  const selected = state.selection.has(p.uuid);
  el.className = `vgrid-cell photo-card${selected ? " selected" : ""}${p.placed ? " placed" : ""}`;
  el.setAttribute("aria-selected", selected ? "true" : "false");
  const url = repo.thumbUrl(p);
  const img = url ? thumbCanvas(url) : h("div", { class: "thumb-wait" }, p.thumbState === "failed" ? "表示できません" : "準備中");
  const c = p.classification;
  el.append(h("div", { class: "thumb" }, img, selected ? h("span", { class: "check-mark" }, "✓") : null, p.sourceKind === "aopic" ? h("span", { class: "badge" }, "aoPIC") : null,
    p.placed ? h("span", { class: "badge placed" }, "配置済") : null),
    h("div", { class: "cap" }, h("div", { class: "cap1" }, c.koushu || c.shubetsu ? `${c.koushu} ${c.shubetsu}` : h("span", { class: "muted" }, "未分類")),
      compact ? null : h("div", { class: "cap2" }, `${fmtDate(p.takenAt)} ${c.sokuten || ""}`)));
  el.onclick = e => {
    if (e.shiftKey && state.lastClicked != null) {
      const [a, b] = [Math.min(state.lastClicked, index), Math.max(state.lastClicked, index)];
      for (let i = a; i <= b; i++) state.selection.add(photoList[i]?.uuid || ledgerPhotoList[i]?.uuid);
    } else if (e.ctrlKey || e.metaKey) { selected ? state.selection.delete(p.uuid) : state.selection.add(p.uuid); }
    else { const only = selected && state.selection.size === 1; state.selection.clear(); if (!only) state.selection.add(p.uuid); }
    state.selection.delete(undefined);
    state.lastClicked = index;
    onChange();
  };
  el.ondblclick = () => showPhotoDetail(p.uuid);
  if (draggable) {
    makeDraggable(el, () => {
      if (!state.selection.has(p.uuid)) { state.selection.clear(); state.selection.add(p.uuid); onChange(); }
      const photos = (state.ledger ? ledgerPhotoList : photoList).filter(x => state.selection.has(x.uuid)).map(x => x.uuid);
      return { photos };
    }, { label: d => `写真${d.photos.length}枚` });
  }
}

async function showPhotoDetail(uuid) {
  const d = await repo.photoDetail(uuid);
  const p = d.photo;
  const board = d.aopic?.boardSnapshot;
  modal("写真の詳細", h("div", { class: "detail" },
    h("div", { class: "detail-img" }, h("img", { src: repo.originalUrl(p), alt: "原寸写真", decoding: "async" })),
    h("dl", {},
      h("dt", {}, "撮影日時"), h("dd", {}, fmtDate(p.takenAt), p.takenAtSource === "file" ? "（ファイルの日時）" : p.takenAtSource === "unknown" ? "（不明）" : ""),
      h("dt", {}, "ファイル名"), h("dd", {}, p.originalName),
      h("dt", {}, "取込み元"), h("dd", {}, p.sourceKind === "aopic" ? "aoPIC" : "一般写真", p.folderLabel ? `（${p.folderLabel}）` : ""),
      h("dt", {}, "大きさ"), h("dd", {}, `${p.width}×${p.height}・${fmtBytes(p.bytes)}`),
      ...FIELDS.flatMap(k => [h("dt", {}, LABEL[k]), h("dd", {}, p.classification[k] || "—", p.overridden.includes(k) ? h("span", { class: "muted" }, `（元：${p.original[k] || "空欄"}）`) : null)]),
      board ? [h("dt", {}, "黒板の工事名"), h("dd", {}, board.koujimei || "—")] : [],
      d.ledgers?.length ? [h("dt", {}, "使用中の台帳"), h("dd", {}, d.ledgers.map(l => l.title).join("、"))] : [])), [{ label: "閉じる", primary: true }]);
}

async function undoClass(refresh) {
  const s = state.classUndo.pop(); if (!s) return toast("元に戻す変更がありません。");
  state.classRedo.push(await repo.restoreClassification(s)); await refresh(); toast("分類の変更を元に戻しました。");
}
async function redoClass(refresh) {
  const s = state.classRedo.pop(); if (!s) return toast("やり直す変更がありません。");
  state.classUndo.push(await repo.restoreClassification(s)); await refresh(); toast("分類の変更をやり直しました。");
}

// ------------------------------------------------------------------ 台帳一覧
async function renderLedgers(main) {
  const trashed = !!state.ledgerTrash;
  const list = await repo.listLedgers(trashed);
  const title = h("input", { placeholder: "例：第1回 出来形写真", maxlength: 200 });
  main.append(h("section", { class: "ledgers" },
    h("div", { class: "row space" },
      h("div", { class: "tabs" },
        h("button", { class: trashed ? "" : "active", onclick: () => go("ledgers", { ledgerTrash: false }) }, "台帳"),
        h("button", { class: trashed ? "active" : "", onclick: () => go("ledgers", { ledgerTrash: true }) }, "ごみ箱")),
      trashed ? null : h("div", { class: "row" }, title, h("button", { class: "primary", onclick: async () => {
        try { const l = await repo.createLedger(title.value || `台帳 ${new Date().toLocaleDateString("ja-JP")}`); go("editor", { ledgerUuid: l.uuid }); } catch (e) { toast(message(e), "error"); }
      } }, "台帳を作る"))),
    list.length ? h("table", { class: "table" },
      h("thead", {}, h("tr", {}, ...["台帳名", "工事名", "作成日時", "更新日時", "ページ数", "配置写真数", "状態", "最終バックアップ", ""].map(x => h("th", {}, x)))),
      h("tbody", {}, ...list.map(l => h("tr", {},
        h("td", {}, trashed ? l.title : h("button", { class: "link", onclick: () => go("editor", { ledgerUuid: l.uuid }) }, l.title)),
        h("td", {}, l.projectName), h("td", {}, fmtDate(l.createdAt)), h("td", {}, fmtDate(l.updatedAt)), h("td", { class: "num" }, l.pageCount), h("td", { class: "num" }, l.photoCount),
        h("td", {}, trashed ? "ごみ箱" : "使用中"), h("td", {}, fmtDate(l.lastBackupAt)),
        h("td", { class: "actions" }, ...(trashed ? [
          h("button", { onclick: async () => { await repo.restoreLedger(l.uuid); toast("台帳を元に戻しました。"); render(); } }, "元に戻す"),
          h("button", { class: "danger", onclick: async () => { if (await repo.confirm(`「${l.title}」を完全に削除します。写真は削除されません。よろしいですか？`)) { await repo.purgeLedger(l.uuid); toast("台帳を完全に削除しました。写真は残っています。"); render(); } } }, "完全に削除"),
        ] : [
          h("button", { onclick: () => go("editor", { ledgerUuid: l.uuid }) }, "開く"),
          h("button", { onclick: async () => { const t = prompt("新しい台帳名", l.title); if (t) { try { await repo.applyLedgerOps(l.uuid, [{ op: "SetTitle", title: t }]); render(); } catch (e) { toast(message(e), "error"); } } } }, "名前変更"),
          h("button", { onclick: async () => { await repo.duplicateLedger(l.uuid, `${l.title}（複製）`); toast("台帳を複製しました。"); render(); } }, "複製"),
          h("button", { onclick: () => pdfFlow(l.uuid, false) }, "PDF出力"),
          h("button", { onclick: () => pdfFlow(l.uuid, true) }, "印刷"),
          h("button", { class: "ghost", onclick: async () => { if (await repo.confirm(`「${l.title}」をごみ箱へ移します。写真は削除されません。`)) { await repo.trashLedger(l.uuid); toast("台帳をごみ箱へ移しました。写真は残っています。"); render(); } } }, "削除"),
        ]))))))
      : h("p", { class: "muted empty" }, trashed ? "ごみ箱は空です。" : "まだ台帳がありません。台帳名を入れて「台帳を作る」を押してください。"),
    trashed ? null : h("p", { class: "muted" }, "工事全体（写真と全台帳）を別のパソコンへ渡すときは「別端末へ引き継ぐ」を使ってください。")));
}

async function pdfFlow(ledgerUuid, print) {
  try {
    const est = await repo.pdfEstimate?.(ledgerUuid);
    if (est && !est.withinLimit) {
      modal("PDFを作成できません", h("div", {}, h("p", {}, est.message), h("p", { class: "muted" }, `推定 ${fmtBytes(est.bytes)}・${est.pages}ページ・写真${est.images}枚`)), [{ label: "閉じる", primary: true }]);
      return;
    }
    let dest = null;
    if (!print) {
      const d = await repo.ledgerDetail(ledgerUuid);
      dest = await repo.pickSaveFile(`${d.title}.pdf`, "pdf", "PDF");
      if (!dest) return;
    }
    const r = await runTask(print ? "印刷用のPDFを作っています" : "PDFを作っています", id => repo.exportPdf(id, ledgerUuid, dest, print));
    const warn = r.warnings.length ? h("div", { class: "failure-list" }, ...r.warnings.map(w => h("div", {}, `${w.page}ページ ${w.slot}枠目：${w.message}`))) : null;
    modal(print ? "印刷の準備ができました" : "PDFを作りました", h("div", {},
      h("p", {}, `${r.pages}ページ（写真${r.images}枚）・${fmtBytes(r.bytes)}`),
      print ? h("p", {}, "開いたPDFの画面から印刷してください。") : null,
      warn ? h("p", { class: "warn" }, "確認が必要な箇所があります。") : null, warn),
      [{ label: "保存先を開く", onClick: () => repo.reveal(r.path) }, { label: "閉じる", primary: true }]);
  } catch (e) { if (e?.kind !== "cancelled") toast(message(e), "error"); }
}

// ------------------------------------------------------------------ 台帳編集
let ledgerPhotoList = [];

async function renderEditor(main) {
  const uuid = state.ledgerUuid;
  let detail;
  try { detail = await repo.ledgerDetail(uuid); } catch (e) { toast(message(e), "error"); return go("ledgers"); }
  if (detail.deletedAt) { toast("ごみ箱の台帳は編集できません。先に元に戻してください。", "error"); return go("ledgers"); }
  const photosById = new Map((await repo.listPhotos({ ledgerUuid: uuid })).concat(await repo.listPhotos({ ledgerUuid: uuid, trashed: true })).map(p => [p.uuid, p]));
  const L = state.ledger = { uuid, detail, confirmed: clone(detail), undo: [], redo: [], selectedSlot: null, photosById, queue: null, filter: { unplacedOnly: true } };
  state.selection.clear();
  const statusEl = document.getElementById("save-status");
  const showStatus = (s, err) => {
    statusEl.replaceChildren();
    statusEl.className = `save-status ${s}`;
    const label = { saved: "保存済み ✓", pending: "未保存（まもなく保存）", saving: "保存中…", error: "保存できていません" }[s];
    statusEl.append(label);
    if (s === SaveStatus.error) statusEl.append(h("button", { class: "mini", onclick: () => L.queue.retry() }, "再試行"));
    if (err && s !== SaveStatus.error) statusEl.title = message(err);
  };
  L.queue = new SaveQueue(ops => repo.applyLedgerOps(uuid, ops), {
    onStatus: showStatus,
    onSaved: (result, morePending) => {
      L.confirmed = result.detail;
      if (!morePending) { L.detail = result.detail; draw(); }
      if (result.skippedPhotos?.length) toast(`${result.skippedPhotos.length}枚はこの台帳に配置済みのため飛ばしました。`);
    },
    onRejected: (e, ops) => {
      // 再試行しても直らない失敗：画面を保存済みの状態へ戻し、どの操作をなぜ戻したかを示す
      L.detail = clone(L.confirmed); draw();
      modal("保存できなかった操作を取り消しました", h("div", {},
        h("p", {}, `理由：${message(e)}`),
        h("p", {}, "取り消した操作："), h("ul", {}, ...describeOps(ops).map(t => h("li", {}, t))),
        h("p", { class: "muted" }, "画面は最後に保存できた状態に戻っています。")), [{ label: "閉じる", primary: true }]);
    },
  });
  showStatus(SaveStatus.saved);

  /** 操作を実行：画面へ即時反映し、保存はまとめて行う */
  const exec = async (ops, { record = true } = {}) => {
    const before = clone(L.detail);
    if (ops.some(isStructural)) {
      // ページ構成を変える操作は、先に保存して結果を表示する（ページの識別子を確定するため）
      L.queue.push(ops, true);
      await L.queue.flush();
      if (L.queue.status === SaveStatus.error) return;
      L.detail = clone(L.confirmed);
    } else {
      try { L.detail = applyLocal(L.detail, ops).detail; } catch (e) { toast(e.message, "error"); return; }
      L.queue.push(ops);
    }
    if (record) { const inv = computeInverse(before, L.detail); if (inv.length) { L.undo.push(inv); L.redo = []; } }
    draw();
  };
  const undo = async () => {
    const inv = L.undo.pop(); if (!inv) return toast("元に戻す操作がありません。");
    await L.queue.flush();
    const before = clone(L.detail);
    L.queue.push(inv, true); await L.queue.flush();
    L.detail = clone(L.confirmed);
    L.redo.push(computeInverse(before, L.detail)); draw();
  };
  const redo = async () => {
    const ops = L.redo.pop(); if (!ops) return toast("やり直す操作がありません。");
    await L.queue.flush();
    const before = clone(L.detail);
    L.queue.push(ops, true); await L.queue.flush();
    L.detail = clone(L.confirmed);
    L.undo.push(computeInverse(before, L.detail)); draw();
  };

  // 左：写真
  const leftGridHost = h("div", { class: "grid-host small", tabindex: 0 });
  const leftCount = h("span", { class: "count" });
  const refreshLeft = async () => {
    const list = await repo.listPhotos({ ledgerUuid: uuid, unplacedOnly: !!L.filter.unplacedOnly, text: L.filter.text || null, koushu: L.filter.koushu || null });
    list.forEach(p => photosById.set(p.uuid, p));
    // 画面上の配置状態（保存前）も反映
    const placed = new Set(orderedSlots(L.detail).filter(s => s.photoUuid).map(s => s.photoUuid));
    ledgerPhotoList = L.filter.unplacedOnly ? list.filter(p => !placed.has(p.uuid)) : list.map(p => ({ ...p, placed: placed.has(p.uuid) }));
    leftCount.textContent = `${ledgerPhotoList.length}枚`;
    leftGrid.setItems(ledgerPhotoList);
  };
  const meta = await repo.classifyMeta();
  const left = h("aside", { class: "ed-left" },
    h("div", { class: "filters column" },
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: true, onchange: e => { L.filter.unplacedOnly = e.target.checked; refreshLeft(); } }), "未配置だけ"),
      h("input", { type: "search", placeholder: "写真を探す", oninput: debounce(e => { L.filter.text = e.target.value; refreshLeft(); }, 250) }),
      h("select", { onchange: e => { L.filter.koushu = e.target.value || null; refreshLeft(); } }, h("option", { value: "" }, "工種：すべて"), ...meta.suggestions.koushu.map(v => h("option", { value: v }, v)))),
    h("div", { class: "row" }, leftCount, h("button", { class: "mini", onclick: () => placeSelected() }, "選択を空き枠へ"), h("button", { class: "mini", onclick: () => autoPlaceByDate() }, "撮影日時順に並べる")),
    leftGridHost);
  // 左へドロップ＝未配置へ戻す
  onDrop(left, d => { if (d.slot) exec([{ op: "Clear", slot: d.slot }]).then(refreshLeft); });

  // 中央：台帳ページ
  const pagesHost = h("div", { class: "pages" });
  const center = h("section", { class: "ed-center" },
    h("div", { class: "toolbar" },
      h("input", { class: "title-input", value: detail.title, maxlength: 200, onchange: e => exec([{ op: "SetTitle", title: e.target.value }]) }),
      h("div", { class: "tabs" },
        h("button", { class: detail.viewMode === "single" ? "active" : "", onclick: e => { exec([{ op: "SetViewMode", mode: "single" }]); e.target.parentElement.querySelectorAll("button").forEach(b => b.classList.toggle("active", b === e.target)); } }, "1ページ"),
        h("button", { class: detail.viewMode === "spread" ? "active" : "", onclick: e => { exec([{ op: "SetViewMode", mode: "spread" }]); e.target.parentElement.querySelectorAll("button").forEach(b => b.classList.toggle("active", b === e.target)); } }, "見開き")),
      h("button", { onclick: undo, title: "Ctrl+Z" }, "元に戻す"), h("button", { onclick: redo, title: "Ctrl+Y" }, "やり直す"),
      h("button", { onclick: () => exec([{ op: "AddPage", page: crypto.randomUUID(), after: currentPage() }]) }, "＋ページ"),
      h("button", { onclick: () => exec([{ op: "AddPage", page: crypto.randomUUID(), after: currentPage(), blank: true }]) }, "＋空白ページ"),
      h("button", { onclick: async () => { if (await guard.ensureSaved()) pdfFlow(uuid, false); } }, "PDF"),
      h("button", { onclick: async () => { if (await guard.ensureSaved()) pdfFlow(uuid, true); } }, "印刷")),
    pagesHost);
  // 右：設定
  const right = h("aside", { class: "ed-right" });
  main.append(h("div", { class: "editor-layout" }, left, center, right));
  const leftGrid = new VirtualGrid(leftGridHost, { cardWidth: 112, cardHeight: 118, gap: 8, render: (el, p, i) => photoCard(el, p, i, () => leftGrid.redrawVisible(), { draggable: true, compact: true }) });

  const currentPage = () => { const f = L.selectedSlot && findSlot(L.detail, L.selectedSlot); return f ? f.page.uuid : L.detail.pages.at(-1)?.uuid || null; };
  const placeSelected = async (fromSlot = null) => {
    const ids = ledgerPhotoList.filter(p => state.selection.has(p.uuid)).map(p => p.uuid);
    if (!ids.length) return toast("左の一覧から写真を選んでください。", "error");
    const slots = orderedSlots(L.detail);
    const from = fromSlot || (L.selectedSlot && slots.find(s => s.uuid === L.selectedSlot)?.uuid) || slots.find(s => s.kind === "empty")?.uuid || slots.at(-1)?.uuid;
    if (!from) return;
    if (ids.length === 1 && slots.find(s => s.uuid === from)?.kind !== "photo") await exec([{ op: "Place", slot: from, photo: ids[0] }]);
    else await exec([{ op: "PlaceMany", from, photos: ids }]);
    state.selection.clear();
    refreshLeft();
  };
  const autoPlaceByDate = async () => {
    const unplaced = (await repo.listPhotos({ ledgerUuid: uuid, unplacedOnly: true, koushu: L.filter.koushu || null }))
      .filter(p => !state.selection.size || state.selection.has(p.uuid)).sort((a, b) => (a.takenAt || "").localeCompare(b.takenAt || ""));
    if (!unplaced.length) return toast("配置する写真がありません。");
    if (!(await repo.confirm(`未配置の写真${unplaced.length}枚を撮影日時順に空き枠へ並べます。`))) return;
    const slots = orderedSlots(L.detail);
    await exec([{ op: "PlaceMany", from: slots[0].uuid, photos: unplaced.map(p => p.uuid) }]);
    refreshLeft();
  };

  // ページを表示範囲だけ描画する
  // 見えているページ（前後約1ページ）だけ描画し、離れたページは画像ごと解放する（1,000ページでもメモリを増やさない）
  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (e.isIntersecting) drawPage(e.target);
      else if (e.target.childElementCount) { releaseThumbs(e.target); e.target.replaceChildren(); pageSig.delete(e.target.dataset.page); }
    }
  }, { root: pagesHost, rootMargin: "800px 0px" });
  // 変更のあったページだけ描き直す（ページ構成が変わった時だけ全体を作り直す）
  let layoutSig = "";
  const pageSig = new Map();
  const sigOf = p => JSON.stringify([p.kind, p.slots, p.slots.map(s => s.photoUuid && L.detail.captions[s.photoUuid]), p.slots.some(s => s.uuid === L.selectedSlot) && L.selectedSlot,
    L.detail.pages.indexOf(p)]);
  function draw() {
    const d = L.detail;
    const sig = JSON.stringify([d.showCover, d.viewMode, d.pages.map(p => p.uuid)]);
    if (sig === layoutSig) {
      for (const frame of pagesHost.querySelectorAll(".page-frame[data-page]")) {
        const p = d.pages.find(x => x.uuid === frame.dataset.page);
        if (p && frame.childElementCount && pageSig.get(p.uuid) !== sigOf(p)) drawPage(frame);
      }
      const cover = pagesHost.querySelector(".page-frame.cover");
      if (cover) cover.replaceChildren(coverPage(d));
      drawRight();
      return;
    }
    layoutSig = sig;
    pageSig.clear();
    pagesHost.classList.toggle("spread", d.viewMode === "spread");
    io.disconnect();
    const frames = [];
    if (d.showCover) frames.push(h("div", { class: "page-frame cover" }, coverPage(d)));
    d.pages.forEach((p, i) => { const f = h("div", { class: "page-frame" }); f.dataset.page = p.uuid; f.dataset.index = String(i); frames.push(f); });
    pagesHost.replaceChildren(...frames);
    frames.forEach(f => f.dataset.page && io.observe(f));
    drawRight();
  }
  function drawPage(frame) {
    const p = L.detail.pages.find(x => x.uuid === frame.dataset.page);
    if (!p) return;
    releaseThumbs(frame);
    const i = L.detail.pages.indexOf(p);
    pageSig.set(p.uuid, sigOf(p));
    const page = h("div", { class: `page ${p.kind}` });
    if (p.kind === "photo") for (const s of p.slots) page.append(slotEl(s));
    else page.append(h("div", { class: "blank-page" }, "空白ページ"));
    page.append(h("div", { class: "page-no" }, `- ${i + 1} -`));
    const tools = h("div", { class: "page-tools" },
      h("span", {}, `${i + 1}ページ`),
      h("button", { class: "mini", disabled: i === 0, onclick: () => exec([{ op: "MovePage", page: p.uuid, after: i >= 2 ? L.detail.pages[i - 2].uuid : null }]) }, "↑"),
      h("button", { class: "mini", disabled: i === L.detail.pages.length - 1, onclick: () => exec([{ op: "MovePage", page: p.uuid, after: L.detail.pages[i + 1].uuid }]) }, "↓"),
      h("button", { class: "mini", onclick: async () => { if (L.detail.pages.length === 1) return toast("最後の1ページは削除できません。", "error"); await exec([{ op: "DeletePage", page: p.uuid }]); refreshLeft(); } }, "ページ削除"));
    frame.replaceChildren(tools, page);
  }
  function slotEl(s) {
    const photo = s.photoUuid ? photosById.get(s.photoUuid) : null;
    const el = h("div", { class: `slot ${s.kind}${L.selectedSlot === s.uuid ? " selected" : ""}`, tabindex: 0 });
    el.dataset.slot = s.uuid;
    if (s.photoUuid) el.dataset.photo = s.photoUuid;
    const cell = h("div", { class: "slot-photo" });
    if (s.kind === "photo") {
      const url = photo && repo.thumbUrl(photo);
      cell.append(url ? thumbCanvas(url) : h("div", { class: "thumb-wait" }, "準備中"));
      if (photo?.deletedAt) cell.append(h("div", { class: "slot-warn" }, "ごみ箱の写真です"));
    } else cell.append(h("div", { class: "slot-empty" }, s.kind === "blank" ? "空白" : "ここへ写真をドラッグ"));
    const c = photo ? resolvedCaption(L.detail, photo) : { koushu: "", sokuten: "", body: "" };
    const lvl = captionLengthLevel(c.body);
    el.append(cell, h("div", { class: "slot-cap" },
      h("div", { class: "cf" }, `工種：${c.koushu}`), h("div", { class: "cf" }, `測点：${c.sokuten}`),
      h("div", { class: `cb ${lvl.level}` }, c.body), lvl.level !== "ok" ? h("div", { class: "len-warn" }, lvl.level === "over" ? "⚠ 長すぎます" : "文字小") : null));
    el.onclick = () => {
      if (state.selection.size && s.kind !== "photo") { placeSelected(s.uuid); return; }
      L.selectedSlot = L.selectedSlot === s.uuid ? null : s.uuid; draw();
    };
    if (s.kind === "photo") makeDraggable(el, () => ({ slot: s.uuid }), { label: () => "入替え・移動" });
    onDrop(el, async d => {
      if (d.slot) { if (d.slot !== s.uuid) await exec([{ op: "Move", from: d.slot, to: s.uuid }]); }
      else if (d.photos?.length) {
        if (d.photos.length === 1) await exec([{ op: "Place", slot: s.uuid, photo: d.photos[0] }]); else await exec([{ op: "PlaceMany", from: s.uuid, photos: d.photos }]);
        state.selection.clear(); refreshLeft();
      }
    });
    return el;
  }
  function coverPage(d) {
    return h("div", { class: "page cover-page", onclick: () => { L.selectedSlot = "cover"; drawRight(); } },
      h("div", { class: "cv title" }, d.cover.title), h("div", { class: "cv koushu" }, d.cover.koushu), h("div", { class: "cv project" }, d.cover.project), h("div", { class: "cv contractor" }, d.cover.contractor));
  }
  function drawRight() {
    const d = L.detail;
    const f = L.selectedSlot && L.selectedSlot !== "cover" ? findSlot(d, L.selectedSlot) : null;
    if (document.activeElement && right.contains(document.activeElement) && right.dataset.for === String(L.selectedSlot)) return; // 入力中は作り直さない
    right.dataset.for = String(L.selectedSlot);
    const parts = [h("h2", {}, "台帳の設定")];
    parts.push(h("label", { class: "check" }, h("input", { type: "checkbox", checked: d.showCover, onchange: e => exec([{ op: "SetShowCover", show: e.target.checked }]) }), "表紙を付ける"));
    if (d.showCover) {
      const cv = { ...d.cover };
      for (const [k, label] of [["title", "表紙タイトル"], ["koushu", "工種"], ["project", "工事名"], ["contractor", "施工者名"]]) {
        parts.push(h("label", {}, label, h("input", { value: cv[k] || "", maxlength: 300, onchange: e => { cv[k] = e.target.value; exec([{ op: "SetCover", cover: cv }]); } })));
      }
    }
    if (f) {
      const s = f.slot;
      const photo = s.photoUuid ? photosById.get(s.photoUuid) : null;
      parts.push(h("h2", {}, "選んだ枠"));
      if (photo) {
        const c = resolvedCaption(d, photo);
        const field = (key, label, multiline) => {
          const auto = key === "body" ? photo.ledgerText : photo.classification[key];
          const input = multiline ? h("textarea", { rows: 6, maxlength: CAPTION_LIMITS[key] }, c[key]) : h("input", { value: c[key], maxlength: CAPTION_LIMITS[key] });
          const warn = h("div", { class: "warn" }, key === "body" ? captionLengthLevel(c[key]).message : "");
          input.oninput = () => { if (key === "body") warn.textContent = captionLengthLevel(input.value).message; };
          input.onchange = () => exec([{ op: "SetCaption", photo: photo.uuid, fields: { [key]: input.value } }]);
          return h("div", { class: "field" }, h("label", {}, label, c.manual[key] ? h("span", { class: "badge" }, "手入力") : h("span", { class: "muted" }, "（自動）")), input, warn,
            c.manual[key] ? h("button", { class: "mini", onclick: () => exec([{ op: "SetCaption", photo: photo.uuid, fields: { [key]: null } }]) }, `自動に戻す（${auto || "空欄"}）`) : null);
        };
        parts.push(h("div", { class: "slot-photo-preview" }, h("img", { src: repo.thumbUrl(photo) || "", alt: "" })),
          field("koushu", "工種", false), field("sokuten", "測点", false), field("body", "台帳文", true),
          h("button", { onclick: () => showPhotoDetail(photo.uuid) }, "写真の詳細"),
          h("button", { onclick: () => exec([{ op: "Clear", slot: s.uuid }]).then(refreshLeft) }, "未配置へ戻す"));
      } else if (s.kind === "blank") parts.push(h("p", {}, "空白枠です。"), h("button", { onclick: () => exec([{ op: "SetBlank", slot: s.uuid, blank: false }]) }, "空白を解除"));
      else parts.push(h("p", { class: "muted" }, "空き枠です。左の写真を選んでこの枠を押すか、ドラッグしてください。"), h("button", { onclick: () => exec([{ op: "SetBlank", slot: s.uuid, blank: true }]) }, "空白枠にする"));
      parts.push(h("div", { class: "row wrap" },
        h("button", { onclick: () => exec([{ op: "InsertBlank", slot: s.uuid }]) }, "この位置に空白を入れる"),
        h("button", { onclick: () => exec([{ op: "RemoveSlot", slot: s.uuid }]).then(refreshLeft) }, "この枠を詰める")));
    } else parts.push(h("p", { class: "muted" }, "台帳の枠を押すと、文言の編集や空白の挿入ができます。"));
    parts.push(h("h3", {}, "操作のヒント"), h("ul", { class: "hints" },
      h("li", {}, "写真を枠へドラッグして配置。配置済みの写真同士をドラッグすると入れ替わります。"),
      h("li", {}, "複数の写真を選んで空き枠を押すと、順に配置します（足りなければページを追加）。"),
      h("li", {}, "枠を左の一覧へドラッグすると未配置へ戻ります。"),
      h("li", {}, "キーボード：Delete 未配置へ／矢印 枠の移動／Ctrl+Z 元に戻す／Ctrl+Y やり直す")));
    right.replaceChildren(...parts);
  }
  const keyHandler = async e => {
    if (state.screen !== "editor" || ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
    else if ((e.key === "Delete" || e.key === "Backspace") && L.selectedSlot && L.selectedSlot !== "cover") { e.preventDefault(); await exec([{ op: "Clear", slot: L.selectedSlot }]); refreshLeft(); }
    else if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(e.key) && L.selectedSlot) {
      const slots = orderedSlots(L.detail); const i = slots.findIndex(s => s.uuid === L.selectedSlot);
      const j = Math.max(0, Math.min(slots.length - 1, i + (["ArrowRight", "ArrowDown"].includes(e.key) ? 1 : -1)));
      L.selectedSlot = slots[j].uuid; draw();
      pagesHost.querySelector(`[data-slot="${L.selectedSlot}"]`)?.scrollIntoView({ block: "nearest" });
      e.preventDefault();
    } else if (e.key === "Enter" && L.selectedSlot && state.selection.size) { placeSelected(L.selectedSlot); }
  };
  document.onkeydown = keyHandler;
  draw();
  await refreshLeft();
}

// ------------------------------------------------------------------ 引継ぎ
async function renderExchange(main) {
  const plan = await repo.exchangePlan(state.project.root);
  main.append(h("section", { class: "two-col" },
    h("div", { class: "card" }, h("h2", {}, "この工事を書き出す"),
      h("p", {}, "写真・分類・すべての台帳を1つのファイルにまとめます。USBメモリ等で別のパソコンへ渡し、「工事を開く」画面の「引継ぎファイルから取り込む」で開けます。"),
      h("dl", {}, h("dt", {}, "写真"), h("dd", {}, `${plan.photos}枚`), h("dt", {}, "台帳"), h("dd", {}, `${plan.ledgers}冊`), h("dt", {}, "容量"), h("dd", {}, `約${fmtBytes(plan.totalBytes)}`),
        h("dt", {}, "保存先の空き"), h("dd", {}, fmtBytes(plan.freeBytes))),
      h("button", { class: "primary", onclick: async () => {
        const dest = await repo.pickSaveFile(plan.suggestedName, "aoalb", "引継ぎファイル");
        if (!dest) return;
        try {
          if (!(await guard.ensureSaved())) return;
          const r = await runTask("引継ぎファイルを書き出しています", id => repo.exportExchange(id, dest));
          modal("書き出しました", h("div", {}, h("p", {}, `写真${r.photos}枚・${fmtBytes(r.bytes)}`), h("p", {}, "書き出した内容を読み直して、壊れていないことを確認しました。")),
            [{ label: "保存先を開く", onClick: () => repo.reveal(r.path) }, { label: "閉じる", primary: true }]);
        } catch (e) { if (e?.kind !== "cancelled") toast(message(e), "error"); }
      } }, "書き出す")),
    h("div", { class: "card" }, h("h2", {}, "別端末のファイルを取り込む"),
      h("p", {}, "別のパソコンで書き出した引継ぎファイルを取り込みます。この端末の工事と自動で混ぜ合わせることはしません。"),
      h("button", { onclick: () => importExchangeFlow(state.project.root.replace(/[\\/][^\\/]+$/, "")) }, "引継ぎファイルを選ぶ"))));
}

async function importExchangeFlow(destParent) {
  const file = await repo.pickExchangeFile();
  if (!file) return;
  if (!destParent) { destParent = await repo.pickFolder("取り込んだ工事を保存するフォルダを選ぶ"); if (!destParent) return; }
  let pv;
  try { pv = await repo.previewExchange(file, destParent); } catch (e) { return toast(message(e), "error"); }
  const run = async mode => {
    try {
      const s = await runTask("引継ぎファイルを取り込んでいます", id => repo.importExchange(id, file, destParent, mode));
      toast("取り込みました。");
      await opened(s);
    } catch (e) { if (e?.kind !== "cancelled") toast(message(e), "error"); }
  };
  const info = h("dl", {}, h("dt", {}, "工事名"), h("dd", {}, pv.projectName), h("dt", {}, "書き出した日時"), h("dd", {}, fmtDate(pv.exportedAt)),
    h("dt", {}, "写真・台帳"), h("dd", {}, `${pv.photos}枚・${pv.ledgers}冊`), h("dt", {}, "必要な空き容量"), h("dd", {}, `約${fmtBytes(pv.totalBytes)}（空き ${fmtBytes(pv.freeBytes)}）`));
  if (!pv.existing) return modal("引継ぎファイルを取り込む", info, [{ label: "取り込む", primary: true, onClick: () => run({ mode: "new" }) }, { label: "キャンセル" }]);
  const ex = pv.existing;
  modal("同じ工事がこの端末にあります", h("div", {}, info,
    ex.localNewer ? h("p", { class: "warn strong" }, ex.message) : h("p", {}, "この端末の工事は、取込ファイルより新しい編集を含んでいません。"),
    h("p", { class: "muted" }, "置き換える場合、今の工事フォルダは名前を変えてそのまま残し、バックアップも作ります。")), [
    { label: "既存工事をバックアップして置き換える", danger: ex.localNewer, primary: !ex.localNewer, onClick: async () => {
      if (ex.localNewer && !(await repo.confirm(`${ex.message}\n\n置き換えますか？`))) return false;
      if (state.project?.root === ex.root) { if (!(await guard.ensureSaved())) return false; await repo.closeProject(); state.project = null; }
      run({ mode: "replace", root: ex.root, confirmNewer: ex.localNewer });
    } },
    { label: "別の工事として取り込む", onClick: () => run({ mode: "asCopy" }) },
    { label: "キャンセル" }]);
}

// ------------------------------------------------------------------ バックアップ
async function renderBackup(main) {
  const { status, list } = await repo.backupStatus();
  main.append(h("section", { class: "card wide" }, h("h2", {}, "バックアップ・復元"),
    h("dl", {}, h("dt", {}, "保存先"), h("dd", { class: "path" }, status.folder), h("dt", {}, "件数・容量"), h("dd", {}, `${status.count}件・${fmtBytes(status.totalBytes)}`),
      h("dt", {}, "最終バックアップ"), h("dd", {}, fmtDate(status.lastBackupAt)), h("dt", {}, "空き容量"), h("dd", {}, fmtBytes(status.freeBytes))),
    h("p", { class: "muted" }, "工事を開いている間は10分ごと（変更がある時）、台帳の削除前、引継ぎファイルで置き換える前、復元の前に自動でバックアップします。原寸写真は変更・削除しないため、バックアップは台帳と分類の情報だけを保存し、写真を重複して保存しません。工事フォルダごと外付けSSD等へコピーすると、写真も含めて保管できます。"),
    h("div", { class: "row" }, h("button", { class: "primary", onclick: async () => { await repo.createBackup(); toast("バックアップしました。"); render(); } }, "今すぐバックアップ"),
      h("button", { onclick: () => repo.reveal(status.folder) }, "フォルダを開く")),
    h("table", { class: "table" }, h("thead", {}, h("tr", {}, ...["日時", "きっかけ", "容量", ""].map(x => h("th", {}, x)))),
      h("tbody", {}, ...list.map(b => h("tr", {}, h("td", {}, b.createdAt), h("td", {}, b.reasonLabel), h("td", {}, fmtBytes(b.bytes)),
        h("td", { class: "actions" },
          h("button", { onclick: async () => { const r = await repo.verifyBackup(b.name); toast(r.message, r.ok ? "info" : "error"); } }, "確認"),
          h("button", { class: "danger", onclick: async () => {
            if (!(await repo.confirm(`${b.createdAt} の状態へ戻します。今の状態は自動でバックアップしてから戻します。よろしいですか？`))) return;
            try {
              if (!(await guard.ensureSaved())) return;
              const r = await repo.restoreBackup(b.name);
              toast("復元しました。");
              if (r?.recovery?.found) showRecovery(r.recovery);
              render();
            } catch (e) { toast(message(e), "error"); }
          } }, "この状態へ戻す"))))))));
}

// ------------------------------------------------------------------ 起動
repo.onThumbnailsReady?.(async uuids => {
  if (state.screen === "photos" && grid) {
    const fresh = await repo.listPhotos({ uuids });
    const m = new Map(fresh.map(p => [p.uuid, p]));
    photoList = photoList.map(p => m.get(p.uuid) || p);
    grid.items = photoList;
    grid.redrawVisible(p => m.has(p.uuid));
  }
});
repo.onDropFiles?.(paths => {
  if (!state.project || !paths?.length) return toast("先に工事を開いてください。", "error");
  if (paths.length === 1 && /\.zip$/i.test(paths[0])) return doImport({ kind: "zip", path: paths[0] });
  if (paths.length === 1 && /\.aoalb$/i.test(paths[0])) return toast("引継ぎファイルは「別端末へ引き継ぐ」から取り込んでください。");
  if (paths.length === 1 && !/\.(jpe?g)$/i.test(paths[0])) return doImport({ kind: "folder", path: paths[0] });
  doImport({ kind: "files", paths });
});
// アプリ終了：保存が成功し、工事を正常に閉じた後だけウィンドウを破棄する。失敗したら終了しない
repo.onCloseRequested?.(destroy => createExitHandler({
  guard,
  closeProject: async () => { if (state.project) { await repo.closeProject(); state.project = null; } },
  destroy,
  onError: e => toast(`終了できませんでした：${message(e)}`, "error"),
}));
setInterval(() => { if (state.project) repo.periodicBackup().catch(() => {}); }, 10 * 60 * 1000);
// ブラウザの再読込み等：非同期の保存は完了を保証できないため頼らず、未保存がある時は止めて確認だけ出す
window.addEventListener("beforeunload", e => { if (state.ledger?.queue?.hasUnsaved) { e.preventDefault(); e.returnValue = ""; } });
window.__aoalb = { state, repo, go, opened }; // 動作確認用
render();
// 計測用の自動操作（アプリ起動時に環境変数で指定した時だけ）
repo.e2eConfig?.().then(c => { if (c?.enabled) import("./e2e-auto.js").then(m => m.run(c.project)); }).catch(() => {});
