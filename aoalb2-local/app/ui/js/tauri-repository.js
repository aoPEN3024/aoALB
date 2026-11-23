// ローカル版の保存処理（Windowsアプリ）。工事フォルダのSQLiteと写真ファイルを Tauri 経由で扱う。
// 画面は Repository インターフェース（repository.js）だけを使い、この実装の中身には依存しない。

const T = () => window.__TAURI__;
const call = (cmd, args) => T().core.invoke(cmd, args);

export class TauriRepository {
  constructor() { this.kind = "local"; this.thumbDir = ""; this.originalDir = ""; }

  // ---- 工事
  appInfo() { return call("app_info"); }
  async createProject(parent, input) { return this._opened(await call("project_create", { parent, input })); }
  async openProject(root) { return this._opened(await call("project_open", { root })); }
  _opened(s) { this.thumbDir = s.thumbDir; this.originalDir = s.originalDir; return s; }
  closeProject() { return call("project_close"); }
  updateProject(input) { return call("project_update", { input }); }
  forgetRecent(root) { return call("forget_recent", { root }); }

  // ---- 写真
  importPhotos(taskId, source, options = {}) { return call("photos_import", { taskId, source, options }); }
  retryImport(taskId, ids, options = {}) { return call("import_retry", { taskId, ids, options }); }
  listFailures(batch = null) { return call("import_failures", { batch }); }
  listPhotos(filter = {}) { return call("photos_list", { filter }); }
  photoDetail(uuid) { return call("photo_detail", { uuid }); }
  trashPhotos(uuids) { return call("photos_trash", { uuids }); }
  restorePhotos(uuids) { return call("photos_restore", { uuids }); }
  folderLabels() { return call("folder_labels"); }
  rebuildThumbnails() { return call("thumbnails_rebuild"); }
  // 写真は専用の経路（今開いている工事の写真だけを返す・画面側に溜めない）で読む
  thumbUrl(photo) { return photo.thumbState === "ready" ? T().core.convertFileSrc(`t/${photo.uuid}.jpg`, "aoimg").replace("%2F", "/") : null; }
  originalUrl(photo) { return T().core.convertFileSrc(`o/${photo.uuid}.jpg`, "aoimg").replace("%2F", "/"); }

  // ---- 分類
  classify(photoUuids, changes) { return call("classify_apply", { photoUuids, changes }); }
  restoreClassification(states) { return call("classify_restore", { states }); }
  previewFolderClassification() { return call("folder_classification_preview"); }
  applyFolderClassification() { return call("folder_classification_apply"); }
  classifyMeta() { return call("classify_meta"); }
  saveTemplate(uuid, name, values) { return call("template_save", { uuid, name, values }); }
  deleteTemplate(uuid) { return call("template_delete", { uuid }); }

  // ---- 台帳
  listLedgers(trashed = false) { return call("ledgers_list", { trashed }); }
  createLedger(title) { return call("ledger_create", { title }); }
  ledgerDetail(uuid) { return call("ledger_detail", { uuid }); }
  applyLedgerOps(uuid, ops) { return call("ledger_apply", { uuid, ops }); }
  trashLedger(uuid) { return call("ledger_trash", { uuid }); }
  restoreLedger(uuid) { return call("ledger_restore", { uuid }); }
  purgeLedger(uuid) { return call("ledger_purge", { uuid }); }
  duplicateLedger(uuid, title) { return call("ledger_duplicate", { uuid, title }); }
  pdfEstimate(ledgerUuid) { return call("pdf_estimate", { ledgerUuid }); }
  exportPdf(taskId, ledgerUuid, dest = null, open = false) { return call("pdf_export", { taskId, ledgerUuid, dest, open }); }

  // ---- 引継ぎ
  exchangePlan(destDir) { return call("exchange_plan", { destDir }); }
  exportExchange(taskId, dest) { return call("exchange_export", { taskId, dest }); }
  previewExchange(file, destParent) { return call("exchange_preview", { file, destParent }); }
  async importExchange(taskId, file, destParent, mode) { return this._opened(await call("exchange_import", { taskId, file, destParent, mode })); }

  // ---- バックアップ
  backupStatus() { return call("backup_status"); }
  createBackup() { return call("backup_create"); }
  periodicBackup() { return call("backup_periodic"); }
  verifyBackup(name) { return call("backup_verify", { name }); }
  restoreBackup(name) { return call("backup_restore", { name }); }
  recoverUnregistered() { return call("recover_unregistered"); }
  about() { return call("about"); }
  e2eConfig() { return call("e2e_config"); }
  e2eReport(report) { return call("e2e_report", { report }); }

  // ---- 共通
  cancelTask(taskId) { return call("task_cancel", { taskId }); }
  onProgress(cb) { return T().event.listen("task-progress", e => cb(e.payload)); }
  onThumbnailsReady(cb) { return T().event.listen("thumbnails-ready", e => cb(e.payload.uuids)); }
  async pickFolder(title) { return T().dialog.open({ directory: true, multiple: false, title }); }
  async pickFiles({ zip = false, multiple = true } = {}) {
    return T().dialog.open({ multiple, title: zip ? "ZIPを選ぶ" : "写真を選ぶ", filters: zip ? [{ name: "ZIP", extensions: ["zip"] }] : [{ name: "写真", extensions: ["jpg", "jpeg", "JPG", "JPEG", "zip"] }] });
  }
  async pickExchangeFile() { return T().dialog.open({ multiple: false, title: "引継ぎファイルを選ぶ", filters: [{ name: "引継ぎファイル", extensions: ["aoalb"] }] }); }
  async pickSaveFile(defaultPath, ext, name) { return T().dialog.save({ defaultPath, filters: [{ name, extensions: [ext] }] }); }
  reveal(path) { return call("reveal", { path }); }
  async confirm(message, title = "確認") { return T().dialog.ask(message, { title, kind: "warning", okLabel: "はい", cancelLabel: "いいえ" }); }
  onDropFiles(cb) {
    const wv = T().webview?.getCurrentWebview?.();
    return wv?.onDragDropEvent?.(e => { if (e.payload.type === "drop") cb(e.payload.paths); });
  }
  /** 閉じる要求を受けたら必ず止め、makeHandler が作った処理が成功した時だけウィンドウを破棄する */
  onCloseRequested(makeHandler) {
    const w = T().window.getCurrentWindow();
    const handler = makeHandler(() => w.destroy());
    return w.onCloseRequested(e => { e.preventDefault(); handler(); });
  }
}
