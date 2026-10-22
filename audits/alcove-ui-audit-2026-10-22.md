# Audit exploratoire UI Alcove — 2026-10-22

## Suivi après correctifs — 2026-10-22

Les sections ci-dessous conservent les constats au moment de leur découverte. État vérifié après déploiement de `alcove-functional-v4-doc-autosave-20261022` (`alcove-local:functional-fix-v4-doc-autosave-20261022`). La release a été construite depuis la source de production existante afin de conserver ses protections `ai_guard` et ses clés MCP dédiées.

| ID | État actuel | Vérification |
|---|---|---|
| ALCO-UI-001 — crash canvas | Corrigé par la normalisation de `searchMatches` et un test `null`/absent/invalide (PR #6, `b5cca64`). | Le canvas de production s’ouvre sur le bundle v3 sans erreur JS; le test de régression passe. |
| ALCO-UI-002 — terminal loopback | Corrigé : sans `TTYD_URL`, l’API renvoie une valeur vide et le composant n’ouvre pas de terminal local (PR #6). | `/api/app/config` renvoie `ttydUrl: ""`; tests `TerminalLocal` verts. |
| ALCO-UI-003 — parcours privés | Partiellement audité; aucun autre bug confirmé pendant ces parcours. | Recherche sémantique : 7 pads avec contenu retournés; Graphe : 9 notes, 10 liens; Assistant : réponse reçue; Révisions et Favoris s’ouvrent avec leurs états vides attendus. |
| ALCO-UI-004 — ressources PWA en 404 | Corrigé par le service des fichiers statiques racine (PR #11, `083818b`). | En production, manifeste, `registerSW.js`, `sw.js`, Workbox, favicon et icône répondent tous `200`. |
| ALCO-UI-005 — retries workspace désactivé | Corrigé : React Query ne retente plus le `503` permanent (PR #10, `8ee1683`). | Test de régression, build v3 sain; les logs montrent un seul appel initial puis aucun nouvel appel pendant 20 s. |
| ALCO-UI-006 — conflits d’autosauvegarde document | Corrigé par PR #12 (`3482cda`) et déployé dans la release v4. | CI complète verte (`backend-tests`, `database-integration`, `secret-scan`, `build-and-push`). En production, le document de test a accepté une sauvegarde (`PUT /api/pad/{id}/doc` → `200`), puis la remise à vide (`200`); la base confirme 0 caractère et aucun conflit `409`. `/` et `/api/app/config` renvoient `200`, conteneur sain. |
| ALCO-UI-007 — ancien bundle après déploiement | Récupération vérifiée; cause d’exploitation probable, sans correctif de code confirmé. | Un onglet ouvert chargeait l’ancien `index-BX7sbqV4.js`, puis un chunk supprimé (`DocumentPad-AOAq4UvP.js`, 404). Recharger a chargé le bundle courant et rétabli l’interface. |

L’index RAG a été initialisé localement sur les 9 pads : 7 pads contenaient du texte (7 chunks), 2 étaient vides. Le traitement et le stockage ont utilisé le service Ollama du serveur Alcove. Aucun pad n’a été créé ni supprimé. Le pad existant `New document`, vide avant le test, a temporairement reçu un marqueur, puis a été remis à vide par l’éditeur. La sauvegarde de l’ajout et celle du nettoyage ont toutes deux répondu `200`; une lecture ciblée de la base confirme que le document reste vide (`content` de longueur 0).

La couverture n’est pas exhaustive : ajout et import de source, restauration depuis la corbeille, parcours complets des raccourcis clavier et création de cartes de révision restent à tester. Les statuts des constats initiaux ci-dessous sont historiques; la table ci-dessus donne leur disposition actuelle.

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
4. Cliquer sur « Réessayer sans recharger » : l’interface peut réapparaître brièvement, puis le crash revient; un essai ultérieur est resté bloqué.

### Proposition de correctif

1. Dans `normalizeCanvasData`, remplacer l’affectation par une valeur conforme à Excalidraw, idéalement `searchMatches: []`, ou omettre la propriété si son défaut est bien une liste vide. Éviter de modifier directement la donnée persistée si cette propriété est un état UI transitoire.
2. Ajouter un test de normalisation couvrant une propriété absente et `null`, ainsi qu’un test de rendu d’un canevas chargé depuis une scène réelle. Vérifier qu’aucune valeur `searchMatches` nulle n’arrive à Excalidraw.
3. Déployer d’abord en préproduction, puis vérifier le chargement à froid et après rechargement d’une scène existante. Confirmer sauvegarde, ouverture et navigation.

### Durcissement de la reprise

L’ErrorBoundary global recouvre toute l’application; son bouton de reprise réaffiche l’arbre fautif sans réinitialiser l’état invalide. À traiter après ALCO-UI-001 ou dans le même correctif :

- isoler le canevas dans une boundary locale pour garder la navigation accessible quand le canvas échoue ;
- faire réinitialiser l’état fautif par une clé/session de récupération, ou remplacer le bouton par une action qui recharge réellement les données sûres ;
- ne pas présenter comme garanti que « Tes données ne sont pas perdues » sans vérifier l’état de sauvegarde côté serveur.

**Critères d’acceptation :** avec une scène contenant un état nul/ancien, l’application rend le canevas ou affiche une erreur locale récupérable; l’accueil et la navigation restent accessibles; le bouton de reprise ne boucle pas sur la même exception; aucune scène existante n’est perdue.

### Parcours authentifié

Le premier retour OAuth observé a échoué avec `Invalid authentication state`; une nouvelle tentative isolée s’est terminée par « Authentication Complete ». Après rechargement, l’application a ouvert l’éditeur, puis le défaut ALCO-UI-001 a bloqué l’écran. Ce premier retour OAuth est donc noté comme transitoire/non reproduit, pas comme défaut confirmé.

Aucune note n’a été créée ni modifiée pendant cet audit.

## ALCO-UI-002 — Terminal configuré sur loopback et sonde d’accès trompeuse

**Statut :** anomalie de configuration et comportement frontend confirmés; impact utilisateur dépend du mode de déploiement  
**Sévérité proposée :** P2 si le terminal est présenté aux utilisateurs du site public  
**Environnement :** configuration publique consultée le 2026-10-22; Chrome sur la machine d’audit

La route publique `/api/app/config` renvoie `ttydUrl: "http://localhost:7681"`. La machine de l’audit n’a aucun service à l’écoute sur `127.0.0.1:7681`. Le code backend a aussi cette valeur comme défaut. Dans le frontend, `TerminalLocal` utilise la même valeur par défaut, lance `fetch(ttydUrl, { mode: 'no-cors' })`, puis affiche une iframe. Une réponse opaque en mode `no-cors` ne permet pas de vérifier la santé ni l’accès réel au terminal; de plus, `localhost` désigne le poste de chaque utilisateur du navigateur, pas le serveur Alcove.

### Proposition de correctif

- Pour un déploiement public, ne pas substituer une URL loopback silencieusement : renvoyer une configuration vide/non activée quand aucun terminal n’est configuré, et afficher « terminal indisponible/non configuré » sans iframe.
- Si le terminal doit être disponible en public, le servir via une URL d’origine contrôlée, derrière authentification et autorisation par utilisateur. Restreindre les origines, limiter les permissions iframe et éviter d’exposer un ttyd shell sans authentification.
- Remplacer la sonde `no-cors` par un endpoint de santé explicite accessible depuis l’application, avec délai d’attente et messages d’erreur corrects. Ne déclarer « prêt » qu’après confirmation du service.
- Ajouter tests frontend couvrant config absente, service indisponible, réponse de santé valide et échec; contrôler la CSP et les en-têtes iframe sur le domaine déployé.

**Critères d’acceptation :** sans `TTYD_URL`, aucun accès réseau à `localhost` n’est tenté et l’UI indique clairement que le terminal est désactivé; avec une URL configurée, seuls les utilisateurs autorisés peuvent ouvrir le terminal et une indisponibilité est affichée sans faux état « prêt ».

## ALCO-UI-003 — Parcours privés non audités à cause du crash bloquant

**Statut :** couverture incomplète, pas un bug fonctionnel confirmé  
**Priorité :** reprendre après correction ALCO-UI-001

L’erreur masque la navigation après connexion. Les parcours suivants n’ont donc pas été testés et ne doivent pas être interprétés comme validés :

- recherche et ouverture d’une note existante ;
- création puis relecture d’une note de test, sans données personnelles ;
- assistant ;
- graphe ;
- révisions ;
- favoris / « à lire » ;
- fichiers et commandes ;
- navigation au clavier et fermeture des dialogues.

La recherche depuis la page publique avait affiché « Aucun résultat » ; ce résultat n’est pas classé comme bug, car le contenu privé n’était pas accessible à ce moment.

## Résumé initial au moment de l’audit

Les premières propositions étaient : (1) corriger la normalisation `searchMatches`; (2) rendre la boundary récupérable; (3) désactiver le terminal non configuré; (4) reprendre les parcours privés. Les correctifs canvas/terminal sont dans la PR #6, l’arrêt des retries workspace dans la PR #10 et les fichiers PWA dans la PR #11. Le registre reste ouvert pour les parcours non vérifiés listés plus haut.

## Dépôt

La création d’issues GitHub est désactivée sur ce dépôt (API répond `410 Issues has been disabled`). Ce relevé est publié dans une branche dédiée et proposé dans une PR brouillon, sans modification de `main`.
