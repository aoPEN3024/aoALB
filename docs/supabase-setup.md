# Supabase初期設定（公開前）

この手順は、空のSupabaseプロジェクトへaoALBの現場共有基盤を準備するためのものです。RLS検証が完了するまでGitHub Pagesへ公開せず、実写真もアップロードしません。

## 使用するファイルと順番

1. 基盤: `supabase/migrations/202607190001_site_sharing.sql`
2. join_site前進修正: `supabase/migrations/202607190004_fix_join_site_ambiguity.sql`
3. 初期現場: `supabase/bootstrap/202607190002_bootstrap_first_site.sql`
4. 検証: `supabase/verification/202607190003_security_verification.sql`
5. 現場作成基盤: `supabase/migrations/202607220001_site_creation_code.sql`
6. 現場作成コード初回生成: `supabase/operations/202607220002_rotate_site_creation_code.sql`
7. 現場作成基盤検証: `supabase/verification/202607220003_site_creation_security_verification.sql`
8. 問題時のみ: `supabase/rollback/202607190099_rollback_site_sharing.sql`または`supabase/rollback/202607220099_rollback_site_creation_code.sql`

SQLはSupabase Dashboardの **SQL Editor > New query** で、上記の順に1ファイルずつ実行します。基盤migrationは1回だけ実行します。2回目は変更前の事前判定で停止する設計です。前進修正は、修正済み基盤を適用した新規環境でも安全に同じ関数定義へ置き換えます。

## 実行前チェックリスト

- [ ] 対象が新規の空プロジェクトである
- [ ] Authentication > Sign In / Providers > Anonymous Sign-Insが有効である
- [ ] CAPTCHAまたはTurnstileと匿名認証のレート制限を設定した
- [ ] 実写真や本番の工事情報をまだ保存していない
- [ ] ブラウザへservice_role key、Secret key、DB passwordを入力していない
- [ ] `config/cloud.local.json`がGit管理外であることを`git status`で確認した

## 初期管理者UUIDの取得

1. ローカルサーバーでaoALBを開き、Project URLとPublishable keyを設定して「現場共有」を開始します。
2. Anonymous Sign-Inが成功したら、Supabase Dashboardの **Authentication > Users** を開きます。
3. 直前に作成された匿名ユーザーであることを確認し、そのユーザーのUUIDをコピーします。
4. `202607190002_bootstrap_first_site.sql`の`bootstrap_input`にある`admin_user_id`だけへ貼り付けます。

UUIDは必ずDashboard上で対象ユーザーと作成時刻を確認します。画面にservice_role keyを渡したり、`auth.users`を誰でも呼べる関数に公開したりしません。

## 初期現場で変更する値

Bootstrap SQLの`insert into bootstrap_input ... values (...)`にある1行だけを変更します。

- `admin_user_id`: 上記で取得した匿名Auth UUID
- `site_code`: 利用者が入力する現場ID。英大文字・数字・`_`・`-`で3～40文字
- `site_name`: 画面に表示する現場名
- `device_name`: 初期管理者端末の表示名

初期参加コードはDBが暗号学的乱数で自動生成し、実行結果へ一度だけ表示します。DBへはbcryptハッシュだけを保存します。結果を安全な場所へ控え、チャット、Git、ソースコードへ保存しないでください。

## ローカル接続設定

1. `config/cloud.local.example.json`を`config/cloud.local.json`という名前でコピーします。
2. Supabase Dashboardの **Connect** でProject URLを、**Settings > API Keys** で`sb_publishable_`から始まるPublishable keyを確認します。
3. `projectUrl`と`publishableKey`へ貼り付け、ローカル静的サーバーを再読み込みします。

受け付けるキーは`sb_publishable_`で始まるPublishable keyだけです。`sb_secret_`、JWT形式の旧key、service_role、DB passwordは拒否します。ローカル設定ファイルは`.gitignore`対象で、localhostからだけ読み込みます。GitHub Pagesではこのファイルを探しません。

## migrationで作成されるもの

- `pgcrypto` extension（`extensions` schema）
- `private` schemaと権限判定関数
- 12テーブル: sites、参加コード・所属・試行、projects、photos、photo_objects、ledgers、pages、slots、sync_events、audit_logs
- 同一現場を保証する複合外部キー、インデックス、revision trigger
- `join_site`など4つのブラウザ用RPC
- 全業務テーブルのRLS policy
- 非公開Storage bucket `site-photos`と4つのStorage policy
- Realtime publicationへの`sync_events`登録

永続的なbootstrap関数は作成しません。参加コードを確認できるのは`join_site` RPCだけで、ブラウザはハッシュ表を直接読めません。

追加の現場作成基盤では、非公開の現場作成コードハッシュ、作成試行履歴、`create_site` RPCを追加します。会社共通コードの平文はSQLへ記入せず、変更SQLがランダム生成して結果へ一度だけ表示します。運用方法は[`site-creation-code.md`](site-creation-code.md)を参照してください。

## 実行後チェックリスト

- [ ] 基盤migrationが`Success`で完了した
- [ ] Bootstrap結果のsite_id、site_code、admin UUIDを確認した
- [ ] 初期参加コードを安全な場所へ一度だけ控えた
- [ ] Table Editorで`site_join_codes.code_hash`が平文コードではない
- [ ] Storageで`site-photos`がPrivateで、20MB、JPEGのみになっている
- [ ] Security verificationの全行が`passed = true`である
- [ ] 未所属匿名ユーザーでsitesが0件になる
- [ ] 5回の誤入力後に15分ブロックされる
- [ ] ブラウザのNetwork、localStorage、配信ファイルに秘密鍵がない
- [ ] RLS検証完了まではPages公開と実写真アップロードを行わない

## Rollback

問題があり、まだ本番データや写真を保存していない場合だけ、SQL Editorで`supabase/rollback/202607190099_rollback_site_sharing.sql`を実行します。これはaoALB現場共有の全テーブルとデータを削除する破壊的操作です。

`site-photos`に1件でもオブジェクトがある場合は、rollbackは変更前に停止します。`pgcrypto`は他機能でも利用される可能性があるため削除しません。必要データがある場合はrollbackを実行せず、先にバックアップと個別復旧方針を決めてください。
