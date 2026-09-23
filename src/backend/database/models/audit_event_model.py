"""Append-only audit events for credentials and application mutations."""

from sqlalchemy import Column, ForeignKey, Index, String
from sqlalchemy.dialects.postgresql import JSONB, UUID as PGUUID

from .base_model import Base, BaseModel, SCHEMA_NAME


class AuditEventStore(Base, BaseModel):
    __tablename__ = "audit_events"
    __table_args__ = (
        Index("ix_audit_events_actor_user_id", "actor_user_id"),
        Index("ix_audit_events_resource", "resource_type", "resource_id"),
        {"schema": SCHEMA_NAME},
    )

    actor_user_id = Column(
        PGUUID(as_uuid=True),
        ForeignKey(f"{SCHEMA_NAME}.users.id", ondelete="SET NULL"),
        nullable=True,
    )
    api_token_id = Column(
        PGUUID(as_uuid=True),
        ForeignKey(f"{SCHEMA_NAME}.api_tokens.id", ondelete="SET NULL"),
        nullable=True,
    )
    action = Column(String(80), nullable=False)
    resource_type = Column(String(80), nullable=False)
    resource_id = Column(PGUUID(as_uuid=True), nullable=True)
    # ``metadata`` is reserved by SQLAlchemy's declarative base. Keep the
    # database column name stable while using a safe Python attribute.
    event_metadata = Column("metadata", JSONB, nullable=False, default=dict)
