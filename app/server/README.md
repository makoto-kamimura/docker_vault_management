# @localvault/server

LocalVault の API サーバー（仕様 §13）。暗号文・公開鍵・最小限のメタデータだけを保存し、平文や鍵は一切受け取らない。
Hono + Kysely + PostgreSQL 16。API の形（ルート、スキーマ、エラーコード、制限値）は `@localvault/protocol` が唯一の定義。

## 開発

```sh
docker compose -f platform/docker/compose.dev.yml up -d db   # リポジトリのルートで
cp app/server/.env.example app/server/.env
pnpm --filter @localvault/server dev                         # tsx watch。先に migrate が必要
pnpm --filter @localvault/server exec tsx src/cli.ts migrate
```

テストは Testcontainers（`postgres:16`）を使うので Docker が必要。DB は 1 コンテナで、テストファイルごとに別のデータベースを作る。

```sh
pnpm --filter @localvault/server typecheck
pnpm --filter @localvault/server test
pnpm --filter @localvault/server build     # dist/server.js と dist/cli.js
```

## 環境変数

| 変数                                                                      | 内容                                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `DATABASE_URL`                                                            | PostgreSQL の接続文字列                                                  |
| `PUBLIC_ORIGIN`                                                           | 公開オリジン（パスなし）                                                 |
| `TOKEN_SECRET`                                                            | アクセストークンの署名鍵（32 バイト以上）                                |
| `PRELOGIN_SECRET`                                                         | 存在しないアカウント用の偽の値を作る秘密値（32 バイト以上）              |
| `REGISTRATION_MODE`                                                       | `invite`（既定）／`closed`／`open`                                       |
| `TRUST_PROXY`                                                             | 信頼するプロキシの段数（既定 0）。IP は `X-Forwarded-For` の右から数える |
| `LOG_LEVEL`、`HOST`、`PORT`                                               | ログの詳細度、待ち受け（既定 `0.0.0.0:8787`）                            |
| `APNS_KEY_ID` `APNS_TEAM_ID` `APNS_KEY_P8` `APNS_TOPIC` `APNS_PRODUCTION` | APNs（4 つとも必要）                                                     |
| `FCM_SERVICE_ACCOUNT_JSON`                                                | FCM HTTP v1 のサービスアカウント                                         |
| `MIGRATIONS_DIR`                                                          | マイグレーションのディレクトリ（既定は `migrations/`）                   |

`DATABASE_URL`、`TOKEN_SECRET`、`PRELOGIN_SECRET`、`APNS_KEY_P8`、`FCM_SERVICE_ACCOUNT_JSON` は `<名前>_FILE` でも渡せる。
起動時に zod で検証し、エラーメッセージには変数名だけを出す（値は出さない）。

## 運用コマンド

```sh
node dist/cli.js migrate                         # スキーマの適用（起動時には自動で適用しない）
node dist/cli.js invite create [--expires-in 7d] # 招待コード（表示は 1 回だけ。DB には SHA-256）
node dist/cli.js invite list | invite revoke <id>
node dist/cli.js account list
node dist/cli.js account delete <名前> --yes
node dist/cli.js stats
```

スキーマが古いとサーバーは起動を拒否し、`migrate` を実行するよう表示する。

## ログとプライバシー

- アクセスログは「メソッド、ルートのパターン（`/v1/devices/{id}`）、ステータス、所要時間」だけ。本文、ヘッダー、トークン、署名、authKey、**IP アドレスも記録しない**（仕様の「IP は 30 日で削除」より厳しい）。
- IP はレート制限のメモリ上のキーにだけ使う。
- すべての応答に `Cache-Control: no-store`。CORS ヘッダーは付けない。

## 構成

- `src/app.ts`：依存（DB、時計、プッシュ送信、設定、レート制限）を受け取って Hono アプリを作る。
- `src/routes/define.ts`：protocol のルート表の各エントリを登録し、共通の流れ（本文サイズ上限 → レート制限 → 認証 → 検証 → ハンドラー → 応答検証）を実行する。
- `src/auth/`：認証の種類ごとの処理。`admin.ts`（管理用署名）と `authkey.ts` は小さく保つ。
- `src/ratelimit.ts`：メモリ上のスライディングウィンドウ。
- `src/jobs/cleanup.ts`：1 時間ごとの掃除。
- `migrations/`：SQL ファイル。

## 実装上の解釈（spec-review §6 に加えて）

- `keysetVersion` を送る手段が protocol の `getRecords` のクエリにないため、鍵セットを変えたとき `rev` を 1 つ消費（`keyset_rev`）し、`since` がそれより古いクライアントにだけ `keyset` を返す。`since=0` のときは常に返す。
- `fullResync` は `0 < since < min_valid_cursor` のときだけ true（`since=0` は元から全件）。
- `GET /v1/pairings/{id}` や解錠の署名時刻のずれ（±5 分）は `E_CLOCK_SKEW`（`details.serverTime` 付き）。
- 想定外のサーバーエラーは HTTP 500 と `E_INTERNAL`（protocol にコードがないため）。
