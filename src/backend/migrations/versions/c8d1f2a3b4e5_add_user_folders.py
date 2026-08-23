"""add persistent user folders

Revision ID: c8d1f2a3b4e5
Revises: b7c9f4a2e5d1
Create Date: 2026-08-23 16:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = 'c8d1f2a3b4e5'
down_revision: Union[str, None] = 'b7c9f4a2e5d1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'users',
        sa.Column(
            'folders',
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        schema='pad_ws',
    )


def downgrade() -> None:
    op.drop_column('users', 'folders', schema='pad_ws')
