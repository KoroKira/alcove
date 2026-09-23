"""Centralized authorization decisions for pads.

The async ``authorize`` function is the application boundary used by REST and
WebSocket code. The small synchronous helpers remain for pure legacy/domain
call sites while the membership table is rolled out; they deliberately mirror
the old fields and do not perform database access.
"""

from enum import Enum
from typing import Any, Optional
from uuid import UUID

from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from database.models.pad_member_model import PadMemberStore


class PadAction(str, Enum):
    READ = "read"
    WRITE = "write"
    SHARE = "share"


class PadRole(str, Enum):
    OWNER = "owner"
    EDITOR = "editor"
    VIEWER = "viewer"


def _same_user(left: Any, right: Optional[UUID]) -> bool:
    return right is not None and str(left) == str(right)


def _principal_id(principal: Any) -> Optional[UUID]:
    if principal is None:
        return None
    value = getattr(principal, "id", principal)
    if value is None:
        return None
    try:
        return value if isinstance(value, UUID) else UUID(str(value))
    except (TypeError, ValueError, AttributeError):
        return None


def can_read_pad(pad: Any, user_id: Optional[UUID]) -> bool:
    """Legacy synchronous read rule, retained for non-request code."""
    if _same_user(getattr(pad, "owner_id", None), user_id):
        return True
    if getattr(pad, "sharing_policy", None) == "public":
        return True
    if getattr(pad, "sharing_policy", None) == "whitelist":
        return any(_same_user(member_id, user_id) for member_id in (getattr(pad, "whitelist", None) or []))
    return False


def can_write_pad(pad: Any, user_id: Optional[UUID]) -> bool:
    """Legacy synchronous write rule used only before a DB session is present."""
    if _same_user(getattr(pad, "owner_id", None), user_id):
        return True
    return (
        getattr(pad, "sharing_policy", None) == "whitelist"
        and any(_same_user(member_id, user_id) for member_id in (getattr(pad, "whitelist", None) or []))
    )


def _legacy_role(pad: Any, user_id: Optional[UUID]) -> Optional[PadRole]:
    if _same_user(getattr(pad, "owner_id", None), user_id):
        return PadRole.OWNER
    if getattr(pad, "sharing_policy", None) == "whitelist" and any(
        _same_user(member_id, user_id) for member_id in (getattr(pad, "whitelist", None) or [])
    ):
        # The legacy whitelist had one collaboration level. Preserve its
        # historical write behavior while old deployments are being upgraded.
        return PadRole.EDITOR
    return None


async def _membership_role(
    session: AsyncSession,
    pad: Any,
    user_id: UUID,
) -> Optional[PadRole]:
    """Read the durable role, with a narrow legacy fallback for compatibility."""
    if _same_user(getattr(pad, "owner_id", None), user_id):
        return PadRole.OWNER

    result = await session.execute(
        select(PadMemberStore.role).where(
            PadMemberStore.pad_id == getattr(pad, "id"),
            PadMemberStore.user_id == user_id,
        )
    )
    role = result.scalar_one_or_none()
    if role is None:
        # Once a pad has any durable membership row, that table is the
        # authority. A stale legacy whitelist must not re-grant access to a
        # user who was removed or downgraded. The fallback exists only for a
        # genuinely pre-migration pad that has not been backfilled yet.
        has_durable_members = await session.execute(
            select(exists().where(PadMemberStore.pad_id == getattr(pad, "id")))
        )
        if has_durable_members.scalar_one():
            return None
        return _legacy_role(pad, user_id)
    try:
        return PadRole(role)
    except ValueError:
        # Invalid rows must never grant access. The migration constraint should
        # make this impossible, but fail closed if a manually edited database
        # is encountered.
        return None


async def authorize(
    session: AsyncSession,
    principal: Any,
    resource: Any,
    action: PadAction | str,
) -> bool:
    """Return whether ``principal`` may perform ``action`` on a pad.

    Public sharing is read-only. Owners can read/write/share, editors can
    read/write, and viewers can read. The owner and legacy-field fallbacks
    preserve compatibility with databases while the backfill is deployed.
    """
    try:
        action = PadAction(action)
    except ValueError:
        return False

    user_id = _principal_id(principal)
    if action is PadAction.READ and getattr(resource, "sharing_policy", None) == "public":
        return True
    if (
        action in {PadAction.WRITE, PadAction.SHARE}
        and getattr(resource, "sharing_policy", None) == "public"
        and not _same_user(getattr(resource, "owner_id", None), user_id)
    ):
        # Public sharing is intentionally read-only, even if stale or
        # manually-created membership data exists.
        return False
    if user_id is None:
        return False

    role = await _membership_role(session, resource, user_id)
    if role is PadRole.OWNER:
        return True
    if role is PadRole.EDITOR:
        return action in {PadAction.READ, PadAction.WRITE}
    if role is PadRole.VIEWER:
        return action is PadAction.READ
    return False


async def authorize_read(session: AsyncSession, principal: Any, resource: Any) -> bool:
    return await authorize(session, principal, resource, PadAction.READ)


async def authorize_write(session: AsyncSession, principal: Any, resource: Any) -> bool:
    return await authorize(session, principal, resource, PadAction.WRITE)


async def authorize_share(session: AsyncSession, principal: Any, resource: Any) -> bool:
    return await authorize(session, principal, resource, PadAction.SHARE)
