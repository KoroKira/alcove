"""Durable replay protection for externally retried mutations."""

from sqlalchemy import Column, ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID as PGUUID

from .base_model import Base, BaseModel, SCHEMA_NAME


class IdempotencyRecordStore(Base, BaseModel):
    __tablename__ = "idempotency_records"
    __table_args__ = (
        UniqueConstraint(
            "principal_id", "operation", "idempotency_key",
            name="uq_idempotency_principal_operation_key",
        ),
        Index("ix_idempotency_principal_id", "principal_id"),
        {"schema": SCHEMA_NAME},
    )

    principal_id = Column(
        PGUUID(as_uuid=True),
        ForeignKey(f"{SCHEMA_NAME}.users.id", ondelete="CASCADE"),
        nullable=False,
    )
    operation = Column(String(100), nullable=False)
    idempotency_key = Column(String(200), nullable=False)
    request_hash = Column(String(64), nullable=False)
    response = Column(JSONB, nullable=True)
    resource_id = Column(PGUUID(as_uuid=True), nullable=True)
