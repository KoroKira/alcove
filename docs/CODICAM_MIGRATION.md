# Migration d'Alcove vers `codicam-server`

Ce runbook est volontairement conservateur : `alcove-server` reste intact
jusqu'à la recette complète et la fin de la période de rollback.

## Architecture cible

Le fichier `docker-compose.codicam.yml` sépare PostgreSQL Alcove, PostgreSQL
Keycloak, Redis, Keycloak, Ollama et l'application. Seuls les ports HTTP de
l'application et de Keycloak sont publiés sur `127.0.0.1`; le proxy HTTPS du
serveur est le seul ingress. PostgreSQL, Redis et Ollama ne sont jamais publiés.
Coder n'est plus dans le chemin d'authentification.

Keycloak porte l'inscription, la connexion, la politique de mot de passe, le
changement/rétablissement du mot de passe, la vérification d'adresse, le
verrouillage contre le brute force et les sessions. Dans le realm `alcove` :

- activer `User registration`, `Forgot password`, `Verify email` et
  `Revoke refresh token` ;
- exiger au moins 12 caractères et refuser les mots de passe compromis selon
  la politique disponible ;
- activer la protection brute-force (échec rapide puis attente croissante) ;
- créer le client confidentiel `alcove`, avec redirect URI exacte
  `${FRONTEND_URL}/api/auth/callback` et web origin exacte `${FRONTEND_URL}` ;
- limiter les sessions inactives et maximales (valeurs initiales conseillées :
  30 jours / 90 jours), puis copier le secret client dans `.env`.

## 1. Inventaire préalable (lecture seule)

Sur chaque serveur, conserver la sortie de `hostname`, `uname -a`, `df -h`,
`free -h`, `docker version`, `docker compose version`, `docker compose ps`,
`docker inspect` (images, mounts, restart policy et réseaux), ainsi que le SHA
Git déployé. Ne jamais imprimer le contenu du `.env`; lister seulement ses clés.

Dans PostgreSQL source, relever le nombre de lignes par table, la taille de la
base, les extensions, le contenu de `alembic_version`, le nombre de propriétaires
distincts et les contraintes orphelines. Relever aussi la taille et le nombre de
fichiers sous le bind mount `pads`.

## 2. Sauvegarde cohérente de la source

1. Créer un répertoire de sauvegarde daté hors du dépôt avec permissions 0700.
2. Faire un `pg_dump --format=custom --no-owner --no-acl` de la base `pad`.
3. Archiver le répertoire persistant `pads` en préservant permissions et dates.
4. Exporter la configuration Docker et les seules clés du `.env` (jamais ses
   valeurs) ; Redis n'est pas une source de vérité, mais conserver son RDB/AOF
   facilite un rollback strict.
5. Produire des SHA-256 de chaque archive et tester `pg_restore --list` ainsi
   que `tar --list` avant toute copie.

Pour le cutover final, mettre brièvement Alcove source en maintenance, attendre
la sauvegarde du canvas worker, refaire ces sauvegardes, puis garder les
conteneurs source arrêtés mais leurs volumes intacts. Cela évite deux instances
écrivaines et garantit un point de coupure cohérent.

## 3. Préparation de `codicam-server`

Créer les répertoires de runtime et sauvegarde avec le compte opérateur Docker
(sur l'hôte audité, sous `/home/prez2codicam/services/alcove` et
`/home/prez2codicam/backups/alcove` faute de sudo non interactif), tous non
accessibles aux utilisateurs non privilégiés.
Copier `.env.codicam.example` vers `.env`, générer chaque secret séparément et
configurer le proxy HTTPS. Aucun nom, IP ou URL de KAYOU ne doit être présent
dans `.env`, le proxy, DNS, `/etc/hosts` ou les variables des conteneurs.

Valider avant démarrage :

```sh
docker compose --env-file .env -f docker-compose.codicam.yml config --quiet
docker compose --env-file .env -f docker-compose.codicam.yml pull
```

## 4. Restauration et rattachement du compte historique

Restaurer le dump dans PostgreSQL cible vide, puis les fichiers `pads`. Exécuter
les migrations Alembic uniquement après comparaison entre le schéma restauré et
la révision attendue. Si l'ancienne base n'a pas de ligne `alembic_version` mais
possède déjà toutes les colonnes, la marquer à la révision réellement équivalente
avant `upgrade head`; ne jamais lancer aveuglément une migration additive.

Créer d'abord le compte administrateur historique dans Keycloak, relever son
claim `sub`, puis, dans une transaction sauvegardée, remplacer l'UUID du compte
local historique (`00000000-0000-0000-0000-000000000001`) par ce `sub` dans la
table utilisateur. Les clés étrangères `ON UPDATE` n'étant pas garanties, mettre
à jour explicitement toutes les références propriétaire après inventaire
(`pads`, `ai_conversations` et toute nouvelle table), vérifier les comptes par
table, puis valider la transaction. Ne jamais affecter les données historiques à
un compte public ou à tous les nouveaux inscrits.

## 5. IA et capacité

Ollama tourne dans le réseau Docker cible. L'application lui parle uniquement
via `http://ollama:11434`. Le proxy Alcove applique par Redis un débit et quota
par utilisateur, un seul job simultané par utilisateur, une concurrence globale
bornée, une attente bornée, un timeout et des limites de contexte/embedding.
Ollama ajoute sa propre file bornée et ne charge qu'un modèle. Adapter la
concurrence après mesure RAM/VRAM, jamais avant.

Télécharger explicitement les modèles nécessaires dans le volume cible, puis
vérifier que le modèle de chat et celui d'embedding sont présents. Surveiller
les 429/503, latences, mémoire du conteneur, taille de la file et espace disque.

## 6. Recette avant bascule

Avec deux comptes réels A et B, tester création/connexion/déconnexion, oubli et
changement de mot de passe, expiration et révocation de session. Pour chaque
famille de ressource, créer chez A puis tenter depuis B les GET/PUT/DELETE et
WebSocket avec l'UUID de A : la réponse doit être 403/404 et aucun contenu ne
doit fuiter. Couvrir pads, versions, fichiers, folders, recherche, graphe,
conversations, mémoire, embeddings/RAG, imports et exports.

Comparer ensuite source/cible : nombres de lignes par table et propriétaire,
identifiants, tailles, échantillons de hashes JSON et de fichiers, ouverture de
chaque type de pad, historique, recherche, export, upload, WebSocket et IA.
Faire un test de charge léger à deux utilisateurs et vérifier la backpressure.

## 7. Bascule et rollback

Après recette, pointer l'URL de référence vers `codicam-server`, garder la source
arrêtée en lecture seule et surveiller au minimum 48 heures. Sauvegarder chaque
nuit les deux bases en format custom, les fichiers et la configuration chiffrée,
avec copie hors machine et test de restauration périodique.

Rollback avant toute écriture significative sur la cible : remettre l'ancien
ingress sur `alcove-server` et redémarrer sa stack inchangée. Après des écritures
sur la cible, ne jamais simplement rallumer la source : arrêter les écritures,
sauvegarder la cible et effectuer une migration inverse contrôlée, faute de quoi
les nouvelles données seraient perdues.

## 8. Sauvegarde automatisée

`scripts/backup-codicam.sh` produit atomiquement un dump custom des deux bases,
une archive des fichiers persistants, le compose, la révision Git et les seules
clés (sans valeurs) de l'environnement. Il valide les archives, génère leurs
SHA-256 et conserve 14 jours par défaut. Exemple de cron quotidien à 03:17 :

```cron
17 3 * * * /home/prez2codicam/services/alcove-next/scripts/backup-codicam.sh >> /home/prez2codicam/backups/alcove-next/backup.log 2>&1
```

Une sauvegarde locale au serveur ne protège pas contre sa perte : synchroniser
le répertoire vers un stockage chiffré hors machine, puis effectuer au moins
mensuellement une restauration de test dans des volumes temporaires.
