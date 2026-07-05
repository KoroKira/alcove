from sqlalchemy import Column, String, DateTime, ForeignKey, func
from sqlalchemy.dialects.postgresql import UUID, JSONB
from uuid import uuid4
from .base_model import Base


class PadVersion(Base):
    __tablename__ = 'pad_versions'
    __table_args__ = {'schema': 'pad_ws'}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    pad_id = Column(UUID(as_uuid=True), ForeignKey('pad_ws.pads.id', ondelete='CASCADE'), nullable=False, index=True)
    data = Column(JSONB, nullable=True)
    pad_type = Column(String(20), nullable=False, default='canvas')
    snapshot_reason = Column(String(100), nullable=False, default='auto')
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    @classmethod
    async def create(cls, session, pad_id, data, pad_type='canvas', reason='auto'):
        from sqlalchemy import select, delete, func as sa_func
        version = cls(pad_id=pad_id, data=data, pad_type=pad_type, snapshot_reason=reason)
        session.add(version)
        # Keep only the last 50 versions per pad
        count_stmt = select(sa_func.count()).where(cls.pad_id == pad_id)
        count = (await session.execute(count_stmt)).scalar()
        if count >= 50:
            oldest_stmt = (
                select(cls.id)
                .where(cls.pad_id == pad_id)
                .order_by(cls.created_at.asc())
                .limit(count - 49)
            )
            oldest_ids = (await session.execute(oldest_stmt)).scalars().all()
            if oldest_ids:
                await session.execute(delete(cls).where(cls.id.in_(oldest_ids)))
        await session.commit()
        return version

    @classmethod
    async def list_for_pad(cls, session, pad_id, limit=50):
        from sqlalchemy import select
        stmt = (
            select(cls)
            .where(cls.pad_id == pad_id)
            .order_by(cls.created_at.desc())
            .limit(limit)
        )
        result = await session.execute(stmt)
        return result.scalars().all()

    def to_dict(self):
        return {
            'id': str(self.id),
            'pad_id': str(self.pad_id),
            'pad_type': self.pad_type,
            'snapshot_reason': self.snapshot_reason,
            'created_at': self.created_at.isoformat(),
        }

    def to_full_dict(self):
        d = self.to_dict()
        d['data'] = self.data
        return d
