from types import SimpleNamespace
from uuid import uuid4

from application.authorization import can_read_pad, can_write_pad


def test_public_pad_is_readable_but_not_writable_by_other_users():
    owner = uuid4()
    stranger = uuid4()
    pad = SimpleNamespace(owner_id=owner, sharing_policy="public", whitelist=[])

    assert can_read_pad(pad, stranger) is True
    assert can_write_pad(pad, stranger) is False
    assert can_write_pad(pad, owner) is True


def test_whitelist_preserves_curated_collaboration():
    owner = uuid4()
    member = uuid4()
    pad = SimpleNamespace(owner_id=owner, sharing_policy="whitelist", whitelist=[member])

    assert can_read_pad(pad, member) is True
    assert can_write_pad(pad, member) is True
