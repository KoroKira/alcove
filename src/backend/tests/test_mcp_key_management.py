from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from database.models import UserStore
from routers.mcp_keys_router import McpKeyCreate, create_key, list_keys, revoke_key
from services.mcp_api_key_service import verify_api_key_principal


def test_key_creation_does_not_accept_foreign_owner_or_unlimited_expiry():
    assert McpKeyCreate(name=" Codex ").name == "Codex"
    for fields in ({"owner_id": str(uuid4())}, {"expires_days": 0}, {"expires_days": 366}, {"allow_write": "false"}):
        with pytest.raises(ValidationError):
            McpKeyCreate(name="Codex", **fields)


@pytest.mark.integration
async def test_browser_key_lifecycle_is_owned_expiring_and_reversible(integration_session):
    import json

    owner_id, other_id = uuid4(), uuid4()
    integration_session.add_all([
        UserStore(id=identity, username=f"mcp-keys-{identity}", email=f"{identity}@example.test")
        for identity in (owner_id, other_id)
    ])
    await integration_session.commit()
    owner = SimpleNamespace(id=owner_id)
    other = SimpleNamespace(id=other_id)
    result = await create_key(McpKeyCreate(name="isolated client"), owner, integration_session)
    assert result.status_code == 201
    assert result.headers["cache-control"] == "no-store"
    created = json.loads(result.body)
    assert created["key"]["scopes"] == ["read"]
    assert created["key"]["expires_at"] is not None
    assert (await verify_api_key_principal(integration_session, created["token"])).owner_id == owner_id

    listed = await list_keys(owner, integration_session)
    assert b"secret_hash" not in listed.body and created["token"].encode() not in listed.body
    assert len(json.loads(listed.body)["keys"]) == 1
    assert json.loads((await list_keys(other, integration_session)).body)["keys"] == []
    with pytest.raises(HTTPException) as denied:
        await revoke_key(created["key"]["public_id"], other, integration_session)
    assert denied.value.status_code == 404
    await revoke_key(created["key"]["public_id"], owner, integration_session)
    assert await verify_api_key_principal(integration_session, created["token"]) is None


@pytest.mark.integration
async def test_active_key_stays_visible_after_many_inactive_connections(integration_session):
    import json
    from datetime import datetime, timedelta, timezone
    from database.models.mcp_api_key_model import McpApiKey

    owner_id = uuid4()
    now = datetime.now(timezone.utc)
    integration_session.add(UserStore(id=owner_id, username=f"mcp-list-{owner_id}", email=f"{owner_id}@example.test"))
    await integration_session.commit()
    active_public_id = uuid4().hex[:16]
    # The still-active key predates more than one page of revoked/expired keys.
    rows = [McpApiKey(
        owner_id=owner_id, public_id=active_public_id, secret_hash="0" * 64,
        name="Active connection", scopes=["read"], expires_at=now + timedelta(days=1),
        created_at=now - timedelta(days=2),
    )]
    rows.extend(McpApiKey(
        owner_id=owner_id, public_id=f"inactive-{owner_id.hex[:8]}-{index}", secret_hash="0" * 64,
        name="Inactive connection", scopes=["read"], created_at=now - timedelta(hours=1),
        revoked_at=now if index % 2 else None,
        expires_at=now - timedelta(minutes=1),
    ) for index in range(101))
    integration_session.add_all(rows)
    await integration_session.commit()
    result = json.loads((await list_keys(SimpleNamespace(id=owner_id), integration_session)).body)
    assert len(result["keys"]) == 100
    assert result["keys"][0]["public_id"] == active_public_id
    assert b"secret_hash" not in json.dumps(result).encode()
