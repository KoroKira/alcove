# Connecter Alcove à un assistant

Alcove expose le protocole MCP sur **`https://VOTRE-ALCOVE/mcp`**
(Streamable HTTP). Sur l'installation Codicam : **`https://alcove.codicam.fr/mcp`**.
La connexion donne accès aux pads du compte authentifié, jamais à ceux d'un autre compte.

| Outil | Utilisation | Permission |
|---|---|---|
| `workspace_overview` | Comprendre l'organisation : types de pads, dossiers, tags | Lecture |
| `search_pads` | Rechercher (sémantique si l'index IA existe, sinon mots-clés dans les titres **et** le contenu) | Lecture |
| `read_pad` | Lire un pad de n'importe quel type (texte, wikilinks résolus, dossier, tags) | Lecture |
| `list_pads` | Lister par dossier, tag ou type, avec pagination | Lecture |
| `list_recent` | Retrouver ses derniers pads | Lecture |
| `write_note` | Créer un nouveau document | Écriture, opt-in |
| `append_to_pad` | Ajouter du texte à la fin d'un document existant | Écriture, opt-in |

Il n'existe **aucun outil de suppression ni de réécriture** : un agent ne peut
ni effacer ni remplacer du contenu. `append_to_pad` exige le `updated_at` obtenu
par `read_pad` : si le pad a changé entre-temps, l'appel échoue avec un conflit
et l'agent doit relire avant de réessayer. Il fonctionne seulement sur les
documents et respecte les droits du compte (un simple lecteur d'un pad partagé
ne peut pas y écrire). Un futur outil destructif devra exiger la permission
d'écriture **et** un argument `confirm` explicite.

Une réponse du modèle n'est pas une validation de ses sources : chaque résultat
contient l'`url` du pad à citer, et `search_pads` indique `degraded: true`
(avec un `notice`) quand Ollama est indisponible ou l'index absent : il s'agit
alors de correspondances par mots-clés, pas de recherche sémantique.

## Démarrage rapide pour un agent (Hermes, OpenBot, autre client MCP)

1. Créer une clé personnelle (**Compte et connexions → Connecter un assistant**),
   en **lecture seule** pour commencer, avec une durée courte. Un agent par clé :
   chacune se révoque séparément.
2. Pointer le client sur `https://VOTRE-ALCOVE/mcp` (transport HTTP « streamable »,
   JSON-RPC en POST) avec l'en-tête `Authorization: Bearer <clé>`. Tout client
   MCP qui accepte une URL et un en-tête convient; ne mettre la clé ni dans l'URL
   ni dans un dépôt. Exemple générique (adapter la syntaxe à votre client) :

   ```json
   {
     "mcpServers": {
       "alcove": {
         "url": "https://VOTRE-ALCOVE/mcp",
         "headers": { "Authorization": "Bearer ${ALCOVE_MCP_TOKEN}" }
       }
     }
   }
   ```

3. Vérifier la connexion sans client MCP :

   ```sh
   curl -sS https://VOTRE-ALCOVE/mcp -H "Authorization: Bearer $ALCOVE_MCP_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   ```

   Une clé en lecture seule ne liste que les outils de lecture. Sans en-tête
   valide, la réponse est `401`. Le message `initialize` renvoie aussi des
   `instructions` d'usage que les agents reçoivent automatiquement.
4. Ajouter l'écriture seulement si nécessaire (clé distincte avec la permission
   d'écriture) et garder les droits minimaux : un agent qui ne fait que lire et
   citer n'a pas besoin de `write_note` ni de `append_to_pad`.

Indexation : les notes créées ou complétées par un agent (ou par l'API) sont
indexées côté serveur pour la recherche sémantique, via l'Ollama configuré
(`OLLAMA_URL`, modèle `RAG_EMBED_MODEL`, `nomic-embed-text` par défaut). Si
Ollama est indisponible, l'écriture réussit quand même, l'ancien index est
conservé et la recherche par mots-clés trouve la note immédiatement.
Pour garder Ollama réactif sous charge, le serveur indexe un seul pad à la
fois, fusionne les réécritures rapprochées du même pad et traite au plus 64
chunks par pad par défaut. `RAG_SERVER_MAX_CHUNKS` peut régler cette limite
entre 1 et 512. `RAG_SERVER_INDEXING=false` désactive l'indexation serveur.

Isolation : une clé ne voit que les pads de son propriétaire (et ceux partagés
avec lui selon ses droits); les pads de la corbeille sont invisibles.

## Connexion depuis ChatGPT / Work

Le dialogue de connexion personnalisé de ChatGPT utilise **OAuth** pour les
données privées. Une clé Bearer collée dans la conversation ne configure pas ce
dialogue. Le serveur doit avoir été préparé par son administrateur ci-dessous.

1. Dans les plugins de ChatGPT, choisir **Ajouter un serveur MCP personnalisé**.
2. Nom : **Alcove**. URL : `https://alcove.codicam.fr/mcp` pour Codicam.
3. Authentification : **OAuth**. Utiliser le client préenregistré
   `alcove-chatgpt` et son secret fournis de façon privée par l'administrateur.
4. Copier l'URL de retour affichée par ChatGPT et la transmettre à
   l'administrateur pour le provisionnement du client. Elle est propre à cette
   connexion (par exemple `https://chatgpt.com/connector/oauth/<callback_id>`)
   et doit être autorisée à l'identique dans Keycloak, sans joker `*` ni slash
   ajouté à la fin.
5. Créer puis installer le plugin. Au premier appel, se connecter avec son
   **compte Alcove** et autoriser la lecture de ses notes.
6. Tester : « Utilise Alcove pour lister mes trois derniers pads. » Puis
   rechercher et lire un pad connu. La seule présence du plugin ne prouve pas
   que les appels fonctionnent.

Le navigateur ChatGPT / Work ne lit pas `~/.codex/config.toml`. L'installation
d'un serveur dans Codex local et celle d'un plugin ChatGPT sont deux démarches
distinctes. Les permissions du workspace peuvent limiter l'ajout de plugins.

## Codex local avec OAuth

Avec un client Codex préenregistré, compléter la configuration locale :

```toml
[mcp_servers.alcove]
url = "https://alcove.codicam.fr/mcp"
scopes = ["alcove:read"]
enabled_tools = ["workspace_overview", "search_pads", "read_pad", "list_pads", "list_recent"]

[mcp_servers.alcove.oauth]
client_id = "alcove-codex"
callback_url = "http://127.0.0.1:18765/callback"
callback_port = 18765
```

L'URL et le port doivent correspondre au client provisionné par
l'administrateur. Ce callback fixe suppose que Keycloak annonce
`authorization_response_iss_parameter_supported: true` dans sa découverte OIDC.
Sinon Codex peut ajouter un identifiant à son callback, tandis que ce script
accepte uniquement le chemin `/callback` pour Codex. Dans ce cas, utiliser une
clé personnelle en attendant une configuration OAuth adaptée. Conserver les
autres entrées de configuration existantes.
Lancer ensuite `codex mcp login alcove --scopes alcove:read`, puis
`codex mcp list`. Une session déjà ouverte peut nécessiter la réouverture du
chat pour charger les nouveaux outils.

## Clé personnelle : Hermes et autres clients Bearer

Dans Alcove, ouvrir **Compte et connexions → Connecter un assistant** :

1. Donner un nom à la connexion et choisir sa durée (90 jours par défaut).
2. Garder la lecture seule, ou cocher explicitement la création de notes.
3. Créer la clé. Elle est montrée **une seule fois** et n'est jamais stockée
   en clair dans la base. La conserver dans un gestionnaire de mots de passe.
4. Configurer l'en-tête `Authorization: Bearer <clé>` dans le client MCP.
5. Révoquer une connexion perdue ou inutilisée depuis le même écran.

### Configuration Hermes en lecture seule

Pour le profil `default`, placer la clé dans `~/.hermes/.env` sous le nom
`ALCOVE_MCP_TOKEN`, avec des permissions accessibles uniquement à ton compte.
Ne pas la coller dans une conversation, un dépôt ou la configuration YAML.
Hermes résout les variables référencées dans les en-têtes depuis ses secrets
locaux. La [référence officielle Hermes](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference)
documente cette syntaxe.

Ajouter à `~/.hermes/config.yaml` :

```yaml
mcp_servers:
  alcove:
    url: "https://alcove.codicam.fr/mcp"
    headers:
      Authorization: "Bearer ${ALCOVE_MCP_TOKEN}"
    tools:
      include:
        - workspace_overview
        - search_pads
        - read_pad
        - list_pads
        - list_recent
```

Cette liste expose la recherche et la lecture uniquement; elle n'inclut pas
`write_note`. Recharger les MCP (`/reload-mcp`) ou redémarrer Hermes, puis
exécuter `hermes mcp test alcove` et `hermes mcp list`. Vérifier ensuite une
recherche et la lecture d'un pad connu. Révoquer la clé depuis Alcove si elle
est perdue ou n'est plus nécessaire. La [documentation Hermes sur les serveurs
HTTP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)
décrit le transport et le rechargement.

Codex accepte une variable d'environnement :

```sh
codex mcp add alcove --url https://alcove.codicam.fr/mcp --bearer-token-env-var ALCOVE_MCP_TOKEN
```

Fournir `ALCOVE_MCP_TOKEN` à l'environnement **du processus Codex**, via le
gestionnaire de secrets du système. Une variable exportée dans un terminal
n'est pas nécessairement transmise à l'app graphique. OAuth est plus pratique
dans ce cas. Ne pas mettre la clé dans une URL, un dépôt ou un message de chat.

L'intégration Hermes existante peut conserver ses clés et sa configuration.
Le serveur accepte simultanément les clés MCP et les jetons OAuth dédiés.

## Préparation OAuth par l'administrateur

Prérequis : le serveur HTTPS avec Keycloak fonctionne déjà selon [SETUP.md](../SETUP.md),
le compte a ouvert Alcove au moins une fois, et une sauvegarde a été vérifiée.
Le script de provisionnement utilise le Keycloak existant et ne modifie aucun
client non géré. Il n'active pas l'enregistrement dynamique public de clients.

Obtenir un jeton d'administration Keycloak de courte durée dans un fichier
privé (`0600`), sans le copier dans le terminal ou dans une commande Git.
Le compte qui l'émet doit pouvoir gérer les clients et les scopes du realm;
le rôle limité à la gestion des utilisateurs ne suffit pas. Le répertoire
parent privé doit déjà exister; choisir un nouveau répertoire de sauvegarde et
un nouveau fichier de clients, car le script refuse de les écraser.
Depuis un environnement Python disposant des dépendances backend :

```sh
python scripts/provision_mcp_oauth.py \
  --server-url https://auth.example.org --realm alcove \
  --admin-token-file /CHEMIN/PRIVE/admin-token.json \
  provision --resource https://alcove.example.org/mcp \
  --codex-redirect-uri http://127.0.0.1:18765/callback \
  --chatgpt-redirect-uri 'https://chatgpt.com/connector/oauth/COPIER_ICI_LE_CALLBACK_AFFICHE' \
  --backup-dir /CHEMIN/PRIVE/nouveau-backup-oauth \
  --credentials-file /CHEMIN/PRIVE/nouveaux-clients.json
```

Remplacer `COPIER_ICI_LE_CALLBACK_AFFICHE` par l'URL exacte fournie par la
connexion ChatGPT en cours. Ne pas réutiliser le callback d'une autre connexion.
Chaque client est optionnel, mais au moins une URL de retour est requise.
Le fichier de clients contient le secret ChatGPT; ne pas le publier. Le script
sauvegarde la configuration précédente dans
`nouveau-backup-oauth/keycloak-mcp-before.json` et tente de la restaurer en cas
d'échec. Si la récupération automatique échoue aussi, réessayer avec cette
sauvegarde et la commande de rollback ci-dessous.

Ajouter au **même fichier d'environnement que le service Compose** :

```dotenv
MCP_OAUTH_ENABLED=true
MCP_OAUTH_RESOURCE=https://alcove.example.org/mcp
MCP_OAUTH_CLIENT_IDS=alcove-codex,alcove-chatgpt
MCP_OAUTH_WRITE_ENABLED=false
```

Remplacer l'origine d'exemple et ne conserver dans `MCP_OAUTH_CLIENT_IDS` que
les identifiants effectivement provisionnés. Si le service utilise un fichier
extérieur au dépôt, utiliser son chemin exact à la place de `.env` ci-dessous.
Puis recréer seulement le service `pad` avec son image épinglée :

```sh
docker compose --env-file .env -p alcove -f docker-compose.codicam.yml up -d --no-deps pad
```

Les clients exigent PKCE S256, utilisent des retours précis et présentent un
écran de consentement. Les jetons sont limités à cinq minutes avant
renouvellement. Le backend contrôle la signature, l'émetteur, l'audience MCP,
le client, l'expiration et les permissions; un jeton de session web Alcove
n'est pas un jeton MCP.

L'écriture OAuth nécessite **à la fois** `--allow-write` lors du provisionnement,
`MCP_OAUTH_WRITE_ENABLED=true` et le consentement au scope `alcove:write`.
La lecture reste la configuration initiale.

### Vérifications et retour arrière

- `GET /.well-known/oauth-protected-resource/mcp` annonce le bon émetteur et
  la bonne URL de ressource. Il ne contient aucune donnée utilisateur.
- Un POST JSON-RPC `initialize` sans authentification renvoie HTTP 401 et un
  `WWW-Authenticate` indiquant cette métadonnée.
- Un client connecté en lecture découvre cinq outils (lecture) et ne peut pas
  créer de notes ni ajouter de texte; un compte n'accède qu'à ses propres pads.
- Une mauvaise audience, un autre émetteur, un autre client ou un jeton expiré
  doit être rejeté. Tester les appels réels après le consentement utilisateur.

Pour retirer OAuth, restaurer les variables sauvegardées puis recréer `pad`.
Pour restaurer les clients Keycloak (avec un nouveau jeton admin valide) :

```sh
python scripts/provision_mcp_oauth.py \
  --server-url https://auth.example.org --realm alcove \
  --admin-token-file /CHEMIN/PRIVE/admin-token.json \
  rollback --snapshot /CHEMIN/PRIVE/nouveau-backup-oauth/keycloak-mcp-before.json
```

Les clés personnelles se révoquent individuellement depuis Alcove; pour
OAuth, supprimer l'autorisation ou la session cliente dans Keycloak. Un jeton
d'accès déjà émis peut rester valide jusqu'à son expiration de cinq minutes.

Références : [MCP dans Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[authentification des plugins OpenAI](https://developers.openai.com/plugins/build/auth),
[ajouter un serveur MCP personnalisé](https://developers.openai.com/api/docs/guides/custom-mcp-server).
