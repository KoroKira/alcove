"""add external API credentials, audit events, and idempotency records

Revision ID: f2b8c4d0e5a6
Revises: e1a7b3c9d2f4
Create Date: 2026-09-23 00:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "f2b8c4d0e5a6"
down_revision: Union[str, None] = "e1a7b3c9d2f4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SCHEMA = "pad_ws"


def _common_columns():
    return (
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
    )


def upgrade() -> None:
    op.create_table(
        "api_tokens",
        *_common_columns(),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("token_prefix", sa.String(length=32), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("scopes", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["user_id"], [f"{SCHEMA}.users.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("token_prefix", name="uq_api_tokens_token_prefix"),
        sa.UniqueConstraint("token_hash", name="uq_api_tokens_token_hash"),
        schema=SCHEMA,
    )
    op.create_index("ix_api_tokens_user_id", "api_tokens", ["user_id"], schema=SCHEMA)
    op.create_index("ix_api_tokens_token_hash", "api_tokens", ["token_hash"], schema=SCHEMA)
    op.create_index("ix_pad_ws_api_tokens_id", "api_tokens", ["id"], schema=SCHEMA)
    op.create_index("ix_pad_ws_api_tokens_created_at", "api_tokens", ["created_at"], schema=SCHEMA)

    op.create_table(
        "audit_events",
        *_common_columns(),
        sa.Column("actor_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("api_token_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("action", sa.String(length=80), nullable=False),
        sa.Column("resource_type", sa.String(length=80), nullable=False),
        sa.Column("resource_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("metadata", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["actor_user_id"], [f"{SCHEMA}.users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["api_token_id"], [f"{SCHEMA}.api_tokens.id"], ondelete="SET NULL"),
        schema=SCHEMA,
    )
    op.create_index("ix_audit_events_actor_user_id", "audit_events", ["actor_user_id"], schema=SCHEMA)
    op.create_index("ix_audit_events_resource", "audit_events", ["resource_type", "resource_id"], schema=SCHEMA)
    op.create_index("ix_pad_ws_audit_events_id", "audit_events", ["id"], schema=SCHEMA)
    op.create_index("ix_pad_ws_audit_events_created_at", "audit_events", ["created_at"], schema=SCHEMA)

    op.create_table(
        "idempotency_records",
        *_common_columns(),
        sa.Column("principal_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("operation", sa.String(length=100), nullable=False),
        sa.Column("idempotency_key", sa.String(length=200), nullable=False),
        sa.Column("request_hash", sa.String(length=64), nullable=False),
        sa.Column("response", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("resource_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["principal_id"], [f"{SCHEMA}.users.id"], ondelete="CASCADE"),
        sa.UniqueConstraint(
            "principal_id", "operation", "idempotency_key",
            name="uq_idempotency_principal_operation_key",
        ),
        schema=SCHEMA,
    )
    op.create_index("ix_idempotency_principal_id", "idempotency_records", ["principal_id"], schema=SCHEMA)
    op.create_index("ix_pad_ws_idempotency_records_id", "idempotency_records", ["id"], schema=SCHEMA)
    op.create_index("ix_pad_ws_idempotency_records_created_at", "idempotency_records", ["created_at"], schema=SCHEMA)


def downgrade() -> None:
    op.drop_index("ix_pad_ws_idempotency_records_created_at", table_name="idempotency_records", schema=SCHEMA)
    op.drop_index("ix_pad_ws_idempotency_records_id", table_name="idempotency_records", schema=SCHEMA)
    op.drop_index("ix_idempotency_principal_id", table_name="idempotency_records", schema=SCHEMA)
    op.drop_table("idempotency_records", schema=SCHEMA)

    op.drop_index("ix_pad_ws_audit_events_created_at", table_name="audit_events", schema=SCHEMA)
    op.drop_index("ix_pad_ws_audit_events_id", table_name="audit_events", schema=SCHEMA)
    op.drop_index("ix_audit_events_resource", table_name="audit_events", schema=SCHEMA)
    op.drop_index("ix_audit_events_actor_user_id", table_name="audit_events", schema=SCHEMA)
    op.drop_table("audit_events", schema=SCHEMA)

    op.drop_index("ix_pad_ws_api_tokens_created_at", table_name="api_tokens", schema=SCHEMA)
    op.drop_index("ix_pad_ws_api_tokens_id", table_name="api_tokens", schema=SCHEMA)
    op.drop_index("ix_api_tokens_token_hash", table_name="api_tokens", schema=SCHEMA)
    op.drop_index("ix_api_tokens_user_id", table_name="api_tokens", schema=SCHEMA)
    op.drop_table("api_tokens", schema=SCHEMA)
