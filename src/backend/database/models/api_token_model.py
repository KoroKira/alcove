"""Persistent API credentials; raw secrets are never stored."""

from sqlalchemy import Column, ForeignKey, Index, String
from sqlalchemy.dialects.postgresql import JSONB, UUID as PGUUID
from sqlalchemy.types import DateTime

from .base_model import Base, BaseModel, SCHEMA_NAME


class ApiTokenStore(Base, BaseModel):
    __tablename__ = "api_tokens"
    __table_args__ = (
        Index("ix_api_tokens_user_id", "user_id"),
        Index("ix_api_tokens_token_hash", "token_hash"),
        {"schema": SCHEMA_NAME},
    )

    user_id = Column(
        PGUUID(as_uuid=True),
        ForeignKey(f"{SCHEMA_NAME}.users.id", ondelete="CASCADE"),
        nullable=False,
    )
    name = Column(String(120), nullable=False)
    token_prefix = Column(String(32), nullable=False, unique=True)
    token_hash = Column(String(64), nullable=False, unique=True)
    scopes = Column(JSONB, nullable=False, default=list)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    revoked_at = Column(DateTime(timezone=True), nullable=True)
    last_used_at = Column(DateTime(timezone=True), nullable=True)
