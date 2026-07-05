from uuid import UUID
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy import Column, String, ForeignKey, Index, select, delete, update
from sqlalchemy import UUID as SQLUUID
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession

from .base_model import Base, BaseModel, SCHEMA_NAME


class AIConversation(Base, BaseModel):
    """A persisted AI chat conversation, optionally attached to a pad.

    `messages` is a JSON list of {role, content} objects. `pad_id` is nullable —
    a conversation can be global (not tied to a specific pad)."""
    __tablename__ = "ai_conversations"
    __table_args__ = (
        Index("ix_ai_conversations_owner_id", "owner_id"),
        Index("ix_ai_conversations_pad_id", "pad_id"),
        {"schema": SCHEMA_NAME},
    )

    owner_id = Column(
        SQLUUID(as_uuid=True),
        ForeignKey(f"{SCHEMA_NAME}.users.id", ondelete="CASCADE"),
        nullable=False,
    )
    pad_id = Column(
        SQLUUID(as_uuid=True),
        ForeignKey(f"{SCHEMA_NAME}.pads.id", ondelete="CASCADE"),
        nullable=True,
    )
    title = Column(String(120), nullable=False, default="Nouvelle conversation")
    messages = Column(JSONB, nullable=False, default=list)

    def to_summary(self) -> Dict[str, Any]:
        """Lightweight representation for list views (no message bodies)."""
        msgs = self.messages or []
        return {
            "id": str(self.id),
            "pad_id": str(self.pad_id) if self.pad_id else None,
            "title": self.title,
            "message_count": len(msgs),
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }

    def to_dict(self) -> Dict[str, Any]:
        d = self.to_summary()
        d["messages"] = self.messages or []
        return d

    # ── Queries ──────────────────────────────────────────────────────────────

    @classmethod
    async def create(
        cls,
        session: AsyncSession,
        owner_id: UUID,
        title: str,
        messages: List[Dict[str, Any]],
        pad_id: Optional[UUID] = None,
    ) -> "AIConversation":
        conv = cls(owner_id=owner_id, title=title[:120], messages=messages, pad_id=pad_id)
        session.add(conv)
        await session.commit()
        await session.refresh(conv)
        return conv

    @classmethod
    async def list_for_owner(
        cls,
        session: AsyncSession,
        owner_id: UUID,
        pad_id: Optional[UUID] = None,
    ) -> List["AIConversation"]:
        stmt = select(cls).where(cls.owner_id == owner_id)
        if pad_id is not None:
            stmt = stmt.where(cls.pad_id == pad_id)
        stmt = stmt.order_by(cls.updated_at.desc())
        result = await session.execute(stmt)
        return list(result.scalars().all())

    @classmethod
    async def get_owned(
        cls, session: AsyncSession, conv_id: UUID, owner_id: UUID
    ) -> Optional["AIConversation"]:
        stmt = select(cls).where(cls.id == conv_id, cls.owner_id == owner_id)
        return (await session.execute(stmt)).scalars().first()

    @classmethod
    async def update_owned(
        cls,
        session: AsyncSession,
        conv_id: UUID,
        owner_id: UUID,
        *,
        title: Optional[str] = None,
        messages: Optional[List[Dict[str, Any]]] = None,
    ) -> Optional["AIConversation"]:
        conv = await cls.get_owned(session, conv_id, owner_id)
        if not conv:
            return None
        values: Dict[str, Any] = {"updated_at": datetime.now()}
        if title is not None:
            values["title"] = title[:120]
        if messages is not None:
            values["messages"] = messages
        await session.execute(update(cls).where(cls.id == conv_id).values(**values))
        await session.commit()
        return await cls.get_owned(session, conv_id, owner_id)

    @classmethod
    async def delete_owned(
        cls, session: AsyncSession, conv_id: UUID, owner_id: UUID
    ) -> bool:
        conv = await cls.get_owned(session, conv_id, owner_id)
        if not conv:
            return False
        await session.execute(delete(cls).where(cls.id == conv_id))
        await session.commit()
        return True
