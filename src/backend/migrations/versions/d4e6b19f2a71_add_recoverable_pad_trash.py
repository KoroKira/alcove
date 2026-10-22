"""add recoverable pad trash

Revision ID: d4e6b19f2a71
Revises: f2b8c4d0e5a6
Create Date: 2026-10-22 20:30:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d4e6b19f2a71"
down_revision: Union[str, None] = "f2b8c4d0e5a6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SCHEMA = "pad_ws"


def upgrade() -> None:
    # `prepare-existing-db.py` synthesizes the legacy schema from current ORM
    # metadata before stamping an old revision. In that isolated migration
    # fixture, create_all already includes this column and index. Production
    # upgrades still add both normally; the guards make the migration safe in
    # either supported path.
    op.execute(
        sa.text(
            f'ALTER TABLE "{SCHEMA}"."pads" '
            'ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP WITH TIME ZONE NULL'
        )
    )
    op.execute(
        sa.text(
            f'CREATE INDEX IF NOT EXISTS "ix_pads_owner_deleted_at" '
            f'ON "{SCHEMA}"."pads" ("owner_id", "deleted_at")'
        )
    )


def downgrade() -> None:
    op.execute(sa.text(f'DROP INDEX IF EXISTS "{SCHEMA}"."ix_pads_owner_deleted_at"'))
    op.execute(sa.text(f'ALTER TABLE "{SCHEMA}"."pads" DROP COLUMN IF EXISTS "deleted_at"'))
