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

## 2. Chantier A — Groupes de couleur par requête (graphe)

**Ce que fait Recall** (vu en direct sur `/knowledge-graph` → panneau
"Groups") : l'utilisateur définit une ou plusieurs requêtes de filtre (même
syntaxe que le champ de recherche existant : `tag:`, `source:`, `name:`, texte
libre), associe chaque requête à une couleur, et tous les nœuds qui matchent
sont peints de cette couleur — par-dessus la couleur de type par défaut. Sert
à visualiser un sous-ensemble thématique du graphe sans devoir filtrer/masquer
le reste.

**État actuel côté Alcove** — [GraphView.tsx](src/frontend/src/ui/GraphView.tsx) :
- Le champ de recherche existe déjà : `searchRef` (ligne 79), lu dans
  `isMatch()` (ligne 157) qui atténue (`ctx.globalAlpha`) les nœuds non
  matchants au lieu de les recolorer.
- La palette de couleurs par type est dans `getNodeColors()` (ligne 44) /
  `TYPE_LABELS` (ligne 55).
- Il n'y a **aucune notion de groupes multiples** actuellement — une seule
  requête de recherche globale à la fois.

**Plan d'implémentation** :
1. State : `interface ColorGroup { id: string; query: string; color: string }`,
   `const [groups, setGroups] = useState<ColorGroup[]>([])` + `groupsRef` (même
   pattern ref-mirror que `spacingRef`/`searchRef` pour que `draw()` lise la
   valeur live sans recréer le `useCallback`).
2. Réutiliser la logique de `isMatch()` (ligne 157) : en extraire le
   sous-matcher `matchesQuery(node, query)` pur, pour l'appliquer group par
   group plutôt que seulement à `searchRef.current`.
3. Dans `draw()` (autour de la ligne 149-160 où `nodeColors` est choisi par
   type) : avant d'assigner `nodeColors[n.type]`, boucler sur `groupsRef.current`
   dans l'ordre et si `matchesQuery(n, group.query)` matche, utiliser
   `group.color` à la place (dernier groupe qui matche gagne, comme Recall).
4. UI : petit panneau dans les contrôles existants (`.graph-controls*` dans
   [GraphView.scss](src/frontend/src/ui/GraphView.scss)) — liste de groupes
   avec input requête + color picker natif (`<input type="color">`) + bouton
   "+ Nouveau groupe" / suppression par groupe. Pas besoin de persistance
   serveur, `localStorage` suffit (comme les autres réglages de graphe déjà
   volatils côté Alcove — vérifier si spacing/linkLength sont persistés
   actuellement ; si non, rester cohérent et ne pas persister les groupes non
   plus, sauf si l'utilisateur le demande).
5. Legend (ligne ~439-445) : optionnel, ajouter les groupes actifs sous la
   légende de types existante.

Effort estimé : petit (~1-2h), tout le socle (matching, refs, panneau
contrôles) existe déjà et suit un pattern déjà en place dans le fichier.

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
