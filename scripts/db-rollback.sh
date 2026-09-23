#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TARGET=${ROLLBACK_TARGET:-}
if [ -z "$TARGET" ]; then
  echo "ROLLBACK_TARGET is required (for example: -1 or c8d1f2a3b4e5)" >&2
  exit 2
fi
case "$TARGET" in
  *[!A-Za-z0-9_.+-]*) echo "Invalid rollback target: $TARGET" >&2; exit 2 ;;
esac

if [ "${ALLOW_ROLLBACK_WITHOUT_BACKUP:-false}" != "true" ]; then
  if [ -z "${DB_BACKUP_DIR:-}" ]; then
    echo "Rollback requires DB_BACKUP_DIR, or an explicit ALLOW_ROLLBACK_WITHOUT_BACKUP=true" >&2
    exit 1
  fi
  stamp=$(date -u +%Y-%m-%dT%H%M%SZ)
  "$SCRIPT_DIR/db-backup.sh" "$DB_BACKUP_DIR/alcove-before-rollback-$stamp.dump"
fi

cd "$SCRIPT_DIR/../src/backend"
alembic downgrade "$TARGET"
alembic current
