"""Verify the real pad-creation path used by the Obsidian importer."""

from types import SimpleNamespace
from uuid import UUID, uuid4
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from cache import RedisClient
from database.models import PadStore, UserStore
from domain.pad import Pad
from routers.pad_router import NewPadRequest, create_new_pad


@pytest.mark.integration
async def test_obsidian_import_payload_persists_markdown_and_vault_folder(
    integration_session, monkeypatch
):
    owner_id = uuid4()
    integration_session.add(UserStore(
        id=owner_id,
        username=f"obsidian-owner-{owner_id}",
        email=f"{owner_id}@example.test",
    ))
    await integration_session.commit()

    monkeypatch.setattr(RedisClient, "get_instance", AsyncMock(return_value=None))
    monkeypatch.setattr(Pad, "cache", AsyncMock())
    owner = SimpleNamespace(id=owner_id)

    imported = await create_new_pad(
        NewPadRequest(
            pad_type="document",
            display_name="Launch notes",
            content="# Launch\n\nImported from an isolated vault.",
            folder="Projects/Launch",
        ),
        owner,
        integration_session,
    )

    stored = await PadStore.get_by_id(integration_session, imported["id"])
    assert stored is not None
    assert stored.owner_id == owner_id
    assert stored.pad_type == "document"
    assert stored.display_name == "Launch notes"
    assert stored.folder == "Projects/Launch"
    assert stored.data == {
        "content": "# Launch\n\nImported from an isolated vault.",
        "format": "markdown",
    }


@pytest.mark.integration
async def test_obsidian_import_replay_returns_the_same_pad_and_rejects_changed_content(
    integration_session, monkeypatch
):
    owner_id = uuid4()
    integration_session.add(UserStore(
        id=owner_id,
        username=f"obsidian-retry-owner-{owner_id}",
        email=f"{owner_id}@example.test",
    ))
    await integration_session.commit()

    monkeypatch.setattr(RedisClient, "get_instance", AsyncMock(return_value=None))
    monkeypatch.setattr(Pad, "cache", AsyncMock())
    owner = SimpleNamespace(id=owner_id)
    key = "obsidian-import-vault-Projects-Launch-Overview"
    request = NewPadRequest(
        pad_type="document",
        display_name="Overview",
        content="# Launch",
        folder="Projects/Launch",
    )

    first = await create_new_pad(request, owner, integration_session, key)
    replay = await create_new_pad(request, owner, integration_session, key)

    assert first["id"] == replay["id"]
    stored = await PadStore.get_by_id(integration_session, UUID(first["id"]))
    assert stored is not None
    assert stored.data["content"] == "# Launch"
    assert stored.folder == "Projects/Launch"

    with pytest.raises(HTTPException) as error:
        await create_new_pad(
            request.model_copy(update={"content": "different content"}),
            owner,
            integration_session,
            key,
        )
    assert error.value.status_code == 409
