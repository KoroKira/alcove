"""Chat conversation persistence + system-prompt preamble.

Since the Ollama refactor, the browser talks to its own local Ollama instance
for the actual chat completion. This file no longer proxies /chat — it only
persists conversation threads and exposes the merged system prompt (BASE +
agent memory) that the client should prepend when calling Ollama directly."""
import json
from uuid import UUID
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies import UserSession, require_auth
from config import OLLAMA_DEFAULT_MODEL
from database.database import get_session
from database.models.conversation_model import AIConversation
from database.models.pad_model import PadStore
from sqlalchemy import select as sa_select

from ._shared import BASE_SYSTEM_PROMPT


router = APIRouter()


# ── Conversation persistence ────────────────────────────────────────────────

class ConvMessage(BaseModel):
    role: str
    content: str


class ConvCreate(BaseModel):
    title: Optional[str] = None
    pad_id: Optional[str] = None
    messages: List[ConvMessage] = []


class ConvUpdate(BaseModel):
    title: Optional[str] = None
    messages: Optional[List[ConvMessage]] = None


def _derive_title(messages: List[ConvMessage]) -> str:
    """Use the first user message as the conversation title."""
    for m in messages:
        if m.role == "user" and m.content.strip():
            t = m.content.strip().replace("\n", " ")
            return (t[:60] + "…") if len(t) > 60 else t
    return "Nouvelle conversation"


@router.get("/conversations")
async def list_conversations(
    pad_id: Optional[str] = None,
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    pad_uuid = UUID(pad_id) if pad_id else None
    convs = await AIConversation.list_for_owner(session, user.id, pad_uuid)
    return {"conversations": [c.to_summary() for c in convs]}


@router.get("/conversations/{conv_id}")
async def get_conversation(
    conv_id: str,
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    conv = await AIConversation.get_owned(session, UUID(conv_id), user.id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation introuvable")
    return conv.to_dict()


@router.post("/conversations")
async def create_conversation(
    body: ConvCreate,
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    title = body.title or _derive_title(body.messages)
    pad_uuid = UUID(body.pad_id) if body.pad_id else None
    if pad_uuid is not None:
        owned = (await session.execute(
            sa_select(PadStore.id).where(PadStore.id == pad_uuid, PadStore.owner_id == user.id)
        )).scalar_one_or_none()
        if owned is None:
            raise HTTPException(status_code=404, detail="Pad introuvable")
    conv = await AIConversation.create(
        session,
        owner_id=user.id,
        title=title,
        messages=[m.model_dump() for m in body.messages],
        pad_id=pad_uuid,
    )
    return conv.to_dict()


@router.put("/conversations/{conv_id}")
async def update_conversation(
    conv_id: str,
    body: ConvUpdate,
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    messages = [m.model_dump() for m in body.messages] if body.messages is not None else None
    conv = await AIConversation.update_owned(
        session, UUID(conv_id), user.id,
        title=body.title, messages=messages,
    )
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation introuvable")
    return conv.to_dict()


@router.delete("/conversations/{conv_id}")
async def delete_conversation(
    conv_id: str,
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    ok = await AIConversation.delete_owned(session, UUID(conv_id), user.id)
    if not ok:
        raise HTTPException(status_code=404, detail="Conversation introuvable")
    return {"deleted": True}


# ── System-prompt preamble (for browser-side chat) ──────────────────────────
#
# The browser fetches this before each chat send, prepends it as a system
# message, then streams from its own local Ollama. The response is cheap and
# small — cache-busting each send keeps memory pad edits reflected immediately
# without having to invalidate any client-side cache.

@router.get("/chat/preamble")
async def chat_preamble(
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    """Return the merged system prompt (BASE + agent-memory pads) the client
    should prepend to its Ollama /api/chat call.

    NOT included: the user's `custom_prompt` (lives in localStorage on the
    client — the client concatenates it) and any per-request system context
    (the client injects the open document itself)."""
    from .memory import load_memory_prompt_block
    system = BASE_SYSTEM_PROMPT
    memory_block = await load_memory_prompt_block(session, user.id)
    if memory_block:
        system += f"\n\n{memory_block}"
    return {"system": system, "default_model": OLLAMA_DEFAULT_MODEL}
