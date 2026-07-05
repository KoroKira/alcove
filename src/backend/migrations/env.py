"""Alembic environment — async-aware, wired to the app's models and schema.

Reuses the app's DATABASE_URL (built from POSTGRES_* env vars) and Base.metadata
so autogenerate sees every model. Targets the `pad_ws` schema.
"""
import asyncio
from logging.config import fileConfig

from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config
from sqlalchemy.schema import CreateSchema

from alembic import context

# Import the app's metadata + connection details (single source of truth).
from database.database import DATABASE_URL
from database.models import Base, SCHEMA_NAME

config = context.config
config.set_main_option("sqlalchemy.url", DATABASE_URL)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def _include_object(obj, name, type_, reflected, compare_to):
    # Only manage objects in our schema.
    if type_ == "table":
        return getattr(obj, "schema", None) in (SCHEMA_NAME, None)
    return True


def do_run_migrations(connection: Connection) -> None:
    connection.execute(CreateSchema(SCHEMA_NAME, if_not_exists=True))
    connection.commit()
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        version_table_schema=SCHEMA_NAME,
        include_schemas=True,
        include_object=_include_object,
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


def run_migrations_offline() -> None:
    context.configure(
        url=DATABASE_URL,
        target_metadata=target_metadata,
        version_table_schema=SCHEMA_NAME,
        include_schemas=True,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_async_migrations())
