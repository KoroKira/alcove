#!/bin/sh
set -eu

# Run from cron on codicam-server. The compose project must already be running.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=${ALCOVE_PROJECT_DIR:-"$(dirname -- "$SCRIPT_DIR")"}
ENV_FILE=${ALCOVE_ENV_FILE:-"$PROJECT_DIR/.env"}
COMPOSE_FILE=${ALCOVE_COMPOSE_FILE:-"$PROJECT_DIR/docker-compose.codicam.yml"}

if [ ! -r "$ENV_FILE" ]; then
  echo "Environment file not readable: $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

BACKUP_ROOT=${BACKUP_DIR:?BACKUP_DIR must be set}
DATA_ROOT=${DATA_DIR:?DATA_DIR must be set}
KEEP_DAYS=${BACKUP_KEEP_DAYS:-14}
case "$BACKUP_ROOT" in
  /|/home|/srv|"") echo "Refusing unsafe BACKUP_DIR: $BACKUP_ROOT" >&2; exit 1 ;;
esac
STAMP=$(date -u +%Y-%m-%dT%H%M%SZ)
FINAL_DIR="$BACKUP_ROOT/$STAMP"
WORK_DIR="$BACKUP_ROOT/.incomplete-$STAMP-$$"

umask 077
mkdir -p "$BACKUP_ROOT" "$WORK_DIR"
cleanup() { rm -rf -- "$WORK_DIR"; }
trap cleanup EXIT INT TERM

compose() {
  docker compose --env-file "$ENV_FILE" -p alcove-next -f "$COMPOSE_FILE" "$@"
}

compose exec -T postgres pg_dump \
  --format=custom --no-owner --no-acl \
  --username "${POSTGRES_USER:-pad}" "${POSTGRES_DB:-pad}" > "$WORK_DIR/alcove.dump"
compose exec -T keycloak-postgres pg_dump \
  --format=custom --no-owner --no-acl \
  --username "${KEYCLOAK_DB_USER:-keycloak}" "${KEYCLOAK_DB_NAME:-keycloak}" > "$WORK_DIR/keycloak.dump"

tar -C "$DATA_ROOT" -czf "$WORK_DIR/pads.tgz" pads
docker run --rm -v "$WORK_DIR:/backup:ro" postgres:16 pg_restore --list /backup/alcove.dump >/dev/null
docker run --rm -v "$WORK_DIR:/backup:ro" postgres:16 pg_restore --list /backup/keycloak.dump >/dev/null
tar -tzf "$WORK_DIR/pads.tgz" >/dev/null

git -C "$PROJECT_DIR" rev-parse HEAD > "$WORK_DIR/git-revision.txt"
sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "$ENV_FILE" | sort > "$WORK_DIR/environment-keys.txt"
cp "$COMPOSE_FILE" "$WORK_DIR/docker-compose.codicam.yml"
(cd "$WORK_DIR" && sha256sum alcove.dump keycloak.dump pads.tgz docker-compose.codicam.yml > SHA256SUMS)

mv "$WORK_DIR" "$FINAL_DIR"
trap - EXIT INT TERM
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20??-*' -mtime "+$KEEP_DAYS" -exec rm -rf -- {} +
echo "Backup complete: $FINAL_DIR"
