# Audit exploratoire UI Alcove — 2026-10-22

## ALCO-UI-001 — Crash du canevas : `searchMatches` vaut `null`

**Statut :** cause racine confirmée dans les bundles de production; reproduit sur plusieurs chargements  
**Sévérité proposée :** P1 — le canevas et, dans cette session, toute la navigation deviennent inutilisables  
**Environnement :** Chrome sur macOS, déploiement `https://alcove.codicam.fr/`

### Symptôme observé

L’écran affiche « Une erreur a interrompu l’affichage » avec :

```
TypeError: Cannot read properties of null (reading 'forEach')
assets/excalidraw-CGF0p-zd.js:144
```

La console confirme l’exception pendant le rendu Excalidraw. Après connexion, le rechargement a reproduit l’erreur et masqué la navigation. Le bouton « Réessayer sans recharger » n’a pas récupéré cette session; l’écran est encore bloqué à la dernière vérification.

### Cause racine confirmée

Les deux extraits concordent dans les ressources servies en production :

- Le bundle applicatif `index-CuxsPwia.js` affecte `e.searchMatches=null` dans la normalisation du canevas. Le code source correspondant sur `main` est `src/frontend/src/lib/canvas.ts`, qui affecte `appState.searchMatches = null`.
- Le bundle Excalidraw `excalidraw-CGF0p-zd.js` appelle directement `E.searchMatches.forEach(...)` pendant le rendu.
- La valeur nulle provoque donc exactement le `TypeError` affiché. Le bundle Excalidraw ne vérifie pas cette valeur avant l’appel.

Le code source de `ErrorBoundary.tsx` montre que « Réessayer sans recharger » efface seulement l’erreur React puis remonte le même arbre; si le canevas conserve `searchMatches: null`, le rendu retombe sur la même exception.

### Reproduction

1. Ouvrir `https://alcove.codicam.fr/` dans Chrome avec le canevas affiché.
2. Constater `Cannot read properties of null (reading 'forEach')` dans le panneau d’erreur.
3. Recharger après connexion : la même exception revient.
4. Cliquer sur « Réessayer sans recharger » : sur la dernière reproduction, l’écran reste bloqué.

Lors d’une première occurrence, le bouton de reprise avait rétabli l’éditeur une fois. Les chargements suivants ont reproduit le défaut et la reprise n’a plus suffi.

### Correctif à réaliser

Dans la normalisation, fournir une collection vide au lieu de `null` pour `searchMatches` (ou omettre la propriété si Excalidraw lui applique correctement son défaut). Ajouter une régression vérifiant les valeurs absentes/nulles puis contrôler un chargement de canevas réel dans la version déployée.

### Parcours authentifié

Le premier retour OAuth observé a échoué avec `Invalid authentication state`; une nouvelle tentative isolée s’est terminée par « Authentication Complete ». Après rechargement, l’application a ouvert l’éditeur, puis le défaut ALCO-UI-001 a bloqué l’écran. Ce premier retour OAuth est donc noté comme transitoire/non reproduit, pas comme défaut confirmé.

Aucune note n’a été créée ni modifiée pendant cet audit.

### Couverture restant à faire

Les parcours privés ne sont pas encore évalués, car l’erreur ALCO-UI-001 masque la navigation après connexion. À reprendre une fois le canevas accessible :

- recherche et ouverture d’une note existante ;
- création puis relecture d’une note de test, sans données personnelles ;
- assistant ;
- graphe ;
- révisions ;
- favoris / « à lire » ;
- fichiers et commandes ;
- navigation au clavier et fermeture des dialogues.

La recherche depuis la page publique avait affiché « Aucun résultat » ; ce résultat n’est pas classé comme bug, car le contenu privé n’était pas accessible à ce moment.

## Dépôt

La création d’issues GitHub est désactivée sur ce dépôt (API répond `410 Issues has been disabled`). Ce relevé est donc publié dans une branche dédiée et proposé dans une PR brouillon, sans modification de `main`.
