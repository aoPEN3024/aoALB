# aoALB

aoPICが出力する「aoALB用ZIP」を読み込み、工事写真台帳を作成するための静的Webアプリです。

## Stage 1

- manifestVersion 1のZIP検証
- JPEGとmanifestの照合（SHA-256、bytes、寸法）
- aoALB専用IndexedDBへの保存
- 工事一覧、写真一覧、絞り込み、写真詳細、取込み履歴

台帳配置、A4プレビュー、印刷は次段階で追加します。

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

JSZip 3.10.1を`vendor/jszip.min.js`へ同梱しています（MIT/GPLv3 dual license）。
