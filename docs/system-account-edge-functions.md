# アカウント管理Edge Function

`account-admin` はシステム管理者専用の単一エンドポイントです。操作ごとに `action` を指定します。

## 操作一覧

- `list_users`
- `list_audit`
- `list_invitation_recovery`
- `invite`
- `retry_invitation`
- `resend_invite`
- `suspend`
- `resume`
- `send_password_reset`
- `delete_equivalent`

すべての操作でBearer tokenを検証し、activeなシステム管理者であることをサーバー側で再確認します。一般利用者や未ログイン利用者はHTML表示の有無に関係なく実行できません。

## 必要なSecrets / 環境変数

値はGit、ブラウザ、チャットへ保存しません。

- `SUPABASE_URL`（Supabase が自動提供）
- `SUPABASE_SERVICE_ROLE_KEY`（Supabase が Edge Function のみに自動提供）
- `SUPABASE_ANON_KEY`（Supabase が自動提供）
- `AOALB_AUTH_REDIRECT_URL`
- `AOALB_ALLOWED_ORIGINS`（カンマ区切り、完全一致）

上記3値は独自Secretとして重複登録しません。公開JavaScriptが使用するのはProject URLとPublishable keyだけです。`SUPABASE_SERVICE_ROLE_KEY` はEdge Functionのサーバー環境から外へ出しません。

招待ごとにブラウザ生成の一意な操作IDを使います。同じ操作IDの再送は同じ処理として扱い、Authユーザーのメタデータ、メールの非可逆フィンガープリント、操作台帳のAuth UUIDがすべて一致するときだけ不足プロフィールを補完します。確認できない既存利用者は自動統合せず、管理画面の復旧対象へ表示します。Auth成功後のDB失敗と復旧は監査へ残り、Authユーザーを自動削除しません。

## 削除

`delete_equivalent` はAuth物理削除ではありません。メール完全一致確認、システム管理者でないこと、唯一の工事管理者でないこと、Storage所有物がないことを確認し、プロフィールをdeleted、端末・所属を無効化し、Authを長期banします。写真・台帳・監査履歴は削除しません。

## デプロイ前確認

1. DB migrationとbootstrapを適用
2. verification SQLを実行
3. SecretsをDashboardへ登録
4. 許可Originに本番URLと使用中のlocalhost完全一致だけを設定
5. Functionをデプロイ
6. 一般利用者・未ログイン・停止利用者の拒否を実通信で確認

本PRではデプロイもSecrets登録も行いません。
