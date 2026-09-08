# システム管理者・招待制アカウント基盤

この段階はDB基盤だけを追加します。実Supabaseへの適用、初期管理者登録、Edge Functionのデプロイ、Auth設定変更は別作業です。

## 権限の分離

- システム管理者: 利用者アカウントを管理します。工事権限は自動付与しません。
- 工事管理者: `site_members.role = admin` の工事だけを管理します。
- 一般利用者: 有効な招待済みアカウントでログインし、工事PASSまたは管理者PASSを使用します。
- ZIP取込み・端末内台帳: ログインなしで従来どおり利用できます。

## 既存利用者の移行

- 既存の `user_profiles.active = true` は `status = active` に移行します。
- 既存の無効プロフィールは `suspended` に移行します。
- プロフィールがない匿名・メールAuthユーザーは自動招待・統合・削除しません。
- 既存の工事所属・写真・台帳・端末情報は変更しません。
- migration適用後、プロフィールのないAuthユーザーと匿名ユーザーはクラウド操作を行えません。招待アカウントで入り直し、工事PASSまたは管理者PASSを使います。

## 削除方針

初期版の「削除」は `status = deleted` とする退会済み相当です。Auth行を物理削除しません。現行スキーマではAuth削除が工事所属をCASCADE削除し、写真・台帳の編集者参照や監査履歴とも衝突するためです。退会済み状態ではセッション失効・長期ban・全DB/Storageアクセス拒否をEdge Function側で組み合わせます。

## 適用順

1. `supabase/migrations/202608180001_system_account_foundation.sql`
2. 対象UUIDとメールをDashboardで別々に照合
3. `supabase/bootstrap/202608180002_bootstrap_system_admin.sql` の2つのプレースホルダーを同じ利用者の値へ変更して1回だけ実行
4. `supabase/verification/202608180003_system_account_verification.sql`

bootstrapは確認済みメールアカウント、activeプロフィール、UUIDとメールの完全一致、既存system adminが0件であることを同時に検証します。UUIDやメールはGitへ保存しません。

## 本番前のAuth設定

Edge/UIの配備と初期管理者登録が完了した後に、Dashboardで自由サインアップを無効化します。匿名Sign-Inの扱いも公開切替手順で確認します。先に無効化すると既存移行経路を失うため、このmigrationだけでは設定変更しません。

## rollback

`supabase/rollback/202608180099_rollback_system_account_foundation.sql` は非本番検証環境専用です。招待・停止・退会・管理者登録・監査履歴が1件でもあれば拒否します。本番データに対して通常運用で実行しません。
