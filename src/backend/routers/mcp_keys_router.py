"""Browser-only management of the signed-in user's MCP connections."""

from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from config import FRONTEND_URL
from database.database import get_session
from database.models.mcp_api_key_model import McpApiKey
from database.models.user_model import UserStore
from dependencies import UserSession, require_auth
from services.mcp_api_key_service import create_api_key, revoke_api_key

mcp_keys_router = APIRouter(prefix="/api/mcp", tags=["MCP connections"])


class McpKeyCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=120)
    allow_write: bool = Field(default=False, strict=True)
    expires_days: int = Field(default=90, ge=1, le=365, strict=True)

    @field_validator("name")
    @classmethod
    def trim_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Donnez un nom à cette connexion.")
        return value.strip()


def _safe_key(row: McpApiKey) -> dict:
    # Deliberately list fields: never serialize the ORM model or its hash.
    return {
        "public_id": row.public_id,
        "name": row.name or "Connexion MCP",
        "scopes": row.scopes,
        "created_at": row.created_at,
        "expires_at": row.expires_at,
        "last_used_at": row.last_used_at,
        "revoked_at": row.revoked_at,
    }


def _private_json(body: dict, status_code: int = 200) -> JSONResponse:
    return JSONResponse(
        jsonable_encoder(body), status_code=status_code,
        headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
    )


@mcp_keys_router.get("/connection")
async def connection_info(request: Request, _: UserSession = Depends(require_auth)):
    from services.mcp_oauth import oauth_connection_info

    origin = (FRONTEND_URL or str(request.base_url)).rstrip("/")
    return _private_json({"endpoint": f"{origin}/mcp", "oauth": oauth_connection_info()})


@mcp_keys_router.get("/keys")
async def list_keys(
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    # Active connections must stay visible and revocable even after many old
    # keys have expired or been revoked. Creation caps active keys at 20.
    active = and_(
        McpApiKey.revoked_at.is_(None),
        or_(McpApiKey.expires_at.is_(None), McpApiKey.expires_at > datetime.now(timezone.utc)),
    )
    rows = (await session.execute(
        select(McpApiKey).where(McpApiKey.owner_id == user.id)
        .order_by(active.desc(), McpApiKey.created_at.desc()).limit(100)
    )).scalars().all()
    return _private_json({"keys": [_safe_key(row) for row in rows]})


@mcp_keys_router.post("/keys")
async def create_key(
    body: McpKeyCreate,
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    # Serialize creations for an owner so concurrent requests cannot exceed
    # the active-connection limit. Browser session identity is the sole owner.
    owner = (await session.execute(
        select(UserStore.id).where(UserStore.id == user.id).with_for_update()
    )).scalar_one_or_none()
    if owner is None:
        raise HTTPException(status_code=401, detail="Reconnectez-vous à Alcove.")
    now = datetime.now(timezone.utc)
    active = (await session.execute(select(func.count()).select_from(McpApiKey).where(
        McpApiKey.owner_id == user.id,
        McpApiKey.revoked_at.is_(None),
        or_(McpApiKey.expires_at.is_(None), McpApiKey.expires_at > now),
    ))).scalar_one()
    if active >= 20:
        raise HTTPException(status_code=409, detail="Révoquez une connexion inutilisée avant d’en créer une autre (limite : 20).")
    scopes = ["read", "write"] if body.allow_write else ["read"]
    token, row = await create_api_key(
        session, UUID(str(user.id)), name=body.name,
        expires_at=now + timedelta(days=body.expires_days), scopes=scopes,
    )
    return _private_json({"key": _safe_key(row), "token": token}, status_code=201)


@mcp_keys_router.post("/keys/{public_id}/revoke")
async def revoke_key(
    public_id: str,
    user: UserSession = Depends(require_auth),
    session: AsyncSession = Depends(get_session),
):
    row = (await session.execute(select(McpApiKey).where(
        McpApiKey.owner_id == user.id, McpApiKey.public_id == public_id,
    ))).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Connexion introuvable.")
    if row.revoked_at is None:
        await revoke_api_key(session, public_id)
    return _private_json({"revoked": True})
