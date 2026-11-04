"""Server-side semantic indexing for writes that never pass through a browser.

The Alcove UI indexes a pad in the browser while it is open. Notes written by
an agent (MCP ``write_note`` / ``append_to_pad``) or an API client have no
browser, so without this module they stayed invisible to semantic search until
someone happened to open them.

Everything here is best effort and fail-safe:
  * Ollama unavailable -> nothing is written, existing chunks are kept, and
    keyword search still finds the pad;
  * all vectors are computed before the index is replaced, so a pad is never
    left half-indexed;
  * the work never blocks or fails the write that triggered it.
"""
from __future__ import annotations

import asyncio
import logging
import os
from types import SimpleNamespace
from typing import Any, List, Optional
from uuid import UUID

import httpx

from config import OLLAMA_URL

logger = logging.getLogger(__name__)

EMBED_MODEL = os.getenv("RAG_EMBED_MODEL", "nomic-embed-text")
CHUNK_SIZE = 400       # words, same window as the browser indexer (src/frontend/src/lib/rag.ts)
CHUNK_OVERLAP = 60
MAX_CHUNKS = 512       # same cap as /rag/index-chunks
ENABLED = os.getenv("RAG_SERVER_INDEXING", "true").strip().lower() != "false"

_background: set[asyncio.Task] = set()


def chunk_text(text: str, size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> List[str]:
    """Word-based sliding window (same size/overlap as the browser's chunkText()),
    without the redundant final chunk that would only repeat the overlap."""
    words = (text or "").split()
    if not words:
        return []
    step = max(1, size - overlap)
    chunks = []
    for start in range(0, len(words), step):
        chunk = " ".join(words[start:start + size])
        if chunk.strip():
            chunks.append(chunk)
        if start + size >= len(words):
            break
    return chunks


async def embed(text: str, client: httpx.AsyncClient) -> Optional[List[float]]:
    try:
        response = await client.post(
            f"{OLLAMA_URL.rstrip('/')}/api/embed", json={"model": EMBED_MODEL, "input": text},
        )
        response.raise_for_status()
        body = response.json()
        vectors = body.get("embeddings")
        if isinstance(vectors, list) and vectors and isinstance(vectors[0], list) and vectors[0]:
            return vectors[0]
        vector = body.get("embedding")
        return vector if isinstance(vector, list) and vector else None
    except Exception as exc:  # network, HTTP error, bad JSON
        logger.info("Server-side embedding unavailable: %s", exc.__class__.__name__)
        return None


async def index_pad(pad_id: UUID, session_factory: Any = None) -> str:
    """(Re)index one pad. Returns "indexed", "cleared", "skipped" or "unavailable"."""
    from database.database import async_session
    from database.models import PadStore
    from database.models.embedding_model import PadEmbedding
    from services.rag_indexer import extract_text_from_pad

    factory = session_factory or async_session
    async with factory() as session:
        pad = await session.get(PadStore, pad_id)
        if pad is None or pad.deleted_at is not None:
            return "skipped"
        text = extract_text_from_pad(SimpleNamespace(pad_type=pad.pad_type, data=pad.data))
        chunks = chunk_text(text)[:MAX_CHUNKS]
        if not chunks:
            await PadEmbedding.delete_for_pad(session, pad_id)
            await session.commit()
            return "cleared"

        vectors = []
        async with httpx.AsyncClient(timeout=20) as client:
            for chunk in chunks:
                vector = await embed(chunk, client)
                if vector is None:
                    return "unavailable"   # keep whatever index already exists
                vectors.append(vector)
        await PadEmbedding.upsert_chunks(
            session, pad_id, [(i, c, v) for i, (c, v) in enumerate(zip(chunks, vectors))],
        )
        await session.commit()
        return "indexed"


def schedule_pad_indexing(pad_id: UUID) -> None:
    """Fire-and-forget reindex; never raises into the caller's request."""
    if not ENABLED:
        return
    try:
        task = asyncio.get_running_loop().create_task(_safe_index(pad_id))
    except RuntimeError:
        return
    _background.add(task)
    task.add_done_callback(_background.discard)


async def _safe_index(pad_id: UUID) -> None:
    try:
        await index_pad(pad_id)
    except Exception:
        logger.warning("Server-side indexing failed for pad %s", pad_id, exc_info=True)
