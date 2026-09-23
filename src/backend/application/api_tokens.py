"""Creation and authentication of scoped external API tokens."""

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone
from typing import Iterable
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from application.audit import record_audit
from application.principal import ALL_EXTERNAL_SCOPES, Principal
from database.models import ApiTokenStore, UserStore


class ApiTokenError(ValueError):
    pass


def _hash_token(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


class ApiTokenService:
    def __init__(self, session: AsyncSession):
        self.session = session

    @staticmethod
    def validate_scopes(scopes: Iterable[str]) -> list[str]:
        normalized = sorted({str(scope).strip() for scope in scopes if str(scope).strip()})
        unknown = [scope for scope in normalized if scope not in ALL_EXTERNAL_SCOPES]
        if unknown:
            raise ApiTokenError(f"Unknown API token scope: {unknown[0]}")
        if not normalized:
            raise ApiTokenError("At least one API token scope is required")
        return normalized

    async def create(
        self,
        principal: Principal,
        *,
        name: str,
        scopes: Iterable[str],
        expires_in_days: int,
    ) -> tuple[ApiTokenStore, str]:
        name = " ".join(name.strip().split())
        if not 1 <= len(name) <= 120:
            raise ApiTokenError("Token name must contain between 1 and 120 characters")
        if not 1 <= expires_in_days <= 365:
            raise ApiTokenError("Token expiration must be between 1 and 365 days")

        normalized_scopes = self.validate_scopes(scopes)
        raw_secret = secrets.token_urlsafe(32)
        # The prefix is parsed as the third underscore-delimited component of
        # the credential. Hex avoids the '_' character that token_urlsafe may
        # generate and keeps lookup deterministic.
        prefix = secrets.token_hex(8)
        raw_token = f"alcove_at_{prefix}_{raw_secret}"
        token = ApiTokenStore(
            user_id=principal.id,
            name=name,
            token_prefix=prefix,
            token_hash=_hash_token(raw_token),
            scopes=normalized_scopes,
            expires_at=datetime.now(timezone.utc) + timedelta(days=expires_in_days),
        )
        self.session.add(token)
        await self.session.flush()
        await record_audit(
            self.session,
            principal,
            action="api_token.created",
            resource_type="api_token",
            resource_id=token.id,
            metadata={"scopes": normalized_scopes, "expires_in_days": expires_in_days},
        )
        await self.session.commit()
        await self.session.refresh(token)
        return token, raw_token

    async def authenticate(self, raw_token: str) -> Principal | None:
        if not raw_token or len(raw_token) > 512:
            return None
        parts = raw_token.split("_", 3)
        if len(parts) != 4 or parts[0] != "alcove" or parts[1] != "at":
            return None
        prefix = parts[2]
        token = (await self.session.execute(
            select(ApiTokenStore).where(ApiTokenStore.token_prefix == prefix)
        )).scalar_one_or_none()
        if not token or not hmac.compare_digest(token.token_hash, _hash_token(raw_token)):
            return None

        now = datetime.now(timezone.utc)
        if token.revoked_at is not None or token.expires_at <= now:
            return None

        user = await UserStore.get_by_id(self.session, token.user_id)
        if not user:
            return None

        token.last_used_at = now
        await record_audit(
            self.session,
            Principal(
                id=user.id,
                auth_type="api_token",
                scopes=frozenset(token.scopes or []),
                token_id=token.id,
                username=user.username,
                email=user.email,
                roles=tuple(user.roles or []),
            ),
            action="api_token.used",
            resource_type="api_token",
            resource_id=token.id,
        )
        await self.session.commit()
        return Principal(
            id=user.id,
            auth_type="api_token",
            scopes=frozenset(token.scopes or []),
            token_id=token.id,
            username=user.username,
            email=user.email,
            email_verified=user.email_verified,
            name=user.name or "",
            given_name=user.given_name or "",
            family_name=user.family_name or "",
            roles=tuple(user.roles or []),
        )

    async def is_active(self, principal: Principal) -> bool:
        """Check revocation/expiry for an already-authenticated connection."""
        if not principal.is_api_token or principal.token_id is None:
            return True
        token = (await self.session.execute(
            select(ApiTokenStore.expires_at, ApiTokenStore.revoked_at).where(
                ApiTokenStore.id == principal.token_id,
                ApiTokenStore.user_id == principal.id,
            )
        )).one_or_none()
        if token is None:
            return False
        expires_at, revoked_at = token
        return revoked_at is None and expires_at > datetime.now(timezone.utc)

    async def list_for_user(self, user_id: UUID) -> list[ApiTokenStore]:
        result = await self.session.execute(
            select(ApiTokenStore)
            .where(ApiTokenStore.user_id == user_id)
            .order_by(ApiTokenStore.created_at.desc())
        )
        return list(result.scalars().all())

    async def revoke(self, principal: Principal, token_id: UUID) -> bool:
        token = (await self.session.execute(
            select(ApiTokenStore).where(
                ApiTokenStore.id == token_id,
                ApiTokenStore.user_id == principal.id,
            )
        )).scalar_one_or_none()
        if not token:
            return False
        if token.revoked_at is None:
            token.revoked_at = datetime.now(timezone.utc)
            await record_audit(
                self.session,
                principal,
                action="api_token.revoked",
                resource_type="api_token",
                resource_id=token.id,
            )
            await self.session.commit()
        return True
