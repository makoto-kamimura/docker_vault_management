#!/usr/bin/env bash
# 使い方: migrate.sh [dev|prod]   （既定: prod）
#   DB マイグレーションを適用します。
set -euo pipefail
. "$(dirname "$0")/_common.sh"
case "${1:-}" in -h|--help) sed -n '2,3p' "$0"; exit 0;; esac
E="${1:-prod}"
dc "$E" run --rm --no-deps -T app dist/cli.js migrate 2>&1 || {
  # --no-deps だと DB が起きていない可能性があるため、起動してから再試行
  dc "$E" up -d --wait db
  dc "$E" run --rm -T app dist/cli.js migrate
}
