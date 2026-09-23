"""Durable pad membership records.

The legacy ``pads.owner_id``, ``sharing_policy`` and ``whitelist`` columns
remain available for compatibility during the transition. New code can read
this table through the application authorization service and legacy write
paths can move over incrementally.
"""

from sqlalchemy import CheckConstraint, Column, ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID as PGUUID

from .base_model import Base, BaseModel, SCHEMA_NAME


class PadMemberStore(Base, BaseModel):
    """A user's role on a pad: owner, editor, or viewer."""

    __tablename__ = "pad_members"
    __table_args__ = (
        UniqueConstraint("pad_id", "user_id", name="uq_pad_members_pad_user"),
        CheckConstraint("role IN ('owner', 'editor', 'viewer')", name="ck_pad_members_role"),
        Index("ix_pad_members_pad_id", "pad_id"),
        Index("ix_pad_members_user_id", "user_id"),
        {"schema": SCHEMA_NAME},
    )

    pad_id = Column(
        PGUUID(as_uuid=True),
        ForeignKey(f"{SCHEMA_NAME}.pads.id", ondelete="CASCADE"),
        nullable=False,
    )
    user_id = Column(
        PGUUID(as_uuid=True),
        ForeignKey(f"{SCHEMA_NAME}.users.id", ondelete="CASCADE"),
        nullable=False,
    )
    role = Column(String(20), nullable=False)


__all__ = ["PadMemberStore"]
