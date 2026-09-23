"""Verify the legacy whitelist was backfilled into pad_members in CI."""

import asyncio
import sys
from pathlib import Path

from sqlalchemy import text

BACKEND = Path(__file__).resolve().parents[1] / "src" / "backend"
sys.path.insert(0, str(BACKEND))

from database.database import engine  # noqa: E402

OWNER_ID = "10000000-0000-0000-0000-000000000001"
MEMBER_ID = "10000000-0000-0000-0000-000000000002"
PAD_ID = "20000000-0000-0000-0000-000000000001"


async def verify() -> None:
    async with engine.connect() as connection:
        rows = (await connection.execute(text(
            "SELECT user_id::text, role FROM pad_ws.pad_members "
            "WHERE pad_id = :pad_id ORDER BY role"
        ), {"pad_id": PAD_ID})).all()
    assert (OWNER_ID, "owner") in rows, rows
    assert (MEMBER_ID, "editor") in rows, rows
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(verify())
