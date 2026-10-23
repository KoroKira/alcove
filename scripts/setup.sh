#!/usr/bin/env bash
# First installation of the authenticated server stack. Existing data is kept.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${ALCOVE_ENV_FILE:-$PROJECT_DIR/.env}"
COMPOSE_FILE="${ALCOVE_COMPOSE_FILE:-$PROJECT_DIR/docker-compose.codicam.yml}"
die() { printf '%s\n' "$*" >&2; exit 1; }

for dependency in docker curl jq; do
  command -v "$dependency" >/dev/null 2>&1 || die "Missing dependency: $dependency"
done
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (docker compose version)."
[ -r "$ENV_FILE" ] || die "Copy .env.codicam.example to $ENV_FILE, configure it, then retry. See SETUP.md."
# This is a trusted operator-owned configuration; it must use shell-compatible assignments.
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
COMPOSE_PROJECT="${ALCOVE_COMPOSE_PROJECT:-${COMPOSE_PROJECT_NAME:-alcove}}"
compose() { docker compose --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" "$@"; }

for key in POSTGRES_PASSWORD REDIS_PASSWORD KEYCLOAK_DB_PASSWORD KEYCLOAK_ADMIN_PASSWORD; do
  value="${!key:-}"
  case "$value" in ''|CHANGE_ME*|your_*) die "Configure $key with its own generated secret in $ENV_FILE." ;; esac
  [ "${#value}" -ge 20 ] || die "$key must contain at least 20 characters."
done
: "${FRONTEND_URL:?Set FRONTEND_URL}" "${OIDC_SERVER_URL:?Set OIDC_SERVER_URL}"
case "$FRONTEND_URL" in https://*) ;; *) die "FRONTEND_URL must be an HTTPS origin for the server stack." ;; esac
case "$OIDC_SERVER_URL" in https://*) ;; *) die "OIDC_SERVER_URL must be an HTTPS origin for the server stack." ;; esac
case "$FRONTEND_URL$OIDC_SERVER_URL" in *\?*|*\#*) die "Use origins without query strings or fragments." ;; esac
[ "${FRONTEND_URL%/}" = "$FRONTEND_URL" ] || die "Remove the trailing slash from FRONTEND_URL."
[ "${OIDC_SERVER_URL%/}" = "$OIDC_SERVER_URL" ] || die "Remove the trailing slash from OIDC_SERVER_URL."
case "${ALCOVE_IMAGE:-}" in
  ''|*REPLACE_WITH*) die "Pin ALCOVE_IMAGE to a published revision or digest before installation." ;;
esac
chmod 600 "$ENV_FILE"
compose config --quiet
printf '%s\n' 'Starting databases, cache and Keycloak…'
compose up -d postgres keycloak-postgres redis keycloak

KC_URL="http://127.0.0.1:${KEYCLOAK_PORT:-8080}"
KC_REALM="${OIDC_REALM:-alcove}"
KC_CLIENT_ID="${OIDC_CLIENT_ID:-alcove}"
# Realm/client identifiers are used in URL paths and queries below.
case "$KC_REALM:$KC_CLIENT_ID" in *[!A-Za-z0-9_.:-]*) die "Realm and client IDs must use letters, digits, dots, underscores or dashes." ;; esac
ready=false
for ((attempt=0; attempt<90; attempt++)); do
  if curl --fail --silent --max-time 3 "$KC_URL/realms/master/.well-known/openid-configuration" >/dev/null; then
    ready=true
    break
  fi
  sleep 2
done
[ "$ready" = true ] || die "Keycloak is unavailable. Inspect: docker compose --env-file $ENV_FILE -p $COMPOSE_PROJECT -f $COMPOSE_FILE logs keycloak"

# --data-urlencode preserves passwords containing URL-reserved characters.
KC_TOKEN=$(curl --fail --silent --show-error --max-time 20 -X POST \
  "$KC_URL/realms/master/protocol/openid-connect/token" \
  --data-urlencode "username=${KEYCLOAK_ADMIN:?Set KEYCLOAK_ADMIN}" \
  --data-urlencode "password=${KEYCLOAK_ADMIN_PASSWORD}" \
  --data-urlencode 'grant_type=password' --data-urlencode 'client_id=admin-cli' | jq -er '.access_token')

realm_status=$(curl --silent --show-error --max-time 20 -o /dev/null -w '%{http_code}' \
  "$KC_URL/admin/realms/$KC_REALM" -H "Authorization: Bearer $KC_TOKEN")
case "$realm_status" in
  200) printf 'Realm %s already exists; its policies are preserved.\n' "$KC_REALM" ;;
  404)
    jq -n --arg realm "$KC_REALM" '{realm:$realm,enabled:true,registrationAllowed:false,bruteForceProtected:true,passwordPolicy:"length(12)"}' |
      curl --fail --silent --show-error --max-time 20 -X POST "$KC_URL/admin/realms" \
        -H "Authorization: Bearer $KC_TOKEN" -H 'Content-Type: application/json' --data-binary @- >/dev/null
    ;;
  *) die "Cannot inspect realm (HTTP $realm_status). Check Keycloak administrator access." ;;
esac

client_uuid() {
  curl --fail --silent --show-error --max-time 20 \
    "$KC_URL/admin/realms/$KC_REALM/clients?clientId=$KC_CLIENT_ID" \
    -H "Authorization: Bearer $KC_TOKEN" | jq -r '.[0].id // empty'
}
CLIENT_UUID=$(client_uuid)
if [ -z "$CLIENT_UUID" ]; then
  jq -n --arg client "$KC_CLIENT_ID" --arg origin "$FRONTEND_URL" \
    '{clientId:$client,enabled:true,protocol:"openid-connect",publicClient:false,clientAuthenticatorType:"client-secret",standardFlowEnabled:true,directAccessGrantsEnabled:false,redirectUris:[($origin+"/api/auth/callback")],webOrigins:[$origin]}' |
    curl --fail --silent --show-error --max-time 20 -X POST "$KC_URL/admin/realms/$KC_REALM/clients" \
      -H "Authorization: Bearer $KC_TOKEN" -H 'Content-Type: application/json' --data-binary @- >/dev/null
  CLIENT_UUID=$(client_uuid)
else
  printf 'Client %s already exists; verify its exact redirect URI in the console.\n' "$KC_CLIENT_ID"
fi
[ -n "$CLIENT_UUID" ] || die "Could not find the OIDC client."
MAPPER_URL="$KC_URL/admin/realms/$KC_REALM/clients/$CLIENT_UUID/protocol-mappers/models"
MAPPER_ID=$(curl --fail --silent --show-error --max-time 20 "$MAPPER_URL" \
  -H "Authorization: Bearer $KC_TOKEN" | jq -r 'map(select(.name == "alcove-audience"))[0].id // empty')
if [ -z "$MAPPER_ID" ]; then
  jq -n --arg client "$KC_CLIENT_ID" \
    '{name:"alcove-audience",protocol:"openid-connect",protocolMapper:"oidc-audience-mapper",config:{"included.client.audience":$client,"access.token.claim":"true"}}' |
    curl --fail --silent --show-error --max-time 20 -X POST "$MAPPER_URL" \
      -H "Authorization: Bearer $KC_TOKEN" -H 'Content-Type: application/json' --data-binary @- >/dev/null
fi
CLIENT_SECRET=$(curl --fail --silent --show-error --max-time 20 \
  "$KC_URL/admin/realms/$KC_REALM/clients/$CLIENT_UUID/client-secret" \
  -H "Authorization: Bearer $KC_TOKEN" | jq -er '.value | select(length > 0)')
case "$CLIENT_SECRET" in
  *[!A-Za-z0-9_.-]*) die "The client secret uses a custom format; configure OIDC_CLIENT_SECRET manually with quoting compatible with both Compose and bash." ;;
esac
# Atomically replace only this assignment, with quoting understood by Compose and bash.
ENV_TMP=$(mktemp "${ENV_FILE}.XXXXXX")
trap 'rm -f -- "$ENV_TMP"' EXIT
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in OIDC_CLIENT_SECRET=*) ;; *) printf '%s\n' "$line" >> "$ENV_TMP" ;; esac
done < "$ENV_FILE"
printf 'OIDC_CLIENT_SECRET=%s\n' "$(jq -rn --arg value "$CLIENT_SECRET" '$value | @sh')" >> "$ENV_TMP"
mv "$ENV_TMP" "$ENV_FILE"
trap - EXIT
unset KC_TOKEN CLIENT_SECRET value
# Compose already sees exported values from the old env; clear this one so the new file wins.
unset OIDC_CLIENT_SECRET
compose config --quiet
compose pull pad ollama
compose up -d ollama pad
printf '\nAlcove started at %s\n' "$FRONTEND_URL"
printf 'Create your application account in the %s realm: %s/admin/%s/console/\n' "$KC_REALM" "$OIDC_SERVER_URL" "$KC_REALM"
printf '%s\n' 'The bootstrap administrator belongs to master; it is not an Alcove application account.'
printf '%s\n' 'Configure and verify the HTTPS proxy, then follow SETUP.md for account creation, model installation and verification.'
