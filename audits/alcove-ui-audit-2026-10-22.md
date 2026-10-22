# Audit exploratoire UI Alcove — 2026-10-22

## ALCO-UI-001 — Erreur intermittente au rendu initial du canevas

**Statut :** confirmé une fois, intermittent, à reproduire sur une session authentifiée  
**Sévérité proposée :** P2  
**Environnement :** Chrome sur macOS, déploiement `https://alcove.codicam.fr/`

### Observation

Au premier chargement de l’application, l’écran a affiché « Une erreur a interrompu l’affichage » avec :

```
TypeError: Cannot read properties of null (reading 'forEach')
assets/excalidraw-CGF0p-zd.js:144
```

La console attribue l’exception au rendu Excalidraw. Le bouton « Réessayer sans recharger » a ensuite rétabli l’éditeur. Une ouverture dans un onglet neuf et un rechargement ultérieur n’ont pas reproduit l’erreur.

### Étapes observées

1. Ouvrir `https://alcove.codicam.fr/` dans Chrome.
2. Observer l’erreur de rendu initial.
3. Cliquer sur « Réessayer sans recharger ».
4. Constater que l’éditeur s’affiche.

### Résultat attendu

Les données initiales/restaurées du canevas sont validées ou normalisées avant leur passage à Excalidraw. Une collection absente ne doit pas faire tomber tout l’éditeur.

### À investiguer

- Identifier la valeur passée à `.forEach` et sa source (état initial, données persistées ou réponse API).
- Ajouter une validation/normalisation au point de frontière entre l’état du pad et Excalidraw.
- Ajouter un test couvrant la valeur `null` et vérifier que l’écran de récupération ne nécessite pas une relance manuelle.

## Couverture restant à faire

La fenêtre Chrome n’était pas authentifiée : le CTA de connexion ouvrait le formulaire Keycloak. Les parcours privés n’ont donc pas été validés. Reprendre après connexion manuelle et vérifier au minimum :

- recherche et ouverture d’une note existante ;
- création puis relecture d’une note de test, sans données personnelles ;
- assistant ;
- graphe ;
- révisions ;
- favoris / « à lire » ;
- fichiers et commandes ;
- navigation au clavier et fermeture des dialogues.

La recherche depuis la page publique a affiché « Aucun résultat » ; ce résultat n’est pas classé comme bug, car le contenu privé et la session utilisateur n’étaient pas accessibles pendant ce passage.

## Dépôt

La création d’issues GitHub est désactivée sur ce dépôt (API répond `410 Issues has been disabled`). Ce relevé est donc publié dans une branche dédiée et proposé dans une PR brouillon, sans modification de `main`.
