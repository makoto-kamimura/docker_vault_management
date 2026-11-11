# shellcheck shell=sh
# 共通処理。他のスクリプトから source される。
PLATFORM_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$PLATFORM_DIR/.." && pwd)"
COMPOSE_PROD="$PLATFORM_DIR/docker/compose.yml"
COMPOSE_DEV="$PLATFORM_DIR/docker/compose.dev.yml"

# compose の呼び出しを組み立てる: dc <dev|prod> <args...>
dc() {
  _env="$1"; shift
  case "$_env" in
    dev) docker compose -f "$COMPOSE_DEV" "$@" ;;
    prod) docker compose -f "$COMPOSE_PROD" --env-file "$PLATFORM_DIR/env/.env" "$@" ;;
    *) echo "環境は dev か prod を指定してください: $_env" >&2; exit 2 ;;
  esac
}
