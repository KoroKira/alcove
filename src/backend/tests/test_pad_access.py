"""Tests for Pad.can_access — the access-control rules for pad sharing."""
from datetime import datetime
from unittest.mock import MagicMock
from uuid import uuid4

from domain.pad import Pad


def make_pad(**overrides):
    kwargs = dict(
        id=uuid4(),
        owner_id=uuid4(),
        display_name="pad",
        created_at=datetime.now(),
        updated_at=datetime.now(),
        store=MagicMock(),
        redis=MagicMock(),
    )
    kwargs.update(overrides)
    return Pad(**kwargs)


def test_owner_always_has_access():
    owner = uuid4()
    pad = make_pad(owner_id=owner, sharing_policy="private")
    assert pad.can_access(owner) is True


def test_private_pad_denies_strangers():
    pad = make_pad(sharing_policy="private")
    assert pad.can_access(uuid4()) is False


def test_public_pad_allows_anyone():
    pad = make_pad(sharing_policy="public")
    assert pad.can_access(uuid4()) is True


def test_whitelist_allows_listed_user_only():
    friend, stranger = uuid4(), uuid4()
    pad = make_pad(sharing_policy="whitelist", whitelist=[friend])
    assert pad.can_access(friend) is True
    assert pad.can_access(stranger) is False


def test_constructor_defaults():
    pad = make_pad(sharing_policy=None, tags=None, pad_type=None, folder="")
    assert pad.sharing_policy == "private"
    assert pad.tags == []
    assert pad.pad_type == "canvas"
    assert pad.folder is None
    assert pad.theme is None
