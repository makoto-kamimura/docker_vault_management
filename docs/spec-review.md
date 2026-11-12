# LocalVault 仕様レビュー（v0.3 → v0.4）

| 項目 | 内容 |
|---|---|
| 対象 | `docs/spec.md` v0.3 |
| 結果 | v0.4（本書の決定を `docs/spec.md` に反映済み。矛盾する箇所は**本書が優先**） |
| 目的 | 実装前に見つかった抜け（G1〜G16）の解決、採用する追加機能（F1〜F3）、範囲外と先送りの整理 |

本書は単体で読めるように、各決定を実装できる粒度で書く。`（v0.4）` は spec.md 内の対応箇所の目印。

## 1. 抜けの解決（G1〜G16）

### G1 解除されたスマホ
`E_DEVICE_REVOKED` を受けたらアプリは即ロックし、同期を止め、ルート `/revoked` を表示する。選択肢は「端末内のデータを消去」（`wipeLocal`）と「§8.6 で再登録」。

### G2 この端末からサインアウト（新 FR-111）
`DELETE /v1/devices/{selfId}`（管理用署名）を送り、自分の端末レコードに `revokedAt` を設定して同期し、最後に `wipeLocal` する。自分が最後の承認端末のときは、PC が解錠できなくなる旨を警告する。サーバーは自己削除を拒否しない。

### G3 他端末でアカウントが削除された
サーバーは `deleted_devices(device_id uuid pk, deleted_at)` を 90 日保持する。該当端末のトークン発行・認証付きリクエストは `E_ACCOUNT_DELETED`（HTTP 410）。クライアントは利用者に知らせてから端末内データを消去する。

### G4 事前条件
- `PUT /v1/keyset`：`keyset.keysetVersion == 現在値 + 1` かつ `keyset.vkVersion == 現在値`。違えば `E_VERSION_CONFLICT`（409）。
- `POST /v1/records/batch`：いずれかの変更の `vkVersion` がアカウントの現在値と違えば、全体を `E_STALE_KEY`（409）で拒否する。
- `PUT /v1/recovery-code` も `vkVersion` が現在値と違えば `E_STALE_KEY`。

### G5 時刻のずれ
管理用署名の `ts` が前後 5 分を超えたら `E_CLOCK_SKEW`（400）。`details.serverTime`（ISO 8601）を付ける。エラー本文は `{ error: { code, message, details? } }`。クライアントは「端末の時刻設定を確認してください」と表示する。

### G6 サーバー CLI
`invite create [--expires-in 7d]`、`invite list`、`invite revoke <id>`、`account list`、`account delete <name> --yes`、`stats`、`migrate`。`invites` に `id uuid`、`expires_at`、`revoked_at` を追加する。

### G7 ヘルプ画面
`/settings/help` に §8.9（スマホを紛失したとき）、§8.10（マスターパスワードを忘れたとき）、§8.11.7（守れないこと）の文面を載せる。

### G8 Android の信頼ブラウザ許可リスト
画面 `/settings/trusted-browsers`（Android のみ）。VaultCore に `listTrustedBrowsers()`、`addTrustedBrowser(packageName)`、`removeTrustedBrowser(packageName)`。端末内にのみ保存し同期しない。同梱の項目は削除できない。

### G9 VaultCore の追加
`getAccountInfo(): { accountId, accountName, serverUrl, deviceId }`、`getThrottleState(): { failedCount, retryAfterSec }`、`getBackupInfo(): { lastExportAt: string | null }`。

### G10 プッシュの種類
`t: "rc_frozen"`（本文「復旧コードが凍結されました。アプリで確認してください」）。`r` は持たない。タップ先は `/settings/recovery-code`。

### G11 開発環境
サーバーは Caddy の背後でプレーン HTTP で待ち受ける。`platform/docker/compose.dev.yml` は `https://localhost:8443`（Caddy 内部 CA。ルート証明書を iOS シミュレーターと Chrome に入れられる）と、プレーン `http://localhost:8787` の両方を公開する。クライアントは**開発ビルドに限り**（コンパイル時フラグ `LV_DEV_ALLOW_HTTP`）`http://localhost`、`http://127.0.0.1`、`http://10.0.2.2` を受け付ける。本番ビルドは §5.11 の https のみの規則を維持する。

### G12 本文サイズ上限と分割ローテーション
既定の JSON 本文上限は 1 MB。`POST /v1/records/batch` とローテーションの分割は 12 MB・各 100 レコードまで。`POST /v1/rotate` は廃止し、次に置き換える。
- `POST /v1/rotations`（承認端末＋管理）`{ expectedRev, newVkVersion }` → `{ rotationId, expiresAt }`。有効 15 分。アカウントごとに 1 つ。新しく作ると古いものは破棄。
- `PUT /v1/rotations/{id}/records`（作成した承認端末）`{ records: [{ id, deleted, nonce, ct }] }` をサーバー側に一時保存する。
- `POST /v1/rotations/{id}/commit`（承認端末＋管理）`{ keyset, verifier, recordCount }` → `{ cursor }`。1 トランザクションで、`record_rev == expectedRev` を確認（違えば `E_VERSION_CONFLICT` で一時保存を破棄）、一時保存の ID 集合が現在の全レコード ID と**完全に一致**すること、全レコードを新しい rev で置換、鍵セット・`vk_version`・`min_valid_cursor` を更新、復旧コードを削除する。
- `DELETE /v1/rotations/{id}` で中止する。

### G13 アカウント作成の冪等性
`POST /v1/accounts` は、同じ `accountId`・`verifier`・`device.signPub` での再試行に 201 を返す。それ以外の重複は `E_ACCOUNT_EXISTS`。

### G14 サーバー URL の変更
画面 `/settings/server`、VaultCore `changeServerUrl(newUrl)`。JS は先に新サーバーの `GET /v1/prelogin` が同じ `accountId` を返すこと、端末ログインが通ることを確かめる。

### G15 マスターパスワード試行回数の共有
FR-12 のカウンタは本体アプリとオートフィル拡張／認証 Activity で共有する（iOS は App Group の UserDefaults、Android は SharedPreferences）。

### G16 `TRUST_PROXY`
信頼するプロキシ段数（既定 0、compose では 1）。クライアント IP は `X-Forwarded-For` の右から数えてその段数番目の要素。

## 2. 採用する追加機能

### F1 他のマネージャーからの CSV 取り込み（新 FR-54）
形式を見出し行で自動判別する。
- Chrome / Edge：`name,url,username,password,note`
- Safari / iCloud：`Title,URL,Username,Password,Notes,OTPAuth`
- Bitwarden：`folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp`
- 1Password：`Title,Url,Username,Password,Notes,...`

流れ：ファイル選択 → プレビュー（形式、件数、重複、スキップ行）→ 新規項目として取り込み → 平文 CSV の削除を促す。重複は「登録ドメインとユーザー名が同じ」。VaultCore：`inspectCsvImport(fileUri)`、`importCsv(fileUri, { skipDuplicates })`。解析は VaultCore 内で行う。画面 `/settings/backup/csv`。

### F2 パスワード履歴（新 FR-28）
`LoginData.passwordHistory?: { password: string; changedAt: string }[]`。新しい順、最大 5 件、無ければ `[]`。`saveItem` はパスワードが変わるとき、直前の値を積む。VaultCore：`getPasswordHistory(id): { index, changedAt }[]`、`revealHistoricPassword(id, index)`、`copyHistoricPassword(id, index)`、`clearPasswordHistory(id)`。Android のオートフィル索引には含めない。

### F3 セキュリティログ（新 FR-95）
`GET /v1/audit-events?before=<id>&limit=50`（承認端末）→ `{ events: [{ id, kind, deviceId, createdAt }], hasMore }`。`id` の降順、`before` はそれより小さい ID。画面 `/settings/security-log`。端末名は端末信頼リストから端末内で解決する。`kind`：`account_created`、`device_added`、`device_revoked`、`device_signed_out`、`keyset_changed`、`rotated`、`unlock_approved`、`unlock_denied`、`rc_issued`、`rc_claimed`、`rc_canceled`、`rc_approved_now`、`rc_used`、`rc_frozen`、`rc_revoked`。

## 3. その他の決定
- Node.js は 22 ではなく **24 LTS**（22 は 2027-04 に保守期間が終わる）。
- リポジトリ構成は `app/`（mobile、extension、server、packages/*、shared）と `platform/`（docker、env、scripts、secrets）。`packages/core` は暗号・レコード・Seal・照合の TypeScript 参照実装で、拡張と開発用 VaultCore が使う。
- expo-router の画面は `app/mobile/src/app/` に置く。
- 新ルート：`/revoked`、`/settings/help`、`/settings/trusted-browsers`、`/settings/server`、`/settings/security-log`、`/settings/backup/csv`。

## 4. 範囲外（変更しない）
パスキー、TOTP、共有、PC での編集、Firefox / Safari、ローカルのみモード（以上 §1.4）、漏えいチェック（§1.2-6 の「第三者に送らない」に反するため）。

## 5. 先送りの案
タグ、端末内だけで行うパスワードの健全性チェック（重複・弱いパスワード）、パスフレーズ生成。

## 6. 実装時の解釈
`@localvault/protocol` を実装するときに曖昧だった点を、厳しい側に倒して決めた。

1. **ID**：すべて小文字の UUID v4（バージョン 4、variant 8/9/a/b）。`prelogin` の偽の `accountId` も同じ形式にすること。
2. **未知のフィールド**：スキーマはすべて strict（余分なキーは拒否）。フィールドの追加は `version` を上げて行う。`LoginData.passwordHistory` だけは任意項目。
3. **base64url**：パディング、`+` `/`、空白、不正な長さ、末尾ビットが 0 でない非正規形をすべて拒否する。長さが決まっている項目はバイト数まで検査する（nonce 12、署名 64、公開鍵 65、`wrappedVK.ct` 48、verifier / authKey / authRC 32、rcId 16、RC 32、指紋 32）。
4. **KDF**：`iterations` は 600,000 以上 10,000,000 以下。salt は 16 バイト。
5. **アカウント名**：3〜32 文字の `[a-z0-9._-]` で、先頭と末尾は英数字。ログイン・`prelogin` の入力は NFKC＋小文字化してから検査する。作成時の送信値は小文字の正規形のみ受け付ける。
6. **管理用署名の PATH**：クエリ文字列を含め、送ったとおりの文字列。本文なしのときの本文ハッシュは空バイト列の SHA-256。
7. **解錠の番号**：`"10"`〜`"99"` の 2 桁文字列。`issuedAt` は秒精度の UTC（`2026-11-11T09:00:00Z`、小数秒なし）。その他の時刻は ISO 8601 UTC（`Z`）で小数秒可。
8. **成功応答**：本文のない操作は 204。`POST /v1/accounts` は 201 と `{}`。`POST /v1/rotations`、`POST /v1/pairings`、`POST /v1/unlock-requests`、`POST /v1/recovery-claims` は 201。ペアリングの `expired` は 200 の本文で返す（HTTP エラーにしない）。
9. **ローテーション**：一時保存に削除の印も含める（`deleted: true`、nonce と ct は null）。`commit` の `keyset.vkVersion` は `newVkVersion` と等しく、`keysetVersion` は現在値 + 1。`recordCount` は一時保存の総件数。`DELETE /v1/rotations/{id}` は承認端末で足りる（管理署名は不要）。1 回の `PUT` は 1〜100 件。
10. **初回の鍵セット**：アカウント作成時は `keysetVersion == 1` かつ `vkVersion == 1`。
11. **サーバー URL**：オリジンのみ（ユーザー情報、パス、クエリ、フラグメントは拒否）。ホストは小文字化し、既定ポートを除く。国際化ドメインは Punycode で入力させる。QR の `s=` には正規化済みの文字列だけを入れ、正規形でないものは拒否する。
12. **`lvkit` の `k=`**：リカバリーキーの表示形式（`LV2-XXXX-…`、ハイフン付き 7 組）をそのまま入れる。
13. **Authorization**：`Bearer` は JWT 形式（3 区間）、`Pairing` と `Claim` は 32 バイトの base64url。
14. **追加した上限**：端末名 1〜64 文字、`androidApps` 20 件、証明書ハッシュ 10 件、ラベル 100 文字、URL 2048 文字、プッシュトークン 4096 文字。`GET /v1/records` の `limit` は 1〜500。
15. **ルート定義の認証区分**：`device` は承認端末・PC どちらでもよいトークン認証。`auth/challenge`・`auth/token`・`prelogin`・`health`・`pairings`（作成）は `none`。
16. **モジュール解決**：内部パッケージの import は拡張子なし（`./limits`）。Node の型除去を直接使う場合は動かないため、サーバーは tsx・vitest・バンドラー経由で実行する。

## サーバー実装で確定した解釈（W2）

クライアント（スマホ、拡張、E2E）は次の挙動を前提に実装する。

| 対象 | 確定した挙動 |
|---|---|
| 取得時の鍵セット | `GET /v1/records` は、`since` が鍵セットの最終変更時の `rev` より小さいとき、および `since=0` のときに `keyset` を返す。鍵セットの変更は `rev` を 1 つ消費するため、`rev` は鍵セット変更をまたぐと連番にならない |
| `fullResync` | `0 < since < min_valid_cursor` のときだけ true。`since=0` では立たない。**クライアントは `fullResync` を受けたら `since=0` から取り直し、その取り直しが `hasMore=false` で終わるまで途中のページの `fullResync` を無視する**（無視しないとループする） |
| `prelogin` | アカウント名は送信前にクライアントが小文字へ正規化する（スキーマが正規形のみ受け付ける）。存在しない名前には反復 600,000 回の偽の値を返す |
| 解錠リクエストの時刻 | `issuedAt` がサーバー時刻の前後 5 分を外れると `E_CLOCK_SKEW`（`details.serverTime` 付き） |
| 管理用の証明 | `X-LV-Admin` があれば必ず検証する（不正でも認証キーへ切り替えない）。`deviceId` はトークンの端末と同じでなければならない。nonce は署名の検証に通った後で消費する |
| ローテーション | `newVkVersion` は現在の `vkVersion + 1`。確定時の ID 集合・件数の不一致は `E_INVALID`（ステージ済みは保持）、版の競合は `E_VERSION_CONFLICT`（ステージ済みは破棄）。確定時に `min_valid_cursor` を旧 `rev + 1` にする |
| 復元要求 | `authRC`・`rcId` の誤りと存在しないアカウントは、区別のつかない同じ 401 を返す。取り消しは進行中の要求をすべて閉じる。復旧コードの再発行も進行中の要求を取り消す |
| 送信時に存在しないレコード | 削除の印が物理削除された後のレコードは、`baseRev` にかかわらず新規として受け付ける |
| 解錠リクエストの取得 | 作成した拡張以外、または別アカウントからの取得は `E_NOT_FOUND` |
| レート制限 | 拒否されたリクエストも回数に数える。全体の 300 回／分は端末 ID 単位 |
| 内部エラー | 想定外の失敗は 500 `E_INTERNAL`（詳細なし。クライアントは再試行可能として扱う） |
| ログ | IP アドレスは記録しない（仕様の「30 日で削除」より厳しい） |
| 監査ログの `deviceId` | その出来事の対象になった端末（追加・解除・要求した端末） |

## VaultCore 契約の追加（W3 の結果を受けて）

参照実装（`@localvault/vault-engine`）と E2E で判明した不足を、`app/packages/core/src/vault-core.ts` に反映した。Swift / Kotlin の実装も同じ形にする。

| 追加・変更 | 理由 |
|---|---|
| `revokeDevice` に `masterPassword?` を追加 | 鍵の更新では新しい鍵セットを包む必要がある。ない場合は `E_NEEDS_MASTER_PASSWORD` |
| `continueRotation(rotationId)`、`confirmRotation({ cursor })`、`abortRotation(rotationId)`、`isRotationPending()` | 確定リクエストの管理用署名がサーバー発行の `rotationId` を含むパスに掛かるため、`revokeDevice` だけでは一連のリクエストを返せない |
| `applyPulled` に `hasMore?` を追加 | 全件取り直しの最終ページを VaultCore が知り、サーバーにないレコードの削除をそこで行うため |
| `VaultNotice` 型、`drainNotices()`、イベント `onNotice` | §7.4 の「利用者に通知する」を画面へ届ける手段がなかった |
| `buildRecoverRequest` は直前の `deriveAuthKey` に依存する | `accountId` を引数に持たないため。呼び出し順を守る |

自動ロックのための前面・背面の通知（`onForeground` / `onBackground`）は契約に入れない。ネイティブ実装はアプリのライフサイクルを自分で監視する（§5.8）。開発用コアだけが、アクセス層から呼ばれる。
