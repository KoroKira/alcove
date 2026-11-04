"""Server-side indexing of agent/API writes: chunking, fail-safe behaviour, real PostgreSQL."""
from uuid import uuid4

import pytest

import services.pad_indexing as indexing


def test_chunking_windows_and_edges():
    assert indexing.chunk_text("") == [] and indexing.chunk_text("  \n ") == []
    assert indexing.chunk_text("un deux trois") == ["un deux trois"]
    words = [f"w{i}" for i in range(1000)]
    chunks = indexing.chunk_text(" ".join(words))
    assert [len(c.split()) for c in chunks] == [400, 400, 320]
    assert chunks[1].split()[0] == "w340"            # 60-word overlap
    assert len(indexing.chunk_text(" ".join(words[:400]))) == 1   # no tail-only chunk


@pytest.mark.parametrize("body,expected", [
    ({"embeddings": [[0.5, 0.5]]}, [0.5, 0.5]),
    ({"embedding": [1.0]}, [1.0]),
    ({"embeddings": []}, None),
    ({}, None),
])
async def test_embed_accepts_both_ollama_response_shapes(monkeypatch, body, expected):
    import httpx

    class Client:
        async def post(self, url, json):
            assert url.endswith("/api/embed") and json["input"] == "x"
            return httpx.Response(200, json=body, request=httpx.Request("POST", url))

    assert await indexing.embed("x", Client()) == expected


async def test_embed_returns_none_when_ollama_is_down():
    import httpx

    class Client:
        async def post(self, url, json):
            raise httpx.ConnectError("refused")

    assert await indexing.embed("x", Client()) is None


@pytest.mark.integration
async def test_index_pad_replaces_chunks_clears_empty_and_is_fail_safe(integration_session, integration_engine, monkeypatch):
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import async_sessionmaker
    from database.models import PadStore, UserStore
    from database.models.embedding_model import PadEmbedding

    owner = uuid4()
    integration_session.add(UserStore(id=owner, username=f"idx-{owner}", email=f"{owner}@example.test"))
    await integration_session.flush()
    pad = PadStore(id=uuid4(), owner_id=owner, display_name="Note", pad_type="document",
                   data={"content": "alpha beta gamma"}, sharing_policy="private", whitelist=[])
    integration_session.add(pad)
    await integration_session.commit()
    factory = async_sessionmaker(integration_engine, expire_on_commit=False)

    async def rows():
        async with factory() as s:
            return (await s.execute(select(PadEmbedding.chunk_text).where(PadEmbedding.pad_id == pad.id))).scalars().all()

    async def fake_embed(text, client):
        return [1.0, 0.0]
    monkeypatch.setattr(indexing, "embed", fake_embed)
    assert await indexing.index_pad(pad.id, factory) == "indexed"
    assert await rows() == ["alpha beta gamma"]

    # Ollama down: the existing index must survive untouched.
    async def down(text, client):
        return None
    monkeypatch.setattr(indexing, "embed", down)
    async with factory() as s:
        (await s.get(PadStore, pad.id)).data = {"content": "delta epsilon"}
        await s.commit()
    assert await indexing.index_pad(pad.id, factory) == "unavailable"
    assert await rows() == ["alpha beta gamma"]

    # Back up: replaced by the new content; then emptied pad clears the index.
    monkeypatch.setattr(indexing, "embed", fake_embed)
    assert await indexing.index_pad(pad.id, factory) == "indexed"
    assert await rows() == ["delta epsilon"]
    async with factory() as s:
        (await s.get(PadStore, pad.id)).data = {"content": "   "}
        await s.commit()
    assert await indexing.index_pad(pad.id, factory) == "cleared"
    assert await rows() == []

    # Trashed pads are never indexed.
    async with factory() as s:
        row = await s.get(PadStore, pad.id)
        row.data = {"content": "again"}
        from sqlalchemy import func
        row.deleted_at = func.now()
        await s.commit()
    assert await indexing.index_pad(pad.id, factory) == "skipped"
