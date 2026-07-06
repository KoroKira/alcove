#!/usr/bin/env bash
# setup.sh — First-time setup for Alcove on macOS (M1/M2/M3)
# Run once. Re-running is safe (idempotent).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
cd "$ROOT"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}▶ $*${NC}"; }
success() { echo -e "${GREEN}✓ $*${NC}"; }
warn()    { echo -e "${YELLOW}⚠ $*${NC}"; }
die()     { echo -e "${RED}✗ $*${NC}" >&2; exit 1; }

# ── Prerequisites ─────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "Docker not found. Install Docker Desktop: https://www.docker.com/products/docker-desktop/"
command -v jq     >/dev/null 2>&1 || die "jq not found. Install with: brew install jq"

# ── .env ─────────────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  cp .env.template .env
  success "Created .env from template"
else
  warn ".env already exists — skipping copy"
fi

# Load env vars
set -a; source .env; set +a

KC_PORT="${KEYCLOAK_PORT:-8080}"
KC_ADMIN="${KEYCLOAK_ADMIN:-admin}"
KC_ADMIN_PASS="${KEYCLOAK_ADMIN_PASSWORD:-admin123}"
KC_REALM="${OIDC_REALM:-pad-ws}"
KC_CLIENT_ID="${OIDC_CLIENT_ID:-pad-ws-client}"
APP_PORT_VAL="${APP_PORT:-8000}"
REDIRECT="${REDIRECT_URI:-http://localhost:${APP_PORT_VAL}/api/auth/callback}"
CODER_PORT_VAL="${CODER_PORT:-7080}"

# ── Build pad image ───────────────────────────────────────────────────────────
info "Building pad image (this takes ~2 min on first run)…"
docker compose build pad
success "Pad image built"

# ── Start infrastructure ──────────────────────────────────────────────────────
info "Starting postgres and redis…"
docker compose up -d postgres redis
sleep 3
success "postgres + redis running"

# ── Keycloak ──────────────────────────────────────────────────────────────────
info "Starting Keycloak (first start may take 60–90 s)…"
docker compose up -d keycloak

echo -n "  Waiting for Keycloak"
for i in $(seq 1 60); do
  if curl -sf "http://localhost:${KC_PORT}/health/ready" >/dev/null 2>&1; then
    echo; break
  fi
  echo -n "."
  sleep 3
done
curl -sf "http://localhost:${KC_PORT}/health/ready" >/dev/null 2>&1 \
  || die "Keycloak did not start in time. Check: docker compose logs keycloak"
success "Keycloak is ready"

# ── Get admin token ───────────────────────────────────────────────────────────
KC_TOKEN=$(curl -sf -X POST \
  "http://localhost:${KC_PORT}/realms/master/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=${KC_ADMIN}&password=${KC_ADMIN_PASS}&grant_type=password&client_id=admin-cli" \
  | jq -r '.access_token')
[ -n "$KC_TOKEN" ] || die "Could not get Keycloak admin token. Check KEYCLOAK_ADMIN / KEYCLOAK_ADMIN_PASSWORD in .env"

# ── Create realm (idempotent) ─────────────────────────────────────────────────
REALM_EXISTS=$(curl -sf -o /dev/null -w "%{http_code}" \
  "http://localhost:${KC_PORT}/admin/realms/${KC_REALM}" \
  -H "Authorization: Bearer ${KC_TOKEN}" || echo "404")

if [ "$REALM_EXISTS" = "200" ]; then
  warn "Realm '${KC_REALM}' already exists — skipping creation"
else
  curl -sf -X POST "http://localhost:${KC_PORT}/admin/realms" \
    -H "Authorization: Bearer ${KC_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"realm\": \"${KC_REALM}\", \"enabled\": true}" >/dev/null
  success "Realm '${KC_REALM}' created"
fi

# ── Create OIDC client (idempotent) ───────────────────────────────────────────
CLIENT_UUID=$(curl -sf \
  "http://localhost:${KC_PORT}/admin/realms/${KC_REALM}/clients?clientId=${KC_CLIENT_ID}" \
  -H "Authorization: Bearer ${KC_TOKEN}" | jq -r '.[0].id // empty')

if [ -n "$CLIENT_UUID" ]; then
  warn "Client '${KC_CLIENT_ID}' already exists (${CLIENT_UUID}) — skipping creation"
else
  curl -sf -X POST \
    "http://localhost:${KC_PORT}/admin/realms/${KC_REALM}/clients" \
    -H "Authorization: Bearer ${KC_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{
      \"clientId\": \"${KC_CLIENT_ID}\",
      \"enabled\": true,
      \"publicClient\": false,
      \"clientAuthenticatorType\": \"client-secret\",
      \"redirectUris\": [\"*\"],
      \"webOrigins\": [\"*\"],
      \"directAccessGrantsEnabled\": true
    }" >/dev/null
  CLIENT_UUID=$(curl -sf \
    "http://localhost:${KC_PORT}/admin/realms/${KC_REALM}/clients?clientId=${KC_CLIENT_ID}" \
    -H "Authorization: Bearer ${KC_TOKEN}" | jq -r '.[0].id')
  success "Client '${KC_CLIENT_ID}' created (${CLIENT_UUID})"
fi

# ── Get client secret ─────────────────────────────────────────────────────────
CLIENT_SECRET=$(curl -sf \
  "http://localhost:${KC_PORT}/admin/realms/${KC_REALM}/clients/${CLIENT_UUID}/client-secret" \
  -H "Authorization: Bearer ${KC_TOKEN}" | jq -r '.value')

# ── Add Audience mapper (idempotent) ──────────────────────────────────────────
DEDICATED_SCOPE_ID=$(curl -sf \
  "http://localhost:${KC_PORT}/admin/realms/${KC_REALM}/clients/${CLIENT_UUID}/default-client-scopes" \
  -H "Authorization: Bearer ${KC_TOKEN}" | jq -r ".[] | select(.name == \"${KC_CLIENT_ID}-dedicated\") | .id // empty")

if [ -n "$DEDICATED_SCOPE_ID" ]; then
  MAPPER_EXISTS=$(curl -sf \
    "http://localhost:${KC_PORT}/admin/realms/${KC_REALM}/client-scopes/${DEDICATED_SCOPE_ID}/protocol-mappers/models" \
    -H "Authorization: Bearer ${KC_TOKEN}" | jq -r '.[] | select(.name == "audience") | .id // empty')
  if [ -z "$MAPPER_EXISTS" ]; then
    curl -sf -X POST \
      "http://localhost:${KC_PORT}/admin/realms/${KC_REALM}/client-scopes/${DEDICATED_SCOPE_ID}/protocol-mappers/models" \
      -H "Authorization: Bearer ${KC_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "{
        \"name\": \"audience\",
        \"protocol\": \"openid-connect\",
        \"protocolMapper\": \"oidc-audience-mapper\",
        \"config\": {
          \"included.client.audience\": \"${KC_CLIENT_ID}\",
          \"access.token.claim\": \"true\"
        }
      }" >/dev/null
    success "Audience mapper added"
  else
    warn "Audience mapper already exists — skipping"
  fi
fi

# ── Create pad user (idempotent) ──────────────────────────────────────────────
PAD_USER="${PAD_USERNAME:-${KC_ADMIN}}"
PAD_PASS="${PAD_PASSWORD:-${KC_ADMIN_PASS}}"
PAD_EMAIL="${PAD_EMAIL:-admin@localhost}"

USER_EXISTS=$(curl -sf \
  "http://localhost:${KC_PORT}/admin/realms/${KC_REALM}/users?username=${PAD_USER}" \
  -H "Authorization: Bearer ${KC_TOKEN}" | jq -r '.[0].id // empty')

if [ -n "$USER_EXISTS" ]; then
  warn "User '${PAD_USER}' already exists — skipping"
else
  curl -sf -X POST \
    "http://localhost:${KC_PORT}/admin/realms/${KC_REALM}/users" \
    -H "Authorization: Bearer ${KC_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{
      \"username\": \"${PAD_USER}\",
      \"email\": \"${PAD_EMAIL}\",
      \"emailVerified\": true,
      \"enabled\": true,
      \"credentials\": [{\"type\": \"password\", \"value\": \"${PAD_PASS}\", \"temporary\": false}]
    }" >/dev/null
  success "User '${PAD_USER}' created (password: ${PAD_PASS})"
fi

# ── Write client secret into .env ─────────────────────────────────────────────
if grep -q "^OIDC_CLIENT_SECRET=your_client_secret" .env; then
  sed -i '' "s|^OIDC_CLIENT_SECRET=.*|OIDC_CLIENT_SECRET=${CLIENT_SECRET}|" .env
  success "OIDC_CLIENT_SECRET written to .env"
fi
if grep -q "^OIDC_REALM=pad-ws" .env && grep -q "^OIDC_CLIENT_ID=pad-ws-client" .env; then
  : # already set
fi

# ── Start Coder ───────────────────────────────────────────────────────────────
info "Starting Coder…"
docker compose up -d coder

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN} Keycloak + infrastructure ready!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  OIDC client secret : ${CYAN}${CLIENT_SECRET}${NC}"
echo -e "  Pad login          : ${CYAN}${PAD_USER}${NC} / ${CYAN}${PAD_PASS}${NC}"
echo ""
echo -e "${YELLOW}━━ Coder setup (optional — needed for terminal/VS Code in pad) ━━${NC}"
echo ""
echo "  1. Open http://localhost:${CODER_PORT_VAL} and create an admin account"
echo "     (use 'Sign in for pad' button to link with Keycloak)"
echo ""
echo "  2. Create a workspace template (e.g. docker-containers)"
echo ""
echo "  3. Get your API key:"
echo "     → Profile → Account → API Keys → New token"
echo "     → Paste into .env: CODER_API_KEY=..."
echo ""
echo "  4. Get template & org IDs:"
echo "     curl -H 'Coder-Session-Token: <key>' http://localhost:${CODER_PORT_VAL}/api/v2/templates"
echo "     curl -H 'Coder-Session-Token: <key>' http://localhost:${CODER_PORT_VAL}/api/v2/organizations"
echo "     → Paste into .env: CODER_TEMPLATE_ID=... CODER_DEFAULT_ORGANIZATION=..."
echo ""
echo -e "${YELLOW}━━ Once Coder is configured, start pad: ━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "     ./scripts/start.sh"
echo ""
