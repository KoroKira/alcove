"""
Database connection and session management.
"""

import logging
import os
from typing import AsyncGenerator
from urllib.parse import quote_plus as urlquote

from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from sqlalchemy.schema import CreateSchema
from fastapi import Depends

from .models import Base, SCHEMA_NAME

from dotenv import load_dotenv

logger = logging.getLogger(__name__)

load_dotenv()

# PostgreSQL connection configuration
DB_USER = os.getenv('POSTGRES_USER', 'postgres')
DB_PASSWORD = os.getenv('POSTGRES_PASSWORD', 'postgres')
DB_NAME = os.getenv('POSTGRES_DB', 'pad')
DB_HOST = os.getenv('POSTGRES_HOST', 'localhost')
DB_PORT = os.getenv('POSTGRES_PORT', '5432')

# SQLAlchemy async database URL
DATABASE_URL = f"postgresql+asyncpg://{DB_USER}:{urlquote(DB_PASSWORD)}@{DB_HOST}:{DB_PORT}/{DB_NAME}"

# Create async engine
engine = create_async_engine(
    DATABASE_URL,
    echo=False,
    # A dashboard used to fan out one request per document preview. Keep the
    # API inside a deliberately small budget so a burst cannot consume all of
    # PostgreSQL's connections and take unrelated features down with it.
    pool_size=int(os.getenv("DB_POOL_SIZE", "5")),
    max_overflow=int(os.getenv("DB_MAX_OVERFLOW", "5")),
    pool_timeout=15,
    pool_pre_ping=True,
)

# Create async session factory
async_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def init_db() -> None:
    """Bring the database to a runnable state.

    On a fresh DB (no tables at all) we create the schema and every table from
    the ORM metadata — that keeps the local-first "just launch it" flow
    working without asking the user to run alembic first. On a DB that
    already has our tables, we do NOTHING here: Alembic (invoked separately
    via `alembic upgrade head` in the deploy scripts) is the single source of
    truth for schema evolution. This kills the previous drift where
    `init_db` shipped its own `ALTER TABLE ADD COLUMN IF NOT EXISTS` while
    Alembic also tracked the same columns.
    """
    from sqlalchemy import inspect

    try:
        async with engine.begin() as conn:
            await conn.execute(CreateSchema(SCHEMA_NAME, if_not_exists=True))

            def _needs_bootstrap(sync_conn) -> bool:
                insp = inspect(sync_conn)
                return "pads" not in insp.get_table_names(schema=SCHEMA_NAME)

            fresh = await conn.run_sync(_needs_bootstrap)
            if fresh:
                logger.info("Fresh database detected — bootstrapping schema from ORM metadata")
                await conn.run_sync(Base.metadata.create_all)
            else:
                logger.debug("Database already provisioned — skipping create_all (Alembic owns migrations)")

    except Exception:
        logger.exception("Error initializing database")
        raise
    

async def get_session() -> AsyncGenerator[AsyncSession, None]:
    """Get a database session"""
    async with async_session() as session:
        try:
            yield session
        finally:
            await session.close()
