"""Free-form chat with Ollama + persisted conversation threads."""
import json
import shutil
from uuid import UUID
from typing import List, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies import UserSession, require_auth
from config import OLLAMA_URL, OLLAMA_DEFAULT_MODEL
from database.database import get_session
from database.models.conversation_model import AIConversation

from ._shared import BASE_SYSTEM_PROMPT, ensure_ollama_running, server_is_running


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
    conv = await AIConversation.create(
        session,
        owner_id=user.id,
        title=title,
        messages=[m.model_dump() for m in body.messages],
        pad_id=UUID(body.pad_id) if body.pad_id else None,
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


# ── Chat streaming ──────────────────────────────────────────────────────────

class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    model: Optional[str] = None
    messages: List[ChatMessage]
    # user-defined instructions layered on top of BASE_SYSTEM_PROMPT
    custom_prompt: Optional[str] = None


@router.post("/chat")
async def chat_stream(
    body: ChatRequest,
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    model = body.model or OLLAMA_DEFAULT_MODEL
    # Single merged system message: hidden base prompt, then any agent memory
    # (facts the assistant should recall about the user), then the user's custom
    # instructions, then any per-request system context sent by the frontend
    # (e.g. the open document for quick actions).
    from .memory import load_memory_prompt_block
    system = BASE_SYSTEM_PROMPT
    memory_block = await load_memory_prompt_block(session, user.id)
    if memory_block:
        system += f"\n\n{memory_block}"
    if body.custom_prompt and body.custom_prompt.strip():
        system += f"\n\nInstructions supplémentaires de l'utilisateur :\n{body.custom_prompt.strip()[:2000]}"
    client_system = [m.content for m in body.messages if m.role == "system"]
    if client_system:
        system += "\n\n" + "\n\n".join(client_system)
    messages = [{"role": "system", "content": system}]
    messages += [{"role": m.role, "content": m.content} for m in body.messages if m.role != "system"]

    async def stream():
        if not await server_is_running():
            if not shutil.which('ollama'):
                yield f"data: {json.dumps({'error': 'Ollama non installé. Télécharge-le sur ollama.com'})}\n\n"
                yield "data: [DONE]\n\n"
                return
            running = await ensure_ollama_running(12)
            if not running:
                yield f"data: {json.dumps({'error': 'Impossible de démarrer Ollama automatiquement.'})}\n\n"
                yield "data: [DONE]\n\n"
                return
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream(
                    "POST", f"{OLLAMA_URL}/api/chat",
                    json={"model": model, "messages": messages, "stream": True},
                ) as resp:
                    async for line in resp.aiter_lines():
                        if line:
                            yield f"data: {line}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")
