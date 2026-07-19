# aoPIC・aoALB 現場共有仕様（試作）

## 1. 責任分担

- aoPICは撮影を最優先し、JPEGとメタデータを先に端末内IndexedDBへ保存する。クラウド送信の成否で撮影保存を取り消さない。
- aoALBは取得済み写真と台帳を端末内へ保持し、共有データが更新されたときだけ差分を受け取る。
- Supabaseは匿名端末認証、現場所属、メタデータ、JPEGオブジェクト、変更通知を担当する。
- 初回PRではaoALBだけに接続層と試作UIを置く。aoPICの本番コード、写真同期、台帳同期はRLS検証後の別PRとする。

共通コード用の新規リポジトリは作らない。共有契約とSQLをaoALBで先に固定し、実環境検証後に必要最小限の認証・キューコードだけをaoPICへ移植する。現在のaoPICは単一HTMLであり、両アプリを同時に大変更するより事故範囲が小さいためである。

## 2. 認証と現場参加

1. 端末はSupabase Authの匿名サインインで固有の`auth.users.id`を得る。
2. 利用者は現場ID、参加コード、端末表示名を入力する。
3. `join_site` RPCだけが参加コードのハッシュを照合し、`site_members`へ所属を登録する。
4. 参加コードは`pgcrypto`の`crypt()`と`gen_salt('bf')`でハッシュ化し、平文をDBへ保存しない。
5. 匿名セッションはSupabaseクライアントの専用localStorageキー`aoALB:supabase-auth`で自動復帰する。
6. 参加失敗は端末ユーザー単位で15分間に5回までとし、現場IDの存在をエラー文から判別できないようにする。

匿名ユーザーもPostgresでは`authenticated`ロールになるため、すべての表でRLSを必須とする。匿名ユーザーはブラウザデータを消すと同じIDへ戻れないため、管理者の端末解除と再参加を前提にする。匿名サインインの濫用対策として、本番ではCAPTCHAまたはTurnstileも有効にする。

## 3. 識別子と対応関係

|用途|識別子|扱い|
|---|---|---|
|現場|`sites.id`（siteId）|クラウド内部UUID|
|入力用現場ID|`sites.site_code`|英数字・`-`・`_`、大文字|
|工事|`project_uid`|aoPICの`projectUid`を維持|
|写真|`photo_uid`|aoPICの`photoUid`を維持、現場内一意|
|台帳|`ledger_uid`|aoALB台帳IDをUUIDとして共有|
|端末|`auth.users.id`|匿名認証ユーザーID|
|同期操作|`sync_events.event_id`|再送しても同一UUID|

すべての業務表は`site_id`を持つ。親子関係には`(id, site_id)`の複合外部キーも設定し、別現場の親IDを混在させられないようにする。

## 4. DBスキーマ

- `sites`: 現場と表示名
- `site_join_codes`: 参加コードのハッシュ、付与権限、世代
- `site_members`: 端末ユーザー、権限、端末表示名、有効状態
- `site_join_attempts`: 参加コード試行制限
- `projects`: aoPIC工事マスターの共有部分
- `photos`: 写真メタデータ。分類、boardSnapshot、ledgerは`metadata` JSONBへ格納
- `photo_objects`: Storageパス、SHA-256、bytes、アップロード完了時刻
- `ledgers`: 台帳ヘッダー、編集中端末、revision
- `ledger_pages`: ページ順
- `ledger_slots`: 3枠、写真または明示的空白、captionOverride
- `sync_events`: 冪等な同期イベントとRealtime通知元
- `audit_logs`: 参加、コード変更、端末解除などの監査記録

正式な列、制約、関数は`supabase/migrations/202607190001_site_sharing.sql`を正とする。

## 5. RLS

- viewer: 所属現場のsites、members、projects、photos、photo_objects、ledgers、pages、slots、sync_eventsを参照可能
- editor: viewer権限に加え、写真・工事・台帳・同期イベントを追加・更新可能
- admin: editor権限に加え、削除、参加コード変更、端末無効化、audit_logs参照が可能
- `site_join_codes`と`site_join_attempts`はクライアントから直接参照・更新できない
- `join_site`など必要なRPCだけを`authenticated`へ個別に許可する
- `SECURITY DEFINER`関数は`search_path = ''`と完全修飾名を使う
- Storageは非公開`site-photos`バケットとし、先頭フォルダ`{siteId}/`を所属・権限で検査する
- `anon`ロールには業務表の権限を与えない
- service role keyはブラウザ、GitHub、設定画面へ一切入れない

## 6. オフライン同期

端末側の状態は`pending → uploading → synced`、失敗時は`error → pending`とする。初期試作ではaoALBの既存`settings`ストアへ小さなメタデータキューを保存し、DBバージョンを変更しない。

- 先に端末DBへ保存してからキューへ追加する
- `eventId`、`photoUid`、`projectUid`を固定し、再送でも新しいIDを発行しない
- `sync_events.event_id`と写真の`(site_id, photo_uid)`一意制約で二重登録を防ぐ
- オンライン復帰時と手動再送で`pending/error`だけを処理する
- JPEGはStorageアップロードとSHA-256照合が完了してから`photo_objects.upload_completed_at`を記録する
- アップロード完了前にaoPICの端末内JPEGを削除しない
- 初期PRはテスト用メタデータだけを送り、実写真は送らない

## 7. Realtimeと競合

初期接続試験は`sync_events`のPostgres Changesを使用する。RLSにより所属現場のイベントだけを受信する。規模拡大時はSupabaseが推奨するBroadcast方式への移行を検討する。

台帳は完全同時編集にしない。

- 編集開始時に`begin_ledger_edit(ledgerId, expectedRevision)`を呼ぶ
- 他端末が10分以内に編集中なら編集者と開始時刻を表示する
- 更新は既知の`revision`を条件に行う
- 0件更新なら競合として、自端末版とクラウド版を両方保持して利用者に選択させる
- 自動上書きやlast-write-winsで元データを捨てない
- RealtimeのDELETEはRLSで旧行全体を検証できない制約があるため、通常同期では削除イベントに依存せず、管理者削除後に一覧を再取得する

## 8. クライアント構成

- `js/sharing.js`: UIと同期処理の調停
- `js/cloud/config.js`: Project URLと公開用keyの検証。秘密鍵を拒否
- `js/cloud/queue.js`: IndexedDB settingsストアの同期キュー
- `js/cloud/mock-provider.js`: 通信しない別タブ通知試作
- `js/cloud/supabase-provider.js`: 匿名認証、RPC、テストイベント、Realtime

Supabase SDKはクラウド接続を明示的に開始したときだけ、固定バージョンを遅延読込みする。ローカルモードでは外部通信を行わない。

## 9. 参考資料

- [Supabase Anonymous Sign-Ins](https://supabase.com/docs/guides/auth/auth-anonymous)
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase Database Functions](https://supabase.com/docs/guides/database/functions)
- [Supabase Realtime Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes)
- [Supabase Storage Access Control](https://supabase.com/docs/guides/storage/security/access-control)
- [PostgreSQL pgcrypto](https://www.postgresql.org/docs/current/pgcrypto.html)
