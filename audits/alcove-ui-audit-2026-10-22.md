# Audit exploratoire UI Alcove — 2026-10-22

## ALCO-UI-001 — Erreur intermittente au rendu initial du canevas

**Statut :** reproduit sur deux chargements distincts; persiste sur le dernier  
**Sévérité proposée :** P2  
**Environnement :** Chrome sur macOS, déploiement `https://alcove.codicam.fr/`

### Observation

Au premier chargement, l’écran a affiché « Une erreur a interrompu l’affichage » avec :

```
TypeError: Cannot read properties of null (reading 'forEach')
assets/excalidraw-CGF0p-zd.js:144
```

La console confirme l’exception pendant le rendu Excalidraw. Lors de cette première observation, « Réessayer sans recharger » a rétabli l’éditeur. Un onglet neuf et un rechargement ultérieur n’avaient pas reproduit le problème.

Après connexion réussie à Alcove, le rechargement de l’application a reproduit la même exception et masqué toute la navigation. Le bouton « Réessayer sans recharger » était visible et activé, mais deux clics (DOM et position visible) n’ont pas fait disparaître l’erreur. La console a de nouveau signalé l’exception de rendu.

### Étapes observées

1. Ouvrir `https://alcove.codicam.fr/` dans Chrome.
2. Observer l’erreur de rendu initial.
3. Lors du premier passage, cliquer sur « Réessayer sans recharger » : l’éditeur réapparaît.
4. Se connecter à Alcove, puis recharger l’application.
5. Constater la même erreur `forEach` dans Excalidraw.
6. Cliquer deux fois sur « Réessayer sans recharger » : l’écran d’erreur reste affiché.

Aucune note n’a été créée ni modifiée pendant cet audit.

### Résultat attendu

Les données initiales/restaurées du canevas sont validées ou normalisées avant leur passage à Excalidraw. Une collection absente ne doit pas faire tomber l’éditeur; la reprise doit restaurer une session utilisable.

### À investiguer

- Identifier la valeur passée à `.forEach` et sa source (état initial, données persistées ou réponse API).
- Ajouter une validation/normalisation au point de frontière entre l’état du pad et Excalidraw.
- Vérifier pourquoi la reprise échoue sur le chargement authentifié.
- Ajouter un test couvrant la valeur `null` et vérifier que l’écran de récupération ne nécessite pas une relance manuelle.

## Parcours authentifié

Le premier retour OAuth observé a échoué avec `Invalid authentication state`; une nouvelle tentative isolée s’est terminée par « Authentication Complete ». Après rechargement, l’application a ouvert l’éditeur, puis le défaut ALCO-UI-001 a bloqué l’écran. Ce premier retour OAuth est donc noté comme transitoire/non reproduit, pas comme défaut confirmé.

## Couverture restant à faire

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
