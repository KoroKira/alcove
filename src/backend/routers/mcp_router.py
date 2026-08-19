"""MCP (Model Context Protocol) server — expose Alcove's knowledge base
to any MCP-capable client (Claude Desktop, Cursor, ChatGPT, custom agents).

The user's KB becomes addressable from outside via 4 tools :
  · search_pads(query, top_k)  — semantic (RAG) or text search
  · read_pad(pad_id)           — full markdown content
  · list_recent(limit)         — recent pads with metadata
  · write_note(title, content) — create a new document pad

Transport : JSON-RPC 2.0 over HTTP POST at /mcp/ — the Streamable HTTP
transport spec'd by the MCP SDK. Single endpoint handles the whole
lifecycle : initialize, tools/list, tools/call, notifications/initialized.

Auth :
  · PAD_DEV_MODE : use the fixed DEV_USER_ID. No token needed. Perfect
    for "point Claude Desktop at localhost:8000/mcp/" one-shot setup.
  · Prod : Bearer token in Authorization header. TODO — needs an API
    keys table (out of scope for chantier #9 MVP ; comes with #12 when
    the extension needs the same auth surface).
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from uuid import UUID

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import select as sa_select
from sqlalchemy.ext.asyncio import AsyncSession

from config import PAD_DEV_MODE
from database.database import get_session
from database.models import PadStore
from database.models.embedding_model import PadEmbedding
from database.pad_serialization import serialize_pad
from routers.ai.rag import rank_rows
from routers.auth_router import DEV_USER_ID

logger = logging.getLogger(__name__)

mcp_router = APIRouter(prefix="/mcp")

# ── MCP protocol constants ─────────────────────────────────────────────────
_PROTOCOL_VERSION = "2025-06-18"
_SERVER_INFO = {
    "name": "alcove",
    "version": "1.0.0",
}
_SERVER_CAPABILITIES = {
    "tools": {},
}


# ── Tool schemas — described in JSON Schema so any MCP client renders them
#    cleanly. Descriptions matter : the calling LLM reads them to decide
#    when to call which tool.
_TOOLS: List[Dict[str, Any]] = [
    {
        "name": "search_pads",
        "description": (
            "Semantic search across the user's Alcove knowledge base. Returns "
            "the top-K most relevant pads with excerpt chunks. Use this when "
            "the user asks about anything in their notes, articles, videos, "
            "or ingested content — it's fuzzy and multilingual, so a French "
            "query can surface English notes and vice-versa."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Natural-language query."},
                "top_k": {"type": "integer", "default": 5, "minimum": 1, "maximum": 20},
            },
            "required": ["query"],
        },
    },
    {
        "name": "read_pad",
        "description": (
            "Fetch the full Markdown content of a specific pad by ID. Use "
            "after search_pads when the excerpts aren't enough context."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "pad_id": {"type": "string", "description": "The pad UUID."},
            },
            "required": ["pad_id"],
        },
    },
    {
        "name": "list_recent",
        "description": (
            "List the user's most recently updated pads (title, type, tags, "
            "date). Use to answer 'what have I been working on' or to build "
            "a shortlist before drilling in with read_pad."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "default": 20, "minimum": 1, "maximum": 100},
            },
        },
    },
    {
        "name": "write_note",
        "description": (
            "Create a new document pad in the user's KB with the given title "
            "and Markdown content. Optionally attach tags. Use when the user "
            "asks you to save something to Alcove."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "content": {"type": "string", "description": "Markdown body."},
                "tags": {"type": "array", "items": {"type": "string"}, "default": []},
            },
            "required": ["title", "content"],
        },
    },
]


# ── Auth resolution ────────────────────────────────────────────────────────
async def _resolve_user_id(request: Request) -> UUID:
    """Return the owning user's UUID for this MCP call.

    Dev mode : always DEV_USER_ID. No credential needed — the local
    Alcove is a single-user session by design.
    Prod mode : Bearer token in Authorization header (TODO — needs the
    API keys table from chantier #12). For now, dev-mode only.
    """
    if PAD_DEV_MODE:
        return UUID(DEV_USER_ID)
    # Placeholder — reject explicitly rather than silently accepting a
    # missing token so a prod deployment doesn't leak the KB.
    raise HTTPException(
        status_code=401,
        detail={
            "code": "auth_required",
            "message": "MCP en production requiert un token API — pas encore implémenté.",
        },
    )


# ── Ollama embedding for semantic search ───────────────────────────────────
_EMBED_MODEL_DEFAULT = "nomic-embed-text"
_OLLAMA_URL = "http://localhost:11434"


async def _embed_query(text: str, model: str = _EMBED_MODEL_DEFAULT) -> Optional[List[float]]:
    """Ask the local Ollama for an embedding of the query text. Returns None
    on any failure — the caller falls back to text search."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(
                f"{_OLLAMA_URL}/api/embeddings",
                json={"model": model, "prompt": text},
            )
            r.raise_for_status()
            emb = r.json().get("embedding")
            return emb if isinstance(emb, list) and emb else None
    except Exception as e:
        logger.info("MCP embed failed (falling back to text search) : %s", e)
        return None


# ── Tool implementations ───────────────────────────────────────────────────
async def _tool_search_pads(
    args: Dict[str, Any], user_id: UUID, session: AsyncSession,
) -> Dict[str, Any]:
    query = (args.get("query") or "").strip()
    top_k = int(args.get("top_k") or 5)
    top_k = max(1, min(20, top_k))
    if not query:
        return {"results": [], "mode": "empty"}

    # Semantic first — falls back to LIKE search if Ollama is offline or
    # the KB has no embeddings.
    emb = await _embed_query(query)
    if emb:
        rows = await PadEmbedding.get_all_for_owner(session, user_id)
        if rows:
            from fastapi.concurrency import run_in_threadpool
            scored = await run_in_threadpool(rank_rows, emb, rows)
            top = [(s, r) for s, r in scored[:top_k] if s > 0.3]
            if top:
                return {
                    "mode": "semantic",
                    "results": [
                        {
                            "pad_id": str(r.pad_id),
                            "pad_name": r.display_name,
                            "score": round(s, 4),
                            "chunk_text": r.chunk_text,
                        }
                        for s, r in top
                    ],
                }

    # Fallback : simple ILIKE on display_name + data.content.
    like = f"%{query}%"
    stmt = (
        sa_select(PadStore.id, PadStore.display_name, PadStore.tags, PadStore.updated_at)
        .where(PadStore.owner_id == user_id)
        .where(PadStore.display_name.ilike(like))
        .order_by(PadStore.updated_at.desc())
        .limit(top_k)
    )
    rows = (await session.execute(stmt)).all()
    return {
        "mode": "text",
        "results": [
            {
                "pad_id": str(r.id),
                "pad_name": r.display_name,
                "tags": list(r.tags or []),
                "updated_at": r.updated_at.isoformat() if r.updated_at else None,
            }
            for r in rows
        ],
    }


async def _tool_read_pad(
    args: Dict[str, Any], user_id: UUID, session: AsyncSession,
) -> Dict[str, Any]:
    try:
        pid = UUID(args.get("pad_id") or "")
    except Exception:
        raise ValueError("invalid pad_id")
    stmt = sa_select(PadStore).where(PadStore.id == pid, PadStore.owner_id == user_id)
    pad = (await session.execute(stmt)).scalar_one_or_none()
    if pad is None:
        raise ValueError(f"pad {pid} not found or not owned by user")
    data = pad.data if isinstance(pad.data, dict) else {}
    content = data.get("content") or ""
    return {
        "pad_id": str(pad.id),
        "title": pad.display_name,
        "pad_type": pad.pad_type,
        "tags": list(pad.tags or []),
        "content": content,
        "source_url": pad.source_url,
        "updated_at": pad.updated_at.isoformat() if pad.updated_at else None,
    }


async def _tool_list_recent(
    args: Dict[str, Any], user_id: UUID, session: AsyncSession,
) -> Dict[str, Any]:
    limit = int(args.get("limit") or 20)
    limit = max(1, min(100, limit))
    stmt = (
        sa_select(
            PadStore.id, PadStore.display_name, PadStore.pad_type,
            PadStore.tags, PadStore.updated_at, PadStore.source_url,
        )
        .where(PadStore.owner_id == user_id)
        .order_by(PadStore.updated_at.desc())
        .limit(limit)
    )
    rows = (await session.execute(stmt)).all()
    return {
        "pads": [
            {
                "pad_id": str(r.id),
                "title": r.display_name,
                "pad_type": r.pad_type,
                "tags": list(r.tags or []),
                "source_url": r.source_url,
                "updated_at": r.updated_at.isoformat() if r.updated_at else None,
            }
            for r in rows
        ],
    }


async def _tool_write_note(
    args: Dict[str, Any], user_id: UUID, session: AsyncSession,
) -> Dict[str, Any]:
    title = (args.get("title") or "").strip()
    content = args.get("content") or ""
    tags = args.get("tags") or []
    if not title:
        raise ValueError("title is required")
    from domain.pad import Pad
    pad = await Pad.create(
        session,
        owner_id=user_id,
        display_name=title[:100],
    )
    # Set as document type + content + tags via direct SQL to bypass
    # pad.save() which we've been keeping thin around a few columns.
    from sqlalchemy import update as sa_update
    stmt = (
        sa_update(PadStore)
        .where(PadStore.id == pad.id)
        .values(
            pad_type="document",
            data={"content": content, "format": "markdown"},
            tags=[t.strip()[:50] for t in tags if isinstance(t, str) and t.strip()][:20],
        )
    )
    await session.execute(stmt)
    await session.commit()
    return {
        "pad_id": str(pad.id),
        "title": title,
        "url": f"/pad/{pad.id}",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


_TOOL_HANDLERS = {
    "search_pads": _tool_search_pads,
    "read_pad": _tool_read_pad,
    "list_recent": _tool_list_recent,
    "write_note": _tool_write_note,
}


# ── JSON-RPC dispatch ──────────────────────────────────────────────────────
def _rpc_response(id: Any, result: Any) -> Dict[str, Any]:
    return {"jsonrpc": "2.0", "id": id, "result": result}


def _rpc_error(id: Any, code: int, message: str, data: Any = None) -> Dict[str, Any]:
    err = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    return {"jsonrpc": "2.0", "id": id, "error": err}


class _MCPRequest(BaseModel):
    jsonrpc: str
    id: Optional[Any] = None
    method: str
    params: Optional[Dict[str, Any]] = None


@mcp_router.post("/")
@mcp_router.post("")
async def mcp_endpoint(request: Request) -> JSONResponse:
    """Single MCP endpoint — dispatches every JSON-RPC method by name.

    Client typically calls in order :
      1. initialize          → we announce protocolVersion + capabilities
      2. notifications/initialized (no id, no response expected)
      3. tools/list          → we return the 4 tools
      4. tools/call          → we run the tool, return content
    """
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(_rpc_error(None, -32700, "Parse error"), status_code=200)

    # Notifications have no id — MCP still requires a 200 with no body per spec.
    is_notification = "id" not in body

    try:
        req = _MCPRequest(**body)
    except Exception as e:
        return JSONResponse(_rpc_error(body.get("id"), -32600, "Invalid Request", str(e)), status_code=200)

    method = req.method
    params = req.params or {}

    # Method dispatch ---------------------------------------------------------
    try:
        if method == "initialize":
            client_version = params.get("protocolVersion", _PROTOCOL_VERSION)
            return JSONResponse(_rpc_response(req.id, {
                "protocolVersion": client_version,
                "capabilities": _SERVER_CAPABILITIES,
                "serverInfo": _SERVER_INFO,
            }))

        if method in ("notifications/initialized", "initialized"):
            # No response for notifications.
            return JSONResponse({}, status_code=202)

        if method == "tools/list":
            return JSONResponse(_rpc_response(req.id, {"tools": _TOOLS}))

        if method == "tools/call":
            name = params.get("name")
            arguments = params.get("arguments") or {}
            handler = _TOOL_HANDLERS.get(name)
            if not handler:
                return JSONResponse(_rpc_error(req.id, -32601, f"Unknown tool: {name}"), status_code=200)
            user_id = await _resolve_user_id(request)
            # Own session — get_session is a FastAPI Depends, and we're
            # dispatching manually here, so we bypass the dep system.
            async for session in get_session():
                try:
                    result = await handler(arguments, user_id, session)
                except ValueError as ve:
                    return JSONResponse(_rpc_error(req.id, -32602, str(ve)), status_code=200)
                except Exception as e:
                    logger.exception("MCP tool %s failed", name)
                    return JSONResponse(_rpc_error(req.id, -32603, "Internal error", str(e)), status_code=200)
                # MCP tools return content as an array of blocks. Wrap the
                # JSON payload as a "text" block containing pretty JSON —
                # every MCP client can render this uniformly.
                return JSONResponse(_rpc_response(req.id, {
                    "content": [{
                        "type": "text",
                        "text": json.dumps(result, ensure_ascii=False, indent=2),
                    }],
                    "isError": False,
                }))

        if method == "ping":
            return JSONResponse(_rpc_response(req.id, {}))

        # Unknown method
        if is_notification:
            return JSONResponse({}, status_code=202)
        return JSONResponse(_rpc_error(req.id, -32601, f"Method not found: {method}"), status_code=200)

    except HTTPException as he:
        return JSONResponse(_rpc_error(req.id, -32001, he.detail if isinstance(he.detail, str) else "Auth error", he.detail), status_code=200)
    except Exception as e:
        logger.exception("MCP dispatch failed")
        return JSONResponse(_rpc_error(req.id, -32603, "Internal error", str(e)), status_code=200)


@mcp_router.get("/")
@mcp_router.get("")
async def mcp_info() -> Dict[str, Any]:
    """GET on the MCP endpoint returns a short description — helps humans
    who paste the URL in a browser to check the server is live."""
    return {
        "server": _SERVER_INFO,
        "protocolVersion": _PROTOCOL_VERSION,
        "capabilities": _SERVER_CAPABILITIES,
        "tools": [{"name": t["name"], "description": t["description"]} for t in _TOOLS],
        "endpoint": "POST /mcp/",
        "transport": "http",
        "auth": "PAD_DEV_MODE : anonymous (dev user). Prod : Bearer token (TODO).",
    }
