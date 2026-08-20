# Handover — état au 2026-08-20 (fin de session, tour bientôt indisponible)

Ce doc permet de reprendre exactement là où on s'arrête, sans accès facile à la
tour (alcove-server / pihomeserver) pendant un moment. Tout ce qui suit est du
"pickup direct" : fichiers, lignes, commandes prêtes à copier-coller.

## 1. État général

Les 13 chantiers originaux + 6 ajoutés en cours de route (#6, #7, #10, #11,
#12, #13, #15 à #21) sont **tous implémentés, commités et déployés** sur
alcove-server (dernier commit de fonctionnalités : `c47ec19`, des fixes de
détails sont venus après — voir `git log`).

Comparaison finale Alcove vs GetRecall (faite en direct, captures à l'appui) :
- **Révision espacée** (`ReviewDashboard.tsx`) : structure identique à Recall
  (Prêtes aujourd'hui / Cette semaine / Semaine prochaine, streak Lun-Dim,
  stats Répondu/Correct/Précision, activité 7 jours). Aucun écart.
- **Chat RAG agentique** : sous-requêtes, citations `[[N]]`, sources avec
  score/extrait — pattern équivalent des deux côtés.
- **Graphe de connaissances** (`GraphView.tsx`) : recherche, filtre nœuds non
  connectés, sliders spacing/link-length, timeline range — tout ça existe déjà
  côté Alcove et correspond au panneau "Graph Settings" de Recall. **Deux
  écarts identifiés, ce sont les 2 chantiers ci-dessous.**

## 2. Chantier A — Groupes de couleur par requête (graphe) — ✅ FAIT ET VÉRIFIÉ

Implémenté, testé en direct sur une vraie instance locale, commité
(`0ca5909`, `4565537`) et déployé sur alcove-server (détails en bas de
section).

Trois modes de requête par groupe, comme prévu à l'origine, avec en plus le
matching contenu et la similarité sémantique par vectorisation demandés
ensuite :
- `tag:xxx` — substring sur les tags du pad (`GraphNode.tags`, ajouté au
  payload de `/graph` dans [pad_router.py](src/backend/routers/pad_router.py)).
  Instantané, pas de round-trip réseau.
- texte libre — titre (instantané) **et** contenu du pad, via l'endpoint
  existant `/api/pad/search` (déjà utilisé par la recherche globale — aucune
  nouvelle logique de recherche full-text à écrire).
- `~xxx` — proximité sémantique par embeddings : la requête est vectorisée
  côté client via Ollama local (même chemin que le chat RAG, `searchRag()`
  dans [rag.ts](src/frontend/src/lib/rag.ts)), le serveur fait le KNN sur les
  embeddings déjà stockés (`/api/ai/rag/knn`, chantier #7). Rien de neuf côté
  infra — c'est la "vectorisation pour mesurer la proximité de contenu" que tu
  demandais, en réutilisant le pipeline RAG existant plutôt qu'en construire un
  second.

Les deux modes asynchrones (texte libre → contenu, `~` → sémantique) sont
débounced (400ms) et résolus dans un cache `Set<padId>` par groupe que `draw()`
lit à chaque frame ; un compteur de requête par groupe (`groupReqIdRef`) ignore
les réponses obsolètes si l'utilisateur retape vite. Erreurs réseau/Ollama
affichées inline sous le groupe concerné plutôt que silencieusement ignorées.

**Vérifié en direct**, pas juste "ça compile" : lancé une vraie instance
Alcove locale (backend natif via `.venv` + Postgres du `docker-compose.local.yml`
existant + frontend buildé sur port 8001, dev mode = auth bypass), créé 3 pads
de test réels (ESAT/handicap, recette de cuisine, droit du travail), indexé
leurs embeddings via le vrai Ollama local (`nomic-embed-text` déjà installé),
et testé les 3 modes dans le vrai graphe :
- `tag:esat` → colore uniquement le pad taggé esat. ✓ correct du premier coup.
- `farine` (texte libre) → colore le pad "Recette de cuisine" alors que ce mot
  n'apparaît que dans le corps, pas le titre. ✓ correct du premier coup.
- `~pâtisserie sucrée au four` (sémantique) → **a d'abord sur-matché** : avec
  le seuil initial de 0.35 (repris du chat RAG), le pad cuisine scorait 0.72
  mais les deux pads hors-sujet (ESAT à 0.49, droit du travail à 0.46)
  passaient aussi le seuil. Mesuré les scores réels via `/api/ai/rag/knn`,
  remonté `SEMANTIC_MIN_SCORE` à 0.55 dans
  [GraphView.tsx](src/frontend/src/ui/GraphView.tsx) — ne garde plus que le
  vrai match. Seuil documenté en commentaire dans le code avec les scores
  mesurés, pour que la prochaine calibration parte de données réelles plutôt
  que de redeviner.

**Bug découvert en cours de route, pas corrigé (hors scope), signalé pour
plus tard** : `TabContextMenu.tsx` (rename + edit-tags) utilise
`window.prompt()`, qui a planté le rendu de la page pendant les tests (dialogue
natif bloquant, incompatible avec toute automation/CDP). Suggestion envoyée en
tâche séparée (`task_0ddc8518`) pour remplacer ça par un input inline.

**Déployé sur alcove-server** — 2026-08-20. Le pipeline de déploiement a
changé depuis les chantiers précédents : il y a maintenant un CI/CD GitHub
Actions (`.github/workflows/docker-build.yml`) qui build et push
`ghcr.io/korokira/alcove:main` automatiquement à chaque push sur `main` — plus
besoin de build local + scp + `docker compose build` sur la tour (l'ancienne
méthode, lente à cause du CPU faible d'alcove-server, documentée dans la
mémoire `feedback_docker_restart_vs_build` — **cette mémoire est maintenant
partiellement obsolète pour ce repo précis**, à corriger). Déploiement réel :
`git pull` sur `/srv/docker/alcove` (repo cloné là-bas) puis
`docker compose -f docker-compose.selfhost.yml pull pad && docker compose
-f docker-compose.selfhost.yml up -d pad`. Vérifié après coup que l'image
tournant sur le serveur contient bien le code du payload `tags` (`docker exec
alcove-pad grep -n 'r.tags' /app/routers/pad_router.py`).

## 3. Chantier B — Test de charge du graphe à échelle réelle — ✅ FAIT

Implémenté, commité (`82b4aba`, `0d7831f`) et déployé sur alcove-server
(détails en section 5).

**Ce qui a été fait** : la boucle de répulsion `O(n²)` de `tick()` (jadis
ligne 241-253) a été remplacée par une grille de hachage spatial. Comme la
répulsion décroît en 1/d², au-delà d'une distance de coupure (`REPULSION_CUTOFF
= max(120, sqrt(kRep * 20))`) la force est négligeable — les nœuds sont
placés dans des cellules de cette taille, et pour chaque nœud on ne teste que
le voisinage 3×3 (9 cellules) au lieu de tous les autres nœuds. Chaque paire
est toujours traitée exactement une fois (garde `j <= i` sur l'index du nœud,
pas sur la direction de la cellule, donc correcte peu importe quel nœud
découvre l'autre en premier).

**Test de charge réel effectué** — deux méthodes complémentaires :

1. **Données réelles synthétiques via une vraie instance Alcove locale** :
   généré 3000 pads (`Node 00000`…`Node 02999`) avec une topologie de type
   knowledge-base réaliste — 15 nœuds "hub" fortement connectés + longue
   traîne, liens via vrais `[[wikilinks]]` parsés par l'endpoint `/graph`
   existant (pas de nouvelle logique de test). Chargé dans le vrai navigateur
   contre le vrai backend — script de seed conservé dans le repo :
   [scripts/loadtest/seed_graph_loadtest.py](scripts/loadtest/seed_graph_loadtest.py)
   (usage local uniquement, voir son en-tête — écrit directement en base via
   `asyncpg` contre `alcove-local-postgres`, ne nettoie pas après lui).

2. **Benchmark algorithmique isolé (Node, sans DOM)** — la mesure qui compte
   vraiment pour trancher "est-ce que ça tient" : port du code exact de
   `tick()` (avant/après) dans un script Node autonome, mesuré à plusieurs
   échelles de 100 à 12 000 nœuds
   ([scripts/loadtest/bench_repulsion.mjs](scripts/loadtest/bench_repulsion.mjs)) :

   | N nœuds | naïf O(n²) ms/tick | grille ms/tick | speedup | naïf tient 60fps (16.7ms) ? | grille tient 60fps ? |
   |--------:|-------------------:|---------------:|--------:|:---------------------------:|:---------------------:|
   | 100     | 0.19               | 0.23           | 0.8×    | oui                          | oui                    |
   | 500     | 0.47               | 0.33           | 1.4×    | oui                          | oui                    |
   | 1 500   | 4.20               | 1.19           | 3.5×    | oui                          | oui                    |
   | 3 000   | 16.96              | 2.56           | 6.6×    | **NON**                      | oui                    |
   | 6 000   | 67.59              | 5.54           | 12.2×   | **NON**                      | oui                    |
   | 12 000  | 272.94             | 12.73          | 21.4×   | **NON**                      | oui                    |

   À l'échelle réelle du compte Recall de l'utilisateur (12 585 nœuds), le
   code naïf aurait pris **~273ms par tick physique** — sous les 4fps,
   totalement inutilisable — contre **~12.7ms** avec la grille, confortablement
   sous le budget 60fps. En dessous de ~1500 nœuds les deux tiennent déjà le
   budget (la grille a un léger surcoût négligeable en absolu, ~0.04ms, à ces
   tailles — sans impact sur l'usage actuel d'Alcove).

**Décision prise** : la grille de hachage spatial seule suffit largement,
même à l'échelle d'un vrai export Recall complet. Pas besoin de quadtree
Barnes-Hut (plus complexe, gain marginal ici vu les chiffres), ni de cap
"figer la simulation au-delà de N nœuds" (les deux options envisagées dans
la version précédente de ce plan) — la marge (21× de speedup, 12.7ms très
en dessous du budget 16.7ms) est confortable même sans ces filets de sécurité
supplémentaires.

**Déployé sur alcove-server** — 2026-08-20. Image GHCR buildée par CI (run
réussi, ~12 min — le job "Build and push Docker image" est le plus long,
normal vu la taille des bundles monaco/excalidraw/mermaid) puis
`docker compose -f docker-compose.selfhost.yml pull pad && up -d pad`.
Vérifié après coup via
`docker inspect ghcr.io/korokira/alcove:main --format '{{json .Config.Labels}}'`
→ `org.opencontainers.image.revision` = `0d7831f...` = exactement le commit
du benchmark chantier B. (Note : grep direct de `REPULSION_CUTOFF` dans les
assets JS ne marche pas pour vérifier un déploiement frontend — le bundle est
minifié, les noms de variables sont mangled. Le label OCI `image.revision` est
la bonne méthode de vérification post-déploiement pour le frontend, à la
différence du backend Python où grep direct sur le code déployé fonctionne
tel quel.)

## 4. Export Recall partiel — fait, données disponibles

Un export ciblé (pas l'export complet, volontairement, pour rester léger) a
été réalisé via **Compte → Data → Export** sur Recall, filtré sur les tags
`Handicap`, `esat`, `Droit du travail`, `arche`, `L'Arche` → **22 items**.

- Fichier zip original : `~/Downloads/Recall_export_2026-08-20T18-51-07.zip`
- Extrait (local uniquement, **gitignored**, ne pas committer — contenu
  copyright/personnel) : `docs/recall-export-sample/` (~25 Mo, 22 paires
  `.md` + `.pdf`)

**Structure de l'export Recall** (utile si on veut un jour un importeur
"Recall → Alcove" dans Alcove, symétrique à l'import Obsidian déjà existant) :

```yaml
---
title: Handicap à vendre
tags:
  - "Handicap"
  - "ICAM/A4/MEI/Arche"      # chemin hiérarchique de tags séparé par /
pdf: "./Handicap à vendre.pdf"   # référence relative vers le PDF source, sidecar
createdAt: Sun Aug 16 2026 11:19:50 GMT+0200 (heure d'été d'Europe centrale)
updatedAt: Sun Aug 16 2026 11:20:30 GMT+0200 (heure d'été d'Europe centrale)
---

Detailed summary

## Section thématique 1
- Point de synthèse avec [[wikilinks]] vers des entités
- ...

## Section thématique 2
- ...
```

Points notables pour un futur importeur :
- Tags hiérarchiques `A/B/C` (un seul tag string avec `/` comme séparateur) —
  différent du système de tags plats d'Alcove, à mapper.
- `createdAt`/`updatedAt` en format `Date.toString()` JS (pas ISO) — à parser
  avec précaution.
- Le corps n'est pas le texte brut de la source, c'est déjà un **résumé
  structuré par l'IA de Recall** (titres `##` + bullet points), avec des
  `[[wikilinks]]` vers des entités extraites — exactement le pattern que fait
  déjà le chantier #6 (NER) côté Alcove. Un import Recall pourrait soit
  réingérer le PDF sidecar via le pipeline d'ingestion Alcove existant (pour
  ravoir un résumé "à la Alcove"), soit importer tel quel le markdown Recall
  (plus rapide, mais deux styles de résumé différents coexisteraient).

**Cette section n'est pas un chantier demandé explicitement** — c'est une
option identifiée en passant, à ne lancer que si l'utilisateur veut
explicitement un jour rapatrier tout son historique Recall dans Alcove pour de
bon (migration complète, pas juste comparaison UX).

## 5. Déploiement — pense-bête

```bash
# Voir l'échantillon d'export Recall
ls docs/recall-export-sample/

# Rejouer le benchmark chantier B
node scripts/loadtest/bench_repulsion.mjs
```

Pipeline de déploiement actuel pour `alcove-pad` sur alcove-server (cf. section
4 et mémoire `feedback_docker_restart_vs_build`, corrigée le 2026-08-20) :
push sur `main` → CI GitHub Actions build + push `ghcr.io/korokira/alcove:main`
(~10-15 min, surveiller via
`curl -s "https://api.github.com/repos/KoroKira/alcove/actions/runs?per_page=1&branch=main"`)
→ sur le serveur, `cd /srv/docker/alcove && git pull && docker compose
-f docker-compose.selfhost.yml pull pad && docker compose -f
docker-compose.selfhost.yml up -d pad`. Vérifier après coup via le label OCI
`org.opencontainers.image.revision` de l'image (pas de grep direct sur les
assets JS minifiés).

## 6. État final — tous les chantiers identifiés sont faits

Chantier A (groupes de couleur, 3 modes tag/contenu/sémantique), Chantier B
(fix perf O(n²)→grille spatiale), et la passe UI/UX ci-dessous sont **tous
implémentés, testés en direct, commités et déployés en production sur
alcove-server**. Rien de connu ne reste ouvert dans ce document.

## 9. Passe UI/UX — ✅ FAIT

Suite à la question "il reste des choses niveau UI/UX ?", trois points
identifiés et traités, commit `a0d84de`, déployé (vérifié via le label
`org.opencontainers.image.revision` = `a0d84de...`) :

1. **Bug `window.prompt()`** (renommer/tags dans `TabContextMenu.tsx`) —
   remplacé par une édition en ligne dans le même popover (nouveau prop
   `interceptActions` sur `ContextMenu` générique). Testé en direct :
   renommage et édition de tags fonctionnent, persistent, aucun freeze,
   aucun dialogue natif.
2. **Persistance des groupes de couleur** (graphe) — presets localStorage
   (`alcove-graph-group-presets`) : sauvegarder/sélectionner/supprimer,
   comme le "Save as preset" de Recall. Testé en direct : sauvegarde,
   sélection et application du preset fonctionnent.
3. **Passe de polish** — animations d'entrée (GraphView filtres, ChatView,
   ReviewDashboard, UnifiedAddModal, toutes apparaissaient sans transition
   avant), transitions hover/focus manquantes ajoutées, barres du graphique
   d'activité qui poussent à l'ouverture, points de streak qui "pop" à
   l'activation.
