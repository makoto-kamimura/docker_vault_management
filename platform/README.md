# platform（Docker / インフラ）

LocalVault サーバーを Docker Compose で動かすための構成です。

## 構成

```
platform/
  docker/
    server.Dockerfile   サーバーのイメージ（ビルドコンテキストはリポジトリのルート）
    compose.yml         本番（db / app / caddy / backup）
    compose.dev.yml     開発（db / migrate / app / caddy[tls internal]）
    caddy/              Caddyfile（本番）/ Caddyfile.dev
    backup/backup.sh    日次 pg_dump（cron 不要のループ）
  env/.env.example      設定のひな形（.env は git 管理外）
  secrets/              秘密ファイル（git 管理外）
  backups/              バックアップ出力先（git 管理外）
  scripts/              運用スクリプト
```

ネットワークは `edge`（caddy と app）と `data`（app / db / backup、`internal: true` で外部に出られない）に分かれます。db は公開しません。app は読み取り専用ルート、全 capability を破棄、`no-new-privileges` で動きます。

## 本番の初回セットアップ

1. DNS で `LV_DOMAIN` の A/AAAA レコードをこのサーバーに向ける。
2. ルーターやファイアウォールで 80/tcp、443/tcp、443/udp を開ける（Let's Encrypt の取得と HTTP/3 に使います）。
3. 秘密値と `.env` を作る。
   ```sh
   platform/scripts/init-secrets.sh
   ```
   `platform/env/.env` の `LV_DOMAIN` と `PUBLIC_ORIGIN` を編集します。
4. 起動する。
   ```sh
   docker compose -f platform/docker/compose.yml --env-file platform/env/.env up -d --build
   ```
5. DB マイグレーションを適用する（起動時には自動適用されません）。
   ```sh
   platform/scripts/migrate.sh prod
   ```
6. 最初の招待コードを発行する。
   ```sh
   platform/scripts/invite.sh prod create --expires-in 7d
   ```

## 開発

```sh
docker compose -f platform/docker/compose.dev.yml up --build   # 全部起動
pnpm platform:dev                                              # 同じ（ルートの script）
```

- API: `http://127.0.0.1:8787`、TLS 付き: `https://localhost:8443`（Caddy の内部 CA）
- 開発用の固定値（DB `localvault/localvault/localvault`、各 secret）は開発専用です。本番では使わないでください。
- DB だけ起動し、サーバーはホストで動かす場合:
  ```sh
  docker compose -f platform/docker/compose.dev.yml up -d db
  DATABASE_URL=postgres://localvault:localvault@127.0.0.1:5432/localvault ...
  ```
- 実機やシミュレーターで `https://localhost:8443` を信頼させる:
  ```sh
  platform/scripts/export-dev-ca.sh   # secrets/dev-root-ca.crt を書き出し、手順を表示
  ```

## バックアップと復元

- `backup` コンテナが毎日 `BACKUP_HOUR_UTC` 時（既定 18 時 UTC）に `pg_dump --format=custom` を取り、`platform/backups/localvault-YYYYmmdd-HHMMSS.dump` に保存します。`BACKUP_KEEP_DAYS`（既定 14）日より古いものは削除されます。ダンプに失敗するとコンテナは非ゼロで終了し、再起動されます。
- パスフレーズで暗号化する場合は、ファイルを作って `.env` の `LV_BACKUP_PASSPHRASE_FILE` に指定します（`.dump.enc` で保存、openssl aes-256-cbc / pbkdf2）。中身は暗号文ですが、バックアップ先も暗号化することを推奨します。
- 今すぐ取る: `platform/scripts/backup-now.sh [dev|prod]`
- 復元: `platform/scripts/restore.sh platform/backups/<ファイル>.dump prod`（確認あり。`--yes` で省略）。復元後は `app` を再起動してください。
- バックアップはホスト上のディスクにあります。別の場所（外付けディスクやオブジェクトストレージ）にも定期的にコピーしてください。

## 更新手順

```sh
git pull
docker compose -f platform/docker/compose.yml --env-file platform/env/.env build
platform/scripts/migrate.sh prod
docker compose -f platform/docker/compose.yml --env-file platform/env/.env up -d
```

更新前に `backup-now.sh prod` を実行しておくと安心です。サーバーの時刻は NTP で同期してください。

## ログに残るもの・残らないもの

- Caddy のアクセスログ（stdout）は、時刻・クライアント IP・メソッド・パス・ステータス・所要時間のみを記録します。リクエストヘッダー（Authorization、X-LV-Admin、X-LV-AuthKey など）、ボディ、クエリ文字列、レスポンスヘッダーは記録しません（spec §5.12）。
- app のログに秘密値や平文のデータを出さないのはサーバー側の責務です（`LOG_LEVEL` で詳細度を調整）。
- 保存される秘密は `platform/secrets/` のファイル（権限 600）だけです。Docker の secret として `/run/secrets/` に渡され、環境変数には載りません（`.env` にはパスワード類を書かない）。
