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

Implémenté, testé en direct sur une vraie instance locale, et commité
(`0ca5909`, `4565537`). Pas encore déployé sur alcove-server.

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

## 3. Chantier B — Test de charge du graphe à échelle réelle

**Constat** : le compte Recall de l'utilisateur a **12 585 nodes / 25 253
liens** et le rendu (canvas + force-layout) reste fluide. Le graphe d'Alcove
n'a jamais été testé au-delà d'un usage perso (probablement quelques
dizaines à centaines de pads). Le layout est un force-directed maison
(`K_REP_DEFAULT` / `REST_LEN_DEFAULT`, boucle de simulation dans `draw()`
autour de la ligne 229-239) — pas de garantie que ça tienne à 10k+ nœuds sans
optimisation (quadratic repulsion entre paires de nœuds = O(n²), ce qui à
12k nœuds ferait ~150M paires par frame si implémenté naïvement).

**Plan de test** :
1. **Confirmé** : `tick()` (ligne 225, boucle de répulsion ligne 241-253) est
   explicitement commenté `// repulsion O(n²)` dans le code — paires de nœuds
   testées deux à deux à chaque frame. À 12k nœuds ça ferait ~78M paires par
   frame, injouable en continu. C'est le premier goulot, avant même de
   lancer un test : soit un quadtree (Barnes-Hut), soit un cap
   `MAX_VISIBLE_NODES` avec fallback "zoomer pour voir le détail" au-delà
   d'un seuil.
2. Générer un jeu de données synthétique réaliste côté backend (script one-off,
   pas dans le code prod) : quelques milliers de pads avec titres/tags variés
   + edges aléatoires mais avec une distribution réaliste (quelques hubs très
   connectés + longue traîne peu connectée, pas uniforme) pour se rapprocher
   de la topologie réelle d'un knowledge graph.
3. Charger ce jeu dans une instance Alcove locale (pas la prod), ouvrir
   `/graph`, mesurer : FPS pendant l'interaction (pan/zoom/drag), temps de
   premier rendu, comportement de la recherche/filtre à cette échelle.
4. Si O(n²) confirmé comme goulot : implémenter un cap doux — au-delà de
   ~1500-2000 nœuds visibles simultanément, désactiver la simulation physique
   continue (figer les positions après un layout initial) plutôt que de
   simuler en continu à chaque frame. C'est ce que font la plupart des outils
   de graphe à cette échelle (Obsidian Graph View, Gephi) — la simulation
   tourne une fois puis se fige, l'utilisateur peut la relancer manuellement.
5. Alternative plus lourde si le cap simple ne suffit pas : migrer le rendu
   vers WebGL (`pixi.js`/`sigma.js`) — mais ne pas partir là-dessus avant
   d'avoir mesuré le vrai point de rupture, ça peut être une réécriture non
   justifiée si le cap suffit.

**Point de départ concret pour la prochaine session** : les **22 items de
l'export Recall partiel** (voir section 4) donnent déjà un petit jeu de
données réel — pas assez pour un vrai stress-test (il en faudrait ~500x plus)
mais utilisable pour vérifier l'ingestion + rendu du graphe sur du contenu
réel avant de passer à la génération synthétique à grande échelle.

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

## 5. Reprise directe — commandes prêtes

```bash
# Voir l'échantillon d'export Recall
ls docs/recall-export-sample/

# Reprendre le chantier A (groupes de couleur) :
# ouvrir directement GraphView.tsx ligne 79 (searchRef) et 157 (isMatch)

# Reprendre le chantier B (test de charge) :
# d'abord lire GraphView.tsx lignes 229-260 pour confirmer la complexité O(n²)
```

Déploiement (rappel, cf. mémoire `feedback_docker_restart_vs_build`) : sur
alcove-server, toujours `docker compose build <service>` avant `up`/`restart`
— `restart` seul ne prend jamais en compte les changements de code.
