"""Tests for database.pad_serialization.serialize_pad — the single source of
truth for the pad JSON shape. The theme passthrough rule is the most important
one here: coercing NULL to a default is exactly the regression this module was
created to prevent."""
from datetime import datetime
from types import SimpleNamespace
from uuid import uuid4

from database.pad_serialization import serialize_pad


def make_pad_row(**overrides):
    base = dict(
        id=uuid4(),
        owner_id=uuid4(),
        display_name="my pad",
        created_at=datetime(2026, 1, 2, 3, 4, 5),
        updated_at=datetime(2026, 1, 2, 3, 4, 6),
        sharing_policy="private",
        theme=None,
        is_scratch=False,
        pad_type="canvas",
        tags=["a", "b"],
        folder=None,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def test_theme_none_is_never_coerced():
    out = serialize_pad(make_pad_row(theme=None))
    assert out["theme"] is None


def test_theme_value_passes_through():
    out = serialize_pad(make_pad_row(theme="light"))
    assert out["theme"] == "light"


def test_uuids_and_datetimes_are_stringified():
    row = make_pad_row()
    out = serialize_pad(row)
    assert out["id"] == str(row.id)
    assert out["owner_id"] == str(row.owner_id)
    assert out["created_at"] == "2026-01-02T03:04:05"
    assert out["updated_at"] == "2026-01-02T03:04:06"


def test_missing_optional_fields_get_defaults():
    row = SimpleNamespace(id=uuid4(), owner_id=uuid4(), display_name="bare")
    out = serialize_pad(row)
    assert out["sharing_policy"] == "private"
    assert out["pad_type"] == "canvas"
    assert out["tags"] == []
    assert out["folder"] is None
    assert out["is_scratch"] is False
    assert out["created_at"] is None


def test_data_and_whitelist_are_opt_in():
    row = make_pad_row(data={"elements": []}, whitelist=[uuid4()])
    out = serialize_pad(row)
    assert "data" not in out
    assert "whitelist" not in out

    full = serialize_pad(row, include_data=True, include_whitelist=True)
    assert full["data"] == {"elements": []}
    assert full["whitelist"] == [str(row.whitelist[0])]


def test_empty_folder_normalized_to_none():
    out = serialize_pad(make_pad_row(folder=""))
    assert out["folder"] is None


def test_worker_id_empty_becomes_none():
    row = make_pad_row()
    row.worker_id = ""
    out = serialize_pad(row)
    assert out["worker_id"] is None
