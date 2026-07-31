# 写真削除の設計

## 操作の区別

- ZIP取込みだけの写真は、aoALBのIndexedDBから写真情報とJPEGを同一トランザクションで削除します。Supabase通信は行いません。
- 共有写真とZIP・共有混在写真は、共有の「削除済み」へ移動します。原寸と一覧画像は非公開Storageに保持し、管理者が復元できます。
- 「写真本体をこの端末から削除」は従来どおり原寸キャッシュだけを削除し、写真情報と台帳配置を残します。

台帳の枠で使われている写真は削除できません。利用者が先に対象台帳を開き、明示的に写真を枠から外します。

## Supabase migration

適用順は次のとおりです。

1. `supabase/migrations/202607310001_photo_lifecycle.sql`
2. `supabase/verification/202607310002_photo_lifecycle_verification.sql`（読取り確認）

Migrationは既存写真を`active`として維持し、写真本体や台帳を移動・削除しません。`trash_photo`、`trash_photos`、`restore_photo`は、現在有効な管理者をサーバー側で再確認し、台帳参照、工事状態、revisionを検証します。

Rollbackは`supabase/rollback/202607310099_rollback_photo_lifecycle.sql`です。削除済み等の非active写真が1件でもある場合は、非表示データが意図せず再表示されるため実行を拒否します。

## 完全削除を初期版へ含めない理由

ブラウザからのStorage削除とPostgreSQLの行削除は、1つの原子的トランザクションにできません。片方だけ成功した状態を安全に自動回復する運用が未確立のため、初期版は「削除済み」と復元までに限定します。Storage原寸・一覧画像の完全削除は行いません。

## aoPIC再送

`check_photo_upload_state`は、同じ`photoUid`が共有の削除済みにあることを、写真本文や秘密情報を返さず送信元へ通知します。送信元は該当キューを通常の再送対象から外し、管理者による復元後にのみ再送できるようにします。
