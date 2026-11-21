# aoALB 2 ローカル版（個人用 工事写真台帳）

写真の取込み・整理・台帳作成・PDF出力・別端末への手動引継ぎができる、Windows向けの個人用ローカル写真台帳アプリです。
ログイン・クラウド・月額サービスは使いません。インターネット接続なしで全機能が動きます。

- 設計書：[docs/design.md](docs/design.md)
- 段階2（最小プロトタイプ）の結果：[docs/stage2-report.md](docs/stage2-report.md)
- レビュー指摘への対応：[docs/review-2026-11-21.md](docs/review-2026-11-21.md)
- Codex独立レビューへの対応：[docs/review-codex-2026-11-22.md](docs/review-codex-2026-11-22.md)
- 同梱フォントとライセンス：[core/fonts/](core/fonts/README.md)
- 将来のクラウド対応案（主対象外）：[../docs/aoalb2/future-cloud/](../docs/aoalb2/future-cloud/README.md)

## 構成

```
aoalb2-local/
  core/               中核（Rust）：工事フォルダ・SQLite・取込み・分類・台帳・PDF・引継ぎ・バックアップ
    src/bin/aoalb-bench.rs  性能計測（架空データ）
    tests/integration.rs    自動検証
  app/
    ui/               画面（HTML/CSS/JS、ビルド不要）
    src-tauri/        Windowsアプリの枠（Tauri 2）。画面と中核の受け渡しだけ
    tests/            画面ロジックの検証、実ブラウザでの操作確認
  docs/               設計書・結果報告
```

## 開発

```bash
# 中核の自動検証
cargo test -p aoalb_core
# 4GB超の引継ぎファイル（時間・容量が必要）
AOALB2_HUGE_DIR=/tmp/huge cargo test --release -p aoalb_core --test integration -- --ignored huge_exchange_over_4gb
# 性能計測（例：1,000枚）
cargo run --release -p aoalb_core --bin aoalb-bench -- 1000 /tmp/bench
# 4GB超の引継ぎの計測（時間・工程ごとの最大メモリ・容量）
cargo run --release -p aoalb_core --example huge_exchange -- /tmp/huge
# 実容量相当の写真での計測
BENCH_REAL=1 cargo run --release -p aoalb_core --bin aoalb-bench -- 1000 /tmp/bench
# アプリ全体（画面エンジン含む）のメモリ計測：計測用工事を残してから
BENCH_KEEP=1 cargo run --release -p aoalb_core --bin aoalb-bench -- 3000 /tmp/b3000
scripts/measure-app-memory.sh target/release/aoalb2-app /tmp/b3000/data/性能計測工事 /tmp/mem
# 台帳PDFの見本（架空データ）
cargo run --release -p aoalb_core --example demo_pdf -- /tmp/demo
# 画面ロジックの検証
node --test app/tests/ledger-model.test.mjs
# 画面だけをブラウザで確認（架空データ1,000枚。保存はしない）
cd app/ui && python3 -m http.server 8765   # → http://localhost:8765/?demo=1000
```

### Windowsアプリの作成

Windows（Rust・Node.js・WebView2）で：

```powershell
cargo install tauri-cli --version "^2" --locked
cd aoalb2-local/app/src-tauri
cargo tauri dev            # 開発起動
cargo tauri build --bundles nsis   # インストーラー（target/release/bundle/nsis/）
```

このブランチをGitHubへpushすると `.github/workflows/aoalb2-local-windows.yml` がWindows上で自動検証・計測（WebView2を含むメモリ）・未署名インストーラー作成を行い、結果を Actions Artifact にだけ保存します（権限は contents: read のみ。Release・Pages・main・secrets には触れません）。

## 守っていること

- 原寸写真は変更しない（再エンコード・EXIF書換えなし、DBでも更新を拒否）。
- 工事データはブラウザの保存領域に置かず、利用者が選んだ工事フォルダに置く。
- 実写真・秘密情報はリポジトリに入れない（検証は生成した架空画像のみ）。
- 本番Supabase・現行aoALB・aoPICには接続・変更しない。
