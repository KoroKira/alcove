#!/usr/bin/env bash
# run.sh — Lance Alcove nativement (sans Docker) sur macOS
# Dépendances : postgresql@16 et redis via Homebrew
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
BACKEND="$ROOT/src/backend"
FRONTEND="$ROOT/src/frontend"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${CYAN}▶ $*${NC}"; }
success() { echo -e "${GREEN}✓ $*${NC}"; }
warn()    { echo -e "${YELLOW}⚠ $*${NC}"; }
die()     { echo -e "${RED}✗ $*${NC}" >&2; exit 1; }

# ── Prérequis ─────────────────────────────────────────────────────────────────
BREW_PREFIX="$(brew --prefix 2>/dev/null)" || die "Homebrew non trouvé — https://brew.sh"

for dep in "postgresql@16" "redis"; do
  brew list "$dep" &>/dev/null || {
    warn "$dep non installé — installation…"
    brew install "$dep"
  }
done

# ── .env.local ────────────────────────────────────────────────────────────────
ENV_FILE="$ROOT/.env.local"
if [ ! -f "$ENV_FILE" ]; then
  sed "s/__YOUR_MAC_USER__/$(whoami)/" "$ROOT/.env.local.template" > "$ENV_FILE"
  success "Créé .env.local (utilisateur postgres = $(whoami))"
else
  warn ".env.local déjà présent"
fi
set -a; source "$ENV_FILE"; set +a

# Initialiser les variables optionnelles avec des défauts
TTYD_PORT="${TTYD_PORT:-7681}"
OLLAMA_PORT="${OLLAMA_PORT:-11434}"

# ── Services Homebrew ─────────────────────────────────────────────────────────
info "Démarrage de PostgreSQL et Redis…"
brew services start postgresql@16 2>/dev/null || true
brew services start redis          2>/dev/null || true
sleep 1

# ── Base de données ───────────────────────────────────────────────────────────
PG_ARGS=(-h "${POSTGRES_HOST:-localhost}" -p "${POSTGRES_PORT:-5432}" -U "${POSTGRES_USER:-$(whoami)}")
if [ -n "${POSTGRES_PASSWORD:-}" ]; then
  export PGPASSWORD="$POSTGRES_PASSWORD"
fi

if ! psql "${PG_ARGS[@]}" -lqt 2>/dev/null | cut -d\| -f1 | grep -qw "${POSTGRES_DB:-pad}"; then
  info "Création de la base de données '${POSTGRES_DB:-pad}'…"
  createdb "${PG_ARGS[@]}" "${POSTGRES_DB:-pad}"
  success "Base de données créée"
else
  warn "Base de données '${POSTGRES_DB:-pad}' déjà existante"
fi

# ── Virtualenv Python (3.11 requis — 3.14 ne supporte pas greenlet) ───────────
PYTHON=""
for v in python3.11 python3.12 python3.13; do
  if command -v "$v" &>/dev/null; then PYTHON="$v"; break; fi
done
if [ -z "$PYTHON" ]; then
  warn "Python 3.11/3.12/3.13 non trouvé — installation de python@3.11…"
  brew install python@3.11
  PYTHON="$(brew --prefix python@3.11)/bin/python3.11"
fi
info "Python utilisé : $PYTHON ($(${PYTHON} --version))"

VENV="$ROOT/.venv"
# Recrée le venv si la version Python a changé (ex: ancien venv en 3.14)
if [ -d "$VENV" ] && ! "$VENV/bin/python" -c "import sys; assert sys.version_info < (3,14)" &>/dev/null; then
  warn "Venv Python 3.14 détecté — suppression et recréation en $($PYTHON --version)…"
  rm -rf "$VENV"
fi
if [ ! -d "$VENV" ]; then
  info "Création du virtualenv Python…"
  "$PYTHON" -m venv "$VENV"
fi
source "$VENV/bin/activate"

if ! python -c "import fastapi" &>/dev/null; then
  info "Installation des dépendances Python…"
  pip install -r "$BACKEND/requirements.txt" -q
fi
success "Python OK ($($PYTHON --version), venv)"

# ── Alembic : appliquer les migrations en attente, ou stamper une install fraîche ──
# Sur une base neuve (pas encore de table `pads`), le backend va la créer via
# create_all au démarrage avec le schéma courant : on peut "stamper" tel quel.
# Sur une base qui a déjà une table `pads` mais n'est pas encore versionnée
# (install pré-Alembic), il faut réellement REJOUER les migrations pour combler
# les colonnes ajoutées depuis (tags, folder, thumbnail_url, …) — un simple stamp
# les sauterait silencieusement.
if command -v alembic &>/dev/null && [ -f "$BACKEND/alembic.ini" ]; then
  if ! (cd "$BACKEND" && alembic current 2>/dev/null | grep -q head); then
    PADS_EXISTS="$(psql "${PG_ARGS[@]}" -d "${POSTGRES_DB:-pad}" -tAc \
      "SELECT 1 FROM information_schema.tables WHERE table_schema='pad_ws' AND table_name='pads'" 2>/dev/null || true)"
    if [ "$PADS_EXISTS" = "1" ]; then
      info "Alembic : base existante non versionnée — application des migrations…"
      (cd "$BACKEND" && alembic upgrade head 2>/dev/null) || {
        warn "Alembic upgrade a échoué (schéma probablement déjà à jour) — stamp de secours…"
        (cd "$BACKEND" && alembic stamp head 2>/dev/null) || warn "Alembic stamp ignoré (base pas encore prête)"
      }
    else
      info "Alembic : synchronisation de l'état du schéma (install fraîche)…"
      (cd "$BACKEND" && alembic stamp head 2>/dev/null) || warn "Alembic stamp ignoré (base pas encore prête)"
    fi
  fi
fi

# ── Dépendances Node ──────────────────────────────────────────────────────────
if [ ! -d "$FRONTEND/node_modules" ]; then
  info "Installation des dépendances Node.js…"
  (cd "$FRONTEND" && yarn install --frozen-lockfile)
fi
success "Node OK"

# ── Bundle frontend (dist/) ───────────────────────────────────────────────────
# Le backend sert le bundle statique (dist/index.html) sur / en dev mode.
# Un dist absent ou plus vieux que src/ = utilisateur voit une UI périmée sans
# le savoir (ex: appels d'API supprimés qui 404 silencieusement). On rebuild
# automatiquement si le dist n'existe pas ou si une source est plus récente
# que dist/index.html.
DIST_INDEX="$FRONTEND/dist/index.html"
NEEDS_BUILD=0
if [ ! -f "$DIST_INDEX" ]; then
  NEEDS_BUILD=1
  info "dist/ absent — build initial du bundle frontend…"
elif [ -n "$(find "$FRONTEND/src" -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.scss" -o -name "*.css" -o -name "*.html" \) -newer "$DIST_INDEX" -print -quit 2>/dev/null)" ]; then
  NEEDS_BUILD=1
  info "Sources frontend plus récentes que dist/ — rebuild…"
fi
if [ "$NEEDS_BUILD" = "1" ]; then
  (cd "$FRONTEND" && yarn build) || die "Build frontend échoué. Log : cd src/frontend && yarn build"
  success "Bundle frontend prêt"
else
  success "Bundle frontend à jour"
fi

# ── ttyd (terminal local) ─────────────────────────────────────────────────────
TTYD_PID=""
brew list ttyd &>/dev/null || { warn "Installation de ttyd…"; brew install ttyd; }
if ! lsof -ti ":$TTYD_PORT" >/dev/null 2>&1; then
  info "Démarrage de ttyd sur le port ${TTYD_PORT}…"
  # -i lo0 : loopback uniquement — ttyd est un shell distant, il ne doit JAMAIS
  # être accessible depuis le réseau (par défaut il écoute sur 0.0.0.0)
  ttyd -p "$TTYD_PORT" -i lo0 -W zsh &>/tmp/pad-ttyd.log &
  TTYD_PID=$!
  sleep 1
  success "ttyd prêt (PID $TTYD_PID)"
else
  warn "ttyd déjà en cours sur le port $TTYD_PORT"
  TTYD_PID=""
fi

# ── Ollama (IA locale) ───────────────────────────────────────────────────────
OLLAMA_PID=""
if command -v ollama &>/dev/null; then
  if pgrep -x "ollama" >/dev/null 2>&1; then
    warn "Ollama déjà en cours"
  else
    info "Démarrage d'Ollama…"
    ollama serve &>/tmp/pad-ollama.log &
    OLLAMA_PID=$!
    sleep 2
    if pgrep -x "ollama" >/dev/null 2>&1; then
      success "Ollama prêt (PID $OLLAMA_PID)"
    else
      warn "Ollama n'a pas démarré — vérifier /tmp/pad-ollama.log"
      OLLAMA_PID=""
    fi
  fi
else
  warn "Ollama non installé — fonctionnalités IA désactivées. Installer : https://ollama.ai"
fi

# ── Vite dev server (background) ──────────────────────────────────────────────
info "Démarrage du serveur Vite (frontend)…"
(cd "$FRONTEND" && yarn start) &>/tmp/pad-vite.log &
VITE_PID=$!

# Attendre que Vite soit prêt sur port 3003
echo -n "  Attente de Vite"
for i in $(seq 1 30); do
  if curl -sf http://localhost:3003/ >/dev/null 2>&1; then echo; break; fi
  sleep 1; echo -n "."
done
curl -sf http://localhost:3003/ >/dev/null 2>&1 \
  || { echo; die "Vite n'a pas démarré. Log : cat /tmp/pad-vite.log"; }
success "Vite prêt sur port 3003"

# ── Cleanup ───────────────────────────────────────────────────────────────────
cleanup() {
  echo ""
  info "Arrêt…"
  kill "$VITE_PID" 2>/dev/null || true
  [ -n "$TTYD_PID" ] && kill "$TTYD_PID" 2>/dev/null || true
  [ -n "$OLLAMA_PID" ] && kill "$OLLAMA_PID" 2>/dev/null || true
  echo -e "${YELLOW}Services Homebrew toujours actifs. Pour les arrêter :${NC}"
  echo "  brew services stop postgresql@16 redis"
}
trap cleanup EXIT INT TERM

# ── Backend ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}${GREEN}  Alcove → http://localhost:8000${NC}"
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

cd "$BACKEND"
# 127.0.0.1 : le mode local tourne avec PAD_DEV_MODE=true (auth désactivée),
# l'app ne doit donc jamais être accessible depuis le réseau
exec python3 -m uvicorn main:app \
  --host 127.0.0.1 \
  --port 8000 \
  --reload \
  --env-file "$ENV_FILE"
