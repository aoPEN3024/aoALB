# Supabase実環境のセキュリティ検証

`supabase/verification/202607190003_security_verification.sql`は、基盤と初期現場を検査します。テスト用の工事・写真メタデータをトランザクション内だけに作り、最後に`ROLLBACK`します。JPEGはアップロードしません。

## SQLで自動確認する内容

- pgcrypto、全テーブル、RLS、Storage bucket・policy、Realtime登録
- すべてのSECURITY DEFINER関数の固定`search_path`
- PUBLIC・anonへ不要な関数実行権限がないこと
- 永続的なbootstrap関数がないこと
- admin、viewer、editor、未所属ユーザーのRLS挙動
- 未所属ユーザーから見える現場が0件であること
- 現場IDを変えても5回で参加試行がブロックされること
- siteIdをまたぐ複合外部キー不整合とStorageパス不整合の拒否

結果一覧の全行が`passed = true`であることを確認します。エラーまたはfalseが1件でもあれば、実写真の同期、Pages公開、PRのマージを停止します。

## Dashboardで追加確認する内容

1. **Authentication > Users**: 初期管理者UUIDと匿名ユーザーであること
2. **Table Editor**: `site_join_codes`に平文参加コードがなく、`grant_role`がeditorまたはviewerであること
3. **Storage > Buckets > site-photos**: Private、20MB、image/jpegのみ
4. **Database > Replication**: sync_eventsがRealtime対象であること
5. **Database > Policies**: 業務テーブルとstorage.objectsのpolicyが有効であること

## 2端末相当の手動確認

- 別ブラウザプロファイルで匿名Auth UUIDが異なる
- 初期管理者と参加端末が同じ現場へ参加できる
- 無効化した端末が参加コードを再入力しても復帰できない
- 誤った現場ID・参加コードは同じ一般エラーになり、5回目から15分停止する
- viewerは読取のみ、editorは追加・更新、adminだけが削除・管理操作を行える
- 現場Aの端末は現場BのUUIDやStorageパスへアクセスできない
- テストイベントの再送で同じeventIdが二重登録されない
- オフライン時はpending、復帰後はsyncedになる

実写真と台帳同期は、このSQL検証と手動確認がすべて通った後の別段階です。
