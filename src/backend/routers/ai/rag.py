"""RAG endpoints — Phase 3C: chunking + embedding moved to the browser.

The server now only stores the vectors and does the pure-math KNN so it can
scope embeddings by owner in a single DB query. The client:

  1. GETs /rag/indexable-text/{pad_id} to obtain the text extract
     (server knows how to pull it out of both document and canvas pads).
  2. Chunks + embeds locally via its own Ollama.
  3. POSTs /rag/index-chunks to persist {chunk_text, embedding} rows.

For search:

  1. Client embeds the query locally.
  2. POSTs /rag/knn with the query vector.
  3. Server returns owner-scoped top-k chunks.

`/related-pads` is unchanged — it never needed Ollama (pure cosine over
existing embeddings). The old streaming index-all and rag-chat endpoints
were deleted; the client orchestrates their loop now."""

import math
from uuid import UUID
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from sqlalchemy import select as sa_select
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies import UserSession, require_auth
from database.database import get_session
from database.models.pad_model import PadStore
from database.models.embedding_model import PadEmbedding

from services.rag_indexer import extract_text_from_pad, rank_rows


router = APIRouter()


# ── Text extract (server → client, so the client can chunk+embed) ──────────

@router.get("/rag/indexable-text/{pad_id}")
async def indexable_text(
    pad_id: str,
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    """Return the raw searchable text of a pad. The client uses it to build
    chunks + embeddings locally. Owner-scoped."""
    try:
        pid = UUID(pad_id)
    except Exception:
        raise HTTPException(400, "invalid pad_id")
    stmt = sa_select(PadStore).where(PadStore.id == pid, PadStore.owner_id == user.id)
    pad = (await session.execute(stmt)).scalar_one_or_none()
    if not pad:
        raise HTTPException(404, "Pad not found")
    return {
        "pad_id": str(pad.id),
        "display_name": pad.display_name,
        "text": extract_text_from_pad(pad),
    }


@router.get("/rag/indexable-list")
async def indexable_list(
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    """List the caller's pads with their indexable text. Used by the
    "Réindexer tout" button so the client can loop through everything without
    N+1 round-trips against /rag/indexable-text/{id}."""
    stmt = sa_select(PadStore).where(PadStore.owner_id == user.id)
    pads = list((await session.execute(stmt)).scalars().all())
    return {
        "pads": [
            {
                "pad_id": str(p.id),
                "display_name": p.display_name,
                "text": extract_text_from_pad(p),
            }
            for p in pads
        ]
    }


# ── Embedding persistence (client → server) ────────────────────────────────

class ChunkPayload(BaseModel):
    index: int
    text: str = Field(..., max_length=16000)
    embedding: List[float] = Field(..., min_length=1, max_length=8192)


class IndexChunksRequest(BaseModel):
    pad_id: str
    chunks: List[ChunkPayload] = Field(..., max_length=512)


@router.post("/rag/index-chunks")
async def index_chunks(
    body: IndexChunksRequest,
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    """Replace this pad's stored chunks with the client-provided embeddings.
    Owner check enforced against the parent pad — a user can never poison
    another user's index. Empty `chunks` = delete existing embeddings."""
    try:
        pid = UUID(body.pad_id)
    except Exception:
        raise HTTPException(400, "invalid pad_id")
    stmt = sa_select(PadStore.id).where(PadStore.id == pid, PadStore.owner_id == user.id)
    if (await session.execute(stmt)).scalar_one_or_none() is None:
        raise HTTPException(404, "Pad not found")

    tuples = [(c.index, c.text, c.embedding) for c in body.chunks]
    await PadEmbedding.upsert_chunks(session, pid, tuples)
    await session.commit()
    return {"indexed": len(tuples)}


# ── KNN (client sends embedding, server ranks) ─────────────────────────────

class KnnRequest(BaseModel):
    query_embedding: List[float] = Field(..., min_length=1)
    top_k: int = 5
    min_score: float = 0.3


@router.post("/rag/knn")
async def knn(
    body: KnnRequest,
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    """Return top-k owner-scoped chunks matching the caller's query embedding."""
    rows = await PadEmbedding.get_all_for_owner(session, user.id)
    if not rows:
        return {"results": []}
    scored = await run_in_threadpool(rank_rows, body.query_embedding, rows)
    top = [(s, r) for s, r in scored[:body.top_k] if s > body.min_score]
    return {
        "results": [
            {
                "score": round(s, 4),
                "pad_id": str(r.pad_id),
                "pad_name": r.display_name,
                "chunk_text": r.chunk_text,
            }
            for s, r in top
        ]
    }


# ── Related pads (unchanged — pure DB) ─────────────────────────────────────
#
# "For this pad, which other pads are semantically closest?" — reuses stored
# chunk embeddings, no Ollama call. Max-pool over (target_chunk × candidate_chunk)
# pairs so a candidate scores its best matching chunk, not its average.

class RelatedPadsRequest(BaseModel):
    pad_id: str
    top_k: int = 5
    min_score: float = 0.35


def _rank_related(
    target_vectors: list[list[float]],
    candidate_rows: list,
    target_pad_id: UUID,
) -> list[tuple[float, UUID, str]]:
    tnorms = [math.sqrt(sum(x * x for x in v)) for v in target_vectors]
    best: dict[UUID, tuple[float, str]] = {}
    for row in candidate_rows:
        if row.pad_id == target_pad_id:
            continue
        emb = row.embedding
        rn = math.sqrt(sum(x * x for x in emb))
        if rn == 0:
            continue
        best_local = 0.0
        for v, tn in zip(target_vectors, tnorms):
            if tn == 0:
                continue
            score = sum(x * y for x, y in zip(v, emb)) / (tn * rn)
            if score > best_local:
                best_local = score
        cur = best.get(row.pad_id)
        if cur is None or best_local > cur[0]:
            best[row.pad_id] = (best_local, row.display_name)
    return sorted(
        [(sc, pid, name) for pid, (sc, name) in best.items()],
        key=lambda x: x[0],
        reverse=True,
    )


@router.post("/related-pads")
async def related_pads(
    body: RelatedPadsRequest,
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    """Find pads semantically closest to the given one."""
    try:
        pad_uuid = UUID(body.pad_id)
    except Exception:
        raise HTTPException(400, "invalid pad_id")

    target_rows = list((await session.execute(
        sa_select(PadEmbedding.embedding)
        .join(PadStore, PadStore.id == PadEmbedding.pad_id)
        .where(PadEmbedding.pad_id == pad_uuid, PadStore.owner_id == user.id)
    )).all())
    if not target_rows:
        return {"related": [], "reason": "not-indexed"}

    target_vectors = [r[0] for r in target_rows]
    all_rows = await PadEmbedding.get_all_for_owner(session, user.id)
    if not all_rows:
        return {"related": []}
    scored = await run_in_threadpool(_rank_related, target_vectors, all_rows, pad_uuid)
    top = [(s, pid, name) for s, pid, name in scored[:body.top_k] if s >= body.min_score]
    return {
        "related": [
            {"pad_id": str(pid), "pad_name": name, "score": round(s, 3)}
            for s, pid, name in top
        ],
    }
