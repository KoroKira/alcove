#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BACKEND_DIR=$(dirname -- "$SCRIPT_DIR")/src/backend
cd "$BACKEND_DIR"

if [ "${REQUIRE_DB_BACKUP:-false}" = "true" ] && [ -z "${DB_BACKUP_DIR:-}" ]; then
  echo "REQUIRE_DB_BACKUP=true requires DB_BACKUP_DIR" >&2
  exit 1
fi

if [ -n "${DB_BACKUP_DIR:-}" ]; then
  stamp=$(date -u +%Y-%m-%dT%H%M%SZ)
  "$SCRIPT_DIR/db-backup.sh" "$DB_BACKUP_DIR/alcove-$stamp.dump"
fi

if [ "${DB_BOOTSTRAP_FRESH:-false}" = "true" ]; then
  echo "Bootstrapping a fresh database from the ORM metadata"
  "${PYTHON:-python3}" -c 'import asyncio; from database.database import init_db; asyncio.run(init_db())'
  # The historical baseline represents the create_all bootstrap. Stamping is
  # explicit and only valid immediately after the fresh bootstrap above.
  alembic stamp head
else
  alembic upgrade head
fi

alembic check
alembic current
