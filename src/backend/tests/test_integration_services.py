"""Integration checks against real PostgreSQL and Redis services."""

import json
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI
from fastapi import WebSocketDisconnect
from fastapi.testclient import TestClient
from redis import asyncio as aioredis
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from application.api_tokens import ApiTokenService
from application.authorization import PadAction, authorize
from application.errors import ConflictError, PermissionDeniedError
from application.membership import MembershipService
from application.pad_writes import PadWriteService
from application.principal import Principal
from application.pads import PadQueryService
from database.models import AuditEventStore, PadMemberStore, PadStore, UserStore
from cache import RedisClient
from domain.pad import Pad
from routers import ws_router
from api.v1.router import v1_router


@pytest.mark.integration
async def test_postgresql_and_redis_are_reachable(integration_session, integration_redis):
    result = await integration_session.execute(text("SELECT 1"))
    assert result.scalar_one() == 1

    key = f"alcove:test:{uuid4()}"
    await integration_redis.set(key, "ok", ex=30)
    assert await integration_redis.get(key) == "ok"
    await integration_redis.delete(key)


@pytest.mark.integration
async def test_pad_members_permission_matrix(integration_session, integration_redis, monkeypatch):
    owner, editor, viewer, stranger = [uuid4() for _ in range(4)]
    users = [
        UserStore(id=user_id, username=f"user-{user_id}", email=f"{user_id}@example.test")
        for user_id in (owner, editor, viewer, stranger)
    ]
    pad = PadStore(
        id=uuid4(),
        owner_id=owner,
        display_name="integration pad",
        data={"elements": []},
        sharing_policy="private",
        whitelist=[],
    )
    integration_session.add_all(users + [pad])
    await integration_session.flush()
    integration_session.add_all([
        PadMemberStore(pad_id=pad.id, user_id=owner, role="owner"),
        PadMemberStore(pad_id=pad.id, user_id=editor, role="editor"),
        PadMemberStore(pad_id=pad.id, user_id=viewer, role="viewer"),
    ])
    await integration_session.commit()

    expected = {
        owner: {PadAction.READ: True, PadAction.WRITE: True, PadAction.SHARE: True},
        editor: {PadAction.READ: True, PadAction.WRITE: True, PadAction.SHARE: False},
        viewer: {PadAction.READ: True, PadAction.WRITE: False, PadAction.SHARE: False},
        stranger: {PadAction.READ: False, PadAction.WRITE: False, PadAction.SHARE: False},
    }
    for user_id, actions in expected.items():
        for action, allowed in actions.items():
            assert await authorize(integration_session, user_id, pad, action) is allowed

    public_pad = PadStore(
        id=uuid4(),
        owner_id=owner,
        display_name="public integration pad",
        data={"elements": []},
        sharing_policy="public",
        whitelist=[editor],
    )
    integration_session.add(public_pad)
    await integration_session.commit()
    assert await authorize(integration_session, stranger, public_pad, PadAction.READ)
    assert not await authorize(integration_session, stranger, public_pad, PadAction.WRITE)
    assert not await authorize(integration_session, stranger, public_pad, PadAction.SHARE)

    # Exercise the actual WebSocket mutation path against the same
    # authorization service and a real Redis stream.
    ws_cases = [(owner, pad, True), (editor, pad, True), (viewer, pad, False), (stranger, public_pad, False)]
    for user_id, resource, allowed in ws_cases:
        monkeypatch.setattr(ws_router.Pad, "get_by_id", AsyncMock(return_value=resource))
        stream = f"alcove:integration:ws:{uuid4()}"
        accepted = await ws_router._handle_received_data(
            json.dumps({"type": "scene_update", "data": {"elements": []}}),
            resource.id,
            SimpleNamespace(id=user_id),
            integration_redis,
            stream,
            str(uuid4()),
            integration_session,
        )
        assert accepted is allowed
        assert await integration_redis.xlen(stream) == (1 if allowed else 0)
        await integration_redis.delete(stream)


@pytest.mark.integration
async def test_scoped_api_token_is_hashed_audited_and_revocable(integration_session):
    user_id = uuid4()
    integration_session.add(UserStore(
        id=user_id,
        username=f"token-user-{user_id}",
        email=f"{user_id}@example.test",
    ))
    await integration_session.flush()
    browser = Principal(id=user_id)

    token, raw = await ApiTokenService(integration_session).create(
        browser,
        name="CLI read token",
        scopes=["me:read", "pads:read", "search:read"],
        expires_in_days=30,
    )
    assert raw.startswith("alcove_at_")
    assert token.token_hash not in raw
    assert token.token_prefix in raw

    authenticated = await ApiTokenService(integration_session).authenticate(raw)
    assert authenticated is not None
    assert authenticated.is_api_token
    assert authenticated.has_scope("pads:read")
    assert not authenticated.has_scope("pads:write")
    assert token.last_used_at is not None

    # This is the external-client contract: the token can call the versioned
    # API directly, without a browser cookie or frontend bootstrap.
    app = FastAPI()
    app.include_router(v1_router)
    response = TestClient(app).get(
        "/api/v1/me",
        headers={"Authorization": f"Bearer {raw}"},
    )
    assert response.status_code == 200
    assert response.json()["id"] == str(user_id)

    actions = (await integration_session.execute(
        select(AuditEventStore.action).where(AuditEventStore.actor_user_id == user_id)
    )).scalars().all()
    assert "api_token.created" in actions
    assert "api_token.used" in actions
    audit_payloads = (await integration_session.execute(
        select(AuditEventStore.event_metadata).where(AuditEventStore.actor_user_id == user_id)
    )).scalars().all()
    assert raw not in json.dumps(audit_payloads, default=str)

    assert await ApiTokenService(integration_session).revoke(browser, token.id)
    assert await ApiTokenService(integration_session).authenticate(raw) is None


@pytest.mark.integration
async def test_pad_write_service_is_idempotent_and_uses_cas(integration_session):
    owner_id, editor_id, viewer_id = uuid4(), uuid4(), uuid4()
    integration_session.add_all([
        UserStore(id=owner_id, username=f"owner-{owner_id}", email=f"{owner_id}@example.test"),
        UserStore(id=editor_id, username=f"editor-{editor_id}", email=f"{editor_id}@example.test"),
        UserStore(id=viewer_id, username=f"viewer-{viewer_id}", email=f"{viewer_id}@example.test"),
    ])
    await integration_session.flush()
    writes = PadWriteService(integration_session)
    owner = Principal(id=owner_id)

    first, replayed = await writes.create_pad(
        owner,
        display_name="API pad",
        pad_type="document",
        content="hello",
        idempotency_key="create-api-pad-1",
    )
    second, replayed_second = await writes.create_pad(
        owner,
        display_name="API pad",
        pad_type="document",
        content="hello",
        idempotency_key="create-api-pad-1",
    )
    assert replayed is False
    assert replayed_second is True
    assert first["id"] == second["id"]

    pad_id = UUID(first["id"])
    await MembershipService(integration_session).add_member(owner, pad_id, editor_id, "editor")
    await MembershipService(integration_session).add_member(owner, pad_id, viewer_id, "viewer")
    pad = (await integration_session.execute(select(PadStore).where(PadStore.id == pad_id))).scalar_one()
    expected = pad.updated_at

    editor = Principal(id=editor_id)
    updated, _ = await writes.update_data(
        editor,
        pad_id,
        {"content": "edited"},
        expected,
        "editor-update-1",
    )
    replay, replayed = await writes.update_data(
        editor,
        pad_id,
        {"content": "edited"},
        expected,
        "editor-update-1",
    )
    assert replayed is True
    assert replay == updated

    with pytest.raises(PermissionDeniedError):
        await writes.update_data(Principal(id=viewer_id), pad_id, {"content": "nope"}, expected)

    with pytest.raises(ConflictError):
        await writes.update_data(editor, pad_id, {"content": "stale"}, expected)


@pytest.mark.integration
async def test_membership_is_authoritative_for_shared_listing_search_and_content(integration_session):
    owner_id, editor_id, viewer_id, outsider_id, legacy_owner_id = [uuid4() for _ in range(5)]
    integration_session.add_all([
        UserStore(id=user_id, username=f"access-{user_id}", email=f"{user_id}@example.test")
        for user_id in (owner_id, editor_id, viewer_id, outsider_id, legacy_owner_id)
    ])
    private_pad = PadStore(
        id=uuid4(), owner_id=owner_id, display_name="member shared needle",
        data={"content": "member shared needle body"}, sharing_policy="private",
        whitelist=[outsider_id], pad_type="document",
    )
    public_pad = PadStore(
        id=uuid4(), owner_id=owner_id, display_name="public shared needle",
        data={"content": "public shared needle body"}, sharing_policy="public",
        whitelist=[], pad_type="document",
    )
    stale_pad = PadStore(
        id=uuid4(), owner_id=owner_id, display_name="stale whitelist needle",
        data={"content": "must not be visible to outsider"}, sharing_policy="private",
        whitelist=[outsider_id], pad_type="document",
    )
    legacy_pad = PadStore(
        id=uuid4(), owner_id=legacy_owner_id, display_name="legacy shared needle",
        data={"content": "legacy compatibility body"}, sharing_policy="whitelist",
        whitelist=[outsider_id], pad_type="document",
    )
    integration_session.add_all([private_pad, public_pad, stale_pad, legacy_pad])
    await integration_session.flush()
    integration_session.add_all([
        PadMemberStore(pad_id=private_pad.id, user_id=owner_id, role="owner"),
        PadMemberStore(pad_id=private_pad.id, user_id=editor_id, role="editor"),
        PadMemberStore(pad_id=private_pad.id, user_id=viewer_id, role="viewer"),
        PadMemberStore(pad_id=public_pad.id, user_id=owner_id, role="owner"),
        # A migrated pad with a stale legacy whitelist: membership wins.
        PadMemberStore(pad_id=stale_pad.id, user_id=owner_id, role="owner"),
    ])
    await integration_session.commit()

    query = PadQueryService(integration_session)
    test_pad_ids = {private_pad.id, public_pad.id, stale_pad.id, legacy_pad.id}
    expected = {
        owner_id: {private_pad.id, public_pad.id, stale_pad.id},
        editor_id: {private_pad.id, public_pad.id},
        viewer_id: {private_pad.id, public_pad.id},
        outsider_id: {public_pad.id, legacy_pad.id},
    }
    for user_id, expected_ids in expected.items():
        listed = await query.list_accessible_stores(user_id)
        assert {pad.id for pad in listed if pad.id in test_pad_ids} == expected_ids
        results = await query.search(user_id, "shared needle", limit=20)
        assert {UUID(row["pad_id"]) for row in results if UUID(row["pad_id"]) in test_pad_ids} == {
            pad_id for pad_id in expected_ids
            if pad_id in {private_pad.id, public_pad.id, legacy_pad.id}
        }

    anonymous = await query.list_accessible_stores(None)
    assert {pad.id for pad in anonymous if pad.id in test_pad_ids} == {public_pad.id}
    assert await authorize(integration_session, None, public_pad, PadAction.READ)
    assert not await authorize(integration_session, None, private_pad, PadAction.READ)

    assert (await query.get_pad_content(private_pad.id, editor_id))[0].id == private_pad.id
    assert (await query.get_pad_content(private_pad.id, viewer_id))[0].id == private_pad.id
    with pytest.raises(PermissionDeniedError):
        await query.get_pad_content(private_pad.id, outsider_id)
    with pytest.raises(PermissionDeniedError):
        await query.get_pad_content(stale_pad.id, outsider_id)


@pytest.mark.integration
async def test_document_reads_refresh_stale_cache_without_starting_canvas_worker(
    integration_session, integration_redis, monkeypatch
):
    owner_id = uuid4()
    pad_id = uuid4()
    old_updated_at = datetime.now(timezone.utc) - timedelta(minutes=2)
    new_updated_at = old_updated_at + timedelta(seconds=1)
    owner = UserStore(
        id=owner_id,
        username=f"cache-owner-{owner_id}",
        email=f"{owner_id}@example.test",
    )
    row = PadStore(
        id=pad_id,
        owner_id=owner_id,
        display_name="document cache regression",
        data={"content": "original", "format": "markdown"},
        sharing_policy="private",
        whitelist=[],
        pad_type="document",
        updated_at=old_updated_at,
    )
    integration_session.add_all([owner, row])
    await integration_session.commit()
    await integration_session.refresh(row)

    # Pad.create used to start a canvas worker before callers set the final
    # pad type. Creation is now passive until an actual canvas read/connection.
    ensure_worker = AsyncMock(return_value=True)
    monkeypatch.setattr(Pad, "ensure_worker", ensure_worker)
    monkeypatch.setattr(RedisClient, "get_instance", AsyncMock(return_value=integration_redis))

    created = await Pad.create(
        integration_session,
        owner_id=owner_id,
        display_name="deferred worker creation regression",
    )
    ensure_worker.assert_not_awaited()
    await integration_redis.delete(f"pad:{created.id}")
    ensure_worker.reset_mock()

    cached = Pad.from_store(row, integration_redis)
    await cached.cache()
    await integration_session.execute(
        update(PadStore)
        .where(PadStore.id == pad_id)
        .values(
            data={"content": "fresh database value", "format": "markdown"},
            updated_at=new_updated_at,
        )
    )
    await integration_session.commit()
    integration_session.expire_all()

    fresh = await Pad.get_by_id(integration_session, pad_id)
    assert fresh is not None
    assert fresh.data["content"] == "fresh database value"
    assert fresh.updated_at == new_updated_at
    ensure_worker.assert_not_awaited()

    await integration_redis.delete(f"pad:{pad_id}")


@pytest.mark.integration
async def test_real_websocket_handshake_tokens_scopes_presence_and_revocation(
    integration_session,
    integration_database_url,
    integration_redis_url,
    monkeypatch,
):
    owner_id, editor_id, viewer_id = uuid4(), uuid4(), uuid4()
    integration_session.add_all([
        UserStore(id=owner_id, username=f"ws-owner-{owner_id}", email=f"{owner_id}@example.test"),
        UserStore(id=editor_id, username=f"ws-editor-{editor_id}", email=f"{editor_id}@example.test"),
        UserStore(id=viewer_id, username=f"ws-viewer-{viewer_id}", email=f"{viewer_id}@example.test"),
    ])
    pad = PadStore(
        id=uuid4(), owner_id=owner_id, display_name="websocket pad",
        data={"elements": []}, sharing_policy="private", whitelist=[], pad_type="canvas",
    )
    integration_session.add(pad)
    await integration_session.flush()
    integration_session.add_all([
        PadMemberStore(pad_id=pad.id, user_id=owner_id, role="owner"),
        PadMemberStore(pad_id=pad.id, user_id=editor_id, role="editor"),
        PadMemberStore(pad_id=pad.id, user_id=viewer_id, role="viewer"),
    ])
    await integration_session.commit()

    editor_token, editor_raw = await ApiTokenService(integration_session).create(
        Principal(id=editor_id),
        name="ws editor",
        scopes=["pads:read", "pads:write"],
        expires_in_days=30,
    )
    viewer_token, viewer_raw = await ApiTokenService(integration_session).create(
        Principal(id=viewer_id),
        name="ws viewer",
        scopes=["pads:read"],
        expires_in_days=30,
    )
    no_read_token, no_read_raw = await ApiTokenService(integration_session).create(
        Principal(id=viewer_id),
        name="ws no read",
        scopes=["search:read"],
        expires_in_days=30,
    )
    expired_token, expired_raw = await ApiTokenService(integration_session).create(
        Principal(id=viewer_id),
        name="ws expired",
        scopes=["pads:read"],
        expires_in_days=30,
    )
    expired_token.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    await integration_session.commit()

    # The production endpoint opens its own sessions. Use a NullPool factory
    # in this test so TestClient's event loop never reuses an asyncpg connection
    # created by pytest's loop.
    test_engine = create_async_engine(integration_database_url, poolclass=NullPool)
    test_sessions = async_sessionmaker(test_engine, expire_on_commit=False)

    async def override_session():
        async with test_sessions() as session:
            yield session

    class FakeWorker:
        worker_id = "integration-ws-worker"

        async def start_processing_pad(self, _pad_id):
            return True

        async def save_pad(self, _pad_id):
            return None

    fake_worker = FakeWorker()
    fake_pad = SimpleNamespace(
        id=pad.id,
        owner_id=owner_id,
        display_name=pad.display_name,
        data=pad.data,
        pad_type="canvas",
        sharing_policy="private",
        whitelist=[],
    )

    # SimpleNamespace cannot contain an async method in its constructor on all
    # supported Python versions; attach it explicitly for clarity.
    async def connected_users():
        redis = await RedisClient.get_instance()
        rows = await redis.hgetall(f"pad:users:{pad.id}")
        return [
            {"user_id": str(user_id), "username": json.loads(payload)["username"]}
            for user_id, payload in rows.items()
        ]
    fake_pad.get_connected_users = connected_users

    app = FastAPI()
    app.include_router(ws_router.ws_router)
    app.dependency_overrides[ws_router.get_session] = override_session
    monkeypatch.setattr(ws_router, "async_session", test_sessions)
    monkeypatch.setattr(ws_router.Pad, "get_by_id", AsyncMock(return_value=fake_pad))
    monkeypatch.setattr(ws_router.CanvasWorker, "get_instance", AsyncMock(return_value=fake_worker))
    monkeypatch.setattr(ws_router, "PAD_DEV_MODE", True)
    await RedisClient.close()

    ws_url = f"/ws/pad/{pad.id}"
    # RedisClient (the production singleton) uses REDIS_HOST/REDIS_PORT and
    # therefore defaults to database 0; the generic integration fixture uses
    # database 15 for isolated service checks.
    redis_probe = aioredis.from_url(
        integration_redis_url.rsplit("/", 1)[0] + "/0",
        decode_responses=True,
    )
    stream_key = f"pad:stream:{pad.id}"
    try:
        with TestClient(app) as client:
            with client.websocket_connect(ws_url, headers={"Authorization": f"Bearer {editor_raw}"}) as websocket:
                connected = websocket.receive_json()
                assert connected["type"] == "connected"
                assert connected["data"]["collaboratorsList"]
                websocket.send_json({"type": "scene_update", "data": {"elements": []}})
                time.sleep(0.1)
            assert await redis_probe.xlen(stream_key) >= 2  # joined + accepted mutation

            with client.websocket_connect(ws_url, headers={"Authorization": f"Bearer {viewer_raw}"}) as websocket:
                connected = websocket.receive_json()
                assert connected["type"] == "connected"
                websocket.send_json({"type": "scene_update", "data": {"elements": []}})
                error = websocket.receive_json()
                assert error["type"] == "error"
                assert error["data"]["code"] == "read_only"

            with pytest.raises(WebSocketDisconnect) as rejected:
                with client.websocket_connect(ws_url, headers={"Authorization": f"Bearer {no_read_raw}"}):
                    pass
            assert rejected.value.code == 4001

            with pytest.raises(WebSocketDisconnect) as expired:
                with client.websocket_connect(ws_url, headers={"Authorization": f"Bearer {expired_raw}"}):
                    pass
            assert expired.value.code == 4001

        # Revocation is checked again at the next handshake, not just during
        # token creation. The same raw secret must stop working immediately.
        await ApiTokenService(integration_session).revoke(
            Principal(id=editor_id), editor_token.id
        )
        with TestClient(app) as client:
            with pytest.raises(WebSocketDisconnect) as revoked:
                with client.websocket_connect(ws_url, headers={"Authorization": f"Bearer {editor_raw}"}):
                    pass
            assert revoked.value.code == 4001
    finally:
        await redis_probe.delete(stream_key, f"pad:users:{pad.id}")
        await redis_probe.aclose()
        await RedisClient.close()
        await test_engine.dispose()
