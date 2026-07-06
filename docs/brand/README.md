# Charte graphique — Alcove

## Logo

`alcove-mark.svg` est la source vectorielle canonique — une arche qui se lit aussi comme un "A" (les deux jambes touchent la base, une traverse ferme le creux du haut). Toujours partir de ce fichier pour toute déclinaison (favicon, icônes PWA, réseaux sociaux, bannière README).

## Couleurs de marque (fixes, indépendantes des thèmes de l'app)

| Rôle | Hex | Usage |
|---|---|---|
| Violet principal | `#534AB7` | Silhouette de l'arche, traverse |
| Violet clair | `#AFA9EC` | Les deux creux du A |
| Fond sombre (icône maskable) | `#1e1e2e` | Fond plein derrière le logo sur fond sombre/PWA |

Ces couleurs sont volontairement distinctes des ~11 thèmes d'interface (`--ap-*`) : la marque doit rester reconnaissable même si l'utilisateur change de thème dans l'app.

## Règles d'usage

- Espace de respiration minimum autour du logo : ~15 % de sa hauteur de chaque côté.
- Ne jamais recolorer l'arche principale hors de ce nuancier violet.
- Sur fond très clair ou très sombre, garder les deux tons (voir `alcove-mark-preview.png`) plutôt que de passer en tout-blanc/tout-noir — sauf version monochrome dédiée (tampon, impression une couleur), où l'arche entière passe en une seule teinte (`var(--text-primary)` ou noir) et les creux en négatif.
- Taille minimale recommandée : ~32px de large (en dessous, la traverse du A devient peu lisible — le logo reste reconnaissable comme simple aplat en arche).

## Fichiers

- `alcove-mark.svg` — source vectorielle, à décliner
- `alcove-mark-preview.png` — rendu 1024×1024 pour prévisualisation rapide
- `alcove-illustration.jpg` — illustration utilisée en tête du README.
- `alcove-banner.svg` / `.png` — bannière plus simple (logo + texte), gardée en solution de repli si besoin d'un visuel éditable
- Déployés dans l'app : `src/frontend/public/favicon.svg`, `public/assets/images/favicon.png`, `public/icon-192.png`, `public/icon-512.png`

## Visuels de communication (`social/`)

Templates SVG prêts à l'emploi pour les visuels de lancement, avec un emplacement réservé pour une vraie capture d'écran de l'app :

| Fichier | Format | Usage |
|---|---|---|
| `alcove-avatar.svg` | 1024×1024 | Avatar Ko-fi, GitHub, réseaux |
| `alcove-og.svg` | 1280×640 | Social preview GitHub (aperçu de lien) |
| `alcove-showhn.svg` | 1200×727 | Visuel Show HN / Reddit (cadre navigateur) |
| `alcove-square.svg` | 1080×1080 | Post carré X/LinkedIn/Instagram |

**Pour générer les visuels avec ta vraie capture d'écran** :
1. Lance l'app, fais une capture (idéalement 16:9, ex. 1920×1080).
2. Enregistre-la sous `docs/brand/social/screenshot.png` (nom exact, même dossier).
3. Lance `bash docs/brand/social/regenerate.sh`.

Sans `screenshot.png`, les visuels se génèrent quand même avec un cadre "Capture d'écran ici" — pratique pour vérifier la mise en page avant d'avoir la vraie image.

⚠️ Ne jamais utiliser `docs/canvas_ide.png` dans ces visuels : c'est l'ancienne capture de l'upstream pad.ws (elle contient encore son branding et son lien GitHub dans l'image elle-même).
