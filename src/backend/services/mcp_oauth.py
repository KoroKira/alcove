"""Optional OAuth resource server for pre-registered Keycloak MCP clients.

Web session tokens are never MCP credentials: both the dedicated resource
 audience and an explicit authorized-party allowlist are checked after RS256
verification. No user provisioning or dynamic client registration happens here.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from functools import lru_cache
import os
from urllib.parse import urlsplit
from uuid import UUID

import jwt
from jwt import PyJWKClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database.models.user_model import UserStore
from services.mcp_api_key_service import McpPrincipal

OAUTH_SCOPES = {"alcove:read": "read", "alcove:write": "write"}


@dataclass(frozen=True)
class McpOAuthSettings:
    resource: str
    issuer: str
    jwks_url: str
    client_ids: frozenset[str]
    allow_write: bool = False

    @property
    def metadata_url(self) -> str:
        url = urlsplit(self.resource)
        return f"{url.scheme}://{url.netloc}/.well-known/oauth-protected-resource{url.path.rstrip('/')}"


def _https_url(value: str, name: str) -> str:
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or any(char in value for char in ('"', "\\", "\r", "\n"))):
        raise ValueError(f"{name} must be an absolute HTTPS URL without credentials, query or fragment")
    return value.rstrip("/")


def oauth_settings() -> McpOAuthSettings | None:
    if os.getenv("MCP_OAUTH_ENABLED", "false").lower() != "true":
        return None
    resource = _https_url(os.getenv("MCP_OAUTH_RESOURCE", ""), "MCP_OAUTH_RESOURCE")
    # Pin discovery and token audience to the canonical MCP resource.
    if urlsplit(resource).path != "/mcp":
        raise ValueError("MCP_OAUTH_RESOURCE must end in /mcp")
    server = _https_url(os.getenv("OIDC_SERVER_URL", ""), "OIDC_SERVER_URL")
    realm = os.getenv("OIDC_REALM", "")
    if not realm or any(char in realm for char in '/?#"\\\r\n'):
        raise ValueError("OIDC_REALM is required")
    client_ids = frozenset(part.strip() for part in os.getenv("MCP_OAUTH_CLIENT_IDS", "").split(",") if part.strip())
    if not client_ids or os.getenv("OIDC_CLIENT_ID") in client_ids:
        raise ValueError("MCP_OAUTH_CLIENT_IDS must name dedicated MCP clients, not the web client")
    issuer = f"{server}/realms/{realm}"
    # Internal origin may be HTTP on the Docker network, matching existing OIDC
    # configuration. Public issuer validation always uses OIDC_SERVER_URL above.
    internal = (os.getenv("OIDC_INTERNAL_URL") or server).rstrip("/")
    parsed = urlsplit(internal)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("OIDC_INTERNAL_URL must be an HTTP(S) origin")
    return McpOAuthSettings(resource, issuer, f"{internal}/realms/{realm}/protocol/openid-connect/certs", client_ids,
                            os.getenv("MCP_OAUTH_WRITE_ENABLED", "false").lower() == "true")


def oauth_connection_info() -> dict:
    try:
        settings = oauth_settings()
    except ValueError:
        return {"enabled": False, "available": False}
    if settings is None:
        return {"enabled": False, "available": False}
    return {"enabled": True, "available": True, "resource": settings.resource,
            "authorization_server": settings.issuer, "client_ids": sorted(settings.client_ids),
            "scopes": ["alcove:read"] + (["alcove:write"] if settings.allow_write else [])}


@lru_cache(maxsize=4)
def _jwks_client(url: str) -> PyJWKClient:
    return PyJWKClient(url, timeout=5, lifespan=300)


def _verified_claims(token: str, settings: McpOAuthSettings) -> dict:
    signing_key = _jwks_client(settings.jwks_url).get_signing_key_from_jwt(token)
    claims = jwt.decode(
        token, signing_key.key, algorithms=["RS256"], audience=settings.resource,
        issuer=settings.issuer,
        options={"require": ["exp", "iat", "sub", "iss", "aud", "azp", "scope"]},
    )
    if claims.get("azp") not in settings.client_ids or claims.get("typ") != "Bearer":
        raise jwt.InvalidTokenError("Not a dedicated MCP access token")
    if not isinstance(claims.get("scope"), str):
        raise jwt.InvalidTokenError("Invalid scope claim")
    return claims


async def verify_oauth_principal(session: AsyncSession, token: str) -> McpPrincipal | None:
    settings = oauth_settings()
    if settings is None or not token or len(token) > 16_384:
        return None
    try:
        # PyJWKClient performs synchronous HTTP on cache misses: keep it off the
        # event loop. Signature, issuer, audience, expiry and client checks are
        # completed before either scopes or subject are trusted.
        claims = await asyncio.to_thread(_verified_claims, token, settings)
        owner_id = UUID(claims["sub"])
        scopes = frozenset(OAUTH_SCOPES[s] for s in claims["scope"].split()
                           if s in OAUTH_SCOPES and (s != "alcove:write" or settings.allow_write))
        if not scopes:
            return None
    except (jwt.PyJWTError, ValueError, TypeError, KeyError):
        return None
    # OAuth cannot create an account or impersonate a subject supplied as an
    # argument: the verified Keycloak UUID must already belong to an Alcove user.
    existing = (await session.execute(select(UserStore.id).where(UserStore.id == owner_id))).scalar_one_or_none()
    return McpPrincipal(owner_id, scopes) if existing is not None else None


def protected_resource_metadata(settings: McpOAuthSettings) -> dict:
    return {"resource": settings.resource, "authorization_servers": [settings.issuer],
            "scopes_supported": ["alcove:read"] + (["alcove:write"] if settings.allow_write else []),
            "bearer_methods_supported": ["header"],
            "resource_name": "Alcove personal knowledge base"}


def auth_challenge(settings: McpOAuthSettings | None, *, invalid: bool = False, scope: str | None = None) -> str:
    parts = ["Bearer"]
    if settings:
        parts.append(f'resource_metadata="{settings.metadata_url}"')
    if scope:
        parts.extend(['error="insufficient_scope"', f'scope="{scope}"'])
    elif invalid:
        parts.append('error="invalid_token"')
    return parts[0] + (" " + ", ".join(parts[1:]) if len(parts) > 1 else "")
