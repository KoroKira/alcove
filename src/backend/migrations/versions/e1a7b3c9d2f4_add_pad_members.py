"""add durable pad membership roles and backfill legacy sharing

Revision ID: e1a7b3c9d2f4
Revises: c8d1f2a3b4e5
Create Date: 2026-09-23 00:00:00.000000
"""

from typing import Sequence, Union
from uuid import UUID, uuid4

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "e1a7b3c9d2f4"
down_revision: Union[str, None] = "c8d1f2a3b4e5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SCHEMA = "pad_ws"


def _insert_member(bind, pad_id: UUID, user_id: UUID, role: str) -> None:
    bind.execute(
        sa.text(
            f"""
            INSERT INTO {SCHEMA}.pad_members
                (id, pad_id, user_id, role)
            VALUES (:id, :pad_id, :user_id, :role)
            ON CONFLICT (pad_id, user_id) DO NOTHING
            """
        ),
        {"id": uuid4(), "pad_id": pad_id, "user_id": user_id, "role": role},
    )


def upgrade() -> None:
    op.create_table(
        "pad_members",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("pad_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("role", sa.String(length=20), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(
            ["pad_id"], [f"{SCHEMA}.pads.id"], ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], [f"{SCHEMA}.users.id"], ondelete="CASCADE",
        ),
        sa.UniqueConstraint("pad_id", "user_id", name="uq_pad_members_pad_user"),
        sa.CheckConstraint("role IN ('owner', 'editor', 'viewer')", name="ck_pad_members_role"),
        schema=SCHEMA,
    )
    op.create_index("ix_pad_members_pad_id", "pad_members", ["pad_id"], schema=SCHEMA)
    op.create_index("ix_pad_members_user_id", "pad_members", ["user_id"], schema=SCHEMA)
    op.create_index("ix_pad_ws_pad_members_id", "pad_members", ["id"], schema=SCHEMA)
    op.create_index("ix_pad_ws_pad_members_created_at", "pad_members", ["created_at"], schema=SCHEMA)

    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            f"""
            SELECT id, owner_id, whitelist
            FROM {SCHEMA}.pads
            """
        )
    ).mappings()

    # Insert owners first. If an owner also appears in the old whitelist, the
    # unique constraint keeps the stronger owner role.
    for row in rows:
        _insert_member(bind, row["id"], row["owner_id"], "owner")

    rows = bind.execute(
        sa.text(
            f"""
            SELECT id, sharing_policy, whitelist
            FROM {SCHEMA}.pads
            """
        )
    ).mappings()
    for row in rows:
        if row["sharing_policy"] != "whitelist":
            continue
        for user_id in row["whitelist"] or []:
            _insert_member(bind, row["id"], user_id, "editor")


def downgrade() -> None:
    # This intentionally removes only the new compatibility layer. A rollback
    # after membership edits must be preceded by the documented database
    # backup because those edits cannot be represented in the legacy columns.
    op.drop_index("ix_pad_members_pad_id", table_name="pad_members", schema=SCHEMA)
    op.drop_index("ix_pad_members_user_id", table_name="pad_members", schema=SCHEMA)
    op.drop_index("ix_pad_ws_pad_members_created_at", table_name="pad_members", schema=SCHEMA)
    op.drop_index("ix_pad_ws_pad_members_id", table_name="pad_members", schema=SCHEMA)
    op.drop_table("pad_members", schema=SCHEMA)
