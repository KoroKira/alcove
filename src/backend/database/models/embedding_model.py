from uuid import UUID
from sqlalchemy import Column, String, Integer, ForeignKey, Index, Text
from sqlalchemy import UUID as SQLUUID
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete

from .base_model import Base, BaseModel, SCHEMA_NAME


class PadEmbedding(Base, BaseModel):
    """Stores text chunks + their embeddings for RAG search."""
    __tablename__ = "pad_embeddings"
    __table_args__ = (
        Index("ix_pad_embeddings_pad_id", "pad_id"),
        {"schema": SCHEMA_NAME},
    )

    pad_id = Column(
        SQLUUID(as_uuid=True),
        ForeignKey(f"{SCHEMA_NAME}.pads.id", ondelete="CASCADE"),
        nullable=False,
    )
    chunk_index = Column(Integer, nullable=False, default=0)
    chunk_text = Column(Text, nullable=False)
    # Stored as JSON list of floats — portable, no pgvector dependency
    embedding = Column(JSONB, nullable=False)

    @classmethod
    async def delete_for_pad(cls, session: AsyncSession, pad_id: UUID) -> None:
        await session.execute(delete(cls).where(cls.pad_id == pad_id))

    @classmethod
    async def upsert_chunks(
        cls,
        session: AsyncSession,
        pad_id: UUID,
        chunks: list[tuple[int, str, list[float]]],
    ) -> None:
        await cls.delete_for_pad(session, pad_id)
        for idx, text, vec in chunks:
            row = cls(pad_id=pad_id, chunk_index=idx, chunk_text=text, embedding=vec)
            session.add(row)

    @classmethod
    async def get_all(cls, session: AsyncSession) -> list["PadEmbedding"]:
        result = await session.execute(select(cls))
        return list(result.scalars().all())
