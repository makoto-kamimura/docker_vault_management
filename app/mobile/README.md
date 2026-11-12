# @localvault/mobile

LocalVault 本体アプリ（Expo SDK 58 / React Native 0.88、New Architecture、expo-router、TypeScript strict）。
この版（W3c）は土台です：デザインシステム、ナビゲーションとガード、i18n、状態、API クライアント、同期エンジン、
VaultCore へのアクセス層、初期設定とロック解除の画面まで。項目・端末・設定・復旧コードの画面は次のウェーブで追加します。

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
| `EXPO_PUBLIC_LV_DEV_CORE=1`  | 開発用 VaultCore（`native/dev/createDevVaultCore.ts`、次のウェーブで `@localvault/vault-engine` につなぐ） |

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

## 次のウェーブでの追加場所

- 項目の画面：`src/app/(app)/item/...`、`generator.tsx`、`trash.tsx`。ロジックは `src/features/items/`。
- 端末・PC の承認：`src/app/(app)/devices/...`、`src/app/(app)/approve/[requestId].tsx`（ガードはロック中でも通す）、
  `src/app/(app)/recovery-claim/[id].tsx`。ロジックは `src/features/devices/`。
- 設定：`src/app/(app)/settings/...`、ロジックは `src/features/settings/`。
- 一覧：`src/features/home/HomeScreen.tsx` を置き換える。同期状態は `useSyncStore`、同期は `useSession().engine`。
- 文言は必ず `src/i18n/ja.ts` に追加し、`t()` で使う。
- 通知タップのディープリンクは `pushTargetRoute()`（`@localvault/protocol`）で解決する。
