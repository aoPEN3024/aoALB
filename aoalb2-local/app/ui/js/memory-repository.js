// 架空データだけで画面を確認するための実装（ブラウザで index.html?demo=1000 を開いた時に使う）。
// 保存はしない。将来のクラウド版も、この実装と同じ Repository インターフェースを実装する。

import { applyLocal, clone } from "./ledger-model.js";

const FIELDS = ["koushu", "shubetsu", "saibetsu", "sokuten", "tekiyo"];
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const empty = () => Object.fromEntries(FIELDS.map(f => [f, ""]));
const err = (message, kind = "invalid") => Object.assign(new Error(message), { kind, message });
const folderClassification = label => {
  const p = String(label || "").split(/[\\/]/).map(x => x.trim()).filter(Boolean).slice(0, 3);
  if (!p.length || p[0] === "未分類") return { koushu: "", shubetsu: "", saibetsu: "" };
  return { koushu: p[0] || "", shubetsu: p[1] || "", saibetsu: p[2] || "" };
};

export class MemoryRepository {
  constructor(count = 300) {
    this.kind = "demo";
    this.count = count;
    this.photos = [];
    this.ledgers = new Map();
    this.ledgerFolders = [];
    this.ledgerAssignments = new Map();
    this.deletedPages = new Map();
    this.templates = [];
    this.recent = [];
    this.thumbs = new Map();
    this.progressCbs = [];
    this.thumbCbs = [];
    this.project = null;
  }

  _makePhotos(n, start = 0) {
    const kinds = ["塗装工", "足場工", "下地処理工"];
    for (let i = start; i < start + n; i++) {
      const aopic = i % 3 === 0;
      const original = aopic ? { koushu: kinds[i % 3], shubetsu: "橋梁塗装", saibetsu: `第${1 + (i % 3)}層`, sokuten: `P${i + 1}`, tekiyo: "架空データ" } : empty();
      const t = new Date(Date.UTC(2026, 9, 1 + Math.floor(i / 120) % 28, i % 24, i % 60));
      this.photos.push({
        uuid: uuid(), photoUid: aopic ? uuid() : null, sourceKind: aopic ? "aopic" : "general", photoNumber: i + 1,
        takenAt: t.toISOString().slice(0, 19), takenAtSource: aopic ? "aopic" : "exif", width: i % 7 === 0 ? 3000 : 4000, height: i % 7 === 0 ? 4000 : 3000,
        orientation: 1, bytes: aopic ? 420000 : 5200000, originalName: aopic ? `${i}.jpg` : `DSC${String(i).padStart(5, "0")}.JPG`,
        folderLabel: aopic ? "" : `SD/DCIM/${100 + Math.floor(i / 250)}CANON`, original, override: {}, thumbState: "ready", createdAt: now(), deletedAt: null,
        ledgerText: aopic ? `架空台帳タイトル${i + 1}` : "",
      });
    }
  }

  _row(p, ledgerUuid) {
    const classification = Object.fromEntries(FIELDS.map(f => [f, p.override[f] ?? p.original[f]]));
    const overridden = FIELDS.filter(f => p.override[f] != null);
    const l = ledgerUuid && this.ledgers.get(ledgerUuid);
    const placed = !!l && l.pages.some(pg => pg.slots.some(s => s.photoUuid === p.uuid));
    return { ...p, classification, overridden, placed, ledgerText: p.ledgerText || classification.tekiyo };
  }

  async appInfo() { return { version: "demo", recent: [], defaultParent: "（架空）" }; }
  async createProject(parent, input) {
    this.project = { uuid: uuid(), name: input.name, koujiCode: input.koujiCode || "", contractor: input.contractor || "", createdAt: now(), updatedAt: now(), revision: 1 };
    this._makePhotos(this.count);
    return { info: this.project, root: "（架空）", thumbDir: "", originalDir: "", report: null };
  }
  async openProject() { return this.createProject("", { name: "架空 橋梁塗装工事", contractor: "架空建設" }); }
  async closeProject() {}
  async updateProject(input) { Object.assign(this.project, input); return this.project; }
  async forgetRecent() {}

  async importPhotos(taskId, source) {
    const n = 24;
    for (let i = 0; i < n; i++) { this.progressCbs.forEach(cb => cb({ taskId, progress: { phase: "import", current: i, total: n, message: `写真を取り込んでいます ${i + 1}/${n}` } })); await new Promise(r => setTimeout(r, 20)); }
    const start = this.photos.length;
    this._makePhotos(n, start);
    return { batchUuid: uuid(), total: n + 1, accepted: n, duplicates: 0, failed: 1, cancelled: false, photoUuids: this.photos.slice(start).map(p => p.uuid),
      failures: [{ id: 1, sourceName: "IMG_0001.HEIC", reason: "対応していない形式です（JPEGのみ取り込めます）。", kind: "unsupported" }] };
  }
  async retryImport() { return { accepted: 0, duplicates: 0, failed: 0, failures: [], photoUuids: [] }; }
  async listFailures() { return []; }
  async listPhotos(f = {}) {
    let list = this.photos.filter(p => (f.trashed ? !!p.deletedAt : !p.deletedAt)).map(p => this._row(p, f.ledgerUuid));
    if (f.unclassifiedOnly) list = list.filter(p => FIELDS.every(k => !p.classification[k]));
    if (f.unplacedOnly) list = list.filter(p => !p.placed);
    if (f.text) { const t = f.text.trim(); list = list.filter(p => [p.originalName, p.folderLabel, ...FIELDS.map(k => p.classification[k])].some(v => v.includes(t))); }
    if (f.folderLabel != null) list = list.filter(p => p.folderLabel === f.folderLabel);
    if (f.takenFrom) list = list.filter(p => (p.takenAt || "") >= f.takenFrom);
    if (f.takenTo) list = list.filter(p => (p.takenAt || "") < f.takenTo);
    for (const k of ["koushu", "shubetsu", "saibetsu"]) if (f[k] != null) list = list.filter(p => p.classification[k] === f[k]);
    if (f.uuids) { const s = new Set(f.uuids); list = list.filter(p => s.has(p.uuid)); }
    const direction = f.sortDesc ? -1 : 1;
    const number = (a, b) => ((a.photoNumber || 0) - (b.photoNumber || 0)) || a.uuid.localeCompare(b.uuid);
    const text = (a, b, key) => (a[key] || "").localeCompare(b[key] || "", "ja", { numeric: true, sensitivity: "base" });
    return list.sort((a, b) => {
      let compared = 0;
      if (f.sortBy === "name") compared = text(a, b, "originalName");
      else if (f.sortBy === "koushu") {
        const ak = a.classification.koushu || ""; const bk = b.classification.koushu || "";
        if (!ak !== !bk) return !ak ? 1 : -1;
        compared = ak.localeCompare(bk, "ja", { numeric: true, sensitivity: "base" })
          || (a.classification.shubetsu || "").localeCompare(b.classification.shubetsu || "", "ja", { numeric: true, sensitivity: "base" })
          || (a.classification.saibetsu || "").localeCompare(b.classification.saibetsu || "", "ja", { numeric: true, sensitivity: "base" });
      } else compared = (a.takenAt || a.createdAt || "").localeCompare(b.takenAt || b.createdAt || "");
      return compared ? compared * direction : number(a, b) * direction;
    });
  }
  async photoDetail(id) {
    const p = this.photos.find(x => x.uuid === id);
    return { photo: this._row(p), sha256: "", aopic: p.sourceKind === "aopic" ? { boardSnapshot: { koujimei: "架空 橋梁塗装工事", ...p.original } } : null, exif: { make: "架空カメラ" }, ledgers: [] };
  }
  async readBlackboard() {
    return { text: "工種 塗装工\n測点 P12\n施工内容 上塗り 施工状況", lines: ["工種 塗装工", "測点 P12", "施工内容 上塗り 施工状況"], language: "ja-JP", cropWidth: 1600, cropHeight: 900 };
  }
  async trashPhotos(ids) { ids.forEach(i => { this.photos.find(p => p.uuid === i).deletedAt = now(); }); return ids.length; }
  async restorePhotos(ids) { ids.forEach(i => { this.photos.find(p => p.uuid === i).deletedAt = null; }); return ids.length; }
  async folderLabels() {
    const m = new Map();
    this.photos.filter(p => !p.deletedAt).forEach(p => m.set(p.folderLabel, (m.get(p.folderLabel) || 0) + 1));
    return [...m].map(([folderLabel, count]) => ({ folderLabel, count }));
  }
  async rebuildThumbnails() { return 0; }
  thumbUrl(p) {
    if (this.thumbs.has(p.uuid)) return this.thumbs.get(p.uuid);
    const c = document.createElement("canvas");
    const portrait = p.height > p.width;
    c.width = portrait ? 90 : 120; c.height = portrait ? 120 : 90;
    const g = c.getContext("2d");
    const h = (p.photoNumber * 47) % 360;
    const grad = g.createLinearGradient(0, 0, c.width, c.height);
    grad.addColorStop(0, `hsl(${h} 45% 55%)`); grad.addColorStop(1, `hsl(${(h + 60) % 360} 45% 35%)`);
    g.fillStyle = grad; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "rgba(255,255,255,.85)"; g.font = "bold 18px sans-serif"; g.fillText(String(p.photoNumber), 8, 24);
    const url = c.toDataURL("image/jpeg", 0.7);
    this.thumbs.set(p.uuid, url);
    return url;
  }
  originalUrl(p) { return this.thumbUrl(p); }

  async classify(ids, changes) {
    const before = [];
    for (const id of ids) {
      const p = this.photos.find(x => x.uuid === id);
      before.push({ photoUuid: id, ...Object.fromEntries(FIELDS.map(f => [f, p.override[f] ?? null])) });
      for (const [k, c] of Object.entries(changes)) {
        if (c.mode === "original") delete p.override[k];
        else { const v = String(c.value).trim(); if (v === p.original[k]) delete p.override[k]; else p.override[k] = v; }
      }
    }
    const values = Object.fromEntries(Object.entries(changes).filter(([, c]) => c.mode === "set" && c.value).map(([k, c]) => [k, c.value]));
    if (Object.keys(values).length) { this.recent = [values, ...this.recent.filter(r => JSON.stringify(r) !== JSON.stringify(values))].slice(0, 20); }
    return before;
  }
  async restoreClassification(states) {
    const before = [];
    for (const s of states) {
      const p = this.photos.find(x => x.uuid === s.photoUuid);
      before.push({ photoUuid: p.uuid, ...Object.fromEntries(FIELDS.map(f => [f, p.override[f] ?? null])) });
      p.override = Object.fromEntries(FIELDS.filter(f => s[f] != null).map(f => [f, s[f]]));
    }
    return before;
  }
  async previewFolderClassification() {
    const mappings = new Map();
    const result = { photoCount: 0, koushuCount: 0, shubetsuCount: 0, saibetsuCount: 0, mappings: [] };
    for (const p of this.photos.filter(x => !x.deletedAt && x.sourceKind !== "aopic" && x.folderLabel)) {
      const current = this._row(p).classification;
      const inferred = folderClassification(p.folderLabel);
      const fill = { koushu: !current.koushu && !!inferred.koushu, shubetsu: !current.shubetsu && !!inferred.shubetsu, saibetsu: !current.saibetsu && !!inferred.saibetsu };
      if (!Object.values(fill).some(Boolean)) continue;
      result.photoCount++;
      for (const k of ["koushu", "shubetsu", "saibetsu"]) if (fill[k]) result[`${k}Count`]++;
      const m = mappings.get(p.folderLabel) || { folderLabel: p.folderLabel, photoCount: 0, candidateCount: 0, ...inferred };
      m.photoCount++; m.candidateCount++; mappings.set(p.folderLabel, m);
    }
    result.mappings = [...mappings.values()];
    return result;
  }
  async applyFolderClassification() {
    const result = { changedPhotos: 0, changedKoushu: 0, changedShubetsu: 0, changedSaibetsu: 0 };
    for (const p of this.photos.filter(x => !x.deletedAt && x.sourceKind !== "aopic" && x.folderLabel)) {
      const current = this._row(p).classification;
      const inferred = folderClassification(p.folderLabel);
      let changed = false;
      for (const k of ["koushu", "shubetsu", "saibetsu"]) if (!current[k] && inferred[k]) { p.override[k] = inferred[k]; result[`changed${k[0].toUpperCase()}${k.slice(1)}`]++; changed = true; }
      if (changed) result.changedPhotos++;
    }
    return result;
  }
  async classifyMeta() {
    const suggestions = {};
    for (const f of FIELDS) {
      const m = new Map();
      this.photos.forEach(p => { const v = p.override[f] ?? p.original[f]; if (v) m.set(v, (m.get(v) || 0) + 1); });
      suggestions[f] = [...m].sort((a, b) => b[1] - a[1]).map(x => x[0]).slice(0, 200);
    }
    return { suggestions, recent: this.recent, templates: this.templates };
  }
  async saveTemplate(id, name, values) { const t = { uuid: id || uuid(), name, values }; this.templates = [...this.templates.filter(x => x.uuid !== t.uuid), t]; return t; }
  async deleteTemplate(id) { this.templates = this.templates.filter(x => x.uuid !== id); }

  _summary(l) {
    return { uuid: l.uuid, title: l.title, projectName: this.project.name, createdAt: l.createdAt, updatedAt: l.updatedAt, pageCount: l.pages.length,
      photoCount: l.pages.reduce((n, p) => n + p.slots.filter(s => s.kind === "photo").length, 0), deletedAt: l.deletedAt, lastBackupAt: null,
      folderUuid: this.ledgerAssignments.get(l.uuid) || null };
  }
  async listLedgers(trashed = false) { return [...this.ledgers.values()].filter(l => !!l.deletedAt === trashed).map(l => this._summary(l)); }
  async listLedgerFolders() { return clone(this.ledgerFolders); }
  async createLedgerFolder(name) {
    name = String(name).trim();
    if (!name) throw err("フォルダ名を入力してください。");
    if (this.ledgerFolders.some(f => f.name.toLocaleLowerCase("ja") === name.toLocaleLowerCase("ja"))) throw err("同じ名前のフォルダがあります。");
    const folder = { uuid: uuid(), name, position: this.ledgerFolders.length };
    this.ledgerFolders.push(folder); return clone(folder);
  }
  async renameLedgerFolder(id, name) {
    name = String(name).trim();
    const folder = this.ledgerFolders.find(f => f.uuid === id);
    if (!folder) throw err("フォルダが見つかりません。", "not_found");
    if (!name) throw err("フォルダ名を入力してください。");
    if (this.ledgerFolders.some(f => f.uuid !== id && f.name.toLocaleLowerCase("ja") === name.toLocaleLowerCase("ja"))) throw err("同じ名前のフォルダがあります。");
    folder.name = name; return clone(folder);
  }
  async deleteLedgerFolder(id) {
    this.ledgerFolders = this.ledgerFolders.filter(f => f.uuid !== id);
    for (const [ledger, folder] of this.ledgerAssignments) if (folder === id) this.ledgerAssignments.delete(ledger);
  }
  async moveLedgerToFolder(ledgerId, folderId = null) {
    if (!this.ledgers.has(ledgerId)) throw err("台帳が見つかりません。", "not_found");
    if (folderId && !this.ledgerFolders.some(f => f.uuid === folderId)) throw err("移動先のフォルダが見つかりません。", "not_found");
    if (folderId) this.ledgerAssignments.set(ledgerId, folderId); else this.ledgerAssignments.delete(ledgerId);
  }
  async createLedger(title) {
    if (!String(title).trim()) throw err("台帳名を入力してください。");
    const l = { uuid: uuid(), title: title.trim(), template: "construction-3", showCover: true, cover: { title: "工事写真帳", koushu: "", project: this.project.name, contractor: this.project.contractor },
      viewMode: "single", createdAt: now(), updatedAt: now(), revision: 1, deletedAt: null, captions: {},
      pages: [{ uuid: uuid(), kind: "photo", position: 1, slots: [0, 1, 2].map(index => ({ uuid: uuid(), index, kind: "empty", photoUuid: null })) }] };
    this.ledgers.set(l.uuid, l);
    return clone(l);
  }
  async ledgerDetail(id) { const l = this.ledgers.get(id); if (!l) throw err("台帳が見つかりません。", "not_found"); return clone(l); }
  async applyLedgerOps(id, ops) {
    // 画面確認用：failSaves 回だけ一時的な保存失敗を起こす
    if (this.failSaves > 0) { this.failSaves--; await new Promise(res => setTimeout(res, 5)); throw err("保存先に書き込めません。", "internal"); }
    const l = this.ledgers.get(id);
    if (l.deletedAt) throw err("ごみ箱の台帳は編集できません。先に復元してください。");
    const trashed = new Set(this.photos.filter(p => p.deletedAt).map(p => p.uuid));
    let r;
    try { r = applyLocal(l, ops, { idGen: uuid, trashedPhotos: trashed, deletedPages: this.deletedPages }); } catch (e) { throw err(e.message); }
    Object.assign(r.detail, { updatedAt: now(), revision: l.revision + 1 });
    this.ledgers.set(id, r.detail);
    await new Promise(res => setTimeout(res, 5));
    return { detail: clone(r.detail), changedSlots: 0, changedPages: 0, skippedPhotos: r.skipped };
  }
  async trashLedger(id) { this.ledgers.get(id).deletedAt = now(); }
  async restoreLedger(id) { this.ledgers.get(id).deletedAt = null; }
  async purgeLedger(id) { this.ledgers.delete(id); this.ledgerAssignments.delete(id); }
  async duplicateLedger(id, title) {
    const src = clone(this.ledgers.get(id));
    src.uuid = uuid(); src.title = title; src.pages.forEach(p => { p.uuid = uuid(); p.slots.forEach(s => { s.uuid = uuid(); }); });
    this.ledgers.set(src.uuid, src);
    const folder = this.ledgerAssignments.get(id); if (folder) this.ledgerAssignments.set(src.uuid, folder);
    return clone(src);
  }
  async pdfEstimate() { return { bytes: 0, pages: 0, images: 0, limit: 7e9, withinLimit: true, message: null }; }
  async exportPdf() { throw err("確認用の画面ではPDFを作成できません。Windowsアプリで作成してください。"); }
  async exchangePlan() { return { photos: this.photos.length, ledgers: this.ledgers.size, totalBytes: this.photos.reduce((n, p) => n + p.bytes, 0), freeBytes: null, suggestedName: "架空工事.aoalb" }; }
  async exportExchange() { throw err("確認用の画面では書き出せません。"); }
  async previewExchange() { throw err("確認用の画面では取り込めません。"); }
  async importExchange() { throw err("確認用の画面では取り込めません。"); }
  async backupStatus() { return { status: { folder: "（架空）", count: 0, totalBytes: 0, lastBackupAt: null, freeBytes: null }, list: [] }; }
  async createBackup() { return null; }
  async periodicBackup() { return null; }
  async verifyBackup() { return { ok: true, message: "" }; }
  async restoreBackup() { return { before: null, recovery: { found: 0, recoveredFromBackup: 0, recoveredFromFile: 0, failed: [] } }; }
  async recoverUnregistered() { return { found: 0, recoveredFromBackup: 0, recoveredFromFile: 0, failed: [], otherFiles: 0 }; }
  async about() { return { version: "demo", font: "BIZ UDゴシック（同梱）", fontLicense: "SIL Open Font License 1.1（Windowsアプリで全文を表示）" }; }
  async cancelTask() {}
  onProgress(cb) { this.progressCbs.push(cb); }
  onThumbnailsReady(cb) { this.thumbCbs.push(cb); }
  async pickFolder() { return "（架空フォルダ）"; }
  async pickFiles() { return ["（架空写真）"]; }
  async pickExchangeFile() { return null; }
  async pickSaveFile() { return null; }
  async reveal() {}
  async confirm(message) { return window.confirm(message); }
  onDropFiles() {}
  onCloseRequested(makeHandler) { this.exitHandler = makeHandler(async () => { this.destroyed = true; }); }
}
