// Repository インターフェース：画面が使う保存処理の窓口。
// 画面・台帳編集はこのインターフェースだけに依存する。
//   現在：TauriRepository（工事フォルダのSQLite＋写真ファイル、Windowsアプリ）
//   確認用：MemoryRepository（架空データ、ブラウザで index.html?demo=1000）
//   将来：クラウド同期付きの実装を追加しても、画面と台帳編集は作り直さない。
//
// 主なメソッド（すべて Promise を返す）
//   工事     appInfo / createProject / openProject / closeProject / updateProject
//   写真     importPhotos / retryImport / listPhotos / photoDetail / trashPhotos / restorePhotos / folderLabels
//            thumbUrl(photo) / originalUrl(photo)（同期。画像のURL）
//   分類     classify(photoUuids, changes) → 変更前の状態 / restoreClassification(states) / classifyMeta / saveTemplate / deleteTemplate
//   台帳     listLedgers / createLedger / ledgerDetail / applyLedgerOps(uuid, ops) / trashLedger / restoreLedger / purgeLedger / duplicateLedger / exportPdf
//   引継ぎ   exchangePlan / exportExchange / previewExchange / importExchange
//   バックアップ backupStatus / createBackup / periodicBackup / verifyBackup / restoreBackup
//   共通     cancelTask / onProgress / onThumbnailsReady / pick* / confirm / onDropFiles / onCloseRequested
// 失敗は { kind, message } で返す。message は利用者向けの日本語。

import { TauriRepository } from "./tauri-repository.js";
import { MemoryRepository } from "./memory-repository.js";

export function createRepository() {
  const demo = new URLSearchParams(location.search).get("demo");
  if (window.__TAURI__ && demo == null) return new TauriRepository();
  return new MemoryRepository(Number(demo) || 300);
}
