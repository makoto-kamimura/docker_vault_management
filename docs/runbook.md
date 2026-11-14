# うちカギ（LocalVault）運用手順書

この文書は、利用者のための自前サーバー（1 台の Docker ホスト）を運用する人のための手順です。`platform/README.md` と `app/server/README.md` の内容を、運用の順に並べ直したものです。仕様の根拠は [仕様 §13.9（運用）](spec.md) と [§5.12（ログ）](spec.md) です。v0.4 の決定が優先されます（[spec-review.md](spec-review.md)）。

> **前提の注意**：サーバーはゼロ知識です。サーバーの管理者はマスターパスワード、保管庫の内容、復旧コードの平文を取得できません。データを復元できるのはバックアップと、利用者の承認端末（またはその復旧コード）だけです。

## 1. 構成の確認

```
Internet ──443/80──▶ caddy ──edge──▶ app (Hono :8787) ──data──▶ db (PostgreSQL 16)
                                                         ▲
                                       backup（日次 pg_dump）┘
```

| サービス | 役割 | 公開 |
|---|---|---|
| `caddy` | TLS 終端（Let's Encrypt）、HSTS、本文上限 13 MB、アクセスログ | 80/tcp、443/tcp、443/udp |
| `app` | API サーバー。読み取り専用ルート、capability なし、`no-new-privileges` | なし（edge のみ） |
| `db` | PostgreSQL 16。`data` ネットワークは `internal: true` で外に出られない | なし |
| `backup` | 日次の `pg_dump`（cron 不要のループ） | なし |

本番の Compose は `platform/docker/compose.yml`、env は `platform/env/.env`、秘密ファイルは `platform/secrets/`（どれも Git 管理外）です。運用コマンドはすべて `platform/scripts/` にあり、第 1 引数で `prod` か `dev` を指定します。

## 2. 初回デプロイ

**事前に確認すること**

- [ ] DNS：`LV_DOMAIN` の A/AAAA レコードをこのホストに向けた（第 3 章）
- [ ] ファイアウォール：80/tcp、443/tcp、443/udp を開けた
- [ ] 時刻：NTP で同期している（署名の時刻検証に使うため。ずれると `E_CLOCK_SKEW` になる）
- [ ] Docker と Docker Compose（v2）、Git、curl、openssl が動く（イメージのビルドは Docker 内で行うため、ホストに Node.js は不要）
- [ ] ホストの目安：メモリ 2 GB 以上（イメージのビルドに使う。1 GB の場合はスワップを用意する）、ディスク 10 GB 以上

**手順**

配置は Git 経由で行います。サーバーには GitHub の公開リポジトリを clone し、更新は `git pull` で取り込みます（第 8 章）。秘密値と `.env` はサーバー上にだけ置き、Git には入れません。

```sh
# 1. リポジトリを取得する（運用するユーザーで。root でなくてよい）
git clone https://github.com/makoto-kamimura/docker_vault_management.git
cd docker_vault_management

# 2. 秘密値と .env を作る（既存のファイルは上書きしない）
platform/scripts/init-secrets.sh
#    → platform/env/.env の LV_DOMAIN と PUBLIC_ORIGIN を編集する（第 4 章）
#      REGISTRATION_MODE は invite のまま。APNS_* は空のまま（プッシュ通知を使わない場合）

# 3. 配置する（ビルド → マイグレーション → 起動 → ヘルスチェック）
platform/scripts/deploy.sh

# 4. 最初の招待コードを発行（表示は 1 回だけ）
platform/scripts/invite.sh prod create --expires-in 7d
```

`deploy.sh` は初回、DB がまだ無いので事前のバックアップを省きます。初回は証明書の取得に 1〜2 分かかることがあります（ヘルスチェックは最大およそ 3 分待ちます）。

**確認**

- [ ] `https://<LV_DOMAIN>/v1/health` が応答する（第 9 章）
- [ ] `platform/scripts/cli.sh prod stats` が動く
- [ ] 招待コードでアカウントを作れる（テスト用アカウントは作成後に削除してよい。第 6 章）

## 3. DNS と TLS

- Caddy は `LV_DOMAIN` の証明書を Let's Encrypt から自動取得・自動更新します。取得には 80/tcp か 443/tcp が届く必要があります。
- 証明書は `caddy_data` ボリュームに保存されます。このボリュームを失っても再取得されますが、Let's Encrypt の発行上限に注意してください。
- Caddy は `Strict-Transport-Security: max-age=31536000; includeSubDomains` を付けます。**同じドメインの下に HTTP だけのサブドメインを置かないでください。**
- `TRUST_PROXY` は compose で `1` に固定されています（Caddy の 1 段）。構成を変えたときだけ見直し、既定の `0` のまま Caddy を使うと、レート制限がすべて Caddy の IP になります。
- 本文の上限：Caddy は 13 MB、アプリの既定の JSON 上限は 1 MB、`POST /v1/records/batch` とローテーションの分割は 12 MB（spec-review G12）。

## 4. 秘密値と設定

| ファイル／変数 | 用途 | 作り方・注意 |
|---|---|---|
| `platform/secrets/db_password` | `db` と `backup` のパスワード | `init-secrets.sh` が生成（hex 24 バイト） |
| `platform/secrets/database_url` | `app` の `DATABASE_URL_FILE` | 同上。接続先は `db:5432` |
| `platform/secrets/token_secret` | アクセストークンの署名鍵（32 バイト以上） | `init-secrets.sh` が生成。変更時の影響は未検証のため、変更は計画的に行う |
| `platform/secrets/prelogin_secret` | 存在しないアカウントへの偽の応答を作る鍵 | 同上。変更すると偽の応答の値が変わる |
| `platform/secrets/backup_passphrase`（任意） | バックアップの暗号化 | 作成し、`.env` の `LV_BACKUP_PASSPHRASE_FILE` に指定する。**紛失すると暗号化されたバックアップは開けない** |
| `platform/env/.env` | `LV_DOMAIN`、`PUBLIC_ORIGIN`、`REGISTRATION_MODE`、`LOG_LEVEL`、バックアップの時刻と保持日数、APNs／FCM の設定 | `init-secrets.sh` が雛形から作る（権限 600）。`PUBLIC_ORIGIN` は `https://<LV_DOMAIN>`（パスなし） |

- 秘密ファイルの権限は 600、Docker secret として `/run/secrets/` に渡されます。**パスワードや secret を `.env` に書かないでください。**
- プッシュ通知の鍵（APNs の `.p8`、FCM のサービスアカウント JSON）もファイルで用意し、`.env` の `LV_APNS_KEY_P8_FILE` と `LV_FCM_SERVICE_ACCOUNT_FILE` にパスを書きます。Docker secret として渡るので、鍵の中身を `.env` に書く必要はありません。未設定ならその送信先は無効になります。
- `REGISTRATION_MODE` は本番では `invite`（既定）のままにしてください。`open` は開発用の設定です。
- ログに秘密値、平文、トークン、署名を出さないのはサーバーの責務です（`LOG_LEVEL` は `info` が既定）。

## 5. マイグレーション

- 適用：`platform/scripts/migrate.sh prod`（`app` の CLI で `migrate` を実行。DB が止まっていれば起動してから再試行します）。
- 起動時には自動適用しません。スキーマが古いとサーバーは起動を拒否し、`migrate` を実行するよう表示します。
- マイグレーションは `app/server/migrations/*.sql` の順方向のみです（現状は `0001_init.sql`）。**元に戻すには、適用前のバックアップから復元します。**
- 更新のときは、必ず「バックアップ → ビルド → マイグレーション → 起動」の順に行います（第 8 章）。

## 6. 招待とアカウントの管理

```sh
platform/scripts/invite.sh prod create --expires-in 7d   # 招待コードを発行（表示は 1 回だけ）
platform/scripts/invite.sh prod list                     # 一覧（id、期限、取り消し、使用済み）
platform/scripts/invite.sh prod revoke <id>              # 取り消し
platform/scripts/cli.sh prod account list                # アカウント一覧
platform/scripts/cli.sh prod account delete <名前> --yes # アカウントの削除（取り消せない）
platform/scripts/cli.sh prod stats                       # 件数などの集計
```

- 招待コードは DB に SHA-256 のハッシュだけが残ります。コードを忘れた場合は、取り消して新しく発行します。
- `account delete` は、そのアカウントの暗号文とメタデータをすべて削除します。他の端末は次の同期で `E_ACCOUNT_DELETED`（HTTP 410）を受け取り、利用者に知らせてから端末内のデータを消去します（spec-review G3）。**利用者の同意なしに行わないでください。**
- 管理者は利用者のマスターパスワードを知りません。パスワードを忘れた利用者にサーバー側でできることはありません（復旧コードまたは承認端末による復旧だけです）。

## 7. バックアップと復元

### 7.1 仕組み

- `backup` コンテナが毎日 `BACKUP_HOUR_UTC`（既定 18 時 UTC）に `pg_dump --format=custom` を取り、`platform/backups/localvault-YYYYmmdd-HHMMSS.dump` に保存します。
- `BACKUP_KEEP_DAYS`（既定 14）日より古いものは削除されます。
- `backup_passphrase` を設定すると `.dump.enc` で保存されます（openssl aes-256-cbc、pbkdf2、反復 600,000）。
- 中身は暗号文とメタデータ（アカウント名、端末の公開情報、監査イベントなど）です。**保存先も暗号化し、アクセスを制限してください。**
- バックアップは同じディスク上にあります。**別の場所（外付けディスク、別のホストのオブジェクトストレージ）へのコピーは自動化されていないため、手動で定期的に行ってください。**

### 7.2 今すぐ取得する

```sh
platform/scripts/backup-now.sh prod      # 更新前や復元前に必ず取る
```

### 7.3 復元の演習（推奨：定期的に、月 1 回程度）

本番に似た状態で、バックアップが実際に戻ることを確かめます。演習は**開発環境**で行い、本番の DB に対して行わないでください。

1. 直近のダンプを本番のホスト以外のコピーから取り出す。`.dump.enc` の場合は先に復号する（`platform/scripts/restore.sh` のヘッダーに openssl のコマンドがあります）。
2. 開発環境を起動する（`pnpm platform:dev`）。
3. 復元する：`platform/scripts/restore.sh <ダンプ> dev --yes`（`--clean --if-exists` で既存データを置き換えます）。
4. アプリを再起動する：`docker compose -f platform/docker/compose.dev.yml restart app`。
5. `platform/scripts/cli.sh dev stats` と `account list` で件数を確認し、テスト用アカウントで端末からログインできることを確かめる。
6. 日付、ダンプの名前、所要時間、結果を運用記録に残す。

### 7.4 本番で復元する

1. 利用者に停止を知らせる。
2. 現在の状態を保存する：`platform/scripts/backup-now.sh prod`（復元が失敗したときに戻すため）。
3. アプリを止める：`docker compose -f platform/docker/compose.yml --env-file platform/env/.env stop app`（書き込みを止めてから復元する）。
4. 復元する：`platform/scripts/restore.sh <ダンプ> prod`（確認を求めます。`--yes` で省略可）。
5. アプリを起動する：`docker compose -f platform/docker/compose.yml --env-file platform/env/.env up -d app`。
6. `/v1/health` と `cli.sh prod stats` を確認する。
7. 復元で戻った時点より後に行われた変更（登録、端末の追加など）は失われています。利用者への案内に含めてください。
8. 復元後のクライアントの挙動は第 10 章を参照してください。

## 8. 更新

開発側で `main` に push した変更を、サーバーで取り込みます。

```sh
cd docker_vault_management
platform/scripts/deploy.sh            # main を取り込んで配置する
```

`deploy.sh` が行うこと（失敗したらその場で止まり、理由を表示します）：

1. 前提の確認：`platform/env/.env` と秘密ファイルがあること、`LV_DOMAIN` と `PUBLIC_ORIGIN` が設定済みであること、作業ツリーに未コミットの変更がないこと
2. `git fetch` → `git pull --ff-only origin main`（早送りできない場合は止まる。サーバーでコミットしないこと）
3. 事前のバックアップ（`backup-now.sh prod`。DB が動いていない初回は省く）
4. イメージのビルド（`app`）
5. DB マイグレーション（`migrate.sh prod`）
6. 起動（`up -d --wait`）
7. `https://<LV_DOMAIN>/v1/health` のヘルスチェック

| オプション | 意味 |
|---|---|
| `--branch <名前>` | `main` 以外のブランチを取り込む（検証用） |
| `--no-pull` | `git pull` をせず、いまのチェックアウトのまま配置する |
| `--skip-backup` | 事前のバックアップを省く |

手動で行う場合の手順（`deploy.sh` と同じ内容）：

```sh
platform/scripts/backup-now.sh prod                                     # 1. 先にバックアップ
git pull --ff-only                                                      # 2. 更新を取り込む
docker compose -f platform/docker/compose.yml --env-file platform/env/.env build   # 3. イメージをビルド
platform/scripts/migrate.sh prod                                        # 4. マイグレーション
docker compose -f platform/docker/compose.yml --env-file platform/env/.env up -d   # 5. 起動
```

- 更新後に `/v1/health` と `cli.sh prod stats` を確認します。
- 前の版に戻すとき：`git log` で戻したいコミットを確かめ、`git switch --detach <コミット>` の後に `platform/scripts/deploy.sh --no-pull` を実行します。マイグレーションを適用していた場合は、下のとおりバックアップから復元します。元に戻したら `git switch main` で戻してください。
- 不具合が出たら、コードとイメージを前の版に戻します。マイグレーションを適用していた場合は、**バックアップから復元します**（逆向きのマイグレーションはありません）。
- サーバーの時刻が NTP で同期されていることを、更新のたびに確認してください。

## 9. 監視とログ

### 9.1 ヘルスチェック

- `GET /v1/health`：認証なし。DB に `select 1` を発行し、バージョンと登録モードを返します。
- Caddy は `/v1/health` を 30 秒ごとに確認します（`health_uri`）。
- 外部からの監視は任意です（spec §13.9）。例：`curl -fsS https://<LV_DOMAIN>/v1/health`。

### 9.2 ログの方針

| ログ | 記録されるもの | 記録されないもの |
|---|---|---|
| Caddy（アクセスログ、stdout） | 時刻、メソッド、パス、ステータス、所要時間 | クライアント IP、ヘッダー（Authorization、X-LV-Admin、X-LV-AuthKey など）、本文、クエリ文字列、レスポンスヘッダー |
| app（アクセスログ） | メソッド、ルートのパターン（`/v1/devices/{id}`）、ステータス、所要時間 | IP アドレス、本文、ヘッダー、トークン、署名、authKey |

- IP アドレスは Caddy とアプリのどちらのログにも残しません（spec §5.12 の「30 日で削除」より厳しい）。コンテナのログは `compose.yml` の `logging` で 10 MB × 3 世代までに制限しています。
- ログの確認：`docker compose -f platform/docker/compose.yml --env-file platform/env/.env logs --tail 200 app caddy`

## 10. 復元後・巻き戻し後にクライアントに見えること

サーバーの状態が古いものに戻ると、クライアント（スマホ、拡張）は次のどちらかを見ます。

**(a) 全件の取り直し（`fullResync`）**

- サーバーは、クライアントの `since` が `min_valid_cursor` より小さいとき `fullResync: true` を返します（`since=0` では立ちません）。
- クライアントは `since=0` から取り直し、その取り直しが `hasMore=false` で終わるまで、途中のページの `fullResync` を無視します（無視しないと無限に取り直すため。spec-review W2）。
- 取り直しの最後のページで、サーバーにないレコードを端末から削除します。

**(b) 巻き戻しの検知（`E_ROLLBACK_DETECTED`）**

- クライアントは、カーソルが端末の記録より小さい、レコードの版（rev）が端末の記録を超えている、鍵の版（vkVersion）が古い、などを見つけると巻き戻しを検知します（spec §7.5）。
- 同期は止まり、一覧画面に「巻き戻しを検知」が表示されます（`sync.rollback`）。端末のデータは消えません。
- 利用者は画面の案内に従い、先にエクスポートしてから、サーバーの状態を受け入れるかを判断します（文言は `app/mobile/src/i18n/ja.ts`）。受け入れると、カーソルを 0 に戻して全件を取り直します（`acceptServerState`）。

**運用者の案内**：復元で古い状態に戻すと、復元後に行われた変更が失われます。利用者には「巻き戻し警告が出たら、慌てて操作せず、まずエクスポートしてから管理者に連絡する」ことを伝えてください。

## 11. インシデント対応

### 11.1 利用者がスマホを紛失した

1. 依頼者が利用者本人かを確認する。本人確認ができない依頼では、端末の登録解除や復旧の操作を行わない。
2. 利用者に、残っている承認端末（別のスマホ、ペアリング済みの PC）から、紛失した端末を登録解除してもらう。鍵の更新を伴う操作です（spec §8.8）。利用者向けの手順は spec §8.9 とヘルプ画面（`/settings/help`）にあります。
3. 他の承認端末がない場合は、復旧コード（spec §8.11）を使う。復旧コードもない場合、サーバー側では復元できません（ゼロ知識）。
4. 紛失の前後の監査イベントを確認する（読み取りだけ行う）。

```sql
-- 読み取り専用。アカウント ID は cli.sh prod account list で確認する
select kind, device_id, created_at from audit_events
where account_id = '<アカウント ID>' order by id desc limit 50;
```

- `kind` は `device_added`、`device_revoked`、`unlock_approved`、`rc_used` などです。端末名は含まれません。
- 運用記録に、日時、対応内容、担当者を残してください。

### 11.2 サーバーの侵害が疑われる

1. **隔離する**：`app` と `caddy` を止める。`db` とボリュームは消さない（調査のため）。
   ```sh
   docker compose -f platform/docker/compose.yml --env-file platform/env/.env stop app caddy
   ```
2. **保全する**：ログを書き出す（`logs ... > ファイル`）。現在の DB を `backup-now.sh prod` で取り、ホストの外へコピーする。
3. **調べる**：`audit_events`（直近の `device_added`、`keyset_changed`、`rotated` など）、`invite list`（見覚えのない招待）、`account list`（見覚えのないアカウント）を確認する。
4. **秘密値を替える**：`token_secret`、`prelogin_secret`、`db_password`（`database_url` も）、APNs・FCM の鍵。未使用の招待はすべて `invite revoke` する。
5. **利用者に知らせる**：サーバーが悪意を持つ場合でも、クライアントは暗号文の改ざんや巻き戻しを検知する設計です（spec §5、§7.5）。ただし、利用者は端末の一覧（登録済みの端末）を確認し、見覚えのない端末を登録解除してください。鍵が漏れた疑いがある場合は、鍵の更新（spec §8.8）を行います。
6. **再構築する**：新しいホストに構築し直す。バックアップから復元するのは、侵害より前のものだと確認できたものだけにする（第 7 章、第 10 章）。

### 11.3 バックアップから復元した

- 第 7.4 章の手順に従う。
- 利用者に、同期の挙動（第 10 章）と、「巻き戻しを検知」が出た場合の対応を案内する。
- 復元後に作られた招待、アカウント、端末の登録は失われているため、確認して再作成する。

### 11.4 よくあるエラー

| 症状 | 原因と対応 |
|---|---|
| サーバーが起動しない（migrate を実行するよう表示） | スキーマが古い。`platform/scripts/migrate.sh prod` |
| `E_CLOCK_SKEW`（400、`details.serverTime` あり） | サーバーの時刻がずれている。NTP を確認する。クライアントは「端末の時刻設定を確認してください」と表示する |
| `E_INTERNAL`（500） | 想定外のエラー。詳細は応答に含まれない。`app` のログで確認する。クライアントは再試行する |
| 招待コードが使えない | 期限切れ、取り消し済み、使用済みのいずれか。`invite list` で確認する |
| `/v1/health` が応答しない | `docker compose ... ps` で `db` と `app` の状態を確認。`db` の健全性チェックが通るまで `app` は起動しない |

## 12. 開発環境の TLS を信頼させる

開発用の `https://localhost:8443` は Caddy の内部 CA で署名されます。実機やシミュレーターで使うには、ルート証明書を信頼させます。

```sh
platform/scripts/export-dev-ca.sh   # secrets/dev-root-ca.crt を書き出し、手順を表示する
```

この証明書は開発専用です。本番のホストや利用者の端末に入れないでください。
