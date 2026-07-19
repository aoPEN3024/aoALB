# aoALB

aoPICが出力する「aoALB用ZIP」を読み込み、工事写真台帳を作成するための静的Webアプリです。

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
- 現場ID共有のローカル試作UI、オフライン同期キュー、Supabase接続層

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
- 現在のバージョンでは、取り込んだ工事・写真をアプリ内から削除できません。削除機能は今後追加予定です。
- 台帳配置は`ledgers`ストアへ保存し、aoPIC由来の写真・分類・台帳文は変更しません。
- 台帳文言の上書きは台帳ごとの`captionOverrides`へ写真ID別に保存します。未配置へ戻しても同じ台帳内では保持され、別台帳には影響しません。
- 1頁／見開きの表示設定は`aoALB:ledgerViewMode`へ保存し、台帳配置データや印刷順には影響しません。
- 現場共有は初期試作です。Supabase未設定時は外部通信せず、従来のローカル機能だけが動作します。
- 実写真と台帳のクラウド同期はまだ行いません。現在の同期対象は接続確認用メタデータだけです。
- service role key、DBパスワード、参加コードをリポジトリへ保存しません。
- Supabaseのローカル検証手順は[`docs/supabase-setup.md`](docs/supabase-setup.md)を参照してください。接続設定はgit管理外の`config/cloud.local.json`へ保存し、Publishable keyだけを使用します。

JSZip 3.10.1を`vendor/jszip.min.js`へ同梱しています（MIT/GPLv3 dual license）。
