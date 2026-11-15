# @localvault/extension（ブラウザ拡張、Manifest V3）

Chromium 116 以上（Chrome / Edge / Brave）向けの LocalVault 拡張です。PC 側は読み取り専用で、項目の追加・編集・削除はできません。
仕様は `docs/spec.md` の §1.3 D、§2.7、§8.3〜§8.5、§9.4、§12 を参照してください。

## 構成

| ディレクトリ                 | 内容                                                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/core/`                  | プラットフォームに依存しないロジック（API、ペアリング、解錠、セッション、同期、照合）。ストレージ・fetch・時計・端末鍵は注入 |
| `src/background/`            | Service Worker（メッセージ検証、アラーム、idle）。モジュールレベルの状態を持たない                                           |
| `src/content/`               | フォーム検出、アイコン、候補リスト、解錠待ちパネル（closed Shadow DOM）、入力                                                |
| `src/popup/`, `src/options/` | React 製の画面                                                                                                               |
| `src/offscreen/`             | クリップボードの消去                                                                                                         |
| `src/i18n/ja.ts`             | 画面の文言                                                                                                                   |
| `test-pages/`                | 手動確認用の静的ページ                                                                                                       |

## 開発

```sh
pnpm install                                  # リポジトリのルートで
pnpm --filter @localvault/extension test      # 単体・結合テスト（ビルドも実行して manifest を検査）
pnpm --filter @localvault/extension typecheck
pnpm --filter @localvault/extension build     # → app/extension/.output/chrome-mv3
pnpm --filter @localvault/extension check:manifest
```

### ブラウザに読み込む

1. `pnpm --filter @localvault/extension build`
2. Chrome で `chrome://extensions` を開き、「デベロッパーモード」を有効にする
3. 「パッケージ化されていない拡張機能を読み込む」で `app/extension/.output/chrome-mv3` を選ぶ
4. 拡張のアイコン →「設定を開く」でサーバー URL を入力し、「ペアリングを開始」。表示された QR をスマホの LocalVault で読み取って承認する

### 開発サーバー（http://localhost を使うとき）

`LV_DEV_ALLOW_HTTP=1` は**開発ビルド専用**のコンパイル時フラグで、`http://localhost`、`http://127.0.0.1` のサーバー URL を許可します（G11）。このフラグを付けたビルドは配布しないでください。

```sh
pnpm --filter @localvault/extension dev:http         # 開発モード
pnpm --filter @localvault/extension build:dev        # .output-dev に出力
```

製品ビルドは `https://` のみを受け付け、`console.*` を取り除きます。

## テストページ

```sh
python3 -m http.server 8000 --directory app/extension/test-pages
```

`http://localhost:8000/` を開きます。通常のフォーム、別オリジン iframe（`127.0.0.1`）のフォーム、隠し欄のわな、2 段階ログインがあります。
http のページなので、アイコンを押すと警告 → 確認 → 検索の流れになります（自動候補は https のみ）。https での確認は Caddy 経由（`platform/docker/compose.dev.yml`）などで行ってください。

確認する点：

- ページを開いただけでは何も入力されない
- 隠し欄（`trap-*`）は空のまま
- iframe のフォームには「127.0.0.1 のフォーム」と表示され、トップページのドメインでは照合されない
- キーボードだけで操作できる（入力欄で Alt+↓ → 候補を矢印で選ぶ → Enter、Esc で閉じる）

## セキュリティ上の約束

- VK と復号済みの索引は `chrome.storage.session` にだけ置く。パスワードは索引に入れず、入力・コピーのたびに 1 件だけ復号する
- 端末署名鍵は `extractable: false` の `CryptoKey` として IndexedDB に置く
- 照合は Service Worker が受け取る `MessageSender.origin` と `frameId` だけで行う
- 権限は `storage, unlimitedStorage, alarms, idle, offscreen` のみ。サーバーのオリジンは設定時に `optional_host_permissions` として要求する
