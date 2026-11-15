# @localvault/mobile

LocalVault 本体アプリ（Expo SDK 58 / React Native 0.88、New Architecture、expo-router、TypeScript strict）。
仕様 §14 の全画面（初期設定、ロック解除、項目、パスワード生成、ゴミ箱、PC の承認、端末、設定、アカウント、
復旧コード、バックアップ、CSV 取り込み、セキュリティ履歴、ヘルプ）を実装済みです。
VaultCore の iOS ネイティブ実装は `modules/vault-kit`（純 Swift の VaultKit：暗号・保存・同期のエンジン）と
`modules/vault-core`（Expo モジュール `LocalVaultCore`：Keychain、Face ID、クリップボード、ライフサイクル）にあります。
ネイティブモジュールがあればそれを使い、なければ開発ビルドに限って開発用コア（下記）で動きます。Android（Kotlin）は未実装です。
自分の iPhone に入れる手順は [runbook の第 13 章](../../docs/runbook.md#13-iphone-にアプリを入れる無料の-apple-id) を参照してください。

VaultKit のテスト（crypto-vectors、TS 参照実装との差分テスト、エンジンのシナリオ）：

```sh
pnpm --filter @localvault/mobile test:native     # swift test（シミュレーター不要）
pnpm --filter @localvault/mobile parity:core     # 差分テストの fixture を TS から再生成
```

## 動かし方

```sh
pnpm install                 # リポジトリのルートで
pnpm --filter @localvault/mobile typecheck
pnpm --filter @localvault/mobile test
cd app/mobile
npx expo-doctor
npx expo export --platform ios         # バンドルの確認
npx expo prebuild --platform ios --clean
EXPO_PUBLIC_LV_FAKE_CORE=1 npx expo run:ios   # シミュレーターで画面だけ確認（サーバー不要）
```

Android のビルドは対象外です（JDK / Android SDK 前提）。ネイティブの VaultCore モジュール（Swift / Kotlin）は未実装です。

## 環境フラグ（開発ビルドのみ有効）

| 変数                         | 意味                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `EXPO_PUBLIC_LV_FAKE_CORE=1` | メモリ上の `FakeVaultCore` と簡易ダミーサーバーを使う。画面確認用（暗号は行わない）                        |
| `EXPO_PUBLIC_LV_DEV_CORE=1`  | 開発用 VaultCore（`native/dev/createDevVaultCore.ts`。`@localvault/vault-engine` を noble 実装で動かす。鍵の保管は安全ではない開発用の模擬） |

`VaultCore` の解決順（`src/native/VaultCore.ts`）：ネイティブモジュール `LocalVaultCore` → 上記フラグ（`__DEV__` のみ）→ エラー。
`http://localhost` などは開発ビルド（`__DEV__`）に限り受け付けます（§5.11 / G11）。本番は https のみ。

## 構成

```
index.ts                 エントリ。src/polyfills.ts（getRandomValues を expo-crypto から注入）を最初に読む
app.config.ts            §16.1。未実装のネイティブ側プラグインは TODO コメント
src/app/                 expo-router のルート（薄く保つ）
  (setup)/setup/*        初期設定
  (locked)/unlock, revoked
  (app)/                 ロック解除後。いまは index（一覧のプレースホルダー）だけ
src/features/<name>/     画面ロジックと機能別コンポーネント（setup, unlock, home, session, navigation, errors）
src/components/          UI キット（index.ts から import）
src/theme/               ThemeProvider / useTheme / makeStyles / useReduceMotion
src/i18n/                ja.ts（型付き辞書）と t()
src/api/                 型付き API クライアント（protocol の routes から検証）、トークン管理、サーバー URL の規則
src/sync/engine.ts       §15 syncOnce と §7.8 のトリガー（純 TypeScript、テスト済み）
src/state/               zustand（ロック状態、同期状態、承認待ち件数、トースト、初期設定の下書き）
src/native/              VaultCore のアクセス点、fake/、dev/、privacy.ts（画面保護のフック位置）
test/                    vitest（API、同期、ガード、フロー、リカバリーキー入力など）
```

## 画面の置き場所

- 項目：`src/app/(app)/item/...`、`generator.tsx`、`trash.tsx`、一覧は `src/app/(app)/index.tsx`。ロジックは `src/features/{items,generator,trash}/`。
- PC の承認と復元要求：`src/app/(app)/approve/[requestId].tsx`（ガードはロック中でも通す）、`recovery-claim/[id].tsx`。ロジックは `src/features/approvals/`。
- 端末：`src/app/(app)/devices/...`、ロジックは `src/features/devices/`（鍵の更新を伴う解除と再開を含む）。
- 設定：`src/app/(app)/settings/...`、ロジックは `src/features/{settings,account,recovery-code,backup,security-log,help}/`。
- 同期状態は `useSyncStore`、同期は `useSession().engine`。
- 文言は必ず `src/i18n/` の辞書に追加し、`t()` で使う。
- 開発用コアや偽のコアを読み込む条件は、`src/native/VaultCore.ts` の `__DEV__ && process.env.…` のリテラル比較のままにする。定数に置き換えると本番バンドルに混入する。
- 通知タップのディープリンクは `pushTargetRoute()`（`@localvault/protocol`）で解決する。
