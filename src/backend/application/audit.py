"""Small transactional audit writer used by security-sensitive mutations."""

from typing import Any, Optional
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from database.models.audit_event_model import AuditEventStore
from application.principal import Principal


async def record_audit(
    session: AsyncSession,
    principal: Optional[Principal],
    *,
    action: str,
    resource_type: str,
    resource_id: Optional[UUID] = None,
    metadata: Optional[dict[str, Any]] = None,
) -> AuditEventStore:
    event = AuditEventStore(
        actor_user_id=principal.id if principal else None,
        api_token_id=principal.token_id if principal and principal.is_api_token else None,
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        event_metadata=metadata or {},
    )
    session.add(event)
    return event
