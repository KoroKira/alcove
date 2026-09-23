import json
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

from routers import ws_router
import pytest


def test_public_reader_cannot_publish_scene_mutation(monkeypatch):
    pad_id = uuid4()
    user = SimpleNamespace(id=uuid4())
    public_pad = SimpleNamespace(owner_id=uuid4(), sharing_policy="public", whitelist=[])
    session = AsyncMock()
    session.get.return_value = public_pad
    publish = AsyncMock()
    monkeypatch.setattr(ws_router, "publish_event_to_redis", publish)

    accepted = asyncio.run(ws_router._handle_received_data(
        json.dumps({"type": "scene_update", "data": {"elements": []}}),
        pad_id,
        user,
        AsyncMock(),
        "stream",
        "connection",
        session,
    ))

    assert accepted is False
    publish.assert_not_awaited()


def test_public_reader_can_still_publish_pointer_presence(monkeypatch):
    pad_id = uuid4()
    user = SimpleNamespace(id=uuid4())
    publish_pointer = AsyncMock()
    monkeypatch.setattr(ws_router, "publish_pointer_update", publish_pointer)

    accepted = asyncio.run(ws_router._handle_received_data(
        json.dumps({"type": "pointer_update", "data": {"x": 1, "y": 2}}),
        pad_id,
        user,
        AsyncMock(),
        "stream",
        "connection",
        AsyncMock(),
    ))

    assert accepted is True
    publish_pointer.assert_awaited_once()


@pytest.mark.parametrize(
    ("role", "allowed"),
    [("owner", True), ("editor", True), ("viewer", False), ("public", False)],
)
def test_websocket_mutations_use_central_authorization(monkeypatch, role, allowed):
    pad_id = uuid4()
    user = SimpleNamespace(id=uuid4())
    pad = SimpleNamespace(owner_id=uuid4(), sharing_policy="private", whitelist=[])
    session = AsyncMock()
    session.get.return_value = pad
    monkeypatch.setattr(ws_router, "authorize_write", AsyncMock(return_value=allowed))
    publish = AsyncMock()
    monkeypatch.setattr(ws_router, "publish_event_to_redis", publish)

    accepted = asyncio.run(ws_router._handle_received_data(
        json.dumps({"type": "scene_update", "data": {"role": role}}),
        pad_id,
        user,
        AsyncMock(),
        "stream",
        "connection",
        session,
    ))

    assert accepted is allowed
    if allowed:
        publish.assert_awaited_once()
    else:
        publish.assert_not_awaited()
    ws_router.authorize_write.assert_awaited_once()
