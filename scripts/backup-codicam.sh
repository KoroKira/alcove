#!/bin/sh
set -eu

# Run from cron on the server. Use the same Compose project and env as the app.
# For a cutover snapshot, stop pad first so DB and filesystem writes are quiescent.
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
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

COMPOSE_PROJECT=${ALCOVE_COMPOSE_PROJECT:-${COMPOSE_PROJECT_NAME:-alcove}}
BACKUP_ROOT=${BACKUP_DIR:?BACKUP_DIR must be set}
DATA_ROOT=${DATA_DIR:?DATA_DIR must be set}
KEEP_DAYS=${BACKUP_KEEP_DAYS:-14}
case "$KEEP_DAYS" in
  ''|*[!0-9]*) echo "BACKUP_KEEP_DAYS must be a positive integer" >&2; exit 1 ;;
esac
[ "$KEEP_DAYS" -gt 0 ] || { echo "BACKUP_KEEP_DAYS must be positive" >&2; exit 1; }
case "$BACKUP_ROOT" in /*) ;; *) echo "BACKUP_DIR must be absolute" >&2; exit 1 ;; esac
case "$BACKUP_ROOT" in
  /|/home|/srv|"") echo "Refusing unsafe BACKUP_DIR: $BACKUP_ROOT" >&2; exit 1 ;;
esac
STAMP=$(date -u +%Y-%m-%dT%H%M%SZ)
FINAL_DIR="$BACKUP_ROOT/$STAMP"
WORK_DIR="$BACKUP_ROOT/.incomplete-$STAMP-$$"

[ ! -e "$FINAL_DIR" ] || { echo "Backup already exists: $FINAL_DIR" >&2; exit 1; }
umask 077
mkdir -p "$BACKUP_ROOT" "$WORK_DIR"
cleanup() { rm -rf -- "$WORK_DIR"; }
trap cleanup EXIT INT TERM

compose() {
  docker compose --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" "$@"
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

# Runtime metadata works for release tarballs without a .git directory too.
PAD_CONTAINER=$(compose ps -a -q pad)
[ -n "$PAD_CONTAINER" ] || { echo "No pad container found in project $COMPOSE_PROJECT" >&2; exit 1; }
docker inspect --format '{{.Config.Image}}' "$PAD_CONTAINER" > "$WORK_DIR/runtime-image.txt"
docker inspect --format '{{.Image}}' "$PAD_CONTAINER" > "$WORK_DIR/runtime-image-id.txt"
if git -C "$PROJECT_DIR" rev-parse --verify HEAD >/dev/null 2>&1; then
  git -C "$PROJECT_DIR" rev-parse HEAD > "$WORK_DIR/git-revision.txt"
fi
printf '%s\n' "$COMPOSE_PROJECT" > "$WORK_DIR/compose-project.txt"
# Recovery needs the exact secrets as well as the databases. The backup is private
# (umask 077); encrypt it before copying it to storage outside this host.
cp "$ENV_FILE" "$WORK_DIR/environment.env"
chmod 600 "$WORK_DIR/environment.env"
sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "$ENV_FILE" | sort > "$WORK_DIR/environment-keys.txt"
cp "$COMPOSE_FILE" "$WORK_DIR/docker-compose.codicam.yml"
(cd "$WORK_DIR" && sha256sum alcove.dump keycloak.dump pads.tgz docker-compose.codicam.yml environment.env runtime-image.txt runtime-image-id.txt compose-project.txt environment-keys.txt > SHA256SUMS)

mv "$WORK_DIR" "$FINAL_DIR"
trap - EXIT INT TERM
# Retention is opt-in: a normal backup never removes an older recovery point.
if [ "${BACKUP_PRUNE:-false}" = "true" ]; then
  find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20??-*' -mtime "+$KEEP_DAYS" -exec rm -rf -- {} +
fi
echo "Backup complete: $FINAL_DIR"
