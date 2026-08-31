# Administration des comptes Alcove

La création publique de comptes est désactivée. Les visiteurs sont invités à
écrire à l'adresse configurée par `REGISTRATION_CONTACT_EMAIL`; l'opérateur
décide ensuite de créer ou non leur compte.

## Ouvrir la console

Depuis Alcove, ouvrir le profil puis cliquer sur **Gérer les comptes
utilisateurs**, ou aller directement sur :

<https://auth-alcove.codicam.fr/admin/alcove/console/>

Se connecter avec le compte opérateur `guilhem`. Ses permissions Keycloak sont
limitées à la consultation et à la gestion des utilisateurs du realm `alcove`.
Il ne possède pas les droits permettant de modifier les clients OIDC ou les
clés du realm.

## Créer un compte

1. Ouvrir **Users**, puis **Create new user**.
2. Renseigner `Username`, `Email`, `First name` et `Last name`.
3. Laisser **Enabled** activé et enregistrer.
4. Dans **Credentials**, choisir **Set password**.
5. Définir un mot de passe initial robuste et laisser **Temporary** activé.
6. Transmettre séparément l'identifiant et le mot de passe initial à la
   personne. Elle devra le remplacer lors de sa première connexion.

L'utilisateur applicatif et son espace privé sont créés au premier callback de
connexion réussi. Il ne reçoit jamais les pads, conversations ou embeddings
d'un autre compte.

## Suspendre ou réactiver un compte

Dans **Users**, ouvrir le compte puis désactiver **Enabled**. Préférer cette
action à la suppression : elle bloque la prochaine authentification tout en
préservant l'identité et les données. Réactiver le même interrupteur pour rendre
l'accès de nouveau possible.

Les sessions Alcove déjà ouvertes expirent selon leur TTL. Pour une révocation
immédiate, utiliser aussi l'onglet **Sessions** de l'utilisateur et fermer ses
sessions actives.

## Réinitialiser le mot de passe

Dans **Credentials**, utiliser **Reset password**, saisir un mot de passe
initial robuste et activer **Temporary**. Ne jamais envoyer ce mot de passe dans
le même message que l'identifiant si un canal séparé est disponible.

## Supprimer un compte

La commande **Delete user** supprime l'identité Keycloak et bloque
définitivement sa connexion. Elle ne supprime volontairement pas ses données
Alcove : pads, fichiers, historique, conversations et embeddings restent
associés à son UUID pour éviter toute perte accidentelle.

Une recréation avec le même nom reçoit un nouvel UUID et ne récupère donc pas
automatiquement les anciennes données. Pour une suppression complète ou une
réattribution, effectuer d'abord une sauvegarde puis une opération PostgreSQL
contrôlée. En usage courant, suspendre le compte est la procédure recommandée.
