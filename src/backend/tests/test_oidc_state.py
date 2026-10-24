import json
from unittest.mock import AsyncMock

import pytest

from domain.session import Session


@pytest.mark.asyncio
async def test_oidc_state_uses_hashed_key_and_expires_after_ten_minutes():
    redis = type("Redis", (), {"setex": AsyncMock(return_value=True)})()
    session = Session(redis, {})

    assert await session.set_oauth_state("opaque-state", "session-id", "default")

    redis.setex.assert_awaited_once_with(
        Session._oauth_state_key("opaque-state"),
        600,
        json.dumps({"session_id": "session-id", "return_mode": "default"}),
    )
    assert "opaque-state" not in redis.setex.await_args.args[0]


@pytest.mark.asyncio
async def test_oidc_state_is_consumed_once():
    record = json.dumps({"session_id": "session-id", "return_mode": "popup"})
    redis = type("Redis", (), {"getdel": AsyncMock(side_effect=[record, None])})()
    session = Session(redis, {})

    assert await session.consume_oauth_state("opaque-state") == {
        "session_id": "session-id",
        "return_mode": "popup",
    }
    assert await session.consume_oauth_state("opaque-state") is None
    assert redis.getdel.await_count == 2
