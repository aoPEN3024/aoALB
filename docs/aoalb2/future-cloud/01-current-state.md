# aoALB 2 第1段階：現状調査

- 調査対象：`aoPEN3024/aoalb` main `8ef3fe5`（2026-11-19）、`aoPEN3024/aopic` main `a5790a0`（2026-11-11）
- 調査方法：リポジトリのコード・migration・docsの読取りのみ。本番Supabase（DB・Storage・Auth・ログ）には接続していない。
- 以下の「高CPU原因候補」はコードから導いた仮説であり、本番の `pg_stat_statements` 等で確定させる必要がある（`sql/01-readonly-cpu-investigation.sql`）。

## 1. 現行構造の要約

| 項目 | aoPIC | aoALB |
|---|---|---|
| 形態 | 単一HTML PWA（約2,500行）＋ `js/cloud-sync.js` | ES Modules PWA（JS約7,000行）、GitHub Pages |
| 端末保存 | IndexedDB（写真をdataURLで保存）、マスタ等はlocalStorage | IndexedDB `aoALBDB` v5：imports / projects / photos / photoFiles / ledgers / settings / cloudFiles / cloudChanges |
| 写真 | 撮影時に1280×960へ縮小、黒板合成、JPEG ≤500KB、`photoUid`・SHA-256・`boardSnapshot` | aoPIC ZIP（manifest v1）または共有Storageから受信。`mime_type='image/jpeg'` 固定 |
| 認証 | 匿名サインアップ（`/auth/v1/signup` 空body）＋`join_site`（工事ID＋工事PASS） | 匿名＋メール招待（Edge Function `account-admin`）、会社PASS・工事PASS・管理者PASS、端末名 |
| DB | — | `sites` → `projects` → `photos`/`photo_objects`、`ledgers`/`ledger_pages`/`ledger_slots`、`photo_classification_overrides`、`ledger_photo_captions`、`sync_events`、`audit_logs` ほか |
| Storage | `site-photos/{site}/photos/{photoUid}.jpg`、`/thumbnails/`（480px, q0.76） | 同じバケットを読取り |
| 同期 | 写真1件ごとにREST 5〜7回＋`sync_events` INSERT | Realtime `postgres_changes`（`sync_events` INSERT）→ 受信ごとに全件再取得 |
| 台帳保存 | — | `save_ledger_snapshot`：台帳の全ページ・全枠・全文言を削除→再作成 |

## 2. 根本的な問題

1. **正本が二重**：共有工事はクラウド正本とdocsにあるが、実装はIndexedDBの台帳を丸ごとクラウドへ送り、クラウドの全台帳を丸ごと端末へ上書きする「スナップショット往復」。差分の概念がない。
2. **写真の入口がaoPIC形式に固定**：DB制約・manifest・`photoUid` 必須・JPEGのみ・site/projectの二階層がaoPIC前提。
3. **権限モデルの層が多すぎる**：匿名UUID、`site_members.device_name`、3種のPASS、`user_profiles.status`、`system_admins`、`account_devices` が重なり、RLS判定が毎行で多段関数呼出しになる（＝CPU問題にも直結）。
4. **イベント設計が「通知＝全件取り直し」**：1件の変更が全端末の全件再取得を起こす。

## 3. 高CPUの有力原因（コード上の根拠つき・要実測）

優先度は「呼出頻度×1回の重さ」の推定順。

### 候補A：Realtimeイベント1件ごとに全端末が全件再取得（最有力）
- `js/sharing.js:430-435` `receiveEvent`：`photo_synced` を受けると `refreshCloudPhotos()`、`ledger|classification_override` を受けると `syncCloudLedgers()`。**自端末が出したイベントでも実行**。
- `syncCloudLedgers()`（`js/cloud/ledger-sync.js:139`）は毎回 `list_site_ledger_snapshots`（その工事の**全台帳×全ページ×全枠×全文言**をjsonb組立て）＋`list_site_ledger_deletions`＋全分類上書きを取得。
- `refreshCloudPhotos()` は `listCompletePhotoSnapshot`：工事の全 `photo_objects` ＋全 `photos`（200件ずつ `in()`）。
- aoPICが写真300枚を送ると `sync_events` が300件 → 接続中の各aoALB端末が全写真一覧を繰り返し再取得（`receiveQueued` で直列化はされるが回数は減らない）。
- 台帳に写真を1枚置くたびに `ledger_snapshot_saved` → **全端末が全台帳を再取得**。
- 計算量の目安：O(イベント数 × 端末数 × 工事内全件)。

### 候補B：`save_ledger_snapshot` の全削除・全再作成（`202608050003_ledger_sync.sql`）
- 写真1枚の配置ごとに `ledger_pages` 全削除（CASCADEで `ledger_slots`）、`ledger_photo_captions` 全削除 → 全再INSERT。デッドタプル大量発生→autovacuum負荷。
- 枠ごとに「同一台帳内の重複写真チェック」を `ledger_slots JOIN ledger_pages` で実行。**O(枠数²)**。100ページ=300枠で約45,000行の照合を1保存ごとに行う。
- `ledger_slots(photo_id)` にインデックスがない（`photo_ledger_references` や写真削除時のFK `ON DELETE RESTRICT` 検査もシーケンシャル）。
- 毎回 `audit_logs`・`sync_events` に1行追加（保持期限なし）。
- 配置操作ごとに `saveLedgerForProject` → 即 `flushCloudChanges()`。デバウンスなし。

### 候補C：自己競合による再送の連鎖
- 送信中（status=`uploading`）に次の操作をすると、統合されず新しい変更が作られる（`storage.js:252`）。新しい変更の `expectedRevision` は送信前の古い値のまま。
- 先行送信の成功で revision が上がる → 後続は**自分自身と競合**（`revision_conflict`）→ 競合UI → 「複製して残す」等で台帳スナップショットがさらに増える。
- 現行docsの「保存失敗時の再送が重なる」「同じ台帳の未送信変更が積み上がる」の主因と推定。

### 候補D：RLSの行ごと多段関数呼出し
- 全ポリシーが `private.has_site_role(site_id, …)` を列引数で呼ぶため、`(select …)` によるinitPlanキャッシュが効かず**行ごとに評価**。
- `has_site_role` → `site_role_for`（`site_members` 検索）→ `account_is_active`（`auth.users JOIN user_profiles`）。書込み系はさらに `site_is_active`。`photo_objects` のSELECTは `EXISTS(photos …)` と2回目の `has_site_role` も実行。
- SECURITY DEFINER のSQL関数はインライン展開されないため、1,000行の取得で数千回のサブクエリ。

### 候補E：Storage読取りポリシーの全件走査
- `site_photos_photo_lifecycle_select`（restrictive）と `site_photos_complete_select` は、Storageオブジェクト1件の読取りごとに `photo_objects` を `po.site_id::text = foldername(name)`（型変換でインデックス不可）かつ `object_path = name OR thumbnail_object_path = name` で検索。
- `thumbnail_object_path` はインデックスなし、`object_path` の一意索引は `(bucket_id, object_path)` で先頭列が条件にない。→ **サムネイル1枚の取得ごとに `photo_objects` を走査**する可能性が高い。一覧表示・キャッシュ取得で数百〜数千回。

### 候補F：インデックス不足・無制限に増える表
- `photos(site_id, sha256)` なし（送信時に毎回sha256で検索：`supabase-provider.js:325,340`）。
- `photo_objects(site_id)` なし（一覧取得は `site_id` 条件）。
- `ledger_slots(photo_id)` なし。
- `sync_events`・`audit_logs` に保持期限・削除処理なし。`sync_events` はRealtime publication対象。

### 候補G：その他（要計測・優先度低）
- Realtime `postgres_changes` はイベントごとに購読者ごとのRLS評価を行う方式。購読者数×イベント数で負荷が増える。
- aoPIC送信は写真1件あたり5〜7往復（存在確認、INSERT、Storage×2、upsert、検証、イベント）。
- 購読の重複：`subscribeCurrentSite()` は先に解除しているため明確な増殖はコード上見当たらない。ただし `location.reload()` 4箇所と認証状態変化時の再接続経路は実機で購読数を確認する必要あり。

### 調査中に見つかった不整合（設計判断に影響）
1. **aoPICの匿名送信と招待制アカウント基盤の衝突**：`202608180001_system_account_foundation.sql` の `account_is_active` は匿名ユーザーを常に不許可。このmigrationが本番適用済みなら、aoPIC（匿名サインアップ）からの送信はRLSで拒否されるはず。本番の適用状況を確認する必要がある。
2. **台帳削除でページ・文言を物理削除**：`delete_ledger_snapshot` は台帳本体はソフト削除だが `ledger_pages`・`ledger_photo_captions` を物理削除する。台帳の「復元」は中身なしになる。
3. **Storageオブジェクトの残存**：ごみ箱からの完全削除・工事削除時のStorage削除はクライアント／運用手順依存で、DBとStorageの不一致が起き得る（`delete_empty_site` は空工事のみ）。

## 4. 引き継ぐデータ・機能

| 区分 | 項目 | 旧の保存場所 | 備考 |
|---|---|---|---|
| 工事 | 工事名・工事ID・受注者 | `sites`, `projects` | site と project の対応は未決事項1 |
| 写真 | 原寸JPEG・サムネイル | Storage `site-photos` | SHA-256で検証してコピー |
| 写真 | photoUid・SHA-256・撮影日時・幅高さ・容量 | `photos` | |
| 写真 | aoPIC分類・boardSnapshot・ledger情報 | `photos.metadata` | **不変の原情報**として保持 |
| 写真 | classificationOverride | `photo_classification_overrides` | 「現在の分類」へ |
| 写真 | 削除済み状態 | `photos.lifecycle_status/trashed_*` | |
| 台帳 | 台帳名・表紙設定・表示モード | `ledgers` | ソフト削除済みも移行（中身は消失済みの可能性） |
| 台帳 | ページ・枠・空白枠・写真配置 | `ledger_pages`, `ledger_slots` | |
| 台帳 | 右欄文言 | `ledger_photo_captions`（＋旧 `ledger_slots.caption_override`） | |
| 履歴 | 監査履歴 | `audit_logs`, `account_management_audit` | 参照用に移行（秘密値なしを確認） |
| 利用者 | 既存Authユーザー・工事所属 | `auth.users`, `user_profiles`, `site_members` | 自動統合しない |

機能：ZIP取込み、aoPIC連携ZIP、写真一覧・詳細、複数選択、一括分類、台帳作成・編集・削除、PDF・印刷、写真ごみ箱・復元、オフライン編集、競合防止、複数端末同期、管理者による利用者管理。

セキュリティ：非公開Storage、RLS、所属によるアクセス制御、activeアカウントのみ操作、service roleを置かない、SECURITY DEFINERの `search_path=''`、authenticatedのみRPC実行、監査ログに秘密値なし、物理削除の制限、revision競合防止、ソフトデリート。現行のこれらの方針は概ね良好で、新設計でも維持する。

## 5. 引き継がない実装

| 廃止するもの | 理由 | 置換 |
|---|---|---|
| `save_ledger_snapshot`（全削除→再作成） | 候補B | 操作単位の `apply_ledger_ops` |
| `list_site_ledger_snapshots`（全台帳一括jsonb） | 候補A | 台帳単位・差分取得 |
| `sync_events` を `postgres_changes` で購読し全件再取得 | 候補A・G | 変更番号（seq）による差分取得＋軽量通知 |
| 行ごと `has_site_role(site_id)` のRLS | 候補D | 所属工事IDの配列をinitPlanで1回評価 |
| Storageポリシー内の `photo_objects` 走査 | 候補E | パスに写真IDを含め主キー1件照合 |
| IndexedDB `photoFiles` に原寸を常駐 | メモリ・端末依存 | 容量上限つきキャッシュ（LRU） |
| `sites`/`projects` 二階層、`site_code`、`site_join_codes` | 複雑 | 「工事」1階層 |
| 匿名ユーザー・3種PASS・端末名・`account_devices` を権限の中心にする設計 | 2.2 | メール＋パスワード、工事所属のみ |
| ZIP由来／共有由来／混在の分類 | 2.1 | 「取込み元」は属性として記録するだけ |
| 全写真カードのDOM生成、Object URLの無期限保持 | 2.3 | 仮想スクロール、表示範囲外で解放 |
| 現行画面構成・現行コードの大量コピー | 方針 | 新規実装（SQL関数の検証ロジック等は参照のみ） |
