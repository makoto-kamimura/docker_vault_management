#!/usr/bin/env bash
# 使い方: backup-now.sh [dev|prod]   （既定: prod）
#   今すぐ pg_dump を取り、platform/backups/ に保存します。
set -euo pipefail
. "$(dirname "$0")/_common.sh"
case "${1:-}" in -h|--help) sed -n '2,3p' "$0"; exit 0;; esac
E="${1:-prod}"
mkdir -p "$PLATFORM_DIR/backups"
if [ "$E" = prod ]; then
  dc prod run --rm -T -e BACKUP_ONCE=1 backup
else
  # 開発環境には backup サービスが無いので一時コンテナで実行する
  tmp="$(mktemp -d)"; printf 'localvault' > "$tmp/pw"
  docker run --rm --network localvault-dev_default \
    -v "$tmp/pw:/run/secrets/db_password:ro" \
    -v "$PLATFORM_DIR/docker/backup/backup.sh:/backup/backup.sh:ro" \
    -v "$PLATFORM_DIR/backups:/backups" \
    -e BACKUP_ONCE=1 --entrypoint /bin/bash postgres:16 /backup/backup.sh
  rm -rf "$tmp"
fi
ls -1t "$PLATFORM_DIR/backups" | head -1
