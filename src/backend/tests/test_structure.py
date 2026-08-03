"""Tests for the map-reduce structuring helpers (pure functions)."""
from routers.ai_router import _chunk_for_map, _parse_json_obj


def test_chunk_empty():
    assert _chunk_for_map("") == []
    assert _chunk_for_map("   ") == []


def test_chunk_single_short():
    assert _chunk_for_map("court paragraphe") == ["court paragraphe"]


def test_chunk_splits_on_paragraphs():
    text = "\n\n".join(["x" * 200 for _ in range(10)])
    chunks = _chunk_for_map(text, target_chars=500, max_chunks=10)
    assert len(chunks) > 1
    assert all(c.strip() for c in chunks)


def test_chunk_caps_at_max():
    text = "\n\n".join([f"para{i} " + "y" * 100 for i in range(40)])
    chunks = _chunk_for_map(text, target_chars=150, max_chunks=6)
    assert len(chunks) <= 6


def test_parse_json_obj_extracts_first_object():
    assert _parse_json_obj('bla {"a": 1, "b": [2]} tail') == {"a": 1, "b": [2]}


def test_parse_json_obj_strips_think():
    assert _parse_json_obj('<think>noise</think> {"a": 1}') == {"a": 1}


def test_parse_json_obj_bad_returns_empty():
    assert _parse_json_obj("no json here") == {}
    assert _parse_json_obj('{"broken": ') == {}
