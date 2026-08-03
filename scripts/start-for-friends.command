#!/usr/bin/env bash
# Double-clickable from Finder (first time: right-click -> Ouvrir, Gatekeeper).
set -e

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "============================================"
echo "  Alcove - demarrage (mode partage/amis)"
echo "============================================"
echo ""

if ! command -v docker &>/dev/null; then
    echo "Docker n'est pas installe."
    echo "Installe Docker Desktop : https://www.docker.com/products/docker-desktop/"
    echo "puis relance ce script."
    read -p "Appuie sur Entree pour fermer..."
    exit 1
fi

echo "Demarrage des conteneurs (build de l'image la 1ere fois, prevoir 3-5 min)..."
docker compose -f docker-compose.friends.yml up -d --build

echo ""
echo "Attente que l'app reponde sur http://localhost:8000 ..."
ready=false
for i in $(seq 1 60); do
    if curl -sf http://localhost:8000/ >/dev/null 2>&1; then
        ready=true
        break
    fi
    sleep 2
done

echo ""
if [ "$ready" = true ]; then
    echo "============================================"
    echo "  Alcove est pret : http://localhost:8000"
    echo "============================================"
    open http://localhost:8000
else
    echo "L'app met plus de temps que prevu (le modele IA telecharge ~2 Go en tache de fond)."
    echo "Ouvre http://localhost:8000 dans quelques minutes, ou verifie :"
    echo "  docker compose -f docker-compose.friends.yml logs -f pad"
fi

echo ""
echo "Pour arreter : docker compose -f docker-compose.friends.yml stop"
read -p "Appuie sur Entree pour fermer..."
