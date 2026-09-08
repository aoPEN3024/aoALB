# aoALB

aoPICが出力する「aoALB用ZIP」を読み込み、工事写真台帳を作成するための静的Webアプリです。

## ブランドアセット

正式ロゴの画面用アセットは`assets/brand/`にまとめています。ヘッダーではアイコンと文字ロゴを組み合わせ、初期のZIP取込み画面では全体ロゴを使用します。提出用の台帳表紙・写真ページ・印刷PDFにはロゴを表示しません。

## 主な機能

- manifestVersion 1のZIP検証
- JPEGとmanifestの照合（SHA-256、bytes、寸法）
- aoALB専用IndexedDBへの保存
- 工事一覧、写真一覧、絞り込み、写真詳細、取込み履歴
- 写真とは独立した台帳配置の保存
- A4縦・1ページ3枠の施工状況写真台帳
- 写真配置、入れ替え、前後移動、空白挿入、未配置への復帰
- PCのドラッグ＆ドロップと、タッチ端末のタップ配置
- 10.5ptから8ptまでの自動文字調整と、収まらない場合の印刷停止
- ブラウザの印刷機能によるPDF保存
- 編集画面の1頁／見開き表示（印刷は常にA4単ページ）
- 台帳の配置枠ごとの工種・測点・台帳文編集
- スマートフォンの画面下部に固定した「写真／台帳」切替
- 工事ID共有のローカル試作UI、オフライン同期キュー、Supabase接続層
- 所属現場の完成写真をRealtimeで検知し、サムネイル優先で安全に受信
- クラウド原寸の必要時取得、端末キャッシュ、通信量表示、キャッシュ削除

台帳編集では、先に工事と台帳を選びます。スマートフォンでは「写真」「台帳」タブを切り替え、写真を選んでから配置先の枠をタップしてください。

## 起動

ES Modulesを使用するため、ファイルを直接開かず静的Webサーバーで配信してください。

```text
python -m http.server 8000
```

その後、`http://localhost:8000/`を開きます。ビルド処理はありません。

## データと安全性

- IndexedDB: `aoALBDB`
- localStorageキー: `aoALB:`から開始
- 対応形式: aoPIC `aoALB-export` / `manifestVersion: 1`
- 実際のZIPや工事写真はリポジトリへ含めません。
- ZIP由来のHTML、JavaScript、SVGは実行・表示しません。
- ZIP取込み済み工事は、工事一覧から工事単位でこの端末の写真・台帳・取込み履歴を削除できます。共有先や別端末のデータは削除しません。
- 台帳配置は`ledgers`ストアへ保存し、aoPIC由来の写真・分類・台帳文は変更しません。
- 台帳文言の上書きは台帳ごとの`captionOverrides`へ写真ID別に保存します。未配置へ戻しても同じ台帳内では保持され、別台帳には影響しません。
- 1頁／見開きの表示設定は`aoALB:ledgerViewMode`へ保存し、台帳配置データや印刷順には影響しません。
- 現場共有は初期試作です。Supabase未設定時は外部通信せず、従来のローカル機能だけが動作します。
- 台帳配置そのもののクラウド同期はまだ行いません。クラウド写真は`complete`だけを一覧へ反映し、原寸未取得時は印刷を止めます。
- クラウド画像キャッシュは`cloudFiles`ストアへ保存します。「端末キャッシュを削除」ではクラウド原本、写真メタデータ、台帳配置を削除しません。
- 写真同期の通信量制御仕様は[`docs/photo-sync-spec.md`](docs/photo-sync-spec.md)に定義しています。初期値はWi-Fi確認時のみで、回線不明時やモバイル通信では自動送信しません。写真は1枚ずつ送信し、原寸と小容量サムネイルの保存確認後に同期済みとします。
- service role key、DBパスワード、工事PASSをリポジトリへ保存しません。
- Supabaseのローカル検証手順は[`docs/supabase-setup.md`](docs/supabase-setup.md)を参照してください。接続設定はgit管理外の`config/cloud.local.json`へ保存し、Publishable keyだけを使用します。
- 招待制アカウントとシステム管理画面の適用順・公開前条件は[`docs/invite-only-account-ui.md`](docs/invite-only-account-ui.md)を参照してください。この機能はDB基盤とEdge Functionの検証・適用が終わるまで公開しません。
- 会社PASSの初回登録・変更・紛失時の手順は[`docs/site-creation-code.md`](docs/site-creation-code.md)を参照してください。平文PASSはDB、Git、チャット、アプリ設定へ保存しません。
- 現段階のクラウド共有は青山塗装社内だけの試験運用です。Turnstileは正式な外部提供前に追加します。公開ページを開いただけでは匿名ユーザーを作らず、「現場共有を開始」を選んだ場合だけAnonymous Sign-Inを行います。RLSと非公開Storageを維持し、会社PASSまたは工事PASSがなければ現場データへ参加できません。
- 社内試験の監視、緊急停止、会社PASS漏えい時の対応は[`docs/internal-cloud-trial.md`](docs/internal-cloud-trial.md)、所属のない古い匿名ユーザーの確認と整理は[`docs/anonymous-user-maintenance.md`](docs/anonymous-user-maintenance.md)を参照してください。匿名ユーザーは自動削除しません。

JSZip 3.10.1を`vendor/jszip.min.js`へ同梱しています（MIT/GPLv3 dual license）。

## 工事データをこの端末から削除

工事一覧から、ZIP取込みのみ・共有受信のみ・ZIPと共有の混在工事を、このブラウザ内だけから削除できます。これは共有工事の「ごみ箱」「完全削除」とは別の操作です。

- `projects`、`photos`、`photoFiles`、`cloudFiles`、`ledgers`、`imports`、対象工事を参照する端末設定を1つのIndexedDBトランザクションで処理します。
- 同名工事は表示名ではなく内部の工事キーで区別します。
- 同じ取込み履歴を複数工事が共有する場合は、対象工事との関連だけを外し、他工事の履歴と`exportId`を残します。
- 未送信・送信中の写真、共有先へ未反映の更新、他工事からの参照、関連不整合がある場合は削除を開始しません。
- クラウド接続設定、認証セッション、Supabaseの行・Storageオブジェクト、aoPICや別端末のデータには触れません。削除処理から外部通信も行いません。
- 共有中の工事は、再度開いて「最新にする」と端末へ再表示される場合があります。
- 確認画面を開いた後に写真・台帳・キャッシュ・取込み履歴・送信状態が変わった場合は、削除を中止して再確認を求めます。
- 途中で失敗した場合はトランザクション全体をロールバックし、完了後は対象レコードの残存件数も再確認します。

## 管理者端末を失った場合の復旧（現段階の制約）

匿名認証を使用しているため、管理者端末のブラウザーデータを削除すると、同じ管理者UUIDへは戻れません。工事PASSだけでadminになることはできず、別端末では管理者PASSを使用します。

現段階では、端末一覧の管理・端末無効化もアプリ画面にはありません。DBではadminだけが所属端末を参照でき、`set_site_member_active` RPCで無効化できますが、操作は管理者がSupabase Dashboardで対象UUIDを照合して行います。

復旧が必要な場合は、Supabase管理者がDashboardで次の手順を行います。

1. 復旧先端末を通常の工事PASSで対象現場へ参加させ、editorになったことを確認します。
2. `Authentication > Users`で、その端末の匿名ユーザーUUIDを作成時刻と照合して取得します。
3. SQL Editorで対象プロジェクト名を再確認し、下記の`RECOVERY_SITE_CODE`と`RECOVERY_USER_UUID`だけを置き換えて実行します。工事PASS、会社PASS、秘密鍵はSQLへ記載しません。
4. 実行結果で対象現場のadminが1件以上、復旧端末がactiveなadminになったことを確認します。

```sql
begin;

do $admin_recovery$
declare
  v_site_id uuid;
  v_user_id uuid := 'RECOVERY_USER_UUID'::uuid;
  v_updated integer;
begin
  select id into strict v_site_id
  from public.sites
  where site_code = upper(trim('RECOVERY_SITE_CODE'));

  update public.site_members
  set role = 'admin', active = true
  where site_id = v_site_id
    and user_id = v_user_id
    and active = true;

  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception '対象現場の有効な参加端末を1件に特定できませんでした';
  end if;

  insert into public.audit_logs(site_id, actor_user_id, action, entity_type, entity_id, details)
  values (v_site_id, null, 'admin.recovery.sql_editor', 'site_member', v_user_id,
          jsonb_build_object('reason', 'lost anonymous admin device'));
end
$admin_recovery$;

commit;

select s.site_code, sm.user_id, sm.role, sm.device_name, sm.active
from public.site_members sm
join public.sites s on s.id = sm.site_id
where s.site_code = upper(trim('RECOVERY_SITE_CODE'))
order by sm.role, sm.device_name;
```

既存adminの無効化は、復旧後のadmin端末と対象UUIDを確認してから別操作で行います。UUID、工事PASS、会社PASSをGitHubへコミットしないでください。

## 管理者PASS（migration適用後）

別のPC・ブラウザ・ホーム画面版から管理する場合は、工事ごとの「管理者PASS」を使用します。通常の工事PASSはメンバー参加専用で、管理者権限にはなりません。

- 既存工事は、現在の管理者端末で初回設定するまで管理コードによる接続はできません。
- 管理コードは8～64文字で設定し、画面・ログ・GitHubには保存しません。
- 停止中の端末でも、正しい管理コードがあれば管理者端末として復旧できます。端末を恒久的に拒否したい場合は管理コードも変更してください。
- 最後の有効な管理者端末は停止できません。
- 「工事を終了」は削除ではなく、写真・台帳・参加者を保持したまま書込みを止めます。

この画面機能は `202607290001_site_admin_recovery.sql` の適用後に使用できます。未適用環境では従来の参加とローカル台帳機能を維持します。
