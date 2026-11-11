#!/usr/bin/env bash
# 使い方: export-dev-ca.sh
#   開発用 Caddy の内部ルート CA を platform/secrets/dev-root-ca.crt に書き出します。
set -euo pipefail
. "$(dirname "$0")/_common.sh"
case "${1:-}" in -h|--help) sed -n '2,3p' "$0"; exit 0;; esac
OUT="$PLATFORM_DIR/secrets/dev-root-ca.crt"
mkdir -p "$PLATFORM_DIR/secrets"
docker run --rm -v localvault-dev-caddy-data:/data:ro caddy:2 \
  cat /data/caddy/pki/authorities/local/root.crt > "$OUT" \
  || { rm -f "$OUT"; echo "取得できません。先に開発スタックを起動し、https://localhost:8443 へ一度アクセスしてください。" >&2; exit 1; }
echo "書き出しました: $OUT"
cat <<MSG
信頼させる方法:
  iOS シミュレーター: xcrun simctl keychain booted add-root-cert "$OUT"
  macOS キーチェーン: sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "$OUT"
  Chrome (Linux/Win): 設定 > プライバシーとセキュリティ > 証明書の管理 から認証局としてインポート
MSG
