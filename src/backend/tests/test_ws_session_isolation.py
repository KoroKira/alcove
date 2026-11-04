"""The WebSocket access re-check must not share a database session with the message handler."""
import asyncio
import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from application.api_tokens import ApiTokenService
from application.principal import Principal
from cache import RedisClient
from database.models import PadMemberStore, PadStore, UserStore
from routers import ws_router


@pytest.mark.integration
async def test_access_check_uses_its_own_session_and_closes_it(
    integration_session, integration_database_url, monkeypatch,
):
    owner_id = uuid4()
    integration_session.add(UserStore(id=owner_id, username=f"ws-iso-{owner_id}", email=f"{owner_id}@example.test"))
    pad = PadStore(id=uuid4(), owner_id=owner_id, display_name="iso", data={"elements": []},
                   sharing_policy="private", whitelist=[], pad_type="canvas")
    integration_session.add(pad)
    await integration_session.flush()
    integration_session.add(PadMemberStore(pad_id=pad.id, user_id=owner_id, role="owner"))
    await integration_session.commit()
    _token, raw = await ApiTokenService(integration_session).create(
        Principal(id=owner_id), name="iso", scopes=["pads:read", "pads:write"], expires_in_days=30)

    engine = create_async_engine(integration_database_url, poolclass=NullPool)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    created, closed = [], []

    def tracked_session():
        session = factory()
        original_close = session.close

        async def close():
            closed.append(session)
            await original_close()
        session.close = close
        created.append(session)
        return session

    async def override_session():
        async with factory() as session:
            yield session

    class FakeWorker:
        worker_id = "iso-worker"
        async def start_processing_pad(self, _pad_id): return True
        async def save_pad(self, _pad_id): return None

    async def connected_users():
        return []
    fake_pad = SimpleNamespace(id=pad.id, owner_id=owner_id, display_name="iso", data=pad.data, pad_type="canvas",
                               sharing_policy="private", whitelist=[], get_connected_users=connected_users)

    seen = {"handler": [], "auth": []}
    real_handle = ws_router._handle_received_data

    async def spy_handle(raw_data, pad_id, user, redis_client, stream_key, connection_id, session):
        seen["handler"].append(session)
        return await real_handle(raw_data, pad_id, user, redis_client, stream_key, connection_id, session)

    async def spy_auth(websocket, pad_id, user, redis_client, stream_key, connection_id, session):
        seen["auth"].append(session)
        await asyncio.sleep(3600)          # never re-check during this short test

    app = FastAPI()
    app.include_router(ws_router.ws_router)
    app.dependency_overrides[ws_router.get_session] = override_session
    monkeypatch.setattr(ws_router, "async_session", tracked_session)
    monkeypatch.setattr(ws_router.Pad, "get_by_id", AsyncMock(return_value=fake_pad))
    monkeypatch.setattr(ws_router.CanvasWorker, "get_instance", AsyncMock(return_value=FakeWorker()))
    monkeypatch.setattr(ws_router, "_handle_received_data", spy_handle)
    monkeypatch.setattr(ws_router, "periodic_auth_check", spy_auth)
    monkeypatch.setattr(ws_router, "PAD_DEV_MODE", True)
    await RedisClient.close()

    try:
        with TestClient(app) as client:
            with client.websocket_connect(f"/ws/pad/{pad.id}", headers={"Authorization": f"Bearer {raw}"}) as websocket:
                assert websocket.receive_json()["type"] == "connected"
                websocket.send_json({"type": "pointer_update", "data": {"x": 1, "y": 2}})
                time.sleep(0.3)
            time.sleep(0.3)
    finally:
        await RedisClient.close()
        await engine.dispose()

    assert len(seen["auth"]) == 1 and seen["handler"], seen
    auth_session = seen["auth"][0]
    assert all(auth_session is not handler_session for handler_session in seen["handler"])
    assert any(auth_session is s for s in closed), "the access-check session must be closed on disconnect"
