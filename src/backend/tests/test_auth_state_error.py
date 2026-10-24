from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.responses import RedirectResponse

from routers.auth_router import callback


@pytest.mark.asyncio
async def test_expired_or_replayed_oidc_state_returns_user_to_login_with_recovery_hint():
    session = SimpleNamespace(consume_oauth_state=AsyncMock(return_value=None))

    response = await callback(
        request=SimpleNamespace(),
        code="authorization-code",
        state="expired-state",
        session_domain=session,
    )

    assert isinstance(response, RedirectResponse)
    assert response.status_code == 303
    assert response.headers["location"] == "/?auth_error=state"
    session.consume_oauth_state.assert_awaited_once_with("expired-state")
