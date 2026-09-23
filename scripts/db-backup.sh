#!/bin/sh
set -eu

# Explicit, single-database backup used before schema changes. The password is
# passed through the process environment and is never printed.
BACKUP_FILE=${1:-${DB_BACKUP_FILE:-}}
if [ -z "$BACKUP_FILE" ]; then
  echo "Usage: $0 /path/to/alcove-$(date -u +%Y%m%dT%H%M%SZ).dump" >&2
  exit 2
fi
case "$BACKUP_FILE" in
  /|""|*/.) echo "Refusing unsafe backup path: $BACKUP_FILE" >&2; exit 1 ;;
esac
if [ -e "$BACKUP_FILE" ]; then
  echo "Refusing to overwrite existing backup: $BACKUP_FILE" >&2
  exit 1
fi

BACKUP_DIR=$(dirname -- "$BACKUP_FILE")
mkdir -p -- "$BACKUP_DIR"
umask 077

PGPASSWORD=${POSTGRES_PASSWORD:-} pg_dump \
  --format=custom --no-owner --no-acl \
  --host "${POSTGRES_HOST:-127.0.0.1}" \
  --port "${POSTGRES_PORT:-5432}" \
  --username "${POSTGRES_USER:-postgres}" \
  --dbname "${POSTGRES_DB:-pad}" \
  > "$BACKUP_FILE"

pg_restore --list "$BACKUP_FILE" >/dev/null
sha256sum "$BACKUP_FILE" > "$BACKUP_FILE.sha256"
echo "Backup verified: $BACKUP_FILE"
