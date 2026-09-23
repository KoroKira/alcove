"""Prepare a disposable legacy-shaped database for migration CI."""

import asyncio
import os
import sys
from pathlib import Path
from uuid import UUID

from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.schema import CreateSchema

BACKEND = Path(__file__).resolve().parents[1] / "src" / "backend"
sys.path.insert(0, str(BACKEND))

from database.database import async_session, engine  # noqa: E402
from database.models import Base, PadStore, UserStore  # noqa: E402

OWNER_ID = UUID("10000000-0000-0000-0000-000000000001")
MEMBER_ID = UUID("10000000-0000-0000-0000-000000000002")
PAD_ID = UUID("20000000-0000-0000-0000-000000000001")


async def prepare() -> None:
    if os.getenv("ALLOW_TEST_DB_RESET") != "true" or not os.getenv("POSTGRES_DB", "").startswith("alcove_"):
        raise SystemExit("Refusing to reset a non-test database")

    async with engine.begin() as connection:
        await connection.execute(CreateSchema("pad_ws", if_not_exists=True))
        await connection.run_sync(Base.metadata.create_all)
        for table in ("idempotency_records", "audit_events", "api_tokens", "pad_members"):
            await connection.execute(text(f"DROP TABLE IF EXISTS pad_ws.{table} CASCADE"))
        await connection.execute(text("DELETE FROM pad_ws.pads WHERE id = '20000000-0000-0000-0000-000000000001'"))
        await connection.execute(text("DELETE FROM pad_ws.users WHERE id IN ('10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002')"))
        await connection.execute(text("DROP TABLE IF EXISTS pad_ws.alembic_version CASCADE"))

    async with async_session() as session:
        session.add_all([
            UserStore(id=OWNER_ID, username="legacy-owner", email="legacy-owner@example.test"),
            UserStore(id=MEMBER_ID, username="legacy-member", email="legacy-member@example.test"),
            PadStore(
                id=PAD_ID,
                owner_id=OWNER_ID,
                display_name="legacy pad",
                data={"elements": []},
                sharing_policy="whitelist",
                whitelist=[MEMBER_ID],
            ),
        ])
        await session.commit()

    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(prepare())
    # Alembic's async env owns its own event loop; invoke it only after the
    # async SQLAlchemy setup loop has fully closed.
    os.chdir(BACKEND)
    config = Config(str(BACKEND / "alembic.ini"))
    # Keep this helper callable from either the repository root or backend
    # directory; Alembic otherwise resolves a relative script_location before
    # the working-directory change in some installations.
    config.set_main_option("script_location", str(BACKEND / "migrations"))
    command.stamp(config, "c8d1f2a3b4e5")
