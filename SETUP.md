# Installer et exploiter Alcove

Deux parcours sont pris en charge : un essai local sans compte, ou un serveur
HTTPS avec Keycloak. Les commandes serveur ci-dessous utilisent toujours
**le projet Compose `alcove`**, le fichier `docker-compose.codicam.yml` et le
même `.env`. Changer de nom de projet sur une installation existante peut lancer
une deuxième stack : conserver celui de l'installation en cours.

## Essai local

Prérequis : Git, Docker Engine/Desktop démarré et Compose v2.

```sh
git clone https://github.com/KoroKira/alcove.git
cd alcove
docker compose -f docker-compose.friends.yml up -d --build
docker compose -f docker-compose.friends.yml ps
```

Ouvrir <http://localhost:8000>. Les ports publiés sont limités à la boucle
locale. Tous les visiteurs de ce mode partagent le compte `local@localhost` :
ne pas l'exposer par un proxy public ou par une redirection de ports.

Pour arrêter : `docker compose -f docker-compose.friends.yml stop`. Relancer
avec la commande `up` ci-dessus conserve les données. Les volumes Docker
contiennent les bases et les modèles; `./pads` contient les fichiers de sync.

## Serveur HTTPS avec comptes

### 1. Préparer l'hôte et les URL

Prérequis : serveur Linux, Docker Engine + Compose v2, `curl`, `jq`, Git,
`openssl`, espace persistant, et un proxy HTTPS avec support WebSocket. L'accès
au démon Docker équivaut à un accès administrateur sur l'hôte.

Prévoir deux origines, par exemple `https://alcove.example.org` pour Alcove et
`https://auth.example.org` pour Keycloak. La stack ne configure ni DNS, ni
certificat, ni tunnel à votre place. Le serveur doit pouvoir accéder à l'origine
Keycloak publique pour vérifier les clés OIDC.

```sh
git clone https://github.com/KoroKira/alcove.git
cd alcove
cp .env.codicam.example .env
chmod 600 .env
```

Éditer `.env` dans un éditeur privé :

- `COMPOSE_PROJECT_NAME=alcove` (ou le nom exact du projet existant).
- `FRONTEND_URL` et `OIDC_SERVER_URL` : origines HTTPS sans `/` final.
- `DATA_DIR` et `BACKUP_DIR` : chemins absolus persistants, sur un disque suivi.
- Chaque mot de passe : une valeur différente générée par `openssl rand -hex 32`.
- `ALCOVE_IMAGE` : tag publié `ghcr.io/korokira/alcove:sha-<SHA Git complet>` ou
  digest `ghcr.io/korokira/alcove@sha256:<digest>`, choisi après une CI réussie.
- `REGISTRATION_CONTACT_EMAIL` : facultatif, pour les demandes de compte.

Utiliser des affectations compatibles avec le shell et Compose (`CLE=valeur`,
ou `CLE='valeur avec espaces'`). Les scripts lisent ce fichier de confiance;
ne jamais charger un `.env` provenant d'un tiers. Ne pas afficher ni partager
le résultat de `docker compose config` sans `--quiet`, car il contient les secrets.

Créer `DATA_DIR` et `BACKUP_DIR`, propriété du compte opérateur et non lisibles
par les autres utilisateurs. Les conteneurs PostgreSQL doivent pouvoir créer
leurs sous-répertoires. Ne pas remplacer les propriétaires de données existantes
sans avoir vérifié leurs UID et les permissions attendues.

`INGRESS_NETWORK` nomme un réseau Docker externe. Réutiliser celui du proxy
si le proxy est conteneurisé. Pour un proxy natif sur l'hôte, créer un réseau
réservé à cette stack puis renseigner ce nom dans `.env` :

```sh
docker network create alcove-ingress
# Ensuite : INGRESS_NETWORK=alcove-ingress dans .env
```

Configurer le proxy :

| Origine publique | Proxy sur l'hôte | Proxy dans le réseau Docker ingress |
|---|---|---|
| Alcove | `http://127.0.0.1:<APP_PORT>` (8000 par défaut) | `http://pad:8000` |
| Keycloak | `http://127.0.0.1:8080` | `http://keycloak:8080` |

`APP_PORT` est le port hôte défini dans `.env`; il peut différer de la valeur
par défaut lorsque le port 8000 est déjà utilisé.

Conserver les en-têtes `Host`, `X-Forwarded-Proto` et `X-Forwarded-For` corrects;
ne rendre le réseau ingress accessible qu'au proxy de confiance. PostgreSQL,
Redis et Ollama restent sans port public. Restreindre la console Keycloak
`/admin/` à l'opérateur au niveau du proxy ou du réseau d'administration.

### 2. Initialiser Keycloak et Alcove

```sh
docker compose --env-file .env -p alcove -f docker-compose.codicam.yml config --quiet
bash scripts/setup.sh
```

Le script attend le point de découverte OIDC de Keycloak sur son port HTTP,
crée le realm et un client confidentiel si absents, ajoute l'audience Alcove,
écrit le secret client dans `.env` avec permissions 0600, puis démarre Alcove et
Ollama. Il ne publie aucun mot de passe. Un realm ou client déjà existant conserve
ses politiques : en vérifier la configuration dans la console avant utilisation.

Le script ne crée pas de compte applicatif. Le compte bootstrap Keycloak de
`.env` appartient au realm **master**; il sert à l'administration initiale.

1. Ouvrir `https://auth.example.org/admin/` et se connecter avec le bootstrap.
2. Sélectionner le realm `alcove` (valeur `OIDC_REALM`).
3. Dans **Clients → alcove**, vérifier la redirect URI exacte
   `https://alcove.example.org/api/auth/callback`, l'origine exacte
   `https://alcove.example.org` et l'authentification du client activée.
4. Dans **Users → Create new user**, créer votre compte avec prénom, nom,
   adresse et identifiant; le laisser activé. Dans **Credentials**, définir un
   mot de passe initial avec **Temporary** activé.
5. Ouvrir Alcove et cliquer sur **Se connecter** avec ce compte, puis remplacer
   le mot de passe initial. L'espace personnel est créé au premier callback réussi.

La création publique de comptes est désactivée par défaut. Configurer SMTP avant
d'activer « Forgot password » ou « Verify email ». Conserver la protection contre
les essais répétés et limiter les sessions selon votre usage. Pour déléguer la
gestion des comptes sans donner l'administration globale, suivre
[ACCOUNT_ADMINISTRATION.md](docs/ACCOUNT_ADMINISTRATION.md).

### 3. Installer l'IA et vérifier le service

```sh
docker compose --env-file .env -p alcove -f docker-compose.codicam.yml exec ollama ollama pull llama3.2
docker compose --env-file .env -p alcove -f docker-compose.codicam.yml exec ollama ollama pull nomic-embed-text
docker compose --env-file .env -p alcove -f docker-compose.codicam.yml ps
alcove_pad_container=$(docker compose --env-file .env -p alcove -f docker-compose.codicam.yml ps -q pad)
alcove_app_port=$(docker port "$alcove_pad_container" 8000/tcp | awk -F: 'NR == 1 {print $NF}')
curl --fail "http://127.0.0.1:${alcove_app_port}/api/app/config"
```

`OLLAMA_DEFAULT_MODEL` doit désigner un modèle installé. L'IA passe par le
backend Alcove et son proxy authentifié; ne pas exposer Ollama, utiliser
`OLLAMA_ORIGINS=*` ou changer le stockage du navigateur pour contourner une erreur.
L'installation d'un modèle et la première indexation peuvent être longues.

Avec un pad de test sans données privées, vérifier connexion, création,
sauvegarde après rechargement, recherche, export et restauration depuis la
corbeille. Vérifier un document et un canvas; les contrôles clavier et le focus
doivent rester utilisables. Pour le RAG, indexer ce pad, poser une question sur
son contenu et vérifier les sources. Installer un raccourci PWA ne remplace pas
ce contrôle et ne garantit pas l'édition hors connexion.

Pour relier un assistant, utiliser le [guide MCP](docs/MCP.md).

## Mise à jour et retour en arrière

Conserver la révision du compose, le `.env` et l'image exacte de chaque version.
Sur une installation existante, utiliser son projet, ses chemins et ses secrets;
ne pas recopier le modèle `.env` par-dessus. Identifier le fichier d'environnement
réellement lu par le service, le cron et les commandes de redémarrage. Si c'est
un fichier extérieur au dépôt, remplacer `--env-file .env` dans les commandes
ci-dessous par ce chemin exact et fournir `ALCOVE_ENV_FILE` aux scripts.

Le compose actif d'un serveur peut contenir des protections et réglages propres
à son exploitation qui ne sont pas dans le compose versionné : images épinglées
par digest, système de fichiers en lecture seule, capacités supprimées, réseaux,
limites de ressources ou service de sauvegarde. Avant une mise à jour, comparer
les deux fichiers. Ne pas remplacer le compose de production par celui du dépôt
sans reprendre et vérifier chaque réglage local. Pour une mise à jour limitée à
l'application, conserver le compose actif et ne changer que `ALCOVE_IMAGE` dans
la copie de release, sauf si une modification compose est explicitement requise.

Écrire l'image épinglée dans **ce même fichier persistant**. Une commande telle
que `ALCOVE_IMAGE=... docker compose up` ne modifie pas sa valeur : au prochain
redémarrage, l'ancienne image du fichier peut être relancée. Retirer les anciens
overrides de variable dans le shell ou l'unité de service. Si un `.env` de release
est aussi conservé, le synchroniser avec le fichier de référence; éviter deux
sources de configuration qui divergent.

1. Vérifier la CI et tirer l'image de la nouvelle révision sans démarrer l'app.
2. Bloquer brièvement les nouvelles écritures, fermer les éditeurs et arrêter
   `pad` après que l'interface indique la sauvegarde terminée.
3. Produire et vérifier une sauvegarde. Conserver le compose actuel en dehors
   du dépôt avant de changer de révision.
4. Mettre à jour le code/compose, puis `ALCOVE_IMAGE` dans `.env`. Prévoir une
   migration SQL seulement si la release en demande une; suivre les scripts
   `db-migrate.sh` avec sauvegarde. Le démarrage de l'app n'est pas une procédure
   générale de migration de schéma existant.
5. Valider le compose, démarrer `pad`, attendre son état sain et refaire le
   petit parcours de test via l'URL HTTPS.

Pour une installation au chemin courant :

```sh
# Avant tout changement de version :
docker compose --env-file .env -p alcove -f docker-compose.codicam.yml stop pad
bash scripts/backup-codicam.sh
# En cas d'échec de sauvegarde, corriger ou relancer l'ancienne app; ne pas déployer.

# Après mise à jour du compose et d'ALCOVE_IMAGE :
docker compose --env-file .env -p alcove -f docker-compose.codicam.yml config --quiet
docker compose --env-file .env -p alcove -f docker-compose.codicam.yml pull pad
docker compose --env-file .env -p alcove -f docker-compose.codicam.yml up -d --no-deps pad
docker compose --env-file .env -p alcove -f docker-compose.codicam.yml ps
alcove_pad_container=$(docker compose --env-file .env -p alcove -f docker-compose.codicam.yml ps -q pad)
alcove_app_port=$(docker port "$alcove_pad_container" 8000/tcp | awk -F: 'NR == 1 {print $NF}')
curl --fail "http://127.0.0.1:${alcove_app_port}/api/app/config"
```

### Installation par releases avec `/srv/alcove/current`

Quand chaque version est conservée dans son propre répertoire, préparez une
release candidate à partir de la configuration active. Cela garde le compose
local, ses protections et les secrets existants ; seule l'image de `pad` change.
Remplacez `<SHA_COMPLET>` par le commit dont la CI et la publication d'image
sont réussies. Exécutez les commandes depuis un compte autorisé à gérer Docker :

```sh
set -eu
release_sha=<SHA_COMPLET>
image="ghcr.io/korokira/alcove:sha-${release_sha}"
previous=$(sudo readlink -f /srv/alcove/current)
candidate="/srv/alcove/releases/alcove-main-${release_sha}"
sudo mkdir -m 700 "$candidate"
sudo cp -a "$previous/." "$candidate/"
sudo env ALCOVE_ENV="$candidate/.env" ALCOVE_IMAGE="$image" python3 - <<'PY'
import os
from pathlib import Path

path = Path(os.environ["ALCOVE_ENV"])
lines = path.read_text().splitlines(keepends=True)
indexes = [i for i, line in enumerate(lines) if line.startswith("ALCOVE_IMAGE=")]
if len(indexes) != 1:
    raise SystemExit(f"Expected one ALCOVE_IMAGE entry, found {len(indexes)}")
lines[indexes[0]] = f"ALCOVE_IMAGE={os.environ['ALCOVE_IMAGE']}\n"
path.write_text("".join(lines))
PY
sudo docker compose --env-file "$candidate/.env" -p alcove \
  -f "$candidate/docker-compose.codicam.yml" config --quiet
sudo docker compose --env-file "$candidate/.env" -p alcove \
  -f "$candidate/docker-compose.codicam.yml" pull pad
```

Fermez les éditeurs, attendez leur état « sauvegardé », puis arrêtez uniquement
`pad` avant la sauvegarde cohérente. Si la sauvegarde ou sa vérification échoue,
redémarrez l'ancienne release et arrêtez la mise à jour. Après une sauvegarde
validée, basculez le symlink atomiquement et contrôlez l'image et la santé :

```sh
set -eu
release_sha=<SHA_COMPLET>
image="ghcr.io/korokira/alcove:sha-${release_sha}"
previous=$(sudo readlink -f /srv/alcove/current)
candidate="/srv/alcove/releases/alcove-main-${release_sha}"

sudo docker compose --env-file "$previous/.env" -p alcove \
  -f "$previous/docker-compose.codicam.yml" stop pad
backup_dir=$(sudo env ALCOVE_PROJECT_DIR="$previous" ALCOVE_ENV_FILE="$previous/.env" \
  ALCOVE_COMPOSE_FILE="$previous/docker-compose.codicam.yml" \
  /srv/alcove/current/scripts/backup-codicam.sh | sed -n 's/^Backup complete: //p')
if [ -z "$backup_dir" ] || ! sudo sh -c 'cd "$1" && sha256sum -c SHA256SUMS' sh "$backup_dir"; then
  sudo docker compose --env-file "$previous/.env" -p alcove \
    -f "$previous/docker-compose.codicam.yml" up -d --no-deps pad
  echo 'Backup verification failed; old release restarted.' >&2
  exit 1
fi
sudo ln -sfn "$candidate" /srv/alcove/current.next
sudo mv -Tf /srv/alcove/current.next /srv/alcove/current
restore_previous() {
  sudo ln -sfn "$previous" /srv/alcove/current.rollback
  sudo mv -Tf /srv/alcove/current.rollback /srv/alcove/current
  sudo docker compose --env-file "$previous/.env" -p alcove \
    -f "$previous/docker-compose.codicam.yml" up -d --no-deps pad
}
if ! sudo docker compose --env-file /srv/alcove/current/.env -p alcove \
  -f /srv/alcove/current/docker-compose.codicam.yml up -d --no-deps pad; then
  restore_previous
  exit 1
fi
sudo docker compose --env-file /srv/alcove/current/.env -p alcove \
  -f /srv/alcove/current/docker-compose.codicam.yml ps
container=$(sudo docker compose --env-file /srv/alcove/current/.env -p alcove \
  -f /srv/alcove/current/docker-compose.codicam.yml ps -q pad)
running_image=$(sudo docker inspect --format '{{.Config.Image}}' "$container")
health=starting
for attempt in $(seq 1 30); do
  health=$(sudo docker inspect --format '{{.State.Health.Status}}' "$container")
  [ "$health" = healthy ] && break
  [ "$health" = unhealthy ] && break
  sleep 2
done
if [ "$running_image" != "$image" ] || [ "$health" != healthy ]; then
  restore_previous
  echo 'New release failed its image or health check; old release restored.' >&2
  exit 1
fi
```

Rollback applicatif : remettez le symlink sur `previous` avec le même couple
`ln -sfn` / `mv -Tf`, puis relancez `pad` avec le compose et le `.env` de cette
release. Vérifiez que l'image active correspond à `runtime-image.txt` dans la
sauvegarde. Ne restaurez pas les bases pour ce rollback ; cela effacerait les
écritures effectuées depuis la mise à jour.

Comparer ensuite l'image prévue par ce fichier à celle du conteneur actif,
sans afficher les secrets du compose. Adapter le chemin au fichier de référence :

```sh
ALCOVE_ENV_FILE=${ALCOVE_ENV_FILE:-.env}
alcove_expected_image=$(env -u ALCOVE_IMAGE docker compose --env-file "$ALCOVE_ENV_FILE" -p alcove -f docker-compose.codicam.yml config --format json | jq -er '.services.pad.image')
alcove_pad_container=$(env -u ALCOVE_IMAGE docker compose --env-file "$ALCOVE_ENV_FILE" -p alcove -f docker-compose.codicam.yml ps -q pad)
alcove_running_image=$(docker inspect --format '{{.Config.Image}}' "$alcove_pad_container")
test "$alcove_expected_image" = "$alcove_running_image"
```

Si la comparaison échoue, corriger la configuration persistante avant de
considérer le déploiement terminé. Vérifier aussi l'image après un redémarrage
contrôlé lorsque les éditeurs sont fermés.
Dans un navigateur ayant déjà installé la PWA, recharger l'application et
vérifier que la nouvelle interface s'affiche. Le service worker utilise une URL
stable (`/sw.js`) ; les anciennes URL `/sw-<version>.js` servent également le
worker courant pour permettre la migration des sessions déjà ouvertes. Une
seconde actualisation peut être nécessaire après son activation.

Pour un rollback **applicatif sans changement de schéma**, remettre le compose
précédent et `ALCOVE_IMAGE` à la valeur de `runtime-image.txt` de la sauvegarde
dans le fichier d'environnement de référence, puis relancer `pad`. Une copie
antérieure du `.env` peut elle-même contenir une image obsolète : comparer sa
valeur avec l'image effectivement sauvegardée avant de l'utiliser. Un script de
rollback doit restaurer ce fichier persistant autant que le symlink de release,
puis refaire la comparaison d'image ci-dessus. Cela préserve les écritures faites
depuis la mise à jour.
Ne pas restaurer automatiquement une ancienne base : cela écraserait ces écritures.
Si le schéma a changé, examiner la migration inverse et sa compatibilité avant
le rollback; sauvegarder l'état courant même en cas de panne.

## Sauvegarde et restauration

```sh
bash scripts/backup-codicam.sh
# Vérifier depuis le répertoire produit :
sha256sum -c SHA256SUMS
```

Le script utilise `COMPOSE_PROJECT_NAME` (`alcove` par défaut), pas le nom du
répertoire de release. Il accepte `ALCOVE_PROJECT_DIR`, `ALCOVE_ENV_FILE`,
`ALCOVE_COMPOSE_FILE` et `ALCOVE_COMPOSE_PROJECT` pour une installation avec
symlink de release et configuration extérieure au dépôt.

Il sauvegarde les deux bases PostgreSQL, les fichiers `pads`, le compose, le
`.env` privé et l'identité de l'image réellement exécutée. Les dumps et archives
sont vérifiés avant publication du dossier daté. Aucune ancienne sauvegarde n'est
supprimée par défaut. Pour une rotation
explicite, définir `BACKUP_PRUNE=true` et `BACKUP_KEEP_DAYS=14` (ou la durée
voulue), après avoir vérifié la copie hors machine. Surveiller l'espace disque.
Une archive en cours d'écriture reste marquée
`.incomplete-*` et n'est pas présentée comme réussie. Les sauvegardes contiennent
des secrets et des données personnelles : conserver les permissions privées,
chiffrer la copie hors machine et tester régulièrement la restauration.

Une sauvegarde quotidienne en ligne est utile, mais les deux bases et les fichiers
ne sont pas pris dans une transaction commune. Pour un point de restauration
avant migration, arrêter `pad`; pour une copie strictement cohérente incluant
l'administration des identités, suspendre aussi les modifications Keycloak.

Pour programmer une sauvegarde quotidienne sur l'installation par releases,
utiliser les unités systemd fournies. Elles lancent le script avec le compte
root, nécessaire ici pour accéder à Docker, et conservent les journaux dans
journalctl. Le timer rattrape une échéance manquée au redémarrage et ajoute un
retard aléatoire de cinq minutes pour éviter un démarrage simultané avec d'autres
tâches.

Après avoir adapté `ExecStart` dans `deploy/systemd/alcove-backup.service` si le
chemin d'installation diffère, sauvegarder les éventuelles unités déjà présentes,
puis installer et valider :

```sh
sudo install -o root -g root -m 644 deploy/systemd/alcove-backup.service /etc/systemd/system/alcove-backup.service
sudo install -o root -g root -m 644 deploy/systemd/alcove-backup.timer /etc/systemd/system/alcove-backup.timer
sudo systemd-analyze verify /etc/systemd/system/alcove-backup.service /etc/systemd/system/alcove-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now alcove-backup.timer
sudo systemctl start alcove-backup.service
sudo systemctl --no-pager status alcove-backup.timer alcove-backup.service
```

Vérifier que la dernière sauvegarde est complète avec `sha256sum -c SHA256SUMS`
depuis son répertoire. Surveiller `sudo journalctl -u alcove-backup.service` et
l'espace libre. Pour désactiver le calendrier, exécuter
`sudo systemctl disable --now alcove-backup.timer`; pour retirer les unités,
supprimer leurs fichiers sous `/etc/systemd/system/` puis lancer
`sudo systemctl daemon-reload`. Restaurer les copies préalablement sauvegardées
si des unités existaient avant l'installation.

Tester une restauration sur **de nouveaux chemins de données et un projet
Compose isolé**, sans toucher aux volumes d'origine :

1. Vérifier `SHA256SUMS`, copier le compose et `environment.env` de la sauvegarde
   vers un dossier privé. Modifier `COMPOSE_PROJECT_NAME`, `DATA_DIR`,
   `BACKUP_DIR`, `APP_PORT`, `KEYCLOAK_PORT`, les origines et le réseau ingress
   pour éviter tout conflit. Ne pas router les URL de production vers ce test.
2. Démarrer seulement `postgres`, `keycloak-postgres` et `redis`; attendre que
   les bases soient saines. Les bases doivent être vides, créées avec les mêmes
   utilisateurs que ceux de la sauvegarde.
3. Restaurer chaque dump dans sa base vide, avec `pg_restore --exit-on-error
   --no-owner --no-acl` via `docker compose exec -T`. Exemple, depuis le dossier
   de test avec son `.env` :

   ```sh
   docker compose --env-file .env -p alcove-restore-test -f docker-compose.codicam.yml exec -T postgres pg_restore --exit-on-error --no-owner --no-acl --username pad --dbname pad < /chemin/backup/alcove.dump
   docker compose --env-file .env -p alcove-restore-test -f docker-compose.codicam.yml exec -T keycloak-postgres pg_restore --exit-on-error --no-owner --no-acl --username keycloak --dbname keycloak < /chemin/backup/keycloak.dump
   ```

4. Extraire `pads.tgz` dans le **nouveau** `DATA_DIR`, préserver ses permissions,
   puis démarrer Keycloak, Ollama et `pad`. Le Redis neuf évite de réinjecter
   d'anciens caches. Adapter dans Keycloak les origines/redirects du client pour
   les URL de test.
5. Comparer comptes, nombres de pads, révisions et fichiers, puis ouvrir chaque
   type de pad et vérifier export et recherche. Valider le test avant toute
   restauration réelle, qui demande une fenêtre de maintenance et un plan pour
   conserver les écritures plus récentes.

Le runbook [CODICAM_MIGRATION.md](docs/CODICAM_MIGRATION.md) couvre la migration
historique entre serveurs; il ne remplace pas cette procédure d'installation.

## Développement local

Le développement natif utilise un compte automatique sans Keycloak. Les services
restent sur la boucle locale; ce mode ne convient pas à l'hébergement public.

Sur macOS avec Homebrew, Python et Git :

```sh
bash scripts/run.sh
```

Le script installe les dépendances nécessaires, démarre PostgreSQL/Redis via
Homebrew, crée `.env.local`, puis lance Vite et FastAPI sur
<http://localhost:8000>. `Ctrl+C` arrête les processus qu'il a démarrés.
Inspecter le script avant de l'exécuter si vous partagez déjà les services
PostgreSQL/Redis avec d'autres applications.

Sur Windows avec Docker Desktop, Python 3.11+, Node.js et Yarn :

```powershell
powershell -ExecutionPolicy Bypass -File scripts\run.ps1
```

PostgreSQL et Redis tournent via `scripts/docker-compose.local.yml`; backend et
frontend restent natifs. Arrêter ces conteneurs si nécessaire avec
`docker compose -f scripts/docker-compose.local.yml stop`. Le terminal ttyd
n'est pas disponible sous Windows.

Pour l'IA native, démarrer Ollama sur la machine du backend, installer les
modèles et régler `OLLAMA_URL` dans `.env.local`. Aucun accès direct du navigateur
à Ollama n'est requis. Pour un Ollama sur l'hôte vu depuis un conteneur, utiliser
`host.docker.internal` et autoriser uniquement le réseau Docker requis.

## Dépannage sans perte de données

- **Connexion bloquée :** repartir d'Alcove pour ouvrir un formulaire Keycloak
  neuf. Le compte `master` de bootstrap ne remplace pas votre compte `alcove`.
  Vérifier les origines HTTPS et la redirect URI exacte, puis les logs récents
  d'Alcove/Keycloak sans partager de secrets.
- **App indisponible :** vérifier `docker compose ... ps`, les logs de `pad`,
  l'état sain des bases et le routage du proxy. `start.sh` renvoie une erreur
  si l'app ne devient pas prête; il ne prétend pas qu'un démarrage a réussi.
- **Port occupé :** identifier le service avec `lsof -i :8000` ou `ss -ltnp`,
  puis choisir un autre `APP_PORT` et ajuster le proxy. Ne pas tuer un processus
  arbitrairement.
- **IA/RAG indisponible :** vérifier les modèles avec
  `docker compose ... exec ollama ollama list`, la mémoire disponible et les
  quotas. Les réponses 429/503 peuvent indiquer une file pleine.
- **Ne jamais réinitialiser la base, utiliser `down -v` ou supprimer les données
  pour résoudre un problème de connexion.** Sauvegarder et diagnostiquer d'abord.
