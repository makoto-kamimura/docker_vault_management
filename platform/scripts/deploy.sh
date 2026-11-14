#!/usr/bin/env bash
# 使い方: deploy.sh [--branch <名前>] [--no-pull] [--skip-backup]
#   本番（VPS）で Git の最新版を取り込み、バックアップ → ビルド → マイグレーション → 起動 → ヘルスチェックを行います。
#   --branch <名前>  取り込むブランチ（既定: main）
#   --no-pull        git pull をせず、いまのチェックアウトのまま配置する
#   --skip-backup    事前のバックアップを省く（初回は自動で省きます）
set -euo pipefail
. "$(dirname "$0")/_common.sh"

BRANCH=main
PULL=1
BACKUP=1

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\n中止: %s\n' "$*" >&2; exit 1; }

env_value() { # env_value <KEY>: platform/env/.env から値を読む（最後の定義を使う）
  sed -n "s/^$1=//p" "$PLATFORM_DIR/env/.env" | tail -1 | tr -d '"'"'"
}

preflight() {
  command -v docker >/dev/null || die "docker がありません"
  docker compose version >/dev/null 2>&1 || die "docker compose（v2）がありません"
  command -v curl >/dev/null || die "curl がありません"
  [ -f "$PLATFORM_DIR/env/.env" ] || die "platform/env/.env がありません。先に platform/scripts/init-secrets.sh を実行してください"
  for s in db_password database_url token_secret prelogin_secret; do
    [ -s "$PLATFORM_DIR/secrets/$s" ] || die "platform/secrets/$s がありません。platform/scripts/init-secrets.sh を実行してください"
  done
  LV_DOMAIN="$(env_value LV_DOMAIN)"
  [ -n "$LV_DOMAIN" ] && [ "$LV_DOMAIN" != "vault.example.net" ] \
    || die "platform/env/.env の LV_DOMAIN を設定してください"
  [ "$(env_value PUBLIC_ORIGIN)" = "https://$LV_DOMAIN" ] \
    || die "platform/env/.env の PUBLIC_ORIGIN を https://$LV_DOMAIN にしてください"
}

pull() {
  cd "$REPO_ROOT"
  [ -z "$(git status --porcelain)" ] \
    || die "作業ツリーに未コミットの変更があります（git status で確認してください）"
  say "Git の更新を取り込みます（${BRANCH}）"
  local before after
  before="$(git rev-parse HEAD)"
  git fetch --prune origin || die "git fetch に失敗しました（ネットワークと origin の設定を確認してください）"
  if [ "$(git rev-parse --abbrev-ref HEAD)" != "$BRANCH" ]; then
    git switch "$BRANCH" || die "ブランチ ${BRANCH} に切り替えられません"
  fi
  git pull --ff-only origin "$BRANCH" \
    || die "早送りで取り込めません。VPS 側にだけあるコミットがないか確認してください（git log origin/${BRANCH}..HEAD）"
  after="$(git rev-parse HEAD)"
  if [ "$before" != "$after" ]; then
    echo "更新: ${before:0:7} → ${after:0:7}"
    # このスクリプト自体が更新された場合に備え、新しい版で続きを実行する
    exec "$0" --no-pull ${PASS_ARGS[@]+"${PASS_ARGS[@]}"}
  else
    echo "更新はありません（${after:0:7}）"
  fi
}

backup() {
  if [ "$BACKUP" = 0 ]; then echo "バックアップを省きます（--skip-backup）"; return; fi
  if [ -z "$(dc prod ps --status running -q db 2>/dev/null)" ]; then
    echo "DB がまだ動いていないため、バックアップを省きます（初回の配置）"
    return
  fi
  say "事前のバックアップを取ります"
  "$PLATFORM_DIR/scripts/backup-now.sh" prod
}

health() {
  say "ヘルスチェック: https://$LV_DOMAIN/v1/health"
  local i body
  # 初回は証明書の取得に時間がかかるため、最大およそ 3 分待つ
  for i in $(seq 1 36); do
    if body="$(curl -fsS --max-time 5 "https://$LV_DOMAIN/v1/health" 2>/dev/null)"; then
      echo "OK: $body"
      return 0
    fi
    sleep 5
  done
  dc prod ps
  die "ヘルスチェックに失敗しました。ログ: docker compose -f platform/docker/compose.yml --env-file platform/env/.env logs --tail=100 app caddy"
}

main() {
  PASS_ARGS=()
  while [ $# -gt 0 ]; do
    case "$1" in
      -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
      --branch) [ $# -ge 2 ] || die "--branch には名前が必要です"; BRANCH="$2"; PASS_ARGS+=(--branch "$2"); shift 2 ;;
      --no-pull) PULL=0; shift ;;
      --skip-backup) BACKUP=0; PASS_ARGS+=(--skip-backup); shift ;;
      *) die "不明なオプション: $1（-h で使い方）" ;;
    esac
  done

  preflight
  if [ "$PULL" = 1 ]; then pull; fi
  backup
  say "イメージをビルドします"
  dc prod build app
  say "DB マイグレーションを適用します"
  "$PLATFORM_DIR/scripts/migrate.sh" prod
  say "起動します"
  dc prod up -d --wait --remove-orphans
  health
  say "配置が完了しました（$(cd "$REPO_ROOT" && git rev-parse --short HEAD)）"
}

# ファイル全体を読み込んでから実行する（実行中に git pull で書き換わっても安全にするため）
main "$@"
