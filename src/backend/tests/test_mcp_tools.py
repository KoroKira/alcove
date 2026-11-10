"""MCP tool catalogue (unit) and tool behaviour against real PostgreSQL (integration)."""
import asyncio
from datetime import datetime, timezone
from uuid import uuid4

import httpx
import pytest

import routers.mcp_router as mcp


# ── catalogue / policy (no database) ────────────────────────────────────────

def test_no_tool_can_delete_or_overwrite():
    for tool in mcp._TOOLS:
        assert not any(word in tool["name"] for word in ("delete", "remove", "overwrite", "update", "replace"))
        assert tool["annotations"]["destructiveHint"] is False
    assert mcp._READ_TOOLS.isdisjoint({"write_note", "append_to_pad"})


@pytest.mark.parametrize("name,args,ok", [
    ("list_pads", {}, True),
    ("list_pads", {"folder": "Projets", "tag": "ia", "pad_type": "kanban", "limit": 10, "offset": 20}, True),
    ("list_pads", {"pad_type": "../etc"}, False),
    ("list_pads", {"limit": 0}, False),
    ("list_pads", {"limit": True}, False),
    ("list_pads", {"folder": ""}, False),
    ("list_pads", {"unknown": 1}, False),
    ("workspace_overview", {}, True),
    ("workspace_overview", {"x": 1}, False),
    ("append_to_pad", {"pad_id": str(uuid4()), "content": "hi", "expected_updated_at": "2026-01-01T00:00:00+00:00"}, True),
    ("append_to_pad", {"pad_id": str(uuid4()), "content": "hi"}, False),
    ("append_to_pad", {"pad_id": str(uuid4()), "content": "   ", "expected_updated_at": "2026-01-01T00:00:00+00:00"}, False),
    ("append_to_pad", {"pad_id": str(uuid4()), "content": "x" * 300_000, "expected_updated_at": "2026-01-01T00:00:00+00:00"}, False),
])
def test_new_tool_argument_validation(name, args, ok):
    assert mcp._valid_tool_arguments(name, args) is ok


def test_embeddings_use_the_configured_ollama_url(monkeypatch):
    seen = {}

    class FakeClient:
        def __init__(self, *a, **k): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def post(self, url, json):
            seen["url"] = url
            return httpx.Response(200, json={"embedding": [0.1, 0.2]}, request=httpx.Request("POST", url))

    monkeypatch.setattr(mcp, "OLLAMA_URL", "http://ollama.internal:11434/")
    monkeypatch.setattr(mcp.httpx, "AsyncClient", FakeClient)
    assert asyncio.run(mcp._embed_query("hello")) == [0.1, 0.2]
    assert seen["url"] == "http://ollama.internal:11434/api/embeddings"


# ── behaviour against real PostgreSQL ───────────────────────────────────────



async def _user(session, label):
    from database.models import UserStore
    uid = uuid4()
    session.add(UserStore(id=uid, username=f"{label}-{uid}", email=f"{uid}@example.test"))
    await session.flush()
    return uid


async def _pad(session, owner, name, pad_type, data, **kw):
    from application.membership import MembershipService
    from database.models import PadStore
    pad = PadStore(id=uuid4(), owner_id=owner, display_name=name, data=data, pad_type=pad_type,
                   sharing_policy="private", whitelist=[], **kw)
    session.add(pad)
    await session.flush()
    await MembershipService(session).ensure_owner(pad.id, owner)
    await session.commit()
    return pad


@pytest.mark.integration
async def test_read_pad_returns_text_for_every_pad_type_and_resolves_wikilinks(integration_session):
    owner, stranger = await _user(integration_session, "o"), await _user(integration_session, "s")
    target = await _pad(integration_session, owner, "Cible", "document", {"content": "x"})
    doc = await _pad(integration_session, owner, "Source", "document",
                     {"content": "Voir [[Cible]] et [[cible#titre]] puis [[Inconnu|alias]]."})
    board = await _pad(integration_session, owner, "Board", "kanban", {"columns": [
        {"id": "c1", "title": "À faire", "cards": [{"id": "k1", "title": "Écrire le rapport", "desc": "avant vendredi"}]}]})
    tex = await _pad(integration_session, owner, "Papier", "latex", {"source": "\\section{Intro}"})

    read = lambda pad, user=owner: mcp._tool_read_pad({"pad_id": str(pad.id)}, user, integration_session)

    result = await read(doc)
    assert result["content_format"] == "markdown"
    assert {(l["target"], l["pad_id"]) for l in result["links"]} == {
        ("Cible", str(target.id)), ("Inconnu", None)}
    kanban = await read(board)
    assert "Écrire le rapport" in kanban["content"] and kanban["content_format"] == "text"
    assert (await read(tex))["content"] == "\\section{Intro}"
    with pytest.raises(ValueError, match="not found or access denied"):
        await read(doc, stranger)


@pytest.mark.integration
async def test_listing_overview_and_filters_respect_isolation(integration_session):
    owner, other = await _user(integration_session, "o"), await _user(integration_session, "x")
    # The shared test database may hold public pads from other tests, which any
    # user may read: measure the overview as a delta from this baseline.
    baseline = await mcp._tool_workspace_overview({}, owner, integration_session)
    await _pad(integration_session, owner, "A", "document", {"content": ""}, folder="Projets", tags=["ia", "rag"])
    await _pad(integration_session, owner, "B", "kanban", {"columns": []}, folder="Projets", tags=["ia"])
    await _pad(integration_session, owner, "C", "document", {"content": ""}, tags=["perso"])
    await _pad(integration_session, other, "Secret", "document", {"content": ""}, folder="Projets", tags=["ia"])

    listing = await mcp._tool_list_pads({"folder": "Projets", "tag": "ia", "limit": 1}, owner, integration_session)
    assert listing["total"] == 2 and listing["has_more"] and len(listing["pads"]) == 1  # the other user's pad is invisible
    page2 = await mcp._tool_list_pads({"folder": "Projets", "tag": "ia", "limit": 1, "offset": 1}, owner, integration_session)
    assert not page2["has_more"] and page2["pads"][0]["pad_id"] != listing["pads"][0]["pad_id"]
    assert "B" in {p["title"] for p in (await mcp._tool_list_pads({"pad_type": "kanban"}, owner, integration_session))["pads"]}
    assert "Secret" not in {p["title"] for p in (await mcp._tool_list_pads({"limit": 100}, owner, integration_session))["pads"]}

    overview = await mcp._tool_workspace_overview({}, owner, integration_session)
    assert overview["total_pads"] - baseline["total_pads"] == 3
    count = lambda o, kind, key: {i["name"]: i["pads"] for i in o[kind]}.get(key, 0)
    assert count(overview, "folders", "Projets") - count(baseline, "folders", "Projets") == 2
    for tag, expected in {"ia": 2, "rag": 1, "perso": 1}.items():
        assert count(overview, "tags", tag) - count(baseline, "tags", tag) == expected


@pytest.mark.integration
async def test_search_reports_degraded_keyword_mode_and_never_leaks(integration_session, monkeypatch):
    owner, other = await _user(integration_session, "o"), await _user(integration_session, "x")
    await _pad(integration_session, owner, "Roadmap", "kanban", {"columns": [
        {"id": "c", "title": "Todo", "cards": [{"id": "1", "title": "Migrer vers PostgreSQL 17"}]}]})
    await _pad(integration_session, other, "Privé", "document", {"content": "PostgreSQL 17 secret"})

    async def no_embedding(*_a, **_k):
        return None
    monkeypatch.setattr(mcp, "_embed_query", no_embedding)

    found = await mcp._tool_search_pads({"query": "postgresql 17"}, owner, integration_session)
    assert found["mode"] == "text" and found["degraded"] is True and "unavailable" in found["notice"]
    assert [r["pad_name"] for r in found["results"]] == ["Roadmap"]
    assert "PostgreSQL 17" in found["results"][0]["excerpts"][0]


@pytest.mark.integration
async def test_semantic_search_is_used_when_an_index_exists(integration_session, monkeypatch):
    from database.models.embedding_model import PadEmbedding
    owner = await _user(integration_session, "o")
    pad = await _pad(integration_session, owner, "Note IA", "document", {"content": "RAG local"})
    integration_session.add(PadEmbedding(pad_id=pad.id, chunk_index=0, chunk_text="RAG local", embedding=[1.0, 0.0]))
    await integration_session.commit()

    async def embedding(*_a, **_k):
        return [1.0, 0.0]
    monkeypatch.setattr(mcp, "_embed_query", embedding)
    found = await mcp._tool_search_pads({"query": "recherche"}, owner, integration_session)
    assert found["mode"] == "semantic" and found["degraded"] is False
    assert found["results"][0]["pad_id"] == str(pad.id) and found["results"][0]["url"].endswith(f"/pad/{pad.id}")


@pytest.mark.integration
async def test_append_to_pad_is_optimistic_permissioned_and_non_destructive(integration_session):
    from application.membership import MembershipService
    from application.principal import Principal
    from database.models import PadMemberStore
    owner, viewer = await _user(integration_session, "o"), await _user(integration_session, "v")
    pad = await _pad(integration_session, owner, "Journal", "document", {"content": "Ligne 1"})
    integration_session.add(PadMemberStore(pad_id=pad.id, user_id=viewer, role="viewer"))
    await integration_session.commit()

    first = await mcp._tool_read_pad({"pad_id": str(pad.id)}, owner, integration_session)
    done = await mcp._tool_append_to_pad(
        {"pad_id": str(pad.id), "content": "Ligne 2", "expected_updated_at": first["updated_at"]}, owner, integration_session)
    after = await mcp._tool_read_pad({"pad_id": str(pad.id)}, owner, integration_session)
    assert after["content"] == "Ligne 1\n\nLigne 2\n" and after["updated_at"] == done["updated_at"] != first["updated_at"]

    # stale updated_at -> conflict, nothing written
    with pytest.raises(ValueError, match="conflict"):
        await mcp._tool_append_to_pad(
            {"pad_id": str(pad.id), "content": "perdu", "expected_updated_at": first["updated_at"]}, owner, integration_session)
    assert (await mcp._tool_read_pad({"pad_id": str(pad.id)}, owner, integration_session))["content"] == after["content"]

    # read-only member can read but not append
    with pytest.raises(ValueError, match="Not authorized"):
        await mcp._tool_append_to_pad(
            {"pad_id": str(pad.id), "content": "x", "expected_updated_at": after["updated_at"]}, viewer, integration_session)

    # only documents; naive timestamps rejected
    board = await _pad(integration_session, owner, "Board", "kanban", {"columns": []})
    with pytest.raises(ValueError, match="only supports document"):
        await mcp._tool_append_to_pad(
            {"pad_id": str(board.id), "content": "x", "expected_updated_at": datetime.now(timezone.utc).isoformat()}, owner, integration_session)
    with pytest.raises(ValueError, match="timezone"):
        await mcp._tool_append_to_pad(
            {"pad_id": str(pad.id), "content": "x", "expected_updated_at": "2026-01-01T00:00:00"}, owner, integration_session)
