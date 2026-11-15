#!/usr/bin/env bash
# 使い方: init-secrets.sh
#   platform/secrets/ に db_password, database_url, token_secret, prelogin_secret を作成し、
#   platform/env/.env が無ければ .env.example から作ります。既存ファイルは上書きしません。
set -euo pipefail
. "$(dirname "$0")/_common.sh"
case "${1:-}" in -h|--help) sed -n '2,4p' "$0"; exit 0;; esac

S="$PLATFORM_DIR/secrets"
mkdir -p "$S"
umask 077

make() { # make <name> <value>
  if [ -e "$S/$1" ]; then echo "既にあります（そのまま）: secrets/$1"; return; fi
  printf '%s' "$2" > "$S/$1"; chmod 600 "$S/$1"; echo "作成: secrets/$1"
}

if [ -e "$S/db_password" ]; then
  DBPW="$(cat "$S/db_password")"
else
  DBPW="$(openssl rand -hex 24)"
fi
make db_password "$DBPW"
make database_url "postgres://localvault:${DBPW}@db:5432/localvault"
make token_secret "$(openssl rand -base64 48 | tr -d '\n')"
make prelogin_secret "$(openssl rand -base64 48 | tr -d '\n')"

ENVF="$PLATFORM_DIR/env/.env"
if [ ! -e "$ENVF" ]; then
  cp "$PLATFORM_DIR/env/.env.example" "$ENVF"; chmod 600 "$ENVF"
  sed -i.bak "s/^LV_UID=.*/LV_UID=$(id -u)/; s/^LV_GID=.*/LV_GID=$(id -g)/" "$ENVF" && rm -f "$ENVF.bak"
  echo "作成: env/.env（LV_DOMAIN と PUBLIC_ORIGIN を編集してください）"
else
  echo "既にあります（そのまま）: env/.env"
fi
