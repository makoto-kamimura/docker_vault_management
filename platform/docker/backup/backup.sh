#!/bin/bash
# LocalVault 日次バックアップ（postgres:16 イメージ上で動かす。cron は不要）。
#   BACKUP_HOUR_UTC  実行時刻（UTC の時、既定 18）
#   BACKUP_KEEP_DAYS 保持日数（既定 14）
#   BACKUP_ON_START  1 なら起動直後に一度実行
#   BACKUP_ONCE      1 なら一度だけ実行して終了（backup-now.sh 用）
# /run/secrets/backup_passphrase が空でなければ openssl で暗号化する（.dump.enc）。
set -euo pipefail

: "${PGHOST:=db}"
: "${PGUSER:=localvault}"
: "${PGDATABASE:=localvault}"
: "${BACKUP_DIR:=/backups}"
: "${BACKUP_HOUR_UTC:=18}"
: "${BACKUP_KEEP_DAYS:=14}"
: "${BACKUP_ON_START:=0}"
: "${BACKUP_ONCE:=0}"
export PGHOST PGUSER PGDATABASE

PGPASSWORD="$(cat /run/secrets/db_password)"
export PGPASSWORD

log() { printf '%s backup: %s\n' "$(date -u +%FT%TZ)" "$*"; }

run_backup() {
  local ts base tmp
  ts="$(date -u +%Y%m%d-%H%M%S)"
  base="${BACKUP_DIR}/localvault-${ts}.dump"
  tmp="${base}.partial"
  umask 077
  if [ -s /run/secrets/backup_passphrase ]; then
    if ! { pg_dump --format=custom --no-owner \
        | openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt \
            -pass file:/run/secrets/backup_passphrase > "$tmp"; }; then
      rm -f "$tmp"; log "FAILED"; return 1
    fi
    mv "$tmp" "${base}.enc"; log "wrote ${base}.enc"
  else
    if ! pg_dump --format=custom --no-owner --file="$tmp"; then
      rm -f "$tmp"; log "FAILED"; return 1
    fi
    mv "$tmp" "$base"; log "wrote ${base}"
  fi
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'localvault-*.dump*' \
    -mtime "+$((BACKUP_KEEP_DAYS - 1))" -print -delete | sed 's/^/backup: pruned /'
}

seconds_until_next() {
  local now target
  now="$(date -u +%s)"
  target="$(date -u -d "today ${BACKUP_HOUR_UTC}:00:00" +%s)"
  [ "$target" -le "$now" ] && target=$((target + 86400))
  echo $((target - now))
}

if [ "$BACKUP_ONCE" = 1 ]; then run_backup; exit $?; fi
if [ "$BACKUP_ON_START" = 1 ]; then run_backup; fi
while true; do
  wait_s="$(seconds_until_next)"
  log "next run in ${wait_s}s (${BACKUP_HOUR_UTC}:00 UTC)"
  sleep "$wait_s"
  run_backup
done
