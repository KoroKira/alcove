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

- Le [code source de normalisation](https://github.com/KoroKira/alcove/blob/main/src/frontend/src/lib/canvas.ts#L87) affecte `appState.searchMatches = null`. Le bundle applicatif déployé [index-CuxsPwia.js](https://alcove.codicam.fr/assets/index-CuxsPwia.js) contient la même affectation `e.searchMatches=null` (offset 483835).
- Le bundle Excalidraw déployé [excalidraw-CGF0p-zd.js](https://alcove.codicam.fr/assets/excalidraw-CGF0p-zd.js) appelle directement `E.searchMatches.forEach(...)` (ligne 144, offset 51972).
- La valeur nulle provoque donc exactement le `TypeError` affiché. Le bundle Excalidraw ne vérifie pas cette valeur avant l’appel.

Le [code de reprise d’ErrorBoundary](https://github.com/KoroKira/alcove/blob/main/src/frontend/src/ui/ErrorBoundary.tsx#L36) efface seulement l’erreur React puis remonte le même arbre; si le canevas conserve `searchMatches: null`, le rendu retombe sur la même exception.

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

### ALCO-UI-002 — Terminal local configuré sur une adresse loopback sans service accessible

**Statut :** configuration observée; indisponibilité probable du terminal embarqué sur le déploiement public, portée à confirmer  
**Sévérité proposée :** P2 si le terminal local est une fonctionnalité attendue sur `alcove.codicam.fr`; sinon configuration documentée pour usage local  
**Environnement :** configuration publique consultée le 2026-10-22

La route publique `/api/app/config` renvoie `ttydUrl: "http://localhost:7681"`. Sur la machine où le navigateur Chrome de l’audit tourne, aucun processus n’écoute sur `127.0.0.1:7681` (connexion TCP locale refusée). Le composant `TerminalLocal` du dépôt utilise cette URL. Ainsi, si le terminal embarqué doit fonctionner pour les utilisateurs du déploiement public, le navigateur tente de joindre un service loopback sur le poste de chaque utilisateur au lieu d’un service accessible depuis l’application; il sera indisponible sauf si un ttyd local est installé sur ce poste.

La configuration seule ne permet pas de savoir si cette adresse est intentionnelle pour le mode local. Confirmer le comportement attendu, puis soit fournir une URL ttyd joignable via la configuration de déploiement, soit masquer/documenter le terminal lorsque le service local n’est pas installé. Ne pas exposer ttyd directement sans contrôle d’accès.

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
