#!/usr/bin/env bash
# Régénère les visuels de com à partir des templates SVG de ce dossier.
# Avant de lancer : place une vraie capture d'écran de l'app ici, nommée
# exactement "screenshot.png" (idéal : 16:9, ~1920x1080).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [ ! -f screenshot.png ]; then
  echo "⚠ screenshot.png absent — les visuels seront générés avec un cadre vide 'Capture d'écran ici'."
fi

rsvg-convert -w 1024 -h 1024 alcove-avatar.svg -o alcove-avatar.png
rsvg-convert -w 1280 -h 640  alcove-og.svg      -o alcove-og.png
rsvg-convert -w 1200 -h 727  alcove-showhn.svg  -o alcove-showhn.png
rsvg-convert -w 1080 -h 1080 alcove-square.svg  -o alcove-square.png

echo "✓ Régénéré : alcove-avatar.png, alcove-og.png, alcove-showhn.png, alcove-square.png"
