"""Authenticated same-origin proxy to the operator-configured Ollama.

The browser should not need a local Ollama, special CORS flags, or mixed HTTP
content exceptions. This keeps Alcove usable from phones and laptops while the
homelab's stronger inference machine does the work.
"""
import json
import os
import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from config import OLLAMA_URL
from dependencies import UserSession, require_auth
from services.ai_admission import charge_user, inference_slot

router = APIRouter(prefix="/ollama")

AI_MAX_REQUEST_BYTES = int(os.getenv("AI_MAX_REQUEST_BYTES", "262144"))
AI_MAX_MESSAGES = int(os.getenv("AI_MAX_MESSAGES", "40"))
AI_MAX_CONTEXT_CHARS = int(os.getenv("AI_MAX_CONTEXT_CHARS", "120000"))
AI_MAX_EMBED_CHARS = int(os.getenv("AI_MAX_EMBED_CHARS", "16000"))
AI_UPSTREAM_TIMEOUT_SECONDS = float(os.getenv("AI_UPSTREAM_TIMEOUT_SECONDS", "180"))


@router.get("/api/tags")
async def tags(_: UserSession = Depends(require_auth)):
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            response = await client.get(f"{OLLAMA_URL.rstrip('/')}/api/tags")
        response.raise_for_status()
        return response.json()
    except Exception as exc:
        raise HTTPException(503, f"Ollama indisponible: {exc}")


def _validated_payload(raw: bytes, path: str) -> dict:
    if len(raw) > AI_MAX_REQUEST_BYTES:
        raise HTTPException(413, "Requête IA trop volumineuse")
    try:
        payload = json.loads(raw)
    except Exception:
        raise HTTPException(400, "Corps JSON invalide")
    if not isinstance(payload, dict):
        raise HTTPException(400, "Corps JSON invalide")
    if path == "/api/chat":
        messages = payload.get("messages")
        if not isinstance(messages, list) or not messages or len(messages) > AI_MAX_MESSAGES:
            raise HTTPException(413, "Nombre de messages IA invalide ou excessif")
        total = sum(len(str(m.get("content", ""))) for m in messages if isinstance(m, dict))
        if total > AI_MAX_CONTEXT_CHARS:
            raise HTTPException(413, "Contexte IA trop volumineux")
    elif path in {"/api/embed", "/api/embeddings"}:
        value = payload.get("input", payload.get("prompt", ""))
        values = value if isinstance(value, list) else [value]
        if any(len(str(item)) > AI_MAX_EMBED_CHARS for item in values):
            raise HTTPException(413, "Texte d'embedding trop volumineux")
    return payload


def _normalize_embedding_payload(payload: dict) -> dict:
    """Adapt cached clients using the former prompt field to Ollama's input field."""
    normalized = dict(payload)
    normalized["input"] = normalized.pop("prompt", normalized.get("input", ""))
    return normalized


async def _forward(request: Request, path: str, stream: bool, user: UserSession):
    raw = await request.body()
    payload = _validated_payload(raw, path)
    return await _forward_payload(path, payload, stream, user)


async def _forward_payload(path: str, payload: dict, stream: bool, user: UserSession):
    await charge_user(user.id)
    url = f"{OLLAMA_URL.rstrip('/')}{path}"
    if not stream:
        try:
            async with inference_slot(user.id):
                async with httpx.AsyncClient(timeout=AI_UPSTREAM_TIMEOUT_SECONDS) as client:
                    response = await client.post(url, json=payload, headers={"content-type": "application/json"})
            return StreamingResponse(iter([response.content]), status_code=response.status_code,
                                     media_type=response.headers.get("content-type", "application/json"))
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(503, f"Ollama indisponible: {exc}")

    slot = inference_slot(user.id)
    await slot.__aenter__()
    client = httpx.AsyncClient(timeout=httpx.Timeout(AI_UPSTREAM_TIMEOUT_SECONDS, read=AI_UPSTREAM_TIMEOUT_SECONDS))
    try:
        upstream = await client.send(client.build_request("POST", url, json=payload,
            headers={"content-type": "application/json"}), stream=True)
    except Exception as exc:
        await client.aclose()
        await slot.__aexit__(None, None, None)
        raise HTTPException(503, f"Ollama indisponible: {exc}")

    async def body():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()
            await slot.__aexit__(None, None, None)
    return StreamingResponse(body(), status_code=upstream.status_code,
                             media_type=upstream.headers.get("content-type", "application/x-ndjson"))


@router.post("/api/embeddings")
async def embeddings(request: Request, user: UserSession = Depends(require_auth)):
    # Convert cached legacy clients to Ollama's current /api/embed schema.
    payload = _normalize_embedding_payload(
        _validated_payload(await request.body(), "/api/embeddings")
    )
    return await _forward_payload("/api/embed", payload, False, user)


@router.post("/api/embed")
async def embed(request: Request, user: UserSession = Depends(require_auth)):
    return await _forward(request, "/api/embed", False, user)


@router.post("/api/chat")
async def chat(request: Request, user: UserSession = Depends(require_auth)):
    raw = await request.body()
    parsed = _validated_payload(raw, "/api/chat")
    return await _forward(request, "/api/chat", bool(parsed.get("stream", False)), user)
