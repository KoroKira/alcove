#!/usr/bin/env bash
# Start the authenticated server stack after its first installation.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${ALCOVE_ENV_FILE:-$PROJECT_DIR/.env}"
COMPOSE_FILE="${ALCOVE_COMPOSE_FILE:-$PROJECT_DIR/docker-compose.codicam.yml}"
[ -r "$ENV_FILE" ] || { printf '%s\n' 'Configure .env and run scripts/setup.sh first. See SETUP.md.' >&2; exit 1; }
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
COMPOSE_PROJECT="${ALCOVE_COMPOSE_PROJECT:-${COMPOSE_PROJECT_NAME:-alcove}}"
compose() { docker compose --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" "$@"; }
compose config --quiet
compose up -d
for ((attempt=0; attempt<60; attempt++)); do
  if curl --fail --silent --max-time 3 "http://127.0.0.1:${APP_PORT:-8000}/api/app/config" >/dev/null; then
    printf 'Alcove responds at %s\n' "${FRONTEND_URL:?Set FRONTEND_URL}"
    exit 0
  fi
  sleep 2
done
printf '%s\n' 'Alcove did not become ready. Inspect the pad and database logs; no data was removed.' >&2
exit 1
