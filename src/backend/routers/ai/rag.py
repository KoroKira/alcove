"""RAG endpoints: index a pad, index everything, semantic search, RAG chat."""
import json
import math
from uuid import UUID
from typing import List, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel
from sqlalchemy import select as sa_select
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies import UserSession, require_auth
from config import OLLAMA_URL, OLLAMA_DEFAULT_MODEL
from database.database import get_session
from database.models.pad_model import PadStore
from database.models.embedding_model import PadEmbedding

from services.rag_indexer import (
    EMBED_MODEL,
    embed, extract_text_from_pad, chunk_text, rank_rows, index_pad,
)


router = APIRouter()


class IndexPadRequest(BaseModel):
    pad_id: str
    model: Optional[str] = None


class RagChatRequest(BaseModel):
    model: Optional[str] = None
    question: str
    top_k: int = 5
    lang: Optional[str] = "fr"


@router.post("/index")
async def index_pad_endpoint(
    body: IndexPadRequest,
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    """Generate and store embeddings for a single pad."""
    embed_model = body.model or EMBED_MODEL

    stmt = sa_select(PadStore).where(
        PadStore.id == UUID(body.pad_id),
        PadStore.owner_id == user.id,
    )
    result = await session.execute(stmt)
    pad = result.scalar_one_or_none()
    if not pad:
        raise HTTPException(404, "Pad not found")

    count = await index_pad(session, pad, embed_model)
    return {"indexed": count}


@router.post("/index-all")
async def index_all_pads(
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    """Index all pads for the current user (streaming progress via SSE)."""
    async def stream():
        def evt(msg: str, kind: str = "log") -> str:
            return f"data: {json.dumps({'kind': kind, 'msg': msg})}\n\n"

        stmt = sa_select(PadStore).where(PadStore.owner_id == user.id)
        result = await session.execute(stmt)
        pads = list(result.scalars().all())

        total = len(pads)
        yield evt(f"📚 Indexation de {total} pads…", "step")

        indexed = 0
        for i, pad in enumerate(pads):
            text = extract_text_from_pad(pad)
            chunks = chunk_text(text)
            if chunks:
                chunk_data = []
                for idx, chunk in enumerate(chunks):
                    vec = await embed(chunk)
                    chunk_data.append((idx, chunk, vec))
                await PadEmbedding.upsert_chunks(session, pad.id, chunk_data)
                await session.commit()
                indexed += 1
            yield evt(f"  [{i+1}/{total}] {pad.display_name} — {len(chunks)} chunks")

        yield evt(f"✅ {indexed} pads indexés", "success")
        yield evt("done", "done")
        yield "data: [DONE]\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


@router.post("/semantic-search")
async def semantic_search(
    body: RagChatRequest,
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    """Find the top-k most relevant pad chunks for a question."""
    q_vec = await embed(body.question)

    rows = await PadEmbedding.get_all_for_owner(session, user.id)
    if not rows:
        return {"results": []}

    # Cosine over every chunk is pure CPU — keep it off the event loop.
    scored = await run_in_threadpool(rank_rows, q_vec, rows)
    top = scored[:body.top_k]

    return {
        "results": [
            {
                "score": round(score, 4),
                "pad_id": str(row.pad_id),
                "pad_name": row.display_name,
                "excerpt": row.chunk_text[:300],
            }
            for score, row in top
            if score > 0.3
        ]
    }


@router.post("/rag-chat")
async def rag_chat(
    body: RagChatRequest,
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    """RAG-augmented chat: retrieves relevant chunks, then answers via Ollama."""
    model = OLLAMA_DEFAULT_MODEL

    # 1. Embed question & retrieve top-k chunks (scoped to this user)
    q_vec = await embed(body.question)
    rows = await PadEmbedding.get_all_for_owner(session, user.id)

    # Cosine over every chunk is pure CPU — keep it off the event loop.
    scored = await run_in_threadpool(rank_rows, q_vec, rows) if rows else []
    top = [(s, r) for s, r in scored[:body.top_k] if s > 0.3]

    # 2. Build context
    from .memory import load_memory_prompt_block
    memory_block = await load_memory_prompt_block(session, user.id)
    mem_prefix = f"{memory_block}\n\n" if memory_block else ""

    if top:
        ctx_parts = []
        for score, row in top:
            pad_name = row.display_name
            ctx_parts.append(f"[{pad_name}]\n{row.chunk_text}")
        context = "\n\n---\n\n".join(ctx_parts)
        if body.lang == "fr":
            system = (
                f"{mem_prefix}"
                "Tu es un assistant qui répond aux questions en te basant sur les notes de l'utilisateur.\n"
                "Voici les extraits pertinents de ses notes :\n\n"
                f"{context}\n\n"
                "Réponds en français, de façon concise et précise. "
                "Cite les noms des notes sources entre crochets quand tu les utilises."
            )
        else:
            system = (
                f"{mem_prefix}"
                "You are an assistant that answers questions based on the user's notes.\n"
                "Here are the relevant excerpts:\n\n"
                f"{context}\n\n"
                "Answer concisely. Cite source note names in brackets when you use them."
            )
    else:
        if body.lang == "fr":
            system = f"{mem_prefix}Tu es un assistant. Aucune note pertinente n'a été trouvée pour cette question."
        else:
            system = f"{mem_prefix}You are an assistant. No relevant notes were found for this question."

    sources = [
        {"pad_id": str(r.pad_id), "pad_name": r.display_name, "score": round(s, 3)}
        for s, r in top
    ]

    async def stream():
        # First emit the sources metadata
        yield f"data: {json.dumps({'kind': 'sources', 'sources': sources})}\n\n"

        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": body.question},
        ]
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream(
                "POST", f"{OLLAMA_URL}/api/chat",
                json={"model": model, "messages": messages, "stream": True},
            ) as resp:
                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    data = json.loads(line)
                    token = data.get("message", {}).get("content", "")
                    if token:
                        yield f"data: {json.dumps({'message': {'content': token}})}\n\n"
                    if data.get("done"):
                        yield "data: [DONE]\n\n"
                        return

    return StreamingResponse(stream(), media_type="text/event-stream")


# ── Smart Connections ───────────────────────────────────────────────────────
#
# "For this pad, which other pads are semantically closest?" — reuses the
# existing chunk embeddings, no extra indexing. Ranking is max-pooling: a
# candidate pad's score is the maximum cosine over every (target_chunk,
# candidate_chunk) pair. This surfaces pads that share ANY strong overlap,
# rather than diluting by chunks-that-don't-match; matches the "you might want
# to read this too" UX users expect.

class RelatedPadsRequest(BaseModel):
    pad_id: str
    top_k: int = 5
    min_score: float = 0.35


def _rank_related(
    target_vectors: list[list[float]],
    candidate_rows: list,
    target_pad_id: UUID,
) -> list[tuple[float, UUID, str]]:
    """Return [(score, pad_id, display_name), ...] sorted desc, one entry per
    candidate pad (excluding the target)."""
    # Pre-compute norms of target vectors once.
    tnorms = [math.sqrt(sum(x * x for x in v)) for v in target_vectors]

    # Aggregate best per pad.
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

    # Fetch the target's own chunk vectors — cheap, single indexed query.
    target_rows = list((await session.execute(
        sa_select(PadEmbedding.embedding).where(PadEmbedding.pad_id == pad_uuid)
    )).all())
    if not target_rows:
        return {"related": [], "reason": "not-indexed"}

    target_vectors = [r[0] for r in target_rows]

    all_rows = await PadEmbedding.get_all_for_owner(session, user.id)
    if not all_rows:
        return {"related": []}

    scored = await run_in_threadpool(
        _rank_related, target_vectors, all_rows, pad_uuid,
    )
    top = [(s, pid, name) for s, pid, name in scored[:body.top_k] if s >= body.min_score]

    return {
        "related": [
            {"pad_id": str(pid), "pad_name": name, "score": round(s, 3)}
            for s, pid, name in top
        ],
    }
