# @localvault/crypto-vectors

iOS（XCTest）・Android（JUnit）・拡張（Vitest）が同じ暗号結果になることを確認するための固定テストベクタです（仕様 §17.1）。
`vectors/*.json` はコミット済みで、`pnpm --filter @localvault/crypto-vectors generate` で決定的に再生成できます（再実行しても差分は出ません）。

## 共通の約束

- バイト列の表記：ファイル名が `*Hex` で終わる項目は小文字 16 進。`nonce`、`ct`、`salt`、`epk`、署名、公開鍵などワイヤー形式の項目は base64url（パディングなし）で、仕様どおりの値そのものです。
- 公開鍵は SEC1 非圧縮 65 バイト、秘密鍵は 32 バイトのスカラー、署名は r‖s の 64 バイト（IEEE P1363）。
- AES-256-GCM の出力は「暗号文‖タグ（16 バイト）」。AAD は UTF-8 文字列です。
- `negative` 配列は、すべて**失敗しなければならない**ケースです。失敗の種類は復号失敗（認証タグ不一致）で、中身を区別して返してはいけません。
- 乱数（nonce、一時鍵、塩）は各ベクタに固定値が入っています。実装側は「この乱数を使ったときに同じ出力になること」を確認してください。
- ECDSA 署名は乱数を含むため、署名の**検証のみ**を確認します（RFC 6979 で作った署名を収録。`signatureHighS` は high-S 版で、これも検証に成功しなければなりません）。

## ファイル

| ファイル                   | 内容                                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `primitives.json`          | SHA-256、HMAC、HKDF、PBKDF2（低反復）、AES-GCM、ECDH、ECDSA 検証。`ecdsaVerify.invalid*` は検証が `false` になるべき入力（桁数違い、DER、ゼロ署名、曲線上にない点、圧縮形式）                                                                                                                                                                 |
| `kdf.json`                 | §5.4。`cases[]`: `masterPasswordUtf8`、`accountId`、`recoveryKeyHex`（16 バイト）、`kdf`（反復 600,000）、`expected`（`pbkdf2Hex`、`ikmHex` = p‖SK、`kekHex`、`authKeyHex`、`verifier`）。HKDF の salt は accountId の UUID 16 バイト。パスワードは NFKC、前後の空白は削らない（`nfkc-no-trim`）                                              |
| `wrapped-vk.json`          | `kekHex`、`vkHex`、`accountId`、`keysetVersion`、`aad`、`nonceHex` → `wrappedVK`。`negative[]` は AAD 違い、タグ・暗号文・nonce の 1 ビット改ざん                                                                                                                                                                                             |
| `records.json`             | §6.2。`vkHex`、`accountId`、`cases[]`（`plain` = 暗号化前のレコード、`nonceHex`、`aad`、`jsonByteLength`、`paddedByteLength`、`encrypted`）。平文は `JSON.stringify(plain)`（キー順は記載のとおり）を 0x20 で 256 バイトの倍数にそろえたもの。`negative[]` はタグ改ざん、暗号文改ざん、vkVersion 違い、レコード ID の入れ替え、accountId 違い |
| `record-padding.json`      | notes の長さごとの JSON 長・パディング後の長さ・暗号文長（= パディング後 + 16）                                                                                                                                                                                                                                                               |
| `seal.json`                | §8.5。`recipientPrivateKeyHex` / `recipientPublicKeyHex`、`cases[]`（`ctx`、送信側の一時鍵 `senderPrivateKeyHex` / `senderPublicKeyHex`、`nonceHex`、`plaintext`、`intermediates` = ECDH の X 座標・HKDF の salt（SHA-256(S‖R)）・鍵、`envelope` = `{epk, nonce, ct}`）。`negative[]` は文脈違い、改ざん、別の受信鍵                          |
| `signed-strings.json`      | 署名対象文字列（`text`、改行は LF、末尾改行なし）と、その検証に成功する `signature` / `signatureHighS`、失敗する `tamperedSignature`。`items` は認証チャレンジ、解錠リクエスト、管理用署名（本文あり・なし）。`adminHeader.value` は `X-LV-Admin` ヘッダーの完全な値                                                                          |
| `pairing-fingerprint.json` | §8.3。`base64url(SHA-256(signPub‖ephPub))`。`negative[]` は順序を入れ替えた入力（指紋が一致してはならない）                                                                                                                                                                                                                                   |
| `recovery-key.json`        | §5.5。`cases[]`（`skHex` ↔ `text`、`checkChars`）、`lenientValid[]`（大文字小文字・ハイフン・空白・I/L→1・O→0 を許す読み取り）、`invalid[]`（`E_INVALID_RECOVERY_KEY` になるべき入力）                                                                                                                                                        |
| `recovery-code.json`       | §8.11。`textCases[]`（`rcHex` ↔ `text`、52 + 検査 2 文字）、`lenientValid[]`、`invalid[]`、`derivation`（`rcId`・`kekRC`・`authRC`、AAD、wrappedVK、verifier）、`negative[]`                                                                                                                                                                  |
| `export-file.json`         | §6.5。`exportPasswordUtf8`、乱数の消費順（塩、ファイル鍵、wrappedKey の nonce、payload の nonce）、`payload`、`file`（`.lvbackup` の内容そのもの）、`negative[]`（`expectedError`: 誤ったパスワードは `E_WRONG_PASSWORD`、payload 改ざんは `E_IMPORT_FORMAT`）                                                                                |

## テスト

- `test/vectors.test.ts`：`@localvault/core` の WebCrypto 実装と noble 実装の両方が、すべてのベクタを再現することを確認します。
- `test/independent.test.ts`：`node:crypto` だけで（`@localvault/*` を使わずに）同じ期待値を再計算します。2 つの実装が仕様を同じように読み違えていないかを確かめるためのものです。
