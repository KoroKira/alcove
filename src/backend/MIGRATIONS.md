# Migrations de base de données (Alembic)

Le schéma est versionné avec Alembic. `init_db()` conserve uniquement le
bootstrap local d'une base réellement vide ; il ne modifie jamais une base
existante. Les changements de schéma passent par des révisions reviewables.

Toutes les commandes se lancent depuis `src/backend/` avec les variables
`POSTGRES_*` chargées. `env.py` est la source unique de l'URL SQLAlchemy.

## Procédure normale

Avant toute migration sur une base contenant des données :

```bash
cd src/backend
DB_BACKUP_DIR=/srv/alcove/backups REQUIRE_DB_BACKUP=true \
  ../../scripts/db-migrate.sh
```

La procédure crée et vérifie un dump PostgreSQL custom, applique
`alembic upgrade head`, exécute `alembic check` pour détecter une dérive
modèle↔base, puis affiche la révision courante.

Pour une base de test locale, `docker-compose.test.yml` fournit PostgreSQL et
Redis sans volume persistant. Le script `db-migrate.sh` attend alors
`DB_BOOTSTRAP_FRESH=true` pour une base neuve : il exécute le bootstrap ORM,
puis `alembic stamp head`. Cette étape est volontairement explicite car la
révision historique `5396c6b1f129` représente les installations déjà
bootstrapées par `create_all` et ne recrée pas rétroactivement tout l'ancien
schéma.

La suite locale complète se lance depuis la racine avec
`./scripts/test-integration.sh`. Elle démarre les conteneurs éphémères,
exécute les migrations, `alembic check`, puis les tests contre les deux
services réels.

## Rollback et restauration

Un rollback peut supprimer des données introduites par une migration. Il doit
être précédé d'un backup :

```bash
cd src/backend
DB_BACKUP_DIR=/srv/alcove/backups \
  ROLLBACK_TARGET=-1 ../../scripts/db-rollback.sh
```

La migration `e1a7b3c9d2f4` (membres de pad) est réversible au niveau du
schéma, mais un downgrade après modification de membres perd ces rôles car les
colonnes legacy ne peuvent pas les représenter. Dans ce cas, restaurer le dump
dans une base de secours, vérifier les données, puis planifier la restauration
production avec une fenêtre d'indisponibilité ; ne jamais exécuter
`pg_restore --clean` sur une base de production sans validation explicite.

La migration `f2b8c4d0e5a6` ajoute les credentials externes (`api_tokens`), les
événements d'audit (`audit_events`) et les réservations d'idempotence
(`idempotency_records`). Le secret brut d'un token n'est jamais écrit en base
et le downgrade supprime ces trois tables : il doit donc être précédé d'un
backup et d'une révocation/rotation planifiée des tokens concernés.

## Vérifications CI

La CI exécute avec de vrais services PostgreSQL et Redis :

- base fraîche : bootstrap contrôlé, `stamp head`, `alembic check` ;
- base existante : schéma legacy préparé, données owner/whitelist semées,
  `stamp c8d1f2a3b4e5`, puis upgrade et vérification du backfill ;
- tests d'intégration : connectivité réelle, matrice des rôles et smoke test
  Redis, tokens externes, audit, idempotence et contrôle optimiste.

## Ajouter une migration

1. Modifie le modèle SQLAlchemy.
2. Génère puis relis la révision :

   ```bash
   alembic revision --autogenerate -m "description courte"
   ```

3. Corrige manuellement les renommages, contraintes, defaults et backfills.
4. Teste fresh/existing, upgrade/downgrade et `alembic check` avant déploiement.
