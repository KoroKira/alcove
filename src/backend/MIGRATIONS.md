# Migrations de base de données (Alembic)

Le schéma est désormais versionné avec **Alembic**. Fini les `ALTER TABLE` à la
main : chaque changement de schéma est un fichier de migration reviewable et
rejouable.

Toutes les commandes se lancent depuis `src/backend/` avec les variables
`POSTGRES_*` chargées (elles le sont automatiquement via `.env.local` quand
l'app tourne ; en manuel : `set -a; source ../../.env.local; set +a`).

## Ajouter un changement de schéma

1. Modifie le modèle SQLAlchemy (`database/models/*.py`).
2. Génère la migration :
   ```bash
   alembic revision --autogenerate -m "description courte"
   ```
3. **Relis** le fichier généré dans `migrations/versions/` (l'autogenerate se
   trompe parfois sur les renommages/types — corrige à la main si besoin).
4. Applique :
   ```bash
   alembic upgrade head
   ```

## Commandes utiles

| Commande | Effet |
|---|---|
| `alembic current` | Révision actuelle de la DB |
| `alembic history` | Historique des migrations |
| `alembic check` | Vérifie qu'aucune dérive modèle↔DB ne subsiste |
| `alembic upgrade head` | Applique les migrations en attente |
| `alembic downgrade -1` | Revient d'une migration |
| `alembic stamp head` | Marque la DB à jour **sans** exécuter (installs fraîches) |

## Installation fraîche (nouvelle DB)

`init_db()` crée le schéma de base via `create_all` au démarrage, puis il faut
marquer la DB comme étant à la dernière révision :

```bash
alembic stamp head
```

Ensuite, `alembic upgrade head` appliquera uniquement les futures migrations.

## Historique

- `5396c6b1f129` — baseline (schéma existant bootstrapé via create_all)
- `df7edf54b56b` — réconciliation des noms d'index + type de la colonne `tags`
