#!/usr/bin/env bash
# 使い方: cli.sh [dev|prod] <サーバー CLI の引数…>
#   例: cli.sh prod account list / cli.sh dev stats / cli.sh prod account delete <名前> --yes
#   招待コードは invite.sh を使う（cli.sh prod invite create と同じ）
set -euo pipefail
. "$(dirname "$0")/_common.sh"
case "${1:-}" in -h|--help|"") sed -n '2,4p' "$0"; exit 0;; esac
E=prod
case "$1" in dev|prod) E="$1"; shift;; esac
dc "$E" run --rm -T app dist/cli.js "$@"
