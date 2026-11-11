#!/usr/bin/env bash
# 使い方: invite.sh [dev|prod] <cli 引数…>
#   例: invite.sh prod invite create --expires-in 7d
#       invite.sh prod invite list / invite.sh dev account list / stats
set -euo pipefail
. "$(dirname "$0")/_common.sh"
case "${1:-}" in -h|--help|"") sed -n '2,4p' "$0"; exit 0;; esac
E=prod
case "$1" in dev|prod) E="$1"; shift;; esac
dc "$E" run --rm -T app dist/cli.js "$@"
