"""Single application service for legacy sharing and durable memberships."""

from typing import Any
from uuid import UUID
from datetime import datetime, timezone

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from application.audit import record_audit
from application.authorization import PadAction, authorize
from application.errors import PermissionDeniedError, ResourceNotFoundError, ValidationError
from application.principal import Principal
from database.models import PadMemberStore, PadStore


VALID_ROLES = {"editor", "viewer"}
VALID_POLICIES = {"private", "whitelist", "public"}


class MembershipService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def _invalidate_cache(self, pad_id: UUID) -> None:
        # Membership and policy changes affect the legacy Pad cache too. The
        # durable membership query is authoritative, but stale policy fields
        # could otherwise keep a public/private transition invisible.
        try:
            from cache import RedisClient
            redis = await RedisClient.get_instance()
            await redis.delete(f"pad:{pad_id}")
        except Exception:
            # Cache invalidation is best-effort; PostgreSQL remains the source
            # of truth and the next read will repopulate the cache.
            return

    async def _get_pad(self, pad_id: UUID) -> PadStore:
        pad = (await self.session.execute(
            select(PadStore).where(PadStore.id == pad_id)
        )).scalar_one_or_none()
        if not pad:
            raise ResourceNotFoundError("Pad not found")
        return pad

    async def _require_share(self, principal: Principal, pad: PadStore) -> None:
        if not await authorize(self.session, principal, pad, PadAction.SHARE):
            raise PermissionDeniedError("Only the pad owner can manage sharing")

    async def ensure_owner(self, pad_id: UUID, owner_id: UUID) -> PadMemberStore:
        existing = (await self.session.execute(
            select(PadMemberStore).where(
                PadMemberStore.pad_id == pad_id,
                PadMemberStore.user_id == owner_id,
            )
        )).scalar_one_or_none()
        if existing:
            if existing.role != "owner":
                existing.role = "owner"
            return existing
        member = PadMemberStore(pad_id=pad_id, user_id=owner_id, role="owner")
        self.session.add(member)
        await self.session.flush()
        return member

    async def set_policy(self, principal: Principal, pad_id: UUID, policy: str) -> PadStore:
        if policy not in VALID_POLICIES:
            raise ValidationError("Invalid sharing policy")
        pad = await self._get_pad(pad_id)
        await self._require_share(principal, pad)

        updated_at = datetime.now(timezone.utc)
        values: dict[str, Any] = {
            "sharing_policy": policy,
            "updated_at": updated_at,
        }
        if policy != "whitelist":
            # The legacy model is read-only for public pads and private pads
            # did not expose whitelist collaboration. Remove only editor rows;
            # explicit viewers remain valid durable memberships.
            await self.session.execute(delete(PadMemberStore).where(
                PadMemberStore.pad_id == pad.id,
                PadMemberStore.user_id != pad.owner_id,
                PadMemberStore.role == "editor",
            ))
        elif pad.whitelist:
            # Preserve legacy whitelist entries if an old deployment had them
            # without a corresponding row yet.
            for user_id in pad.whitelist:
                if user_id == pad.owner_id:
                    continue
                existing = (await self.session.execute(
                    select(PadMemberStore).where(
                        PadMemberStore.pad_id == pad.id,
                        PadMemberStore.user_id == user_id,
                    )
                )).scalar_one_or_none()
                if existing is None:
                    self.session.add(PadMemberStore(
                        pad_id=pad.id, user_id=user_id, role="editor"
                    ))

        await self.session.execute(
            update(PadStore).where(PadStore.id == pad.id).values(**values)
        )
        await record_audit(
            self.session,
            principal,
            action="pad.sharing_policy.updated",
            resource_type="pad",
            resource_id=pad.id,
            metadata={"policy": policy},
        )
        await self.session.commit()
        pad.sharing_policy = policy
        pad.updated_at = updated_at
        await self._invalidate_cache(pad.id)
        return pad

    async def add_member(
        self,
        principal: Principal,
        pad_id: UUID,
        user_id: UUID,
        role: str,
    ) -> PadMemberStore:
        if role not in VALID_ROLES:
            raise ValidationError("Role must be 'editor' or 'viewer'")
        pad = await self._get_pad(pad_id)
        await self._require_share(principal, pad)
        if user_id == pad.owner_id:
            raise ValidationError("The pad owner already has the owner role")

        member = (await self.session.execute(
            select(PadMemberStore).where(
                PadMemberStore.pad_id == pad.id,
                PadMemberStore.user_id == user_id,
            )
        )).scalar_one_or_none()
        if member is None:
            member = PadMemberStore(pad_id=pad.id, user_id=user_id, role=role)
            self.session.add(member)
        else:
            member.role = role

        whitelist = list(pad.whitelist or [])
        if role == "editor" and user_id not in whitelist:
            whitelist.append(user_id)
        if role == "viewer" and user_id in whitelist:
            whitelist.remove(user_id)
        if whitelist != list(pad.whitelist or []):
            pad.whitelist = whitelist
            updated_at = datetime.now(timezone.utc)
            await self.session.execute(
                update(PadStore).where(PadStore.id == pad.id).values(
                    whitelist=whitelist,
                    updated_at=updated_at,
                )
            )
            pad.updated_at = updated_at

        await self.session.flush()

        await record_audit(
            self.session,
            principal,
            action="pad.member.upserted",
            resource_type="pad_member",
            resource_id=member.id,
            metadata={"pad_id": str(pad.id), "user_id": str(user_id), "role": role},
        )
        await self.session.commit()
        await self._invalidate_cache(pad.id)
        return member

    async def remove_member(self, principal: Principal, pad_id: UUID, user_id: UUID) -> bool:
        pad = await self._get_pad(pad_id)
        await self._require_share(principal, pad)
        if user_id == pad.owner_id:
            raise ValidationError("The pad owner cannot be removed")

        result = await self.session.execute(
            delete(PadMemberStore).where(
                PadMemberStore.pad_id == pad.id,
                PadMemberStore.user_id == user_id,
            )
        )
        whitelist = [uid for uid in (pad.whitelist or []) if uid != user_id]
        if whitelist != list(pad.whitelist or []):
            updated_at = datetime.now(timezone.utc)
            await self.session.execute(
                update(PadStore).where(PadStore.id == pad.id).values(
                    whitelist=whitelist,
                    updated_at=updated_at,
                )
            )
            pad.updated_at = updated_at
        if result.rowcount:
            await record_audit(
                self.session,
                principal,
                action="pad.member.removed",
                resource_type="pad",
                resource_id=pad.id,
                metadata={"user_id": str(user_id)},
            )
        await self.session.commit()
        await self._invalidate_cache(pad.id)
        return bool(result.rowcount)

    async def list_members(self, principal: Principal, pad_id: UUID) -> list[PadMemberStore]:
        pad = await self._get_pad(pad_id)
        await self._require_share(principal, pad)
        result = await self.session.execute(
            select(PadMemberStore)
            .where(PadMemberStore.pad_id == pad.id)
            .order_by(PadMemberStore.created_at)
        )
        return list(result.scalars().all())
