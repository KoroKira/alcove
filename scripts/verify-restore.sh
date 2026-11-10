#!/bin/sh
# Restore drill: prove that a backup can really be restored, in isolation.
#
#   scripts/verify-restore.sh /path/to/backup-dir      (directory made by backup-codicam.sh)
#   scripts/verify-restore.sh /path/to/alcove.dump     (a single pg_dump custom-format file)
#
# What it does
#   1. verifies SHA256SUMS when the backup is a directory;
#   2. restores alcove.dump into a THROWAWAY PostgreSQL that has no link to the
#      real stack, then checks that the core tables exist and are readable;
#   3. prints row counts and the Alembic revision stored in the backup;
#   4. removes everything it created.
#
# It never connects to the application's database, never reads POSTGRES_* from
# the environment, and never deletes anything it did not create itself.
#
# Scratch server (choose one)
#   default  : a disposable `postgres:16` container, no published port, no volume.
#   VERIFY_PG_HOST (+ VERIFY_PG_PORT, VERIFY_PG_USER, VERIFY_PG_PASSWORD): an
#     existing scratch PostgreSQL you do not care about (CI, laptop). A fresh
#     database named restore_verify_* is created and dropped there.
set -eu

fail() { echo "verify-restore: $*" >&2; exit 1; }

[ $# -eq 1 ] || { echo "Usage: $0 <backup-dir | alcove.dump>" >&2; exit 2; }
TARGET=$1
if [ -d "$TARGET" ]; then
  BACKUP_DIR=$TARGET
  DUMP="$TARGET/alcove.dump"
elif [ -f "$TARGET" ]; then
  BACKUP_DIR=
  DUMP=$TARGET
else
  fail "not found: $TARGET"
fi
[ -r "$DUMP" ] || fail "dump not readable: $DUMP"

if [ -n "$BACKUP_DIR" ]; then
  [ -r "$BACKUP_DIR/SHA256SUMS" ] || fail "SHA256SUMS missing in $BACKUP_DIR"
  (cd "$BACKUP_DIR" && sha256sum -c SHA256SUMS >/dev/null) || fail "checksum mismatch in $BACKUP_DIR"
  echo "checksums: OK"
fi

DBNAME="restore_verify_$(date -u +%Y%m%d%H%M%S)_$$"
SCHEMA=pad_ws
CONTAINER=
CREATED_DB=

if [ -n "${VERIFY_PG_HOST:-}" ]; then
  MODE=server
  export PGPASSWORD=${VERIFY_PG_PASSWORD:-}
  pg() { psql -X -q -v ON_ERROR_STOP=1 -h "$VERIFY_PG_HOST" -p "${VERIFY_PG_PORT:-5432}" -U "${VERIFY_PG_USER:-postgres}" "$@"; }
  restore() { pg_restore --no-owner --no-acl --exit-on-error -h "$VERIFY_PG_HOST" -p "${VERIFY_PG_PORT:-5432}" -U "${VERIFY_PG_USER:-postgres}" -d "$DBNAME" "$DUMP"; }
  cleanup() { [ -n "$CREATED_DB" ] && pg -d postgres -c "DROP DATABASE IF EXISTS \"$DBNAME\"" >/dev/null 2>&1 || true; }
  trap cleanup EXIT INT TERM
else
  MODE=docker
  command -v docker >/dev/null 2>&1 || fail "Docker is required (or set VERIFY_PG_HOST for a scratch server)"
  CONTAINER="alcove-restore-verify-$$"
  # Throwaway credentials for a container that is never reachable from outside.
  SCRATCH_PW=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
  pg() { docker exec -i -e PGPASSWORD="$SCRATCH_PW" "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U postgres "$@"; }
  restore() { docker exec -i -e PGPASSWORD="$SCRATCH_PW" "$CONTAINER" pg_restore --no-owner --no-acl --exit-on-error -U postgres -d "$DBNAME" < "$DUMP"; }
  cleanup() { [ -n "$CONTAINER" ] && docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
  # Install cleanup before creating anything, and give the scratch DB no
  # network access. Restore and checks use only its local Unix socket.
  trap cleanup EXIT INT TERM
  docker run -d --rm --network none --name "$CONTAINER" -e POSTGRES_PASSWORD="$SCRATCH_PW" postgres:16 >/dev/null
  i=0
  # The official image briefly starts a temporary server to initialize the
  # data directory, then shuts it down and launches the real server. `pg_isready`
  # can succeed during that first phase, so wait for the entrypoint marker and
  # then a successful SQL query before trying to create the scratch database.
  until docker logs "$CONTAINER" 2>&1 | grep -Fq "PostgreSQL init process complete; ready for start up."; do
    i=$((i + 1)); [ "$i" -le 60 ] || fail "scratch PostgreSQL did not start"
    sleep 1
  done
  i=0
  until docker exec "$CONTAINER" psql -X -q -U postgres -d postgres -c "SELECT 1" >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -le 60 ] || fail "scratch PostgreSQL did not accept queries"
    sleep 1
  done
fi

pg -d postgres -c "CREATE DATABASE \"$DBNAME\"" || fail "cannot create scratch database"
CREATED_DB=1
restore || fail "pg_restore failed: the backup is NOT restorable. If the error mentions an unrecognized configuration parameter, the pg_dump or pg_restore client is newer than the scratch server: use clients of the same PostgreSQL major version as the server (the default Docker mode already does)."
echo "restore: OK ($MODE)"

count() { pg -d "$DBNAME" -Atc "SELECT count(*) FROM $SCHEMA.$1"; }
for table in users pads pad_members pad_versions pad_embeddings alembic_version; do
  n=$(count "$table" 2>/dev/null) || fail "table $SCHEMA.$table missing or unreadable in the backup"
  echo "rows $table: $n"
done
REV=$(pg -d "$DBNAME" -Atc "SELECT version_num FROM $SCHEMA.alembic_version ORDER BY 1" | tr '\n' ' ')
echo "alembic revision(s): $REV"
ORPHANS=$(pg -d "$DBNAME" -Atc "SELECT count(*) FROM $SCHEMA.pad_members m LEFT JOIN $SCHEMA.pads p ON p.id = m.pad_id WHERE p.id IS NULL")
[ "$ORPHANS" = "0" ] || fail "$ORPHANS pad_members rows reference missing pads"
echo "VERIFIED: backup is restorable and internally consistent"
