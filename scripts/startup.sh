#!/bin/bash
set -e

# Unauthenticated PAD_DEV_MODE is loopback-only. A non-loopback bind requires
# the deliberately named dangerous opt-in and should only be used in an
# isolated container/network.
if [ "${PAD_DEV_MODE:-false}" = "true" ]; then
  BIND_HOST="${PAD_DEV_HOST:-127.0.0.1}"
  case "$BIND_HOST" in
    127.*|localhost|::1|\[::1\]) ;;
    *)
      if [ "${PAD_DEV_ALLOW_DANGEROUS_BIND:-false}" != "true" ]; then
        echo "Refusing non-loopback PAD_DEV_MODE bind ($BIND_HOST); set PAD_DEV_ALLOW_DANGEROUS_BIND=true only intentionally" >&2
        exit 1
      fi
      ;;
  esac
else
  BIND_HOST="${PAD_HOST:-0.0.0.0}"
fi

exec uvicorn main:app --host "$BIND_HOST" --port 8000 --workers "${API_WORKERS:-1}"
