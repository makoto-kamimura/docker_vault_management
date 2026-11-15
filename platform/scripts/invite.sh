#!/usr/bin/env bash
# 使い方: invite.sh [dev|prod] create [--expires-in 7d] | list | revoke <id>
#   例: invite.sh prod create --expires-in 7d
#       invite.sh dev list
set -euo pipefail
case "${1:-}" in -h|--help|"") sed -n '2,4p' "$0"; exit 0;; esac
E=prod
case "$1" in dev|prod) E="$1"; shift;; esac
exec "$(dirname "$0")/cli.sh" "$E" invite "$@"
