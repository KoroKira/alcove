"""End-to-end restore behavior against isolated PostgreSQL integration data."""

from types import SimpleNamespace
from uuid import uuid4
from unittest.mock import AsyncMock

import pytest

from database.models import PadStore, UserStore
from database.models.version_model import PadVersion
from domain.pad import Pad
from routers.pad_router import manual_snapshot, restore_version


@pytest.mark.integration
async def test_manual_snapshot_persists_the_current_document(integration_session):
    owner_id = uuid4()
    owner = UserStore(
        id=owner_id,
        username=f"snapshot-owner-{owner_id}",
        email=f"{owner_id}@example.test",
    )
    store = PadStore(
        id=uuid4(),
        owner_id=owner_id,
        display_name="isolated manual snapshot integration pad",
        data={"content": "saved document content", "format": "markdown"},
        sharing_policy="private",
        whitelist=[],
        pad_type="document",
    )
    integration_session.add_all([owner, store])
    await integration_session.commit()

    pad = Pad.from_store(store, redis=None)
    result = await manual_snapshot(
        pad.id,
        (pad, SimpleNamespace(id=owner_id)),
        integration_session,
    )

    assert result["id"]
    history = await PadVersion.list_for_pad(integration_session, pad.id)
    assert len(history) == 1
    assert history[0].snapshot_reason == "manual"
    assert history[0].data == {"content": "saved document content", "format": "markdown"}


@pytest.mark.integration
async def test_restore_restores_selected_data_and_snapshots_current_data(integration_session, monkeypatch):
    owner_id = uuid4()
    owner = UserStore(
        id=owner_id,
        username=f"restore-owner-{owner_id}",
        email=f"{owner_id}@example.test",
    )
    pad = PadStore(
        id=uuid4(),
        owner_id=owner_id,
        display_name="isolated restore integration pad",
        data={"content": "current content", "format": "markdown"},
        sharing_policy="private",
        whitelist=[],
        pad_type="document",
    )
    version = PadVersion(
        id=uuid4(),
        pad_id=pad.id,
        data={"content": "older content", "format": "markdown"},
        pad_type="document",
        snapshot_reason="manual",
    )
    integration_session.add_all([owner, pad])
    await integration_session.flush()
    integration_session.add(version)
    await integration_session.commit()
    await integration_session.refresh(pad)

    domain_pad = Pad.from_store(pad, redis=None)
    monkeypatch.setattr(Pad, "cache", AsyncMock())
    result = await restore_version(
        pad.id,
        version.id,
        (domain_pad, SimpleNamespace(id=owner_id)),
        integration_session,
    )

    assert result == {"ok": True}
    restored = await PadStore.get_by_id(integration_session, pad.id)
    assert restored is not None
    assert restored.data == {"content": "older content", "format": "markdown"}

    history = await PadVersion.list_for_pad(integration_session, pad.id)
    snapshots = {entry.snapshot_reason: entry.data for entry in history}
    assert snapshots["manual"] == {"content": "older content", "format": "markdown"}
    assert snapshots["pre-restore"] == {"content": "current content", "format": "markdown"}
