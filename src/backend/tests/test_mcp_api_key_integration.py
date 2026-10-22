"""Integration test for the MCP API key lifecycle against a REAL PostgreSQL —
not the mocked AsyncSession used in test_mcp_api_key_service.py. This is the
only place that proves the SQLAlchemy model + FK/cascade + the service's
queries actually work together against a real engine, not just that the
service calls the mock the way we expect.

Skipped in the unit-test job unless ALCOVE_TEST_DATABASE_URL points at the
disposable integration database — never point it at anything you care about,
this test creates and deletes rows.

Local one-off setup used to develop/validate this test :
    docker run --rm -d --name alcove-migration-test \
      -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres -e POSTGRES_DB=pad \
      -p 15433:5432 postgres:16
    cd src/backend && POSTGRES_HOST=localhost POSTGRES_PORT=15433 \
      POSTGRES_USER=postgres POSTGRES_PASSWORD=postgres POSTGRES_DB=pad \
      python -m alembic upgrade head
    ALCOVE_TEST_DATABASE_URL=postgresql+asyncpg://postgres:postgres@localhost:15433/pad \
      python -m pytest tests/test_mcp_api_key_integration.py -v
"""
import asyncio
import os
from uuid import uuid4

import pytest

TEST_DATABASE_URL = os.getenv("ALCOVE_TEST_DATABASE_URL")

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not TEST_DATABASE_URL,
        reason=(
            "set ALCOVE_TEST_DATABASE_URL to a disposable Postgres "
            "(with alembic upgrade head already applied) to run this test"
        ),
    ),
]


def test_create_verify_revoke_and_cascade_delete_against_real_postgres():
    async def scenario():
        from sqlalchemy import delete, select
        from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
        from sqlalchemy.orm import sessionmaker

        from database.models.mcp_api_key_model import McpApiKey
        from database.models.user_model import UserStore
        from services.mcp_api_key_service import create_api_key, revoke_api_key, verify_api_key

        engine = create_async_engine(TEST_DATABASE_URL)
        Session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        owner_id = uuid4()
        suffix = owner_id.hex[:8]

        try:
            # Real owner row — the key's FK must point at a real user.
            async with Session() as session:
                session.add(UserStore(
                    id=owner_id,
                    username=f"itest-{suffix}",
                    email=f"itest-{suffix}@example.invalid",
                    email_verified=True,
                ))
                await session.commit()

            # create_api_key persists a row with a hashed secret, not the raw token.
            async with Session() as session:
                token, row = await create_api_key(session, owner_id, name="itest-key")
                public_id = row.public_id
                assert row.secret_hash != token
                assert token not in row.secret_hash

            # A fresh session (new request) can verify the token and resolve
            # the same owner — proves the round trip through the real table,
            # not just the mocked session in the unit tests.
            async with Session() as session:
                resolved = await verify_api_key(session, token)
                assert resolved == owner_id

            # last_used_at is only set once a valid verification happened.
            async with Session() as session:
                stored = (await session.execute(
                    select(McpApiKey).where(McpApiKey.public_id == public_id)
                )).scalar_one()
                assert stored.last_used_at is not None
                assert stored.revoked_at is None

            # Revoke, then confirm the same token is rejected afterwards.
            async with Session() as session:
                assert await revoke_api_key(session, public_id) is True

            async with Session() as session:
                assert await verify_api_key(session, token) is None

            # ON DELETE CASCADE : deleting the owner removes the key row too.
            async with Session() as session:
                await session.execute(delete(UserStore).where(UserStore.id == owner_id))
                await session.commit()

            async with Session() as session:
                remaining = (await session.execute(
                    select(McpApiKey).where(McpApiKey.public_id == public_id)
                )).scalar_one_or_none()
                assert remaining is None
        finally:
            # Belt-and-suspenders cleanup in case an assertion failed
            # before the cascade-delete step ran.
            async with Session() as session:
                await session.execute(delete(UserStore).where(UserStore.id == owner_id))
                await session.commit()
            await engine.dispose()

    asyncio.run(scenario())


def test_rotate_is_a_single_atomic_commit_against_real_postgres():
    """rotate_api_key must not leave a window where the old key is revoked
    but no replacement exists (or vice versa) — see the single session.commit()
    in services.mcp_api_key_service.rotate_api_key."""
    async def scenario():
        from sqlalchemy import delete, select
        from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
        from sqlalchemy.orm import sessionmaker

        from database.models.mcp_api_key_model import McpApiKey
        from database.models.user_model import UserStore
        from services.mcp_api_key_service import create_api_key, rotate_api_key

        engine = create_async_engine(TEST_DATABASE_URL)
        Session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        owner_id = uuid4()
        suffix = owner_id.hex[:8]

        try:
            async with Session() as session:
                session.add(UserStore(
                    id=owner_id, username=f"itest-rot-{suffix}",
                    email=f"itest-rot-{suffix}@example.invalid", email_verified=True,
                ))
                await session.commit()

            async with Session() as session:
                _, old_row = await create_api_key(session, owner_id, name="pre-rotate")
                old_public_id = old_row.public_id

            async with Session() as session:
                result = await rotate_api_key(session, old_public_id)
                assert result is not None
                _, new_row = result

            # Both the revoke of the old row and the insert of the new row
            # must be visible together — a crash mid-rotate should never
            # produce "old revoked, no new row" or "old still active, new
            # row also exists".
            async with Session() as session:
                rows = (await session.execute(
                    select(McpApiKey).where(McpApiKey.owner_id == owner_id)
                )).scalars().all()
                by_public_id = {r.public_id: r for r in rows}
                assert len(rows) == 2
                assert by_public_id[old_public_id].revoked_at is not None
                assert by_public_id[new_row.public_id].revoked_at is None
        finally:
            async with Session() as session:
                await session.execute(delete(UserStore).where(UserStore.id == owner_id))
                await session.commit()
            await engine.dispose()

    asyncio.run(scenario())


def test_a_token_never_resolves_to_a_different_owner_and_tools_stay_scoped():
    """End-to-end tenant isolation : a key minted for user A resolves only to
    A's owner_id, and mcp_router's own tool handler (unchanged by this auth
    work, but exercised here with a real DB) refuses to read a pad owned by
    B under that resolved id."""
    async def scenario():
        from sqlalchemy import delete, select
        from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
        from sqlalchemy.orm import sessionmaker

        from database.models.pad_model import PadStore
        from database.models.user_model import UserStore
        from routers.mcp_router import _tool_read_pad
        from services.mcp_api_key_service import create_api_key, verify_api_key

        engine = create_async_engine(TEST_DATABASE_URL)
        Session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        owner_a, owner_b = uuid4(), uuid4()
        suffix = owner_a.hex[:8]

        try:
            async with Session() as session:
                session.add(UserStore(
                    id=owner_a, username=f"itest-a-{suffix}",
                    email=f"itest-a-{suffix}@example.invalid", email_verified=True,
                ))
                session.add(UserStore(
                    id=owner_b, username=f"itest-b-{suffix}",
                    email=f"itest-b-{suffix}@example.invalid", email_verified=True,
                ))
                await session.commit()

            async with Session() as session:
                b_pad = PadStore(
                    owner_id=owner_b, display_name="B's private pad",
                    data={"content": "secret to B"}, pad_type="document",
                )
                session.add(b_pad)
                await session.commit()
                await session.refresh(b_pad)
                b_pad_id = b_pad.id

            async with Session() as session:
                token_a, _ = await create_api_key(session, owner_a, name="itest-a-key")

            async with Session() as session:
                resolved = await verify_api_key(session, token_a)
                assert resolved == owner_a
                assert resolved != owner_b

            # The resolved id is what mcp_router hands to every tool handler
            # — confirm the handler itself enforces per-owner scoping.
            async with Session() as session:
                try:
                    await _tool_read_pad({"pad_id": str(b_pad_id)}, resolved, session)
                    assert False, "A's token must not be able to read B's pad"
                except ValueError as e:
                    assert "not found or access denied" in str(e)
        finally:
            async with Session() as session:
                await session.execute(delete(PadStore).where(PadStore.owner_id.in_([owner_a, owner_b])))
                await session.execute(delete(UserStore).where(UserStore.id.in_([owner_a, owner_b])))
                await session.commit()
            await engine.dispose()

    asyncio.run(scenario())
