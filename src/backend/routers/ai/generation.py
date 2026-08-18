"""Server-side helpers that back the browser-driven AI actions.

Since Phase 3B every actual Ollama call lives in the browser (see
`src/frontend/src/lib/aiPrompts.ts`); this module only keeps the two
DB-touching helpers that would otherwise force the client to fan-out N
round-trips against `/api/pad/{id}`:

  * POST /quiz/extract        — regex-scan existing Q:/A: blocks
  * POST /quiz/collect-content — join the doc bodies of N pads

Both check ownership. Neither talks to Ollama.

Two utility functions from the pre-3B era (`_chunk_for_map`, `_parse_json_obj`)
are kept module-level so `video_report.py` (still server-side until Phase 3D)
and the existing tests can keep importing them."""
import re
import math
import json
from uuid import UUID
from typing import List

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select as sa_select
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies import UserSession, require_auth
from database.database import get_session
from database.models.pad_model import PadStore


router = APIRouter()


# ── Utilities kept for video_report (Phase 3D) and existing tests ──────────

def _chunk_for_map(text: str, target_chars: int = 6000, max_chunks: int = 10) -> list[str]:
    """Split on paragraph boundaries into ~target_chars chunks, capped."""
    text = (text or "").strip()
    if not text:
        return []
    paras = re.split(r"\n\s*\n", text)
    chunks: list[str] = []
    cur = ""
    for p in paras:
        if cur and len(cur) + len(p) > target_chars:
            chunks.append(cur.strip())
            cur = ""
        cur += p + "\n\n"
    if cur.strip():
        chunks.append(cur.strip())
    if len(chunks) > max_chunks:
        group = math.ceil(len(chunks) / max_chunks)
        chunks = ["\n\n".join(chunks[i:i + group]) for i in range(0, len(chunks), group)]
    return chunks


def _parse_json_obj(raw: str) -> dict:
    """Tolerant: pull the first {...} block out of a model reply."""
    raw = re.sub(r"<think>[\s\S]*?</think>", "", raw or "")
    start, end = raw.find("{"), raw.rfind("}") + 1
    if start >= 0 and end > start:
        try:
            return json.loads(raw[start:end])
        except Exception:
            return {}
    return {}


# ── Request shapes ─────────────────────────────────────────────────────────

class QuizExtractRequest(BaseModel):
    pad_ids: List[str]


class QuizCollectRequest(BaseModel):
    pad_ids: List[str]


# ── Shared helpers ─────────────────────────────────────────────────────────

def _extract_doc_content(row: PadStore) -> str:
    """Pull the markdown content out of a document pad, tolerating str-encoded JSON."""
    if isinstance(row.data, dict):
        return row.data.get("content", "") or ""
    if isinstance(row.data, str):
        try:
            return json.loads(row.data).get("content", "") or ""
        except Exception:
            return ""
    return ""


async def _owned_document_pads(session: AsyncSession, user_id, pad_ids: List[str]) -> List[PadStore]:
    """Return the owned document pads for the given ids, in the caller's order.
    Silently drops invalid UUIDs, non-owned rows and non-document types."""
    resolved: List[PadStore] = []
    for pid_str in pad_ids:
        try:
            pid = UUID(pid_str)
        except Exception:
            continue
        row = (await session.execute(
            sa_select(PadStore).where(PadStore.id == pid, PadStore.owner_id == user_id)
        )).scalar_one_or_none()
        if not row or row.pad_type != "document":
            continue
        resolved.append(row)
    return resolved


# ── Endpoints ──────────────────────────────────────────────────────────────

@router.post("/quiz/extract")
async def quiz_extract(
    body: QuizExtractRequest,
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    """Return pre-authored Q:/A: pairs found in the given document pads. Pure
    regex, no Ollama — kept server-side so the client doesn't need to load
    every pad body just to find flashcards it already wrote."""
    decks = []
    for row in await _owned_document_pads(session, user.id, body.pad_ids):
        content = _extract_doc_content(row)
        pairs = [
            {"q": m.group(1).strip(), "a": m.group(2).strip()}
            for m in re.finditer(r'^Q:[ \t]*(.+?)\n^A:[ \t]*(.+)', content, re.MULTILINE)
        ]
        if pairs:
            decks.append({"padId": str(row.id), "padName": row.display_name or "Sans titre", "cards": pairs})
    return {"decks": decks}


@router.post("/quiz/collect-content")
async def quiz_collect_content(
    body: QuizCollectRequest,
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    """Return a single joined text of the given pads' markdown bodies, capped
    per-pad so no single pad monopolises the context window. Feeds the
    client-side quiz generator in `aiPrompts.ts::quizGenerate`, so the browser
    doesn't have to make N pad GETs before it can prompt Ollama."""
    blocks = []
    for row in await _owned_document_pads(session, user.id, body.pad_ids):
        content = _extract_doc_content(row)
        if content:
            blocks.append(f"=== {row.display_name or 'Sans titre'} ===\n{content[:2000]}")
    return {"content": "\n\n".join(blocks)}
