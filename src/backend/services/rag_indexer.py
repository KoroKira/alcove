"""RAG indexing primitives — used by the /api/ai/index* endpoints and by the
background re-index hook fired on pad save.

Everything here is pure enough to be called from either request context or a
detached background task."""
import os
import math
import asyncio
from uuid import UUID
from typing import Optional

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from config import OLLAMA_URL
from database.models.pad_model import PadStore
from database.models.embedding_model import PadEmbedding


EMBED_MODEL = os.getenv("OLLAMA_EMBED_MODEL", "nomic-embed-text")
CHUNK_SIZE = 400   # tokens ≈ chars / 4, so ~1600 chars
CHUNK_OVERLAP = 60


def extract_text_from_pad(pad: PadStore) -> str:
    """Extract searchable text from a pad (document or canvas)."""
    pad_type = getattr(pad, "pad_type", "canvas") or "canvas"
    data = pad.data or {}
    if pad_type == "document":
        return data.get("content", "")
    # Canvas: collect text elements
    elements = data.get("elements", [])
    parts = []
    for el in elements:
        t = el.get("text", "").strip()
        if t:
            parts.append(t)
    return "\n".join(parts)


def chunk_text(text: str, size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    words = text.split()
    if not words:
        return []
    chunks, i = [], 0
    while i < len(words):
        chunk = " ".join(words[i:i + size])
        if chunk.strip():
            chunks.append(chunk)
        i += size - overlap
    return chunks


async def embed(text: str, model: str = EMBED_MODEL) -> list[float]:
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(
            f"{OLLAMA_URL}/api/embeddings",
            json={"model": model, "prompt": text},
        )
        resp.raise_for_status()
        return resp.json()["embedding"]


async def embed_model_available(model: str = EMBED_MODEL) -> bool:
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{OLLAMA_URL}/api/tags")
            resp.raise_for_status()
            names = [m["name"] for m in resp.json().get("models", [])]
            # Accept any variant: "nomic-embed-text:latest" matches "nomic-embed-text"
            return any(n.split(":")[0] == model.split(":")[0] for n in names)
    except Exception:
        return False


def rank_rows(q_vec: list[float], rows: list) -> list:
    """Score every chunk row against the query and return them sorted desc.

    Pure CPU work (cosine over every chunk) — callers should hand this to
    run_in_threadpool so it never blocks the async event loop. `rows` come
    from PadEmbedding.get_all_for_owner:
    (pad_id, chunk_text, embedding, display_name).
    """
    qn = math.sqrt(sum(x * x for x in q_vec))
    scored = []
    for r in rows:
        emb = r.embedding
        rn = math.sqrt(sum(x * x for x in emb))
        if qn == 0 or rn == 0:
            score = 0.0
        else:
            score = sum(x * y for x, y in zip(q_vec, emb)) / (qn * rn)
        scored.append((score, r))
    scored.sort(key=lambda x: x[0], reverse=True)
    return scored


async def index_pad(
    session: AsyncSession,
    pad: PadStore,
    model: str = EMBED_MODEL,
) -> int:
    """Re-embed and store all chunks for a single pad. Returns chunk count."""
    text = extract_text_from_pad(pad)
    chunks = chunk_text(text)
    if not chunks:
        await PadEmbedding.delete_for_pad(session, pad.id)
        await session.commit()
        return 0
    chunk_data = []
    for idx, chunk in enumerate(chunks):
        vec = await embed(chunk, model)
        chunk_data.append((idx, chunk, vec))
    await PadEmbedding.upsert_chunks(session, pad.id, chunk_data)
    await session.commit()
    return len(chunk_data)


# ── Background re-index queue ────────────────────────────────────────────────
#
# When a pad's content changes we want to refresh its embeddings, but not on
# every keystroke — the frontend saves aggressively. We debounce per pad: after
# a save, we schedule a re-index in _DEBOUNCE_SECONDS; if another save arrives
# before the timer fires, we cancel and restart.

_DEBOUNCE_SECONDS = 8.0
_pending: dict[UUID, asyncio.Task] = {}


async def _reindex_after_delay(pad_id: UUID, delay: float) -> None:
    from database.database import async_session
    try:
        await asyncio.sleep(delay)
    except asyncio.CancelledError:
        return
    try:
        async with async_session() as session:
            from sqlalchemy import select
            pad = (await session.execute(
                select(PadStore).where(PadStore.id == pad_id)
            )).scalar_one_or_none()
            if pad is None:
                return
            if not await embed_model_available():
                return  # Silent skip — user hasn't set up embeddings yet
            await index_pad(session, pad)
    except Exception:
        # Background task — don't crash the app for a re-index failure
        pass
    finally:
        _pending.pop(pad_id, None)


def schedule_reindex(pad_id: UUID, delay: float = _DEBOUNCE_SECONDS) -> None:
    """Enqueue a re-index for this pad, debounced. Safe to call on every save."""
    existing = _pending.get(pad_id)
    if existing and not existing.done():
        existing.cancel()
    _pending[pad_id] = asyncio.create_task(_reindex_after_delay(pad_id, delay))
