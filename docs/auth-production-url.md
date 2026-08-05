# aoALB 認証URL運用手順

Supabase Dashboard の Authentication > URL Configuration では、本番とローカル検証を分けて登録します。
このファイルは設定値の手順書であり、Dashboard の設定を自動変更するものではありません。

## 本番

- Site URL: `https://aopen3024.github.io/aoALB/`
- Redirect URL: `https://aopen3024.github.io/aoALB/`
- 本番URLはワイルドカードを避け、上記の完全一致を優先します。

aoALB は、メール確認とパスワード再設定のどちらでも、現在開いているaoALBのURLを `redirectTo` としてSupabase Authへ渡します。本番公開版から操作した場合は、メール確認後とパスワード再設定後のどちらも `https://aopen3024.github.io/aoALB/` に戻る設定とします。

## localhost検証

localhostまたは`127.0.0.1`のRedirect URLは、本番URLとは別の検証用項目として登録します。使用するホスト名・ポートを明示し、必要以上に広いワイルドカードは設定しません。

例:

- `http://127.0.0.1:8897/`
- `http://localhost:8897/`

検証終了後も残す必要があるURLだけを維持し、本番のSite URLをlocalhostへ変更しません。

## 公開前確認

1. Site URLが本番URLと完全一致している。
2. Redirect URLsに本番URLが完全一致で登録されている。
3. メール確認リンクが本番aoALBへ戻る。
4. パスワード再設定リンクが本番aoALBへ戻る。
5. Project URLとPublishable key以外の秘密情報をブラウザやGitHubへ保存していない。
