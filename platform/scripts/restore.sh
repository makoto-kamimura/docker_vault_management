#!/usr/bin/env bash
# 使い方: restore.sh <dump ファイル> [dev|prod] [--yes]
#   ダンプを db コンテナへ pg_restore --clean --if-exists で復元します（既存データは置き換わります）。
#   .enc（暗号化）ファイルは先に復号してください:
#     openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in X.dump.enc -out X.dump -pass file:<passphrase>
set -euo pipefail
. "$(dirname "$0")/_common.sh"
YES=0; ARGS=""
for a in "$@"; do case "$a" in --yes) YES=1;; -h|--help) sed -n '2,6p' "$0"; exit 0;; *) ARGS="$ARGS $a";; esac; done
# shellcheck disable=SC2086
set -- $ARGS
[ $# -ge 1 ] || { sed -n '2,3p' "$0"; exit 2; }
DUMP="$1"; E="${2:-prod}"
[ -f "$DUMP" ] || { echo "ファイルが見つかりません: $DUMP" >&2; exit 1; }
case "$DUMP" in *.enc) echo "暗号化ファイルです。先に復号してください。" >&2; exit 1;; esac
if [ "$YES" != 1 ]; then
  printf '%s 環境の DB を %s で置き換えます。続けますか？ [y/N] ' "$E" "$DUMP"
  read -r ans; case "$ans" in y|Y|yes) ;; *) echo "中止しました"; exit 1;; esac
fi
dc "$E" up -d --wait db
dc "$E" exec -T db sh -c 'PGPASSWORD="${POSTGRES_PASSWORD:-$(cat /run/secrets/db_password)}" pg_restore -h 127.0.0.1 -U localvault -d localvault --clean --if-exists --no-owner' < "$DUMP"
echo "復元しました。app を再起動してください: docker compose … restart app"
