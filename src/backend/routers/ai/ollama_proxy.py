"""Authenticated same-origin proxy to the operator-configured Ollama.

The browser should not need a local Ollama, special CORS flags, or mixed HTTP
content exceptions. This keeps Alcove usable from phones and laptops while the
homelab's stronger inference machine does the work.
"""
import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from config import OLLAMA_URL
from dependencies import UserSession, require_auth

router = APIRouter(prefix="/ollama")


@router.get("/api/tags")
async def tags(_: UserSession = Depends(require_auth)):
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            response = await client.get(f"{OLLAMA_URL.rstrip('/')}/api/tags")
        response.raise_for_status()
        return response.json()
    except Exception as exc:
        raise HTTPException(503, f"Ollama indisponible: {exc}")


async def _forward(request: Request, path: str, stream: bool):
    payload = await request.body()
    url = f"{OLLAMA_URL.rstrip('/')}{path}"
    if not stream:
        try:
            async with httpx.AsyncClient(timeout=300) as client:
                response = await client.post(url, content=payload, headers={"content-type": "application/json"})
            return StreamingResponse(iter([response.content]), status_code=response.status_code,
                                     media_type=response.headers.get("content-type", "application/json"))
        except Exception as exc:
            raise HTTPException(503, f"Ollama indisponible: {exc}")

    client = httpx.AsyncClient(timeout=httpx.Timeout(300, read=None))
    try:
        upstream = await client.send(client.build_request("POST", url, content=payload,
            headers={"content-type": "application/json"}), stream=True)
    except Exception as exc:
        await client.aclose()
        raise HTTPException(503, f"Ollama indisponible: {exc}")

    async def body():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()
    return StreamingResponse(body(), status_code=upstream.status_code,
                             media_type=upstream.headers.get("content-type", "application/x-ndjson"))


@router.post("/api/embeddings")
async def embeddings(request: Request, _: UserSession = Depends(require_auth)):
    return await _forward(request, "/api/embeddings", False)


@router.post("/api/chat")
async def chat(request: Request, _: UserSession = Depends(require_auth)):
    raw = await request.json()
    return await _forward(request, "/api/chat", bool(raw.get("stream", False)))
