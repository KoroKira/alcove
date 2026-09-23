"""Read-oriented pad use cases used by both legacy and versioned APIs."""

from copy import deepcopy
from typing import Any, Dict, List, Optional
from uuid import UUID

from sqlalchemy import and_, exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from application.authorization import authorize_read
from application.errors import PermissionDeniedError, ResourceNotFoundError
from database.models import PadMemberStore, PadStore
from database.pad_serialization import serialize_pad
from domain.pad import Pad
from domain.user import User


def match_pad(pad_type: str, data: Any, display_name: str, query: str):
    """Pure full-text matcher shared by the legacy and v1 search endpoints."""
    data = data if isinstance(data, dict) else {}
    matches = []
    if pad_type == "document":
        content = data.get("content", "") or ""
        idx = content.lower().find(query)
        if idx != -1:
            start = max(0, idx - 40)
            excerpt = content[start:idx + 80].replace("\n", " ").strip()
            matches.append({"element_id": "", "text": content[idx:idx + 60], "excerpt": excerpt})
    else:
        for elem in data.get("elements", []):
            if not isinstance(elem, dict):
                continue
            label = elem.get("label") or {}
            text = elem.get("text", "") or (label.get("text", "") if isinstance(label, dict) else "")
            if text and query in text.lower():
                matches.append({"element_id": elem.get("id", ""), "text": text[:60], "excerpt": text[:120]})

    name_match = query in (display_name or "").lower()
    if name_match or matches:
        return name_match, matches[:5]
    return None


def pad_summary(pad: Any) -> Dict[str, Any]:
    """Return the public metadata DTO shape without cache/worker internals."""
    raw = serialize_pad(pad)
    return {
        key: raw.get(key)
        for key in (
            "id", "owner_id", "display_name", "created_at", "updated_at",
            "sharing_policy", "theme", "is_scratch", "pad_type", "tags",
            "folder", "thumbnail_url", "source_url",
        )
    }


def pad_content(pad: Pad, user_id: UUID) -> Dict[str, Any]:
    """Build a read payload without mutating the cached domain object."""
    updated_at = pad.updated_at.isoformat() if pad.updated_at else None
    raw = deepcopy(pad.data if isinstance(pad.data, dict) else {})

    if pad.pad_type == "document":
        result = {
            "content": raw.get("content", ""),
            "format": raw.get("format", "markdown"),
            "updated_at": updated_at,
        }
        if "video" in raw:
            result["video"] = raw["video"]
        return result

    if pad.pad_type in ("kanban", "gantt", "latex", "database"):
        raw["updated_at"] = updated_at
        return raw

    app_state = raw.get("appState", {})
    raw["appState"] = app_state.get(str(user_id), {}) if isinstance(app_state, dict) else {}
    return raw


class PadQueryService:
    """Application-level read use cases for pads."""

    def __init__(self, session: AsyncSession):
        self.session = session

    @staticmethod
    def readable_filter(user_id: Optional[UUID]):
        """Build the DB-level read boundary for a pad listing.

        Durable membership is authoritative for migrated pads. The legacy
        whitelist fallback is deliberately guarded by the absence of *any*
        membership row, so a stale whitelist cannot leak a pad after a member
        was removed or downgraded. Anonymous callers see only public pads.
        """
        public = PadStore.sharing_policy == "public"
        if user_id is None:
            return public

        member = exists().where(
            PadMemberStore.pad_id == PadStore.id,
            PadMemberStore.user_id == user_id,
            PadMemberStore.role.in_(["owner", "editor", "viewer"]),
        )
        any_members = exists().where(PadMemberStore.pad_id == PadStore.id)
        legacy_whitelist = and_(
            ~any_members,
            PadStore.sharing_policy == "whitelist",
            PadStore.whitelist.any(user_id),
        )
        return or_(public, PadStore.owner_id == user_id, member, legacy_whitelist)

    async def list_accessible_stores(
        self,
        user_id: Optional[UUID],
        *,
        pad_type: Optional[str] = None,
    ) -> List[PadStore]:
        stmt = select(PadStore).where(self.readable_filter(user_id))
        if pad_type is not None:
            stmt = stmt.where(PadStore.pad_type == pad_type)
        stmt = stmt.order_by(PadStore.created_at)
        return list((await self.session.execute(stmt)).scalars().all())

    async def get_pad(self, pad_id: UUID, user_id: UUID) -> Pad:
        # Authorize against a current database row before consulting Redis.
        # Redis is a content/cache optimization and must not decide whether a
        # policy transition or membership revocation is effective.
        store = (await self.session.execute(
            select(PadStore).where(PadStore.id == pad_id)
        )).scalar_one_or_none()
        if not store:
            raise ResourceNotFoundError("Pad not found")
        if not await authorize_read(self.session, user_id, store):
            raise PermissionDeniedError("Not authorized to access this pad")
        pad = await Pad.get_by_id(self.session, pad_id)
        if not pad:
            raise ResourceNotFoundError("Pad not found")
        return pad

    async def get_pad_content(self, pad_id: UUID, user_id: UUID) -> tuple[Pad, Dict[str, Any]]:
        pad = await self.get_pad(pad_id, user_id)
        return pad, pad_content(pad, user_id)

    async def list_pads(self, user_id: UUID) -> List[Dict[str, Any]]:
        stores = await self.list_accessible_stores(user_id)
        return [pad_summary(store) for store in stores]

    async def get_me(self, user_id: UUID, session_user: Any) -> Dict[str, Any]:
        user = await User.get_by_id(self.session, user_id)
        if not user or not user._store:
            raise ResourceNotFoundError("User not found")
        return {
            "id": str(user.id),
            "username": session_user.username,
            "email": session_user.email,
            "email_verified": session_user.email_verified,
            "name": session_user.name,
            "given_name": session_user.given_name,
            "family_name": session_user.family_name,
            "roles": session_user.roles,
            "last_selected_pad": str(user.last_selected_pad) if user.last_selected_pad else None,
            "folders": list(user._store.folders or []),
            "pads": await self.list_pads(user_id),
        }

    async def search(self, user_id: UUID, query: str, limit: int = 50) -> List[Dict[str, Any]]:
        query = query.strip().lower()
        if len(query) < 2:
            return []

        stores = await self.list_accessible_stores(user_id)
        results = []
        for store in stores:
            pad_type = getattr(store, "pad_type", "canvas") or "canvas"
            matched = match_pad(pad_type, store.data, store.display_name, query)
            if matched is None:
                continue
            name_match, matches = matched
            results.append({
                "pad_id": str(store.id),
                "pad_name": store.display_name,
                "name_match": name_match,
                "matches": matches,
            })
            if len(results) >= limit:
                break
        return results
