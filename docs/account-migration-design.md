# アカウント移行設計

## 方針

共有機能だけをメールアドレスとパスワードで利用できるようにし、ZIP取込みを使う端末内モードはログイン不要のまま維持する。

既存の匿名利用者は、Supabase Auth の `updateUser({ email })` で同じ利用者へメール identity を追加し、メール確認後にパスワードを設定する。Auth user UUID が変わらないため、既存の `site_members`、管理者権限、写真、監査履歴を移し替えない。自動で既存利用者を更新する migration は行わない。

同じメールアドレスが別アカウントですでに使われている場合、所属を自動統合しない。誤った権限移管を防ぐため既存アカウントでログインし、工事PASSまたは管理者PASSで参加し直す。必要な権限移管は管理者が確認して行う。

## DB

- `user_profiles`: アカウントの表示名、有効状態、最終利用日時。メールとパスワードはAuthだけが保持する。
- `account_devices`: 同じアカウントで利用するPC、スマートフォン、PWAを個別の端末として記録する。
- `private.account_security_audit`: 秘密情報を含まないアカウント操作履歴。
- 既存の `site_members` はアカウントと工事の権限関係として継続利用する。

既存匿名利用者にはprofileを一括作成しない。profileがない既存利用者は従来どおりアクセスでき、明示的な昇格後にprofileを作成する。`active=false`のprofileは既存RLSの共通権限関数で拒否する。

## 適用順

1. `202608050001_account_foundation.sql`
2. `202608050002_account_foundation_verification.sql`（読取り専用）

今回は実Supabaseへ適用しない。rollbackは通常運用で実行しない。
