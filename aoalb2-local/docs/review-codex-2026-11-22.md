# Codex独立レビュー指摘への対応（2026-11-22）

ブランチ `feature/aoalb2-local` のみ修正。push・main・Pages・本番Supabase・現行aoALB・aoPICには触れていない。試験は一時フォルダと架空JPEGだけで行った。

## 1. 保存失敗時のデータ消失【修正】

- 共通の「離脱ガード」`app/ui/js/leave-guard.js` を追加。画面移動・工事を閉じる・PDF/印刷・引継ぎ書出し・引継ぎ置換・バックアップ復元・アプリ終了の前に、未保存の操作を保存し終えるまで進まない。
- 保存に失敗したら「保存できていない変更があります」を表示し［再試行］［編集画面へ戻る］。一時的な失敗では未保存の操作を保持する。
- 恒久的な失敗（入力不正など）は「保存できなかった操作を取り消しました」に、取り消した操作の一覧と理由を表示。
- 終了：Tauriの閉じる要求は常に `preventDefault` し、保存と工事を閉じる処理が両方成功した時だけ `destroy()`。`beforeunload` は確認表示のみで、保存には使わない。閉じるを繰り返しても処理は1本。
- 自動試験
  - `app/tests/leave-guard.test.mjs`（8件）：保存成功後だけ移る／一時失敗では移らず操作が残る／再試行で移る／失敗時は工事を閉じない／失敗時は終了せず成功後だけウィンドウ破棄／閉じる処理失敗でも破棄しない／終了連打でも保存1回／恒久失敗は取消一覧と理由を渡す。
  - `app/tests/e2e-save-failure.mjs`（実ブラウザ、デモ50枚）：ダイアログ表示［再試行・編集画面へ戻る］、編集画面に留まる、未保存1件保持、工事は開いたまま、終了3回とも拒否・ウィンドウ未破棄、再試行後に移動し配置が保存済み、エラー0。

## 2. 10GB以上のPDF【修正（上限で断る）】

- 従来型xrefは位置を10桁（`{offset:010}`）で書くため 9,999,999,999 バイトが絶対上限。
- 上限を **7.0GB** に設定（見積り誤差に3割の余裕）。
  - 作成前に容量を見積り（`pdf::estimate`、画面からは `pdf_estimate`）。超過なら作らず、台帳を複製して前半・後半に分けるよう案内。
  - 書込み中も位置を監視し、上限到達で中止。`*.partial` を削除し完成PDFを残さない。原寸は読むだけ（試験で前後のSHA-256一致を確認）。
- 試験 `pdf_size_limit_before_and_during`：見積りちょうどで作成可・実容量≤見積り／1バイト下回ると開始しない／作成中の上限到達で中止し途中ファイルなし／原寸不変。
- **確認済みは約4.5GB（1,001ページ）まで。15GBは未対応。**
- 次段階の設計候補
  1. PDF 1.5 の xref ストリーム（オフセット幅を可変にし10GB超に対応。古い閲覧ソフトの互換確認が必要）。
  2. ページ範囲を指定した分割出力（例：1〜300ページ、301〜600ページ）。
  3. 印刷用の縮小画像（PDF専用に長辺2,000px程度へ再圧縮。原寸ファイルは変更しない）。
  4. 分割時の容量見積り：各分割の写真合計＋固定分（ページ16KiB・フォント・2MiB）で事前表示し、各ファイルが上限内になる分割点を提案。

## 3. .aoalb の総容量検証【修正】

- `manifest.total_bytes` を信用しない。全ファイルの bytes を checked_add で再計算し、桁あふれは拒否、宣言値と完全一致しなければ拒否。空き容量確認は再計算値を使う。
- 上限：写真50,000、ZIP項目50,005、manifest 64MiB、data/*.json 各256MiB、JPEG 1枚100MB、総容量1TiB（理由は design.md §11）。
- 項目ごとに展開後サイズ＝宣言 bytes、圧縮率（1MiB超の項目で100倍超、または圧縮後0バイトは拒否）。
- パス重複・大文字小文字だけ違うパスを拒否。
- 異常時は取込み処理に入らず、既存工事・保存先は変更しない。
- 試験 `exchange_rejects_forged_sizes`：宣言総容量0・少なすぎ・多すぎ・u64最大・桁あふれ・ずらし・総容量上限超・JPEG上限超・重複パス・`Manifest.json` を全て拒否し、保存先が空のまま。`manifest_size_limits` で件数・JSON・総容量の境界を確認。

## 4. Windows予約名【修正】

- 共通関数 `util::safe_name` と `util::unique_child` を新規工事作成と引継ぎ取込みの保存先で共用（PDFのファイル名も `safe_name`）。
- CON・PRN・AUX・NUL・CONIN$・CONOUT$・COM0〜9・LPT0〜9・COM¹²³・LPT¹²³ を大文字小文字・拡張子付き（`CON.txt`、`LPT9.工事`）・末尾空白でも判定。末尾ピリオド・空白除去、空名は既定名、既存フォルダとは大文字小文字を区別せず衝突回避。
- 試験 `windows_reserved_and_unsafe_folder_names`。

## 5. Windows Actions の再現性【修正】

- Rust 1.97.0、Node 22.23.5、Tauri CLI 2.12.6 を固定（`cargo install tauri-cli --version "=2.12.6" --locked`）。
- `cargo test --locked`、`cargo tauri build -- --locked`。
- 成果物 `environment.json` に commit・runner・Windows版・メモリ・CPU・rustc/cargo/node/Tauri CLI/WebView2 の版・計測条件を記録。
- 権限は `contents: read` のみ。Release・Pages・タグ・main への書込みなし、secrets 参照なし。アクションはSHA固定、`persist-credentials: false`、成果物保持7日。

## Windowsで未確認
- WebView2でのメモリ・表示、NSISインストーラ、Windowsのファイルロック・予約名の実挙動、Edge等でのPDF表示、Actionsの実行そのもの（push前のため未実行）。
