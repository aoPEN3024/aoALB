# 社内クラウド共有の運用

現段階は青山塗装社内だけの試験運用です。Cloudflare Turnstileは正式な外部提供前に追加します。Anonymous Sign-Inは利用者が「現場共有を開始」を選んだ場合だけ実行され、公開ページを開いただけでは新しい匿名ユーザーを作りません。

現場データはRLSと非公開の`site-photos` Storageで分離します。現場作成コードまたは対象現場の参加コードがなければ、現場データへ参加できません。Supabase Dashboardで匿名ユーザー数を定期的に確認し、所属のない古い匿名ユーザーは[`anonymous-user-maintenance.md`](anonymous-user-maintenance.md)の二段階手順で対象を確認した場合だけ整理します。

## 緊急停止

1. Supabase Dashboardで対象プロジェクトを開きます。
2. `Authentication`のAnonymous Sign-Insを無効化し、新規端末の匿名認証を停止します。
3. 必要ならGitHubでクラウド公開設定のマージコミットをrevertします。
4. 既存端末内の写真は削除されません。aoPICはローカル撮影とZIP出力を継続できます。

現場作成コードが漏れた場合は、[`site-creation-code.md`](site-creation-code.md)に従ってSQL Editorで新コードへ変更し、旧コードを直ちに無効化します。既存現場や写真は削除しません。
