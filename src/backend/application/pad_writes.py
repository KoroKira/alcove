"""Controlled pad write use cases for legacy and versioned APIs."""

import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import UUID, uuid4

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from application.audit import record_audit
from application.authorization import PadAction, authorize
from application.errors import (
    ConflictError,
    PermissionDeniedError,
    PreconditionRequiredError,
    ResourceNotFoundError,
    ValidationError,
)
from application.membership import MembershipService
from application.principal import Principal
from database.models import IdempotencyRecordStore, PadStore
from database.pad_serialization import serialize_pad

logger = logging.getLogger(__name__)

VALID_PAD_TYPES = {"canvas", "document", "kanban", "gantt", "latex", "database"}
MAX_DATA_BYTES = 2_000_000


def _request_hash(payload: Any) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _check_size(data: Any) -> None:
    if len(json.dumps(data, ensure_ascii=False).encode("utf-8")) > MAX_DATA_BYTES:
        raise ValidationError("Pad data exceeds the 2 MB API limit")


def _initial_data(owner_id: UUID, pad_type: str, content: Optional[str]) -> dict:
    if pad_type == "document":
        return {"content": content or "", "format": "markdown"}
    if pad_type == "kanban":
        return {"columns": [
            {"id": "col-1", "title": "À faire", "cards": []},
            {"id": "col-2", "title": "En cours", "cards": []},
            {"id": "col-3", "title": "Terminé", "cards": []},
        ]}
    if pad_type == "gantt":
        return {"tasks": []}
    if pad_type == "latex":
        return {"source": ""}
    if pad_type == "database":
        return {"columns": [], "rows": [], "groupBy": None}
    return {"files": {}, "elements": [], "appState": {str(owner_id): {}}}


class PadWriteService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def _get_pad(self, pad_id: UUID) -> PadStore:
        pad = (await self.session.execute(
            select(PadStore).where(PadStore.id == pad_id)
        )).scalar_one_or_none()
        if not pad:
            raise ResourceNotFoundError("Pad not found")
        return pad

    async def _require_write(self, principal: Principal, pad: PadStore) -> None:
        if not await authorize(self.session, principal, pad, PadAction.WRITE):
            raise PermissionDeniedError("Not authorized to write this pad")

    async def _idempotency(
        self,
        principal: Principal,
        operation: str,
        key: Optional[str],
        payload: Any,
    ) -> tuple[Optional[IdempotencyRecordStore], Optional[dict[str, Any]]]:
        if key is None:
            return None, None
        if not 1 <= len(key) <= 200:
            raise ValidationError("Idempotency-Key must contain between 1 and 200 characters")
        request_hash = _request_hash(payload)
        existing = (await self.session.execute(
            select(IdempotencyRecordStore).where(
                IdempotencyRecordStore.principal_id == principal.id,
                IdempotencyRecordStore.operation == operation,
                IdempotencyRecordStore.idempotency_key == key,
            )
        )).scalar_one_or_none()
        if existing:
            if existing.request_hash != request_hash:
                raise ConflictError("Idempotency key was already used with a different request")
            if existing.response is None:
                raise ConflictError("An identical mutation is already in progress")
            return existing, existing.response

        record = IdempotencyRecordStore(
            principal_id=principal.id,
            operation=operation,
            idempotency_key=key,
            request_hash=request_hash,
        )
        self.session.add(record)
        try:
            await self.session.flush()
        except IntegrityError:
            await self.session.rollback()
            existing = (await self.session.execute(
                select(IdempotencyRecordStore).where(
                    IdempotencyRecordStore.principal_id == principal.id,
                    IdempotencyRecordStore.operation == operation,
                    IdempotencyRecordStore.idempotency_key == key,
                )
            )).scalar_one_or_none()
            if not existing or existing.request_hash != request_hash or existing.response is None:
                raise ConflictError("An identical mutation is already in progress")
            return existing, existing.response
        return record, None

    async def create_pad(
        self,
        principal: Principal,
        *,
        display_name: str,
        pad_type: str,
        content: Optional[str],
        idempotency_key: Optional[str] = None,
    ) -> tuple[dict[str, Any], bool]:
        name = " ".join(display_name.strip().split())
        if not 1 <= len(name) <= 100:
            raise ValidationError("display_name must contain between 1 and 100 characters")
        if pad_type not in VALID_PAD_TYPES:
            raise ValidationError("Unsupported pad type")
        if content is not None and len(content) > MAX_DATA_BYTES:
            raise ValidationError("Initial content exceeds the 2 MB API limit")

        payload = {"display_name": name, "pad_type": pad_type, "content": content}
        record, replay = await self._idempotency(principal, "pad.create", idempotency_key, payload)
        if replay is not None:
            return replay, True

        data = _initial_data(principal.id, pad_type, content)
        _check_size(data)
        pad = PadStore(
            id=uuid4(),
            owner_id=principal.id,
            display_name=name,
            data=data,
            sharing_policy="private",
            whitelist=[],
            pad_type=pad_type,
        )
        self.session.add(pad)
        await self.session.flush()
        await MembershipService(self.session).ensure_owner(pad.id, principal.id)
        response = serialize_pad(pad, include_data=False)
        if record:
            record.response = response
            record.resource_id = pad.id
        await record_audit(
            self.session,
            principal,
            action="pad.created",
            resource_type="pad",
            resource_id=pad.id,
            metadata={"pad_type": pad_type},
        )
        await self.session.commit()
        return response, False

    async def update_data(
        self,
        principal: Principal,
        pad_id: UUID,
        data: dict[str, Any],
        expected_updated_at: Optional[datetime],
        idempotency_key: Optional[str] = None,
    ) -> tuple[dict[str, Any], bool]:
        if expected_updated_at is None:
            raise PreconditionRequiredError("If-Match is required for pad writes")
        if not isinstance(data, dict):
            raise ValidationError("data must be an object")
        _check_size(data)
        pad = await self._get_pad(pad_id)
        await self._require_write(principal, pad)
        payload = {"pad_id": str(pad_id), "data": data, "expected_updated_at": expected_updated_at.isoformat()}
        record, replay = await self._idempotency(principal, "pad.update_data", idempotency_key, payload)
        if replay is not None:
            return replay, True

        updated_at = datetime.now(timezone.utc)
        result = await self.session.execute(
            update(PadStore)
            .where(PadStore.id == pad.id, PadStore.updated_at == expected_updated_at)
            .values(data=data, updated_at=updated_at)
        )
        if result.rowcount == 0:
            current = (await self.session.execute(
                select(PadStore.updated_at).where(PadStore.id == pad.id)
            )).scalar_one_or_none()
            raise ConflictError(
                "The pad was modified by another client",
                details={"server_updated_at": current.isoformat() if current else None},
            )
        response = {"ok": True, "pad_id": str(pad.id), "updated_at": updated_at.isoformat()}
        if record:
            record.response = response
            record.resource_id = pad.id
        await record_audit(
            self.session,
            principal,
            action="pad.data.updated",
            resource_type="pad",
            resource_id=pad.id,
            metadata={"idempotent": idempotency_key is not None},
        )
        await self.session.commit()
        await self._invalidate_cache(pad.id)
        return response, False

    async def update_metadata(
        self,
        principal: Principal,
        pad_id: UUID,
        changes: dict[str, Any],
        expected_updated_at: Optional[datetime],
        idempotency_key: Optional[str] = None,
    ) -> tuple[dict[str, Any], bool]:
        if expected_updated_at is None:
            raise PreconditionRequiredError("If-Match is required for pad writes")
        pad = await self._get_pad(pad_id)
        await self._require_write(principal, pad)
        if not changes:
            raise ValidationError("At least one metadata field is required")
        allowed = {"display_name", "theme", "tags", "folder"}
        if set(changes) - allowed:
            raise ValidationError("Unsupported pad metadata field")
        if "display_name" in changes:
            if changes["display_name"] is None:
                raise ValidationError("display_name cannot be null")
            name = " ".join(str(changes["display_name"]).strip().split())
            if not 1 <= len(name) <= 100:
                raise ValidationError("display_name must contain between 1 and 100 characters")
            changes["display_name"] = name
        if "theme" in changes and changes["theme"] not in (None, "light", "dark"):
            raise ValidationError("theme must be 'light', 'dark', or null")
        if "tags" in changes:
            if not isinstance(changes["tags"], list) or len(changes["tags"]) > 20:
                raise ValidationError("tags must be a list of at most 20 items")
            changes["tags"] = [str(tag).strip()[:50] for tag in changes["tags"] if str(tag).strip()]
        if "folder" in changes:
            changes["folder"] = (str(changes["folder"]).strip()[:80] or None) if changes["folder"] else None

        payload = {"pad_id": str(pad_id), "changes": changes, "expected_updated_at": expected_updated_at.isoformat()}
        record, replay = await self._idempotency(principal, "pad.update_metadata", idempotency_key, payload)
        if replay is not None:
            return replay, True
        updated_at = datetime.now(timezone.utc)
        result = await self.session.execute(
            update(PadStore)
            .where(PadStore.id == pad.id, PadStore.updated_at == expected_updated_at)
            .values(**changes, updated_at=updated_at)
        )
        if result.rowcount == 0:
            current = (await self.session.execute(
                select(PadStore.updated_at).where(PadStore.id == pad.id)
            )).scalar_one_or_none()
            raise ConflictError(
                "The pad was modified by another client",
                details={"server_updated_at": current.isoformat() if current else None},
            )
        response = {"ok": True, "pad_id": str(pad.id), "updated_at": updated_at.isoformat(), **changes}
        if record:
            record.response = response
            record.resource_id = pad.id
        await record_audit(
            self.session,
            principal,
            action="pad.metadata.updated",
            resource_type="pad",
            resource_id=pad.id,
            metadata={"fields": sorted(changes)},
        )
        await self.session.commit()
        await self._invalidate_cache(pad.id)
        return response, False

    async def _invalidate_cache(self, pad_id: UUID) -> None:
        try:
            from cache import RedisClient
            redis = await RedisClient.get_instance()
            await redis.delete(f"pad:{pad_id}")
        except Exception:
            logger.warning("Could not invalidate pad cache for %s", pad_id, exc_info=True)
