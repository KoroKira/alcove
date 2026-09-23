#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
COMPOSE_FILE="$ROOT_DIR/docker-compose.test.yml"

command -v docker >/dev/null 2>&1 || {
  echo "Docker is required for the local integration suite" >&2
  exit 1
}

docker compose -f "$COMPOSE_FILE" up -d --wait
cleanup() {
  docker compose -f "$COMPOSE_FILE" down --remove-orphans
}
trap cleanup EXIT INT TERM

export POSTGRES_USER=postgres
export POSTGRES_PASSWORD=postgres
export POSTGRES_HOST=127.0.0.1
export POSTGRES_PORT=55432
export POSTGRES_DB=alcove_test
export REDIS_HOST=127.0.0.1
export REDIS_PORT=56379
export REDIS_PASSWORD=
export DB_BOOTSTRAP_FRESH=true
export PYTHONPATH=.

"$ROOT_DIR/scripts/db-migrate.sh"
export TEST_DATABASE_URL=postgresql+asyncpg://postgres:postgres@127.0.0.1:55432/alcove_test
export TEST_REDIS_URL=redis://127.0.0.1:56379/15

cd "$ROOT_DIR/src/backend"
python -m pytest tests/ -m integration -v
