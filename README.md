# うちカギ（LocalVault）

> **合鍵は、自分で配る。**

> **うちカギ** は本アプリの呼称です（旧称: LocalVault）。
> 「うち（自分のサーバー）」の「カギ」を、自分の手で管理することを表しています。PC の登録は合鍵を渡すこと、端末の解除は合鍵の回収、PC の解錠をスマホで承認するのはインターホンで開けること、復旧シートは予備の鍵にあたります。
> リポジトリ名・パッケージ名（`@localvault/*`）・Bundle ID・Docker サービス名・QR やファイル形式の識別子などは `LocalVault` / `localvault` のまま変更していません。
> テーマは、和紙のような温かい無彩色に **藍**（アクセント）と **真鍮**（鍵とお気に入りの印）。色は `app/packages/design-tokens`、アイコンは `app/mobile/scripts/generate-icons.py` で生成します。

うちカギは、自分のサーバーで動かすパスワード管理アプリです。項目の暗号化と復号は利用者の端末（スマホと PC のブラウザ拡張）だけで行い、サーバーは暗号文と公開情報しか持ちません（ゼロ知識）。マスターパスワードや復号済みの保管庫は、サーバーにも通信経路にも送られません。

## 機能

- **スマホ本体アプリ**：項目の作成・編集・削除、ゴミ箱、パスワード生成、コピー（自動消去）、CSV の取り込み、バックアップ（`.lvbackup`）。画面保護（スクリーンショット防止、アプリ切り替え時の目隠し）はネイティブ実装の段階で入れる
- **ロック解除**：マスターパスワード、生体認証（端末の範囲内）、試行回数の制限
- **オートフィル**：iOS 拡張と Android サービス（M4 / M5、実装は次の段階）
- **PC（ブラウザ拡張）**：Chrome / Edge の読み取り専用クライアント。スマホとのペアリング後、解錠はスマホの承認で行う
- **端末管理**：承認端末の追加・解除、鍵の更新、サインアウト、セキュリティログ
- **復旧**：復旧コード（オプション）と、待機時間を置いた復元
- **セルフホスト**：Docker Compose と Caddy（自動 TLS）、日次バックアップ

仕様の全体は [docs/spec.md](docs/spec.md)、v0.4 の決定事項は [docs/spec-review.md](docs/spec-review.md) を参照してください。範囲外（パスキー、TOTP、共有、PC での編集、Firefox / Safari、ローカルのみモード）は仕様 §1.4 のとおりです。

## 現在の状態

| 構成要素 | 完了している内容 | 次にやること |
|---|---|---|
| サーバー（`app/server`） | 全 API、PostgreSQL マイグレーション、認証、レート制限、プッシュ送信、運用 CLI。単体・統合・E2E テストあり（Docker が必要） | 本番に近い環境での通し確認 |
| 基盤（`platform/`） | 本番・開発の Compose、Caddy（TLS）、日次バックアップ、運用スクリプト | 本番ホストでの初回デプロイ確認（[runbook](docs/runbook.md)） |
| ブラウザ拡張（`app/extension`） | MV3 の拡張（ペアリング、解錠、同期、照合、候補表示と入力、コピー）。テストページあり | 実ブラウザでの手動確認、配布準備 |
| スマホ本体（`app/mobile`） | 初期設定、ロック解除、項目、承認、端末、設定、復旧コードの画面。開発用コア（`@localvault/vault-engine`）で動作 | ネイティブ VaultCore（Swift / Kotlin）の実装（次の段階。M4 / M5 と合わせて） |
| iOS オートフィル | 初期設定の案内画面のみ。拡張本体は未着手 | M4（ネイティブ、VaultKit 共有） |
| Android オートフィル | 初期設定の案内画面のみ。サービス本体は未着手 | M5（ネイティブ、AutofillService） |

マイルストーンの定義は [仕様 §18](docs/spec.md) にあります。ネイティブモジュール（Swift / Kotlin）は次の段階で実装します。それまでスマホのアプリは開発用コアで動きます。暗号結果の一致は `app/packages/crypto-vectors` のテストベクタで確認します。

## リポジトリの構成

```
app/        アプリとパッケージ（pnpm workspaces）
  mobile/     スマホ本体（Expo / React Native）
  extension/  ブラウザ拡張（Manifest V3、WXT）
  server/     API サーバー（Hono + Kysely + PostgreSQL）
  packages/   core（暗号・照合の参照実装）、protocol（API の型と定義）、
              vault-engine（開発用コアの参照実装）、crypto-vectors、design-tokens
  shared/     Public Suffix List など、複数の成果物で使うデータ
platform/   インフラ（Docker Compose、Caddy、バックアップ、運用スクリプト、secrets / env）
docs/       spec.md（仕様）、spec-review.md（v0.4 の決定）、runbook.md（運用）、architecture.md（構成）
scripts/    リポジトリ全体の検査（禁止パッケージの検出）
```

コードの依存関係と信頼の境界は [docs/architecture.md](docs/architecture.md) にまとめています。

## 前提

- Node.js 24（`.nvmrc` と `engines` で指定）
- pnpm（`package.json` の `packageManager` で指定。corepack の利用を推奨）
- Docker（サーバーのテスト、開発用の Compose）
- スマホのアプリを動かす場合：Xcode（iOS シミュレーターまたは実機）。Android のビルドは対象外です
- ブラウザ拡張：Chromium 116 以上（Chrome / Edge / Brave）

## 開発を始める

```sh
pnpm install                  # リポジトリのルートで
pnpm typecheck                # 全パッケージの型検査
pnpm test                     # 全パッケージのテスト（サーバーは Docker が必要）
pnpm lint                     # Biome
pnpm check:deps               # 禁止された通信 SDK が入っていないことの検査
```

### 開発用のサーバーを起動する

```sh
pnpm platform:dev             # DB、マイグレーション、API、Caddy を起動（--build 付き）
```

- API：`http://127.0.0.1:8787`
- TLS 付き：`https://localhost:8443`（Caddy の内部 CA。信頼させる手順は [runbook](docs/runbook.md#12-開発環境の-tls-を信頼させる)）
- 開発用の固定値（DB のパスワード、secret）は開発専用です。本番では使わないでください
- 停止：`pnpm platform:down`

サーバーをホストで動かす場合は、DB だけ起動してください。

```sh
docker compose -f platform/docker/compose.dev.yml up -d db
cp app/server/.env.example app/server/.env
pnpm --filter @localvault/server exec tsx src/cli.ts migrate
pnpm --filter @localvault/server dev
```

### ブラウザ拡張を読み込む

```sh
pnpm --filter @localvault/extension build          # https のみ（製品ビルド）
pnpm --filter @localvault/extension build:dev      # http://localhost を許可（開発専用、出力先 .output-dev）
```

1. Chrome で `chrome://extensions` を開き、「デベロッパーモード」を有効にする
2. 「パッケージ化されていない拡張機能を読み込む」で、ビルドの出力先（`app/extension/.output/chrome-mv3`、開発ビルドは `.output-dev` 配下）を選ぶ
3. 拡張の「設定を開く」でサーバー URL を入力し、「ペアリングを開始」。表示された QR をスマホで読み取って承認する

拡張のテストページ（`app/extension/test-pages`）と詳細は [app/extension/README.md](app/extension/README.md) を参照してください。

### スマホ本体アプリを動かす

```sh
pnpm --filter @localvault/mobile typecheck
pnpm --filter @localvault/mobile test
cd app/mobile
EXPO_PUBLIC_LV_DEV_CORE=1 npx expo run:ios        # 開発用コアでサーバーにつなぐ
EXPO_PUBLIC_LV_FAKE_CORE=1 npx expo run:ios       # サーバーなしで画面だけ確認する（暗号は行わない）
```

- `EXPO_PUBLIC_LV_DEV_CORE=1` は開発ビルドでだけ有効です。`http://localhost` は開発ビルドに限って許可されます（本番は https のみ）
- 詳細と環境フラグの一覧は [app/mobile/README.md](app/mobile/README.md) を参照してください

## ドキュメント

| 文書 | 内容 |
|---|---|
| [docs/spec.md](docs/spec.md) | 仕様（v0.4。変更箇所に「（v0.4）」の印。詳細な決定は spec-review が優先） |
| [docs/spec-review.md](docs/spec-review.md) | v0.4 の決定、実装時の解釈、VaultCore 契約の追加 |
| [docs/architecture.md](docs/architecture.md) | 構成図、依存関係、信頼の境界、主要な流れ、テスト戦略 |
| [docs/runbook.md](docs/runbook.md) | 本番の運用（初回デプロイ、バックアップと復元、更新、インシデント対応） |
| [platform/README.md](platform/README.md) | Docker 構成の詳細 |
| [app/server/README.md](app/server/README.md) | サーバーの環境変数、CLI、ログ方針 |
| [app/extension/README.md](app/extension/README.md) | ブラウザ拡張の構成とテスト |
| [app/mobile/README.md](app/mobile/README.md) | スマホアプリの構成と環境フラグ |
| [app/packages/crypto-vectors/README.md](app/packages/crypto-vectors/README.md) | 暗号テストベクタの形式 |
