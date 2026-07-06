#!/usr/bin/env bash
# start.sh — Start (or restart) Alcove after initial setup
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
cd "$ROOT"

CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

[ -f .env ] || { echo "Run scripts/setup.sh first."; exit 1; }
set -a; source .env; set +a

APP_PORT_VAL="${APP_PORT:-8000}"

echo -e "${CYAN}▶ Starting all services…${NC}"
docker compose up -d

echo -n "  Waiting for pad"
for i in $(seq 1 30); do
  if curl -sf "http://localhost:${APP_PORT_VAL}/" >/dev/null 2>&1; then
    echo; break
  fi
  echo -n "."; sleep 2
done

echo ""
echo -e "${GREEN}✓ Alcove is up → http://localhost:${APP_PORT_VAL}${NC}"
echo ""
echo -e "  Keycloak admin : http://localhost:${KEYCLOAK_PORT:-8080}"
echo -e "  Coder          : http://localhost:${CODER_PORT:-7080}"
echo ""
echo -e "${YELLOW}Stop with: docker compose down${NC}"
