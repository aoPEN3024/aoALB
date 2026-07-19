# Supabase実環境での確認項目

この文書は外部プロジェクト作成後に行う確認手順である。実写真は使わず、テスト用メタデータだけで検証する。

## 必須設定

1. Anonymous Sign-Insを有効にする。
2. CAPTCHAまたはTurnstileと匿名認証のレート制限を設定する。
3. migrationを適用する。
4. `site-photos`が非公開バケットであることを確認する。
5. `sync_events`がRealtime publicationへ登録されていることを確認する。
6. Project URLと公開用publishable keyだけをaoALBへ入力する。
7. service role key、DBパスワード、JWT secretは入力しない。

## RLS試験

- 未認証では全業務表を取得できない
- 匿名認証済み・未参加端末では全現場を取得できない
- 現場Aのviewerは現場Aだけ読め、追加・更新・削除できない
- 現場Aのeditorは現場Aへ追加・更新でき、削除と管理操作はできない
- 現場Aのadminだけが削除、参加コード変更、端末解除を行える
- 現場Aの全権限で現場BのUUIDを指定しても取得・更新できない
- `site_join_codes`のハッシュをクライアントから取得できない
- Storageの`現場B UUID/...`へ現場A端末が読み書きできない
- service role keyが配信HTML、JavaScript、Network、localStorageに存在しない

## 同期試験

- 2つの別ブラウザプロファイルで匿名IDが異なる
- 同じ現場へ参加後、端末1のテストイベントを端末2が受信する
- 同じeventIdを再送しても1件だけになる
- オフライン送信はpendingとなり、復帰後にsyncedとなる
- revision不一致時は更新せず競合になる
- 実写真と台帳同期はこの試験がすべて通るまで開始しない
