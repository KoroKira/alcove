"""Fixtures for integration tests backed by real PostgreSQL and Redis."""

import os
from collections.abc import AsyncIterator

import pytest
from redis import asyncio as aioredis
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool


def _required_url(name: str) -> str:
    value = os.getenv(name)
    if not value:
        pytest.skip(f"{name} is not configured; run the PostgreSQL/Redis integration job")
    return value


@pytest.fixture(scope="session")
def integration_database_url() -> str:
    return _required_url("TEST_DATABASE_URL")


@pytest.fixture(scope="session")
def integration_redis_url() -> str:
    return _required_url("TEST_REDIS_URL")


@pytest.fixture
async def integration_engine(integration_database_url: str) -> AsyncIterator[AsyncEngine]:
    engine = create_async_engine(integration_database_url, poolclass=NullPool)
    try:
        async with engine.connect() as connection:
            await connection.exec_driver_sql("SELECT 1")
        yield engine
    finally:
        await engine.dispose()


@pytest.fixture
async def integration_session(integration_engine: AsyncEngine) -> AsyncIterator[AsyncSession]:
    factory = async_sessionmaker(integration_engine, expire_on_commit=False)
    async with factory() as session:
        yield session
        await session.rollback()


@pytest.fixture
async def integration_redis(integration_redis_url: str) -> AsyncIterator[aioredis.Redis]:
    client = aioredis.from_url(integration_redis_url, decode_responses=True)
    await client.ping()
    try:
        yield client
    finally:
        await client.aclose()
