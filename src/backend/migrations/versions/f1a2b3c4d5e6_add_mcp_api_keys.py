"""add mcp_api_keys table for MCP machine-to-machine auth

Revision ID: f1a2b3c4d5e6
Revises: c8d1f2a3b4e5
Create Date: 2026-09-06 00:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = 'f1a2b3c4d5e6'
down_revision: Union[str, None] = 'c8d1f2a3b4e5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Columns are created bare (no inline index=True) — every index below is
    # created explicitly so its name matches, byte for byte, what
    # Base.metadata.create_all would generate for this same ORM model (the
    # path used to bootstrap a brand-new dev DB). BaseModel gives every
    # table an auto-named index on `id` and `created_at`
    # ("ix_pad_ws_<table>_<col>", schema-prefixed because SCHEMA_NAME is set
    # on the metadata) — see e.g. pad_embeddings / users for the same
    # pattern. Diverging here would leave a fresh-bootstrap DB and a
    # migrated DB with different index names for the same table.
    op.create_table(
        'mcp_api_keys',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('owner_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('public_id', sa.String(length=32), nullable=False),
        sa.Column('secret_hash', sa.String(length=64), nullable=False),
        sa.Column('name', sa.String(length=254), nullable=True),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('last_used_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['owner_id'], ['pad_ws.users.id'], ondelete='CASCADE'),
        schema='pad_ws',
    )
    op.create_index(
        'ix_pad_ws_mcp_api_keys_id', 'mcp_api_keys', ['id'], schema='pad_ws',
    )
    op.create_index(
        'ix_pad_ws_mcp_api_keys_created_at', 'mcp_api_keys', ['created_at'], schema='pad_ws',
    )
    op.create_index(
        'ix_mcp_api_keys_owner_id', 'mcp_api_keys', ['owner_id'], schema='pad_ws',
    )
    op.create_index(
        'ix_pad_ws_mcp_api_keys_public_id', 'mcp_api_keys', ['public_id'], unique=True, schema='pad_ws',
    )


def downgrade() -> None:
    op.drop_index('ix_pad_ws_mcp_api_keys_public_id', table_name='mcp_api_keys', schema='pad_ws')
    op.drop_index('ix_mcp_api_keys_owner_id', table_name='mcp_api_keys', schema='pad_ws')
    op.drop_index('ix_pad_ws_mcp_api_keys_created_at', table_name='mcp_api_keys', schema='pad_ws')
    op.drop_index('ix_pad_ws_mcp_api_keys_id', table_name='mcp_api_keys', schema='pad_ws')
    op.drop_table('mcp_api_keys', schema='pad_ws')
