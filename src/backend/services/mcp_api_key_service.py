"""Machine-to-machine authentication for MCP tool calls in production.

Fully separate from the Keycloak/OIDC web login (routers/auth_router.py):
MCP clients (hub-bot, agents) don't do a browser OAuth dance, they hold a
static Bearer API key. This module owns that key's whole lifecycle —
generation, verification, revocation, rotation — and is the only code
allowed to read or write McpApiKey.secret_hash.

Token shape: "amk_<public_id>_<secret>"
  · public_id (16 hex chars) is stored in cleartext and indexed — it's how
    verification finds the one candidate row in O(1) instead of scanning
    every hash in the table.
  · secret (32 random bytes, base64-urlsafe) is never stored, only
    sha256(secret) is. Losing the DB doesn't hand out usable keys: the
    secret's 256 bits of entropy make offline brute force infeasible against
    the bare hash even without a pepper — the same threat model GitHub/AWS
    use for API tokens (unlike user passwords, which need a slow KDF because
    humans pick low-entropy secrets; these are machine-generated).
  · Comparison is constant-time (hmac.compare_digest) so response timing
    can't be used to guess the hash byte by byte.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional, Tuple
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database.models.mcp_api_key_model import McpApiKey

_TOKEN_PREFIX = "amk"
_PUBLIC_ID_BYTES = 8  # -> 16 hex chars
_SECRET_BYTES = 32  # -> 256 bits of entropy
API_KEY_SCOPES = frozenset({"read", "write"})


@dataclass(frozen=True)
class McpPrincipal:
    owner_id: UUID
    scopes: frozenset[str]


def normalize_scopes(scopes) -> list[str]:
    if not isinstance(scopes, (list, tuple, set, frozenset)) or not scopes:
        raise ValueError("MCP API keys require explicit read and/or write scopes")
    if any(not isinstance(scope, str) or scope not in API_KEY_SCOPES for scope in scopes):
        raise ValueError("MCP API key scopes must be read and/or write")
    return sorted(set(scopes))


def _hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def _split_token(token: str) -> Optional[Tuple[str, str]]:
    """Parse "amk_<public_id>_<secret>". None if malformed."""
    parts = token.split("_", 2)
    if len(parts) != 3 or parts[0] != _TOKEN_PREFIX:
        return None
    _, public_id, secret = parts
    if not public_id or not secret:
        return None
    return public_id, secret


def _generate_key_material() -> Tuple[str, str, str]:
    """Fresh (public_id, plaintext secret, secret_hash) triple. Pure/no I/O
    so create_api_key and rotate_api_key can share it without either one
    forcing an extra commit on the other."""
    public_id = secrets.token_hex(_PUBLIC_ID_BYTES)
    secret = secrets.token_urlsafe(_SECRET_BYTES)
    return public_id, secret, _hash_secret(secret)


async def create_api_key(
    session: AsyncSession,
    owner_id: UUID,
    name: Optional[str] = None,
    expires_at: Optional[datetime] = None,
    scopes=("read",),
) -> Tuple[str, McpApiKey]:
    """Mint a new MCP API key bound to owner_id.

    Returns (plaintext_token, row). The plaintext token is shown exactly
    once here — it is never persisted and cannot be recovered later, only
    rotated (see rotate_api_key).
    """
    scopes = normalize_scopes(scopes)
    public_id, secret, secret_hash = _generate_key_material()
    row = McpApiKey(
        owner_id=owner_id,
        public_id=public_id,
        secret_hash=secret_hash,
        name=name,
        expires_at=expires_at,
        scopes=scopes,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    token = f"{_TOKEN_PREFIX}_{public_id}_{secret}"
    return token, row


async def verify_api_key(session: AsyncSession, token: Optional[str]) -> Optional[UUID]:
    """Return the owner_id for a valid, non-revoked, non-expired token.

    This compatibility API resolves identity only. Tool authorization must use
    verify_api_key_principal and check its scopes, as the MCP router does.

    Returns None on any failure (missing, malformed, unknown, revoked,
    expired, or wrong secret) — callers should not distinguish these cases
    to avoid leaking which part of the token was wrong.
    """
    principal = await verify_api_key_principal(session, token)
    return principal.owner_id if principal is not None else None


async def verify_api_key_principal(session: AsyncSession, token: Optional[str]) -> Optional[McpPrincipal]:
    """Authenticate a key and return its immutable identity and scope bound."""
    if not token:
        return None
    parsed = _split_token(token.strip())
    if parsed is None:
        return None
    public_id, secret = parsed

    stmt = select(McpApiKey).where(McpApiKey.public_id == public_id)
    row = (await session.execute(stmt)).scalar_one_or_none()
    if row is None:
        return None
    if row.revoked_at is not None:
        return None
    if row.expires_at is not None and row.expires_at <= datetime.now(timezone.utc):
        return None
    if not hmac.compare_digest(row.secret_hash, _hash_secret(secret)):
        return None
    try:
        scopes = frozenset(normalize_scopes(row.scopes))
    except ValueError:
        return None

    row.last_used_at = datetime.now(timezone.utc)
    await session.commit()
    return McpPrincipal(row.owner_id, scopes)


async def revoke_api_key(session: AsyncSession, public_id: str) -> bool:
    """Revoke a key by its public_id. Returns False if unknown or already revoked."""
    stmt = select(McpApiKey).where(McpApiKey.public_id == public_id)
    row = (await session.execute(stmt)).scalar_one_or_none()
    if row is None or row.revoked_at is not None:
        return False
    row.revoked_at = datetime.now(timezone.utc)
    await session.commit()
    return True


async def rotate_api_key(
    session: AsyncSession, public_id: str,
) -> Optional[Tuple[str, McpApiKey]]:
    """Revoke the given key and mint a fresh one for the same owner/name/expiry,
    in a single commit — the old key never ends up revoked without a
    replacement (or vice versa) even if the process dies right after.

    None if the key is unknown or already revoked — callers should mint a
    brand-new key with create_api_key in that case instead of rotating.
    """
    stmt = select(McpApiKey).where(McpApiKey.public_id == public_id)
    row = (await session.execute(stmt)).scalar_one_or_none()
    if row is None or row.revoked_at is not None:
        return None
    scopes = normalize_scopes(row.scopes)
    row.revoked_at = datetime.now(timezone.utc)

    new_public_id, new_secret, new_secret_hash = _generate_key_material()
    new_row = McpApiKey(
        owner_id=row.owner_id,
        public_id=new_public_id,
        secret_hash=new_secret_hash,
        name=row.name,
        expires_at=row.expires_at,
        scopes=scopes,
    )
    session.add(new_row)
    await session.commit()
    await session.refresh(new_row)
    token = f"{_TOKEN_PREFIX}_{new_public_id}_{new_secret}"
    return token, new_row
